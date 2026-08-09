import { createHmac, timingSafeEqual } from "node:crypto";

import { transitionQueueEntry, type PerformanceRecord, type QueueEntry, type QueueEntryState } from "../../domain/src/live.ts";
import type { AuthorityCoordinator } from "./live-coordinator.ts";

export type LiveAction = "suggest" | "plan" | "queue" | "make-current" | "perform" | "skip" | "defer" | "restore";
export type LiveCommand = {
  schemaVersion: 1;
  communityId: string;
  eventId: string;
  actorId: string;
  deviceInstallationId: string;
  authorityEpoch: number;
  baseRevision: number;
  operationId: string;
  issuedAt: string;
  expiresAt: string;
  action: LiveAction;
  entryId: string;
  payload: Readonly<Record<string, unknown>>;
  authentication: string;
};
type Unsigned = Omit<LiveCommand, "authentication">;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function signLiveCommand(command: Unsigned, secret: string): LiveCommand {
  return { ...command, authentication: createHmac("sha256", secret).update(canonical(command)).digest("hex") };
}

export class LiveError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type Result = { status: "applied" | "suggested"; entry: QueueEntry; revision: number; auditId: string };
const target: Record<LiveAction, QueueEntryState> = {
  suggest: "suggested",
  plan: "planned",
  queue: "queued",
  "make-current": "current",
  perform: "performed",
  skip: "skipped",
  defer: "deferred",
  restore: "restored",
};

export class LivePerformanceService {
  private entries = new Map<string, QueueEntry>();
  private revisions = new Map<string, number>();
  private receipts = new Map<string, { hash: string; result: Result }>();
  private performances: PerformanceRecord[] = [];
  private audits: { id: string; eventId: string; operationId: string; action: string; revision: number; entryId: string }[] = [];
  private readonly options: {
    coordinator: AuthorityCoordinator;
    credentialFor: (device: string) => string | null;
    now?: () => Date;
    maxOperationsPerEvent?: number;
    eventOpen?: (eventId: string) => boolean;
  };

  constructor(options: {
    coordinator: AuthorityCoordinator;
    credentialFor: (device: string) => string | null;
    now?: () => Date;
    maxOperationsPerEvent?: number;
    eventOpen?: (eventId: string) => boolean;
  }) {
    this.options = options;
  }

  execute(command: LiveCommand): Result {
    const hash = canonical(command);
    const receiptKey = `${command.communityId}\0${command.eventId}\0${command.operationId}`;
    const prior = this.receipts.get(receiptKey);
    if (prior) {
      if (prior.hash !== hash) throw new LiveError("replay-mismatch");
      return prior.result;
    }
    if (command.schemaVersion !== 1) throw new LiveError("unsupported-schema");

    const expected = this.options.credentialFor(command.deviceInstallationId);
    if (!expected) throw new LiveError("device-revoked");
    const unsigned = { ...command } as Partial<LiveCommand>;
    delete unsigned.authentication;
    const calculated = createHmac("sha256", expected).update(canonical(unsigned)).digest("hex");
    if (
      calculated.length !== command.authentication.length ||
      !timingSafeEqual(Buffer.from(calculated), Buffer.from(command.authentication))
    ) throw new LiveError("authentication-failed");

    const now = (this.options.now ?? (() => new Date()))().getTime();
    const issuedAt = Date.parse(command.issuedAt);
    const expiresAt = Date.parse(command.expiresAt);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt < now ||
      issuedAt > now + 30_000 ||
      expiresAt <= issuedAt
    ) throw new LiveError("expired");
    if (this.options.eventOpen && !this.options.eventOpen(command.eventId)) throw new LiveError("event-closed");

    const lease = this.options.coordinator.current(command.eventId);
    if (!lease) throw new LiveError("scope-mismatch");
    if (lease.deviceInstallationId !== command.deviceInstallationId || lease.epoch !== command.authorityEpoch) {
      throw new LiveError("superseded-authority");
    }
    if (this.audits.filter((item) => item.eventId === command.eventId).length >= (this.options.maxOperationsPerEvent ?? 1_000)) {
      throw new LiveError("rate-limited");
    }

    const revision = this.revisions.get(command.eventId) ?? 0;
    const existing = this.entries.get(command.entryId);
    if (existing && (existing.eventId !== command.eventId || existing.communityId !== command.communityId)) {
      throw new LiveError("scope-mismatch");
    }
    if (command.baseRevision !== revision) {
      if (command.action === "queue" && !existing) {
        return this.apply(command, "suggested", "suggested", revision, hash, receiptKey);
      }
      throw new LiveError("stale-revision");
    }
    return this.apply(command, target[command.action], "applied", revision, hash, receiptKey);
  }

  private apply(
    command: LiveCommand,
    state: QueueEntryState,
    status: Result["status"],
    revision: number,
    hash: string,
    receiptKey: string,
  ): Result {
    const old = this.entries.get(command.entryId);
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    if (old) transitionQueueEntry(old.state, state);
    const songId = typeof command.payload.songId === "string" ? command.payload.songId : old?.songId;
    if (!songId) throw new LiveError("invalid-payload");

    const nextRevision = revision + 1;
    const entry: QueueEntry = {
      id: command.entryId,
      communityId: command.communityId,
      eventId: command.eventId,
      songId,
      state,
      revision: (old?.revision ?? 0) + 1,
      audienceVisible: state !== "planned" && state !== "deferred",
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(entry.id, entry);
    this.revisions.set(command.eventId, nextRevision);

    const auditId = `audit_${nextRevision}_${command.operationId}`;
    if (state === "performed") {
      this.performances.push(Object.freeze({
        id: `performance_${command.operationId}`,
        eventId: command.eventId,
        entryId: entry.id,
        songId,
        performedAt: now,
        authorityEpoch: command.authorityEpoch,
        revision: nextRevision,
      }));
    }
    this.audits.push(Object.freeze({
      id: auditId,
      eventId: command.eventId,
      operationId: command.operationId,
      action: command.action,
      revision: nextRevision,
      entryId: entry.id,
    }));
    const result = { status, entry: { ...entry }, revision: nextRevision, auditId };
    this.receipts.set(receiptKey, { hash, result });
    return result;
  }

  history(eventId: string) {
    return this.performances.filter((item) => item.eventId === eventId).map((item) => ({ ...item }));
  }

  audit(eventId: string) {
    return this.audits.filter((item) => item.eventId === eventId).map((item) => ({ ...item }));
  }
}
