import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { ContractValidationError, parseCommandEnvelope, type CommandEnvelope } from "../../contracts/src/index.ts";
import { sha256 } from "../../contracts/src/snapshot.ts";
import { replaceBallot as replaceBallotDomain } from "../../domain/src/ballot.ts";
import { KernelError, type BallotResult, type FailurePoint, type FirstLoopIds } from "../../conformance/src/adapter.ts";
import { queryInvariants } from "../../conformance/src/invariants.ts";


function migrationDirectory(): string {
  return fileURLToPath(new URL("../../../migrations/sqlite/", import.meta.url));
}

export class SqliteKernel {
  readonly database: DatabaseSync;

  constructor(filename = ":memory:") {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  close() { this.database.close(); }

  migrate() {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
    const directory = migrationDirectory();
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
      const sql = readFileSync(path.join(directory, name), "utf8");
      const checksum = sha256(sql);
      const existing = this.database.prepare("SELECT checksum FROM schema_migrations WHERE name = ?").get(name) as { checksum: string } | undefined;
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`migration checksum mismatch: ${name}`);
        continue;
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(sql);
        this.database.prepare("INSERT INTO schema_migrations(name, checksum, applied_at) VALUES (?, ?, ?)").run(name, checksum, new Date(0).toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  seedSyntheticFirstLoop(ids: FirstLoopIds) {
    const insertCommunity = this.database.prepare("INSERT OR IGNORE INTO communities(id, name) VALUES (?, ?)");
    insertCommunity.run(ids.community, "Example Music Circle");
    insertCommunity.run(ids.otherCommunity, "Second Example Circle");
    this.database.prepare("INSERT OR IGNORE INTO events(id, community_id, name, state) VALUES (?, ?, ?, 'voting')").run(ids.event, ids.community, "Example Gathering");
    this.database.prepare("INSERT OR IGNORE INTO guest_participations(id, community_id, event_id) VALUES (?, ?, ?)").run(ids.participation, ids.community, ids.event);
    const insertSong = this.database.prepare("INSERT OR IGNORE INTO canonical_songs(id, community_id, title) VALUES (?, ?, ?)");
    insertSong.run(ids.songA, ids.community, "Example Song One");
    insertSong.run(ids.songB, ids.community, "Example Song Two");
    insertSong.run(ids.songC, ids.community, "Example Song Three");
  }

  count(table: string): number {
    const allowed = new Set(["schema_migrations", "communities", "ballot_versions", "audit_events", "idempotency_receipts"]);
    if (!allowed.has(table)) throw new Error("unsupported count target");
    return Number((this.database.prepare(`SELECT count(*) AS value FROM ${table}`).get() as { value: number }).value);
  }

  revokeParticipation(id: string, at: string) {
    this.database.prepare("UPDATE guest_participations SET revoked_at = ? WHERE id = ?").run(at, id);
  }

  latestBallotCreatedAt() {
    return (this.database.prepare("SELECT created_at FROM ballot_versions ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined)?.created_at;
  }

  invariantViolations() { return queryInvariants(this.database); }

  replaceBallot(rawEnvelope: unknown, rankings: readonly string[], now = new Date(), failurePoint?: FailurePoint): BallotResult {
    let envelope: CommandEnvelope;
    try { envelope = parseCommandEnvelope(rawEnvelope); }
    catch (error) { throw new KernelError("invalid-command", "invalid command envelope", { cause: error }); }
    const scopedEventId = envelope.eventId;
    if (!scopedEventId) throw new KernelError("invalid-command", "ballot replacement requires event scope");
    if (envelope.capability !== "ballot:replace") throw new KernelError("denied", "invalid capability for ballot replacement");
    if (envelope.aggregateType !== "ballot") throw new KernelError("invalid-command", "invalid aggregate type for ballot replacement");
    if (envelope.aggregateId !== `${envelope.actorId}:${scopedEventId}`) throw new KernelError("denied", "invalid ballot aggregate identity");
    if (now.getTime() > Date.parse(envelope.expiresAt)) throw new KernelError("expired", "command expired");
    if (now.getTime() < Date.parse(envelope.issuedAt)) throw new KernelError("not-yet-valid", "command not yet valid");
    const payload = { envelope, rankings };
    const payloadHash = sha256(payload);
    const receipt = this.database.prepare("SELECT payload_hash, result_json FROM idempotency_receipts WHERE community_id = ? AND operation_id = ?").get(envelope.communityId, envelope.operationId) as { payload_hash: string; result_json: string } | undefined;
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) throw new KernelError("replay-mismatch", "operation ID payload mismatch");
      return JSON.parse(receipt.result_json) as BallotResult;
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const scope = this.database.prepare(`
        SELECT p.id AS participation_id
        FROM guest_participations p JOIN events e ON e.id = p.event_id
        WHERE p.id = ? AND p.event_id = ? AND p.community_id = ? AND e.community_id = ? AND p.revoked_at IS NULL
      `).get(envelope.actorId, scopedEventId, envelope.communityId, envelope.communityId);
      if (!scope) throw new KernelError("denied", "community or event scope denied");

      const ballotId = `ballot_${sha256(`${scopedEventId}:${envelope.actorId}`).slice(0, 24)}`;
      this.database.prepare(`
        INSERT OR IGNORE INTO ballots(id, community_id, event_id, participation_id, current_revision, state)
        VALUES (?, ?, ?, ?, 0, 'open')
      `).run(ballotId, envelope.communityId, scopedEventId, envelope.actorId);
      const current = this.database.prepare("SELECT current_revision FROM ballots WHERE id = ? AND community_id = ? AND event_id = ?").get(ballotId, envelope.communityId, scopedEventId) as { current_revision: number } | undefined;
      if (!current || current.current_revision !== envelope.expectedRevision) throw new KernelError("conflict", `stale revision: expected ${envelope.expectedRevision}`);

      const eligible = this.database.prepare("SELECT id FROM canonical_songs WHERE community_id = ?").all(envelope.communityId).map((row) => (row as { id: string }).id);
      let outcome;
      try { outcome = replaceBallotDomain(current.current_revision === 0 ? undefined : { revision: current.current_revision, rankings: [] }, { rankings, eligibleSongIds: eligible }).current; }
      catch (error) {
        if (error instanceof ContractValidationError) throw new KernelError("invalid-ballot", error.message, { cause: error });
        throw error;
      }
      const cas = this.database.prepare("UPDATE ballots SET current_revision = ? WHERE id = ? AND current_revision = ?").run(outcome.revision, ballotId, envelope.expectedRevision);
      if (cas.changes !== 1) throw new KernelError("conflict", "stale revision during mutation");
      this.database.prepare("INSERT INTO ballot_versions(ballot_id, community_id, event_id, revision, operation_id, rankings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ballotId, envelope.communityId, scopedEventId, outcome.revision, envelope.operationId, JSON.stringify(outcome.rankings), now.toISOString());
      if (failurePoint === "after-state") throw new Error("injected failure after state");

      const auditId = `audit_${sha256(`${envelope.communityId}:${envelope.operationId}`).slice(0, 24)}`;
      this.database.prepare(`
        INSERT INTO audit_events(id, community_id, event_id, actor_id, capability, operation_id, aggregate_type, aggregate_id, aggregate_revision, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(auditId, envelope.communityId, scopedEventId, envelope.actorId, envelope.capability, envelope.operationId, envelope.aggregateType, envelope.aggregateId, outcome.revision, now.toISOString());
      if (failurePoint === "after-audit") throw new Error("injected failure after audit");

      const result: BallotResult = { method: "ranked-choice", revision: outcome.revision, rankings: [...outcome.rankings] };
      this.database.prepare("INSERT INTO idempotency_receipts(community_id, operation_id, payload_hash, result_json, audit_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(envelope.communityId, envelope.operationId, payloadHash, JSON.stringify(result), auditId, now.toISOString());
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof KernelError) throw error;
      throw new KernelError("storage-failure", error instanceof Error ? error.message : "SQLite storage failure", { cause: error });
    }
  }
}

export type { CommandEnvelope };
