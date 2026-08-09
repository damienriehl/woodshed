export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type CommunityId = Brand<string, "CommunityId">;
export type EventId = Brand<string, "EventId">;
export type GuestParticipationId = Brand<string, "GuestParticipationId">;
export type CanonicalSongId = Brand<string, "CanonicalSongId">;
export type EventSongDecisionVersionId = Brand<string, "EventSongDecisionVersionId">;
export type BallotId = Brand<string, "BallotId">;
export type ProposalId = Brand<string, "ProposalId">;
export type AuditEventId = Brand<string, "AuditEventId">;

export class ContractValidationError extends Error {
  readonly code = "contract-validation";
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ContractValidationError(`${label} must be a non-empty string`);
  return value;
}

function id<Name extends string>(prefix: string, name: Name) {
  return (value: unknown): Brand<string, Name> => {
    const parsed = string(value, name);
    if (!new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{2,127}$`).test(parsed)) throw new ContractValidationError(`${name} has an invalid format`);
    return parsed as Brand<string, Name>;
  };
}

export const communityId = id("community", "CommunityId");
export const eventId = id("event", "EventId");
export const guestParticipationId = id("participation", "GuestParticipationId");
export const canonicalSongId = id("song", "CanonicalSongId");
export const eventSongDecisionVersionId = id("decision", "EventSongDecisionVersionId");
export const ballotId = id("ballot", "BallotId");
export const proposalId = id("proposal", "ProposalId");
export const auditEventId = id("audit", "AuditEventId");

export function parseCommunity(value: unknown) {
  const item = object(value, "community");
  return { id: communityId(item.id), name: string(item.name, "community.name") };
}

export function parseEvent(value: unknown) {
  const item = object(value, "event");
  return { id: eventId(item.id), communityId: communityId(item.communityId), name: string(item.name, "event.name"), state: parseEventState(item.state) };
}

export function parseGuestParticipation(value: unknown) {
  const item = object(value, "guest participation");
  return { id: guestParticipationId(item.id), communityId: communityId(item.communityId), eventId: eventId(item.eventId) };
}

export function parseCanonicalSong(value: unknown) {
  const item = object(value, "canonical song");
  return { id: canonicalSongId(item.id), communityId: communityId(item.communityId), title: string(item.title, "song.title") };
}

export function parseEventSongDecisionVersion(value: unknown) {
  const item = object(value, "event song decision version");
  if (!Number.isInteger(item.revision) || (item.revision as number) < 1) throw new ContractValidationError("decision revision must be positive");
  return { id: eventSongDecisionVersionId(item.id), eventId: eventId(item.eventId), songId: canonicalSongId(item.songId), revision: item.revision as number };
}

export function parseBallot(value: unknown) {
  const item = object(value, "ballot");
  const rankings = Array.isArray(item.rankings) ? item.rankings.map(canonicalSongId) : (() => { throw new ContractValidationError("ballot.rankings must be an array"); })();
  if (new Set(rankings).size !== rankings.length) throw new ContractValidationError("ballot rankings must be unique");
  return { id: ballotId(item.id), rankings };
}

export function parseProposal(value: unknown) {
  const item = object(value, "proposal");
  return { id: proposalId(item.id), communityId: communityId(item.communityId), eventId: eventId(item.eventId), title: string(item.title, "proposal.title"), state: parseProposalState(item.state) };
}

export function parseAuditEvent(value: unknown) {
  const item = object(value, "audit event");
  return { id: auditEventId(item.id), communityId: communityId(item.communityId), action: string(item.action, "audit.action") };
}

export const EVENT_STATES = ["draft", "published", "voting", "live", "completed", "archived", "cancelled"] as const;
export type EventState = typeof EVENT_STATES[number];
export const PROPOSAL_STATES = ["submitted", "moderated", "matched", "eligible", "rejected", "withdrawn"] as const;
export type ProposalState = typeof PROPOSAL_STATES[number];
export const BALLOT_STATES = ["draft", "open", "closed", "reopened", "final"] as const;
export type BallotState = typeof BALLOT_STATES[number];

function enumValue<T extends readonly string[]>(values: T, value: unknown, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new ContractValidationError(`${label} is invalid`);
  return value as T[number];
}
export const parseEventState = (value: unknown) => enumValue(EVENT_STATES, value, "event state");
export const parseProposalState = (value: unknown) => enumValue(PROPOSAL_STATES, value, "proposal state");
export const parseBallotState = (value: unknown) => enumValue(BALLOT_STATES, value, "ballot state");

const EVENT_TRANSITIONS: Record<EventState, readonly EventState[]> = {
  draft: ["published", "cancelled"],
  published: ["voting", "live", "cancelled"],
  voting: ["published", "live", "completed", "cancelled"],
  live: ["completed", "cancelled"],
  completed: ["archived"],
  archived: [],
  cancelled: ["archived"],
};
const PROPOSAL_TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  submitted: ["moderated", "withdrawn"],
  moderated: ["matched", "eligible", "rejected", "withdrawn"],
  matched: ["eligible", "rejected", "withdrawn"],
  eligible: ["withdrawn"],
  rejected: [],
  withdrawn: [],
};
const BALLOT_TRANSITIONS: Record<BallotState, readonly BallotState[]> = {
  draft: ["open", "closed"],
  open: ["closed"],
  closed: ["reopened", "final"],
  reopened: ["closed"],
  final: [],
};

export function transitionEvent(from: EventState, to: EventState): EventState {
  if (!EVENT_TRANSITIONS[from]?.includes(to)) throw new ContractValidationError(`invalid event transition: ${from} -> ${to}`);
  return to;
}
export function transitionProposal(from: ProposalState, to: ProposalState): ProposalState {
  if (!PROPOSAL_TRANSITIONS[from]?.includes(to)) throw new ContractValidationError(`invalid proposal transition: ${from} -> ${to}`);
  return to;
}
export function transitionBallot(from: BallotState, to: BallotState): BallotState {
  if (!BALLOT_TRANSITIONS[from]?.includes(to)) throw new ContractValidationError(`invalid ballot transition: ${from} -> ${to}`);
  return to;
}

export type CommandEnvelope = {
  schemaVersion: 1; aggregateType: string; aggregateId: string; scope: "community" | "event";
  communityId: CommunityId; eventId?: EventId; actorId: string; capability: string; operationId: string;
  expectedRevision: number; issuedAt: string; expiresAt: string;
};

export function parseCommandEnvelope(value: unknown): CommandEnvelope {
  const item = object(value, "command");
  if (item.schemaVersion !== 1) throw new ContractValidationError("unsupported command schema version");
  const scope = enumValue(["community", "event"] as const, item.scope, "command scope");
  const community = communityId(item.communityId);
  const event = item.eventId === undefined ? undefined : eventId(item.eventId);
  if (scope === "event" && !event) throw new ContractValidationError("event-scoped commands require eventId");
  if (!Number.isInteger(item.expectedRevision) || (item.expectedRevision as number) < 0) throw new ContractValidationError("expectedRevision must be non-negative");
  const issuedAt = string(item.issuedAt, "issuedAt");
  const expiresAt = string(item.expiresAt, "expiresAt");
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new ContractValidationError("command expiry must be after issuance");
  if (expires - issued > 86_400_000) throw new ContractValidationError("command lifetime exceeds maximum");
  return {
    schemaVersion: 1, aggregateType: string(item.aggregateType, "aggregateType"), aggregateId: string(item.aggregateId, "aggregateId"), scope,
    communityId: community, eventId: event, actorId: string(item.actorId, "actorId"), capability: string(item.capability, "capability"),
    operationId: string(item.operationId, "operationId"), expectedRevision: item.expectedRevision as number, issuedAt, expiresAt,
  };
}
