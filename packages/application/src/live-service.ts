import { createHmac, timingSafeEqual } from "node:crypto";

import { transitionQueueEntry, type PerformanceRecord, type QueueEntry, type QueueEntryState } from "../../domain/src/live.ts";
import { canonicalJson } from "../../contracts/src/snapshot.ts";
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

export function signLiveCommand(command: Unsigned, secret: string): LiveCommand {
  return { ...command, authentication: createHmac("sha256", secret).update(canonicalJson(command)).digest("hex") };
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

const actions = new Set<LiveAction>(Object.keys(target) as LiveAction[]);
const identifierFields = ["communityId", "eventId", "actorId", "deviceInstallationId", "operationId", "entryId"] as const;

function parseLiveCommand(value: unknown): LiveCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LiveError("invalid-command");
  const command = value as Record<string, unknown>;
  if (command.schemaVersion !== 1) throw new LiveError("unsupported-schema");
  for (const field of identifierFields) {
    if (typeof command[field] !== "string" || command[field].length === 0) throw new LiveError("invalid-command");
  }
  if (!Number.isSafeInteger(command.authorityEpoch) || (command.authorityEpoch as number) < 1) throw new LiveError("invalid-command");
  if (!Number.isSafeInteger(command.baseRevision) || (command.baseRevision as number) < 0) throw new LiveError("invalid-command");
  if (typeof command.issuedAt !== "string" || typeof command.expiresAt !== "string") throw new LiveError("invalid-command");
  if (typeof command.action !== "string" || !actions.has(command.action as LiveAction)) throw new LiveError("invalid-command");
  if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) throw new LiveError("invalid-payload");
  if (typeof command.authentication !== "string" || !/^[a-f0-9]{64}$/i.test(command.authentication)) throw new LiveError("authentication-failed");
  return command as LiveCommand;
}

export class LivePerformanceService {
  private entries = new Map<string, QueueEntry>();
  private revisions = new Map<string, number>();
  private receipts = new Map<string, { hash: string; result: Result }>();
  private performances: PerformanceRecord[] = [];
  private audits: { id: string; eventId: string; operationId: string; action: string; revision: number; entryId: string }[] = [];
  private operationCounts = new Map<string, number>();
  private readonly options: {
    coordinator: AuthorityCoordinator;
    credentialFor: (device: string) => string | null;
    now?: () => Date;
    maxOperationsPerEvent?: number;
    eventOpen?: (eventId: string) => boolean;
    communityForEvent: (eventId: string) => string | null;
  };

  constructor(options: {
    coordinator: AuthorityCoordinator;
    credentialFor: (device: string) => string | null;
    now?: () => Date;
    maxOperationsPerEvent?: number;
    eventOpen?: (eventId: string) => boolean;
    communityForEvent: (eventId: string) => string | null;
  }) {
    this.options = options;
  }

  execute(rawCommand: unknown): Result {
    const command = parseLiveCommand(rawCommand);
    const hash = canonicalJson(command);
    const receiptKey = `${command.communityId}\0${command.eventId}\0${command.operationId}`;
    const prior = this.receipts.get(receiptKey);
    if (prior) {
      if (prior.hash !== hash) throw new LiveError("replay-mismatch");
      return prior.result;
    }
    if (this.options.communityForEvent(command.eventId) !== command.communityId) throw new LiveError("scope-mismatch");

    const expected = this.options.credentialFor(command.deviceInstallationId);
    if (!expected) throw new LiveError("device-revoked");
    const unsigned = { ...command } as Partial<LiveCommand>;
    delete unsigned.authentication;
    const calculated = createHmac("sha256", expected).update(canonicalJson(unsigned)).digest("hex");
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
    if ((this.operationCounts.get(command.eventId) ?? 0) >= (this.options.maxOperationsPerEvent ?? 1_000)) {
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
    this.operationCounts.set(command.eventId, (this.operationCounts.get(command.eventId) ?? 0) + 1);
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

  purgeEvent(eventId: string) {
    for (const [entryId, entry] of this.entries) if (entry.eventId === eventId) this.entries.delete(entryId);
    for (const [receiptKey, receipt] of this.receipts) if (receipt.result.entry.eventId === eventId) this.receipts.delete(receiptKey);
    this.revisions.delete(eventId);
    this.operationCounts.delete(eventId);
    this.performances = this.performances.filter((item) => item.eventId !== eventId);
    this.audits = this.audits.filter((item) => item.eventId !== eventId);
  }
}
