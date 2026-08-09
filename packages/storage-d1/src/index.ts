import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import { ContractValidationError, parseCommandEnvelope, type CommandEnvelope } from "../../contracts/src/index.ts";
import { replaceBallot as replaceBallotDomain } from "../../domain/src/ballot.ts";
import { INVARIANT_CATALOG } from "../../conformance/src/invariants.ts";
import { KernelError, type BallotResult, type FailurePoint, type FirstLoopIds } from "../../conformance/src/adapter.ts";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failStorage(error: unknown): never {
  if (error instanceof KernelError) throw error;
  throw new KernelError("storage-failure", error instanceof Error ? error.message : "D1 storage failure", { cause: error });
}

export class D1Kernel {
  readonly database: D1Database;
  private readonly migrations: readonly { name: string; sql: string }[];
  private readonly dispose: () => Promise<void> | void;

  constructor(database: D1Database, migrations: readonly { name: string; sql: string }[], dispose: () => Promise<void> | void = () => {}) {
    this.database = database;
    this.migrations = migrations;
    this.dispose = dispose;
  }

  async close() { await this.dispose(); }

  async migrate() {
    await this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const { name, sql } of this.migrations) {
      const checksum = await digest(sql);
      const existing = await this.database.prepare("SELECT checksum FROM schema_migrations WHERE name = ?").bind(name).first<{ checksum: string }>();
      if (existing) {
        if (existing.checksum !== checksum) throw new KernelError("storage-failure", `migration checksum mismatch: ${name}`);
        continue;
      }
      try {
        const statements = sql.split(/\r?\n/).map((statement) => statement.trim()).filter(Boolean).map((statement) => this.database.prepare(statement));
        statements.push(this.database.prepare("INSERT INTO schema_migrations(name, checksum, applied_at) VALUES (?, ?, ?)").bind(name, checksum, new Date(0).toISOString()));
        await this.database.batch(statements);
      } catch (error) { failStorage(error); }
    }
  }

  async seedSyntheticFirstLoop(ids: FirstLoopIds) {
    await this.database.batch([
      this.database.prepare("INSERT OR IGNORE INTO communities(id, name) VALUES (?, ?)").bind(ids.community, "Example Music Circle"),
      this.database.prepare("INSERT OR IGNORE INTO communities(id, name) VALUES (?, ?)").bind(ids.otherCommunity, "Second Example Circle"),
      this.database.prepare("INSERT OR IGNORE INTO events(id, community_id, name, state) VALUES (?, ?, ?, 'voting')").bind(ids.event, ids.community, "Example Gathering"),
      this.database.prepare("INSERT OR IGNORE INTO guest_participations(id, community_id, event_id) VALUES (?, ?, ?)").bind(ids.participation, ids.community, ids.event),
      this.database.prepare("INSERT OR IGNORE INTO canonical_songs(id, community_id, title) VALUES (?, ?, ?)").bind(ids.songA, ids.community, "Example Song One"),
      this.database.prepare("INSERT OR IGNORE INTO canonical_songs(id, community_id, title) VALUES (?, ?, ?)").bind(ids.songB, ids.community, "Example Song Two"),
      this.database.prepare("INSERT OR IGNORE INTO canonical_songs(id, community_id, title) VALUES (?, ?, ?)").bind(ids.songC, ids.community, "Example Song Three"),
    ]);
  }

  async count(table: "schema_migrations" | "communities" | "ballot_versions" | "audit_events" | "idempotency_receipts") {
    const allowed = new Set(["schema_migrations", "communities", "ballot_versions", "audit_events", "idempotency_receipts"]);
    if (!allowed.has(table)) throw new KernelError("invalid-command", "unsupported count target");
    const row = await this.database.prepare(`SELECT count(*) AS value FROM ${table}`).first<{ value: number }>();
    return Number(row?.value ?? 0);
  }

  async revokeParticipation(id: string, at: string) {
    await this.database.prepare("UPDATE guest_participations SET revoked_at = ? WHERE id = ?").bind(at, id).run();
  }

  async latestBallotCreatedAt() {
    return (await this.database.prepare("SELECT created_at FROM ballot_versions ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>())?.created_at;
  }

  async invariantViolations() {
    const violations: { invariant: string; count: number }[] = [];
    for (const [invariant, sql] of Object.entries(INVARIANT_CATALOG)) {
      const row = await this.database.prepare(sql).first<{ value: number }>();
      const count = Number(row?.value ?? 0);
      if (count !== 0) violations.push({ invariant, count });
    }
    return violations;
  }

  async replaceBallot(rawEnvelope: unknown, rankings: readonly string[], now = new Date(), failurePoint?: FailurePoint): Promise<BallotResult> {
    let envelope: CommandEnvelope;
    try { envelope = parseCommandEnvelope(rawEnvelope); }
    catch (error) { throw new KernelError("invalid-command", "invalid command envelope", { cause: error }); }
    const eventId = envelope.eventId;
    if (!eventId) throw new KernelError("invalid-command", "ballot replacement requires event scope");
    if (envelope.capability !== "ballot:replace") throw new KernelError("denied", "invalid capability for ballot replacement");
    if (envelope.aggregateType !== "ballot") throw new KernelError("invalid-command", "invalid aggregate type for ballot replacement");
    if (envelope.aggregateId !== `${envelope.actorId}:${eventId}`) throw new KernelError("denied", "invalid ballot aggregate identity");
    if (now.getTime() > Date.parse(envelope.expiresAt)) throw new KernelError("expired", "command expired");
    if (now.getTime() < Date.parse(envelope.issuedAt)) throw new KernelError("not-yet-valid", "command not yet valid");

    const payloadHash = await digest({ envelope, rankings });
    const receipt = await this.database.prepare("SELECT payload_hash, result_json FROM idempotency_receipts WHERE community_id = ? AND operation_id = ?").bind(envelope.communityId, envelope.operationId).first<{ payload_hash: string; result_json: string }>();
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) throw new KernelError("replay-mismatch", "operation ID payload mismatch");
      return JSON.parse(receipt.result_json) as BallotResult;
    }

    const scope = await this.database.prepare("SELECT p.id FROM guest_participations p JOIN events e ON e.id = p.event_id WHERE p.id = ? AND p.event_id = ? AND p.community_id = ? AND e.community_id = ? AND p.revoked_at IS NULL").bind(envelope.actorId, eventId, envelope.communityId, envelope.communityId).first();
    if (!scope) throw new KernelError("denied", "community or event scope denied");

    const ballot = `ballot_${(await digest(`${eventId}:${envelope.actorId}`)).slice(0, 24)}`;
    const current = await this.database.prepare("SELECT current_revision FROM ballots WHERE id = ? AND community_id = ? AND event_id = ?").bind(ballot, envelope.communityId, eventId).first<{ current_revision: number }>();
    const currentRevision = Number(current?.current_revision ?? 0);
    if (currentRevision !== envelope.expectedRevision) throw new KernelError("conflict", `stale revision: expected ${envelope.expectedRevision}`);

    const eligibleRows = await this.database.prepare("SELECT id FROM canonical_songs WHERE community_id = ? ORDER BY id").bind(envelope.communityId).all<{ id: string }>();
    let outcome;
    try {
      outcome = replaceBallotDomain(currentRevision === 0 ? undefined : { revision: currentRevision, rankings: [] }, { rankings, eligibleSongIds: eligibleRows.results.map(({ id }) => id) }).current;
    } catch (error) {
      if (error instanceof ContractValidationError) throw new KernelError("invalid-ballot", error.message, { cause: error });
      throw error;
    }

    const auditId = `audit_${(await digest(`${envelope.communityId}:${envelope.operationId}`)).slice(0, 24)}`;
    const result: BallotResult = { method: "ranked-choice", revision: outcome.revision, rankings: [...outcome.rankings] };
    const statements: D1PreparedStatement[] = [
      this.database.prepare("INSERT OR IGNORE INTO ballots(id, community_id, event_id, participation_id, current_revision, state) VALUES (?, ?, ?, ?, 0, 'open')").bind(ballot, envelope.communityId, eventId, envelope.actorId),
      this.database.prepare("UPDATE ballots SET current_revision = ? WHERE id = ? AND community_id = ? AND event_id = ? AND current_revision = ?").bind(outcome.revision, ballot, envelope.communityId, eventId, envelope.expectedRevision),
      this.database.prepare("INSERT INTO ballot_versions(ballot_id, community_id, event_id, revision, operation_id, rankings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(ballot, envelope.communityId, eventId, outcome.revision, envelope.operationId, JSON.stringify(outcome.rankings), now.toISOString()),
    ];
    if (failurePoint === "after-state") statements.push(this.database.prepare("INSERT INTO communities(id, name) VALUES ('invalid', 'Fault')"));
    statements.push(this.database.prepare("INSERT INTO audit_events(id, community_id, event_id, actor_id, capability, operation_id, aggregate_type, aggregate_id, aggregate_revision, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(auditId, envelope.communityId, eventId, envelope.actorId, envelope.capability, envelope.operationId, envelope.aggregateType, envelope.aggregateId, outcome.revision, now.toISOString()));
    if (failurePoint === "after-audit") statements.push(this.database.prepare("INSERT INTO communities(id, name) VALUES ('invalid', 'Fault')"));
    statements.push(this.database.prepare("INSERT INTO idempotency_receipts(community_id, operation_id, payload_hash, result_json, audit_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(envelope.communityId, envelope.operationId, payloadHash, JSON.stringify(result), auditId, now.toISOString()));

    try { await this.database.batch(statements); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/UNIQUE constraint failed: ballot_versions|UNIQUE constraint failed: ballots/i.test(message)) throw new KernelError("conflict", "stale revision during mutation", { cause: error });
      failStorage(error);
    }
    return result;
  }
}
