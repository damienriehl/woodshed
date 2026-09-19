import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ContractValidationError,
  eventId,
  parseBallot,
  parseAuditEvent,
  parseCanonicalSong,
  parseCommunity,
  parseCommandEnvelope,
  parseEvent,
  parseEventSongDecisionVersion,
  parseGuestParticipation,
  parseProposal,
  transitionBallot,
  transitionEvent,
  transitionProposal,
} from "../../packages/contracts/src/index.ts";
import { authorize } from "../../packages/application/src/authorization.ts";
import { DATA_CLASSIFICATIONS } from "../../packages/application/src/data-classification.ts";
import { appendEligibleCandidate, replaceBallot } from "../../packages/domain/src/ballot.ts";
import { SqliteKernel } from "../../packages/storage-sqlite/src/index.ts";
import { queryInvariants } from "../../packages/conformance/src/invariants.ts";

const IDS = {
  community: "community_demo_alpha",
  otherCommunity: "community_demo_beta",
  event: "event_demo_show",
  participation: "participation_demo_guest",
  songA: "song_demo_alpha",
  songB: "song_demo_beta",
  songC: "song_demo_gamma",
};

function command(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    aggregateType: "ballot",
    aggregateId: `${IDS.participation}:${IDS.event}`,
    scope: "event",
    communityId: IDS.community,
    eventId: IDS.event,
    actorId: IDS.participation,
    capability: "ballot:replace",
    operationId: "operation_demo_0001",
    expectedRevision: 0,
    issuedAt: "2030-01-01T12:00:00.000Z",
    expiresAt: "2030-01-01T12:10:00.000Z",
    ...overrides,
  };
}

test("runtime schemas accept synthetic records and reject malformed IDs and ballots", () => {
  assert.equal(parseCommunity({ id: IDS.community, name: "Example Music Circle" }).id, IDS.community);
  assert.equal(parseEvent({ id: IDS.event, communityId: IDS.community, name: "Example Gathering", state: "draft" }).state, "draft");
  assert.equal(parseGuestParticipation({ id: IDS.participation, communityId: IDS.community, eventId: IDS.event }).id, IDS.participation);
  assert.equal(parseCanonicalSong({ id: IDS.songA, communityId: IDS.community, title: "Example Song" }).id, IDS.songA);
  assert.equal(parseEventSongDecisionVersion({ id: "decision_demo_one", eventId: IDS.event, songId: IDS.songA, revision: 1 }).revision, 1);
  assert.equal(parseProposal({ id: "proposal_demo_one", communityId: IDS.community, eventId: IDS.event, title: "Another Example Song", state: "submitted" }).state, "submitted");
  assert.equal(parseAuditEvent({ id: "audit_demo_one", communityId: IDS.community, action: "ballot.replaced" }).action, "ballot.replaced");
  assert.throws(() => eventId("community_demo_alpha"), ContractValidationError);
  assert.throws(() => parseBallot({ id: "ballot_demo_one", rankings: [IDS.songA, IDS.songA] }), ContractValidationError);
});

test("event and proposal lifecycle guards reject invalid transitions", () => {
  assert.equal(transitionEvent("draft", "published"), "published");
  assert.throws(() => transitionEvent("draft", "completed"), /transition/i);
  assert.equal(transitionProposal("moderated", "eligible"), "eligible");
  assert.throws(() => transitionProposal("rejected", "eligible"), /transition/i);
  assert.equal(transitionBallot("draft", "open"), "open");
  assert.throws(() => transitionBallot("final", "open"), /transition/i);
});

test("command envelope requires bounded, scoped, revision-aware operations", () => {
  assert.equal(parseCommandEnvelope(command()).scope, "event");
  assert.throws(() => parseCommandEnvelope(command({ eventId: IDS.otherCommunity })), ContractValidationError);
  assert.throws(() => parseCommandEnvelope(command({ expiresAt: "2029-01-01T00:00:00.000Z" })), ContractValidationError);
  assert.throws(() => parseCommandEnvelope(command({ expectedRevision: -1 })), ContractValidationError);
});

test("authorization is deny-by-default and blocks cross-community IDOR", () => {
  assert.equal(authorize({ roles: ["organizer"], actorCommunityId: IDS.community, resourceCommunityId: IDS.community, capability: "event:update" }).allowed, true);
  assert.equal(authorize({ roles: ["organizer"], actorCommunityId: IDS.community, resourceCommunityId: IDS.community, capability: "guest:suspend" }).allowed, true);
  assert.equal(authorize({ roles: ["participant"], actorCommunityId: IDS.community, resourceCommunityId: IDS.community, capability: "event:update" }).allowed, false);
  assert.equal(authorize({ roles: ["organizer"], actorCommunityId: IDS.community, resourceCommunityId: IDS.otherCommunity, capability: "event:update" }).reason, "community-mismatch");
  assert.equal(authorize({ roles: ["organizer"], actorCommunityId: IDS.community, resourceCommunityId: IDS.community, capability: "unknown:action" }).allowed, false);
});

test("classification registry declares access, telemetry, retention, deletion and export policy", () => {
  for (const name of ["publicMetadata", "personalData", "ballot", "authenticationMaterial", "audit"]) {
    const entry = DATA_CLASSIFICATIONS[name];
    assert.ok(entry);
    assert.ok(entry.access.length > 0);
    assert.equal(typeof entry.telemetry, "string");
    assert.equal(typeof entry.retention, "string");
    assert.equal(typeof entry.deletion, "string");
    assert.equal(typeof entry.exportable, "boolean");
  }
});

test("ballot replacement is immutable, ranked-choice by default, and candidate additions append", () => {
  const first = replaceBallot(undefined, { rankings: [IDS.songB, IDS.songA], eligibleSongIds: [IDS.songA, IDS.songB] });
  const second = replaceBallot(first.current, { rankings: [IDS.songA], eligibleSongIds: [IDS.songA, IDS.songB] });
  assert.equal(first.method, "ranked-choice");
  assert.equal(second.current.revision, 2);
  assert.equal(first.current.revision, 1);
  assert.deepEqual(appendEligibleCandidate([IDS.songB, IDS.songA], IDS.songC), [IDS.songB, IDS.songA, IDS.songC]);
  assert.deepEqual(appendEligibleCandidate([IDS.songB, IDS.songA], IDS.songA), [IDS.songB, IDS.songA]);
});

async function withKernel(run: (kernel: SqliteKernel, dbPath: string) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "woodshed-kernel-"));
  const dbPath = path.join(directory, "kernel.sqlite");
  const kernel = new SqliteKernel(dbPath);
  try {
    kernel.migrate();
    kernel.seedSyntheticFirstLoop(IDS);
    await run(kernel, dbPath);
  } finally {
    kernel.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("SQLite mutation atomically writes state, audit and idempotency receipt", async () => {
  await withKernel((kernel) => {
    const result = kernel.replaceBallot(command(), [IDS.songA, IDS.songB], new Date("2030-01-01T12:01:00.000Z"));
    assert.equal(result.revision, 1);
    assert.deepEqual(queryInvariants(kernel.database), []);
  });
});

test("invariant linkage cannot borrow another ballot's same-revision audit", async () => {
  await withKernel((kernel) => {
    kernel.replaceBallot(command(), [IDS.songA], new Date("2030-01-01T12:01:00.000Z"));
    kernel.database.prepare("INSERT INTO guest_participations(id, community_id, event_id) VALUES (?, ?, ?)").run("participation_demo_second", IDS.community, IDS.event);
    kernel.database.prepare("INSERT INTO ballots(id, community_id, event_id, participation_id, current_revision, state) VALUES (?, ?, ?, ?, 1, 'open')").run("ballot_demo_orphan", IDS.community, IDS.event, "participation_demo_second");
    kernel.database.prepare("INSERT INTO ballot_versions(ballot_id, community_id, event_id, revision, operation_id, rankings_json, created_at) VALUES (?, ?, ?, 1, ?, '[]', ?)").run("ballot_demo_orphan", IDS.community, IDS.event, "operation_demo_orphan", "2030-01-01T12:01:00.000Z");
    assert.deepEqual(queryInvariants(kernel.database), [{ invariant: "mutation-has-audit-and-receipt", count: 1 }]);
  });
});

test("ballot history is immutable and guest consent cannot broaden implicitly", async () => {
  await withKernel((kernel) => {
    kernel.replaceBallot(command(), [IDS.songA], new Date("2030-01-01T12:01:00.000Z"));
    assert.throws(() => kernel.database.prepare("UPDATE ballot_versions SET rankings_json = '[]'").run(), /immutable/i);
    assert.throws(() => kernel.database.prepare("DELETE FROM ballot_versions").run(), /immutable/i);
    assert.throws(() => kernel.database.prepare("UPDATE guest_participations SET consent_scope = 'community' WHERE id = ?").run(IDS.participation), /consent|constraint/i);
  });
});

test("duplicate replay returns receipt while payload mismatch is rejected", async () => {
  await withKernel((kernel) => {
    const envelope = command();
    const first = kernel.replaceBallot(envelope, [IDS.songA], new Date("2030-01-01T12:01:00.000Z"));
    const replay = kernel.replaceBallot(envelope, [IDS.songA], new Date("2030-01-01T12:02:00.000Z"));
    assert.deepEqual(replay, first);
    assert.throws(() => kernel.replaceBallot(envelope, [IDS.songB], new Date("2030-01-01T12:02:00.000Z")), /operation.*payload/i);
  });
});

test("expired commands, stale revisions and cross-community resources fail closed", async () => {
  await withKernel((kernel) => {
    assert.throws(() => kernel.replaceBallot(command(), [IDS.songA], new Date("2030-01-01T12:11:00.000Z")), /expired/i);
    kernel.replaceBallot(command(), [IDS.songA], new Date("2030-01-01T12:01:00.000Z"));
    assert.throws(() => kernel.replaceBallot(command({ operationId: "operation_demo_0002", expectedRevision: 0 }), [IDS.songB], new Date("2030-01-01T12:02:00.000Z")), /revision/i);
    assert.throws(() => kernel.replaceBallot(command({ operationId: "operation_demo_0003", communityId: IDS.otherCommunity }), [IDS.songA], new Date("2030-01-01T12:02:00.000Z")), /community/i);
  });
});

test("SQLite kernel reports a lifecycle trigger as voting-closed",async()=>{await withKernel(kernel=>{kernel.database.prepare("UPDATE events SET state='completed' WHERE id=?").run(IDS.event);assert.throws(()=>kernel.replaceBallot(command(),[IDS.songA],new Date("2030-01-01T12:01:00.000Z")),(error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="voting-closed");});});

test("ballot commands reject capability, aggregate type, and aggregate identity confusion", async () => {
  await withKernel((kernel) => {
    const now = new Date("2030-01-01T12:01:00.000Z");
    assert.throws(() => kernel.replaceBallot(command({ capability: "event:update" }), [IDS.songA], now), /capability/i);
    assert.throws(() => kernel.replaceBallot(command({ aggregateType: "event" }), [IDS.songA], now), /aggregate type/i);
    assert.throws(() => kernel.replaceBallot(command({ aggregateId: "ballot_unrelated_target" }), [IDS.songA], now), /aggregate identity/i);
  });
});

test("SQLite composite foreign keys reject cross-community relationships", async () => {
  await withKernel((kernel) => {
    kernel.database.prepare("INSERT INTO events(id, community_id, name) VALUES (?, ?, ?)").run("event_demo_other", IDS.otherCommunity, "Other Gathering");
    assert.throws(() => kernel.database.prepare("INSERT INTO guest_participations(id, community_id, event_id) VALUES (?, ?, ?)").run("participation_demo_cross", IDS.community, "event_demo_other"), /constraint/i);
    assert.throws(() => kernel.database.prepare("INSERT INTO event_song_decisions(id, community_id, event_id, song_id, revision, snapshot_json, created_at) VALUES (?, ?, ?, ?, 1, '{}', ?)").run("decision_demo_cross", IDS.community, "event_demo_other", IDS.songA, "2030-01-01T00:00:00.000Z"), /constraint/i);
  });
});

test("faults between state, audit and receipt roll back the entire operation", async () => {
  for (const point of ["after-state", "after-audit"] as const) {
    await withKernel((kernel) => {
      assert.throws(() => kernel.replaceBallot(command({ operationId: `operation_demo_${point}` }), [IDS.songA], new Date("2030-01-01T12:01:00.000Z"), point), /injected/i);
      assert.equal(kernel.count("ballot_versions"), 0);
      assert.equal(kernel.count("audit_events"), 0);
      assert.equal(kernel.count("idempotency_receipts"), 0);
    });
  }
});

test("sequential and concurrent CAS allow only one replacement at a revision", async () => {
  await withKernel(async (kernel) => {
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => kernel.replaceBallot(command({ operationId: "operation_demo_left" }), [IDS.songA], new Date("2030-01-01T12:01:00.000Z"))),
      Promise.resolve().then(() => kernel.replaceBallot(command({ operationId: "operation_demo_right" }), [IDS.songB], new Date("2030-01-01T12:01:00.000Z"))),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  });
});

test("migrations replay on empty and populated databases without losing state", async () => {
  await withKernel((_kernel, dbPath) => {
    _kernel.migrate();
    assert.equal(_kernel.count("schema_migrations") > 0, true);
    assert.equal(_kernel.count("communities"), 2);
    const reopened = new SqliteKernel(dbPath);
    try {
      reopened.migrate();
      assert.equal(reopened.count("communities"), 2);
    } finally {
      reopened.close();
    }
  });
});

import { communityId, guestParticipationId, canonicalSongId, eventSongDecisionVersionId, ballotId, proposalId, auditEventId, parseBallotState, parseEventState, parseProposalState } from "../../packages/contracts/src/index.ts";

for (const [prefix, parse] of [
  ["community", communityId], ["event", eventId], ["participation", guestParticipationId],
  ["song", canonicalSongId], ["decision", eventSongDecisionVersionId], ["ballot", ballotId],
  ["proposal", proposalId], ["audit", auditEventId],
] as const) {
  test(`${prefix} identifiers enforce length, alphabet, and type boundaries`, () => {
    assert.equal(parse(`${prefix}_abc`), `${prefix}_abc`);
    assert.equal(parse(`${prefix}_${"a".repeat(128)}`), `${prefix}_${"a".repeat(128)}`);
    for (const suffix of ["ab", "a".repeat(129), "Abc", "-abc", " abc", "abc ", "a/b", "a.b"]) {
      assert.throws(() => parse(`${prefix}_${suffix}`), ContractValidationError);
    }
    for (const value of [undefined, null, 42, "", "   "]) assert.throws(() => parse(value), ContractValidationError);
  });
}

test("record schemas reject nonobjects, blank names, invalid revisions, and nonarray rankings", () => {
  for (const parse of [parseCommunity, parseEvent, parseGuestParticipation, parseCanonicalSong, parseEventSongDecisionVersion, parseBallot, parseProposal, parseAuditEvent]) {
    for (const value of [null, [], "record", 1]) assert.throws(() => parse(value), /must be an object/);
  }
  assert.throws(() => parseCommunity({ id: IDS.community, name: " " }), /non-empty/);
  assert.throws(() => parseCanonicalSong({ id: IDS.songA, communityId: IDS.community, title: false }), /non-empty/);
  for (const revision of [0, -1, 1.5, "1", NaN]) {
    assert.throws(() => parseEventSongDecisionVersion({ id: "decision_synthetic", eventId: IDS.event, songId: IDS.songA, revision }), /revision must be positive/);
  }
  for (const rankings of [null, {}, "song_alpha", undefined]) assert.throws(() => parseBallot({ id: "ballot_synthetic", rankings }), /must be an array/);
  assert.deepEqual(parseBallot({ id: "ballot_synthetic", rankings: [] }), { id: "ballot_synthetic", rankings: [] });
});

test("lifecycle parsing and terminal-state guards reject unknown values and backward transitions", () => {
  for (const parse of [parseBallotState, parseEventState, parseProposalState]) {
    for (const value of [null, 1, "", "unknown"]) assert.throws(() => parse(value), ContractValidationError);
  }
  assert.equal(parseBallotState("reopened"), "reopened");
  assert.equal(parseProposalState("withdrawn"), "withdrawn");
  assert.equal(parseEventState("cancelled"), "cancelled");
  let ballot = transitionBallot("draft", "open");
  ballot = transitionBallot(ballot, "closed");
  ballot = transitionBallot(ballot, "reopened");
  ballot = transitionBallot(ballot, "closed");
  assert.equal(transitionBallot(ballot, "final"), "final");
  assert.throws(() => transitionBallot("unknown" as never, "open"), /invalid ballot transition/);
  assert.throws(() => transitionEvent("unknown" as never, "draft"), /invalid event transition/);
  assert.throws(() => transitionProposal("unknown" as never, "submitted"), /invalid proposal transition/);
  assert.throws(() => transitionEvent("archived", "published"), /invalid event transition/);
  assert.throws(() => transitionProposal("withdrawn", "submitted"), /invalid proposal transition/);
});

for (const [label, overrides, expected] of [
  ["unknown schema", { schemaVersion: 2 }, /schema version/],
  ["unknown scope", { scope: "global" }, /scope/],
  ["missing event", { eventId: undefined }, /require eventId/],
  ["fractional revision", { expectedRevision: 0.5 }, /non-negative/],
  ["string revision", { expectedRevision: "0" }, /non-negative/],
  ["invalid issuance", { issuedAt: "invalid" }, /expiry/],
  ["invalid expiry", { expiresAt: "invalid" }, /expiry/],
  ["equal dates", { expiresAt: "2030-01-01T12:00:00.000Z" }, /expiry/],
  ["excessive lifetime", { expiresAt: "2030-01-02T12:00:00.001Z" }, /maximum/],
] as const) {
  test(`command rejects ${label} before SQLite can write state`, async () => {
    await withKernel(kernel => {
      const invalid = command(overrides);
      assert.throws(() => parseCommandEnvelope(invalid), expected);
      assert.throws(() => kernel.replaceBallot(invalid, [IDS.songA], new Date("2030-01-01T12:01:00Z")), error => error instanceof Error && "code" in error && error.code === "invalid-command");
      for (const table of ["ballot_versions", "audit_events", "idempotency_receipts"]) assert.equal(kernel.count(table), 0);
    });
  });
}

test("community envelopes omit event scope and maximum command lifetime is inclusive", () => {
  const parsed = parseCommandEnvelope(command({ scope: "community", eventId: undefined, expiresAt: "2030-01-02T12:00:00.000Z" }));
  assert.equal(parsed.scope, "community");
  assert.equal(parsed.eventId, undefined);
  assert.equal(parsed.expiresAt, "2030-01-02T12:00:00.000Z");
  for (const field of ["aggregateType", "aggregateId", "actorId", "capability", "operationId", "issuedAt", "expiresAt"]) {
    assert.throws(() => parseCommandEnvelope(command({ [field]: " " })), /non-empty/);
  }
});

test("kernel accepts the issuance and expiry instants and rejects one millisecond outside", async () => {
  await withKernel(kernel => {
    assert.equal(kernel.latestBallotCreatedAt(), undefined);
    assert.throws(() => kernel.replaceBallot(command(), [IDS.songA], new Date("2030-01-01T11:59:59.999Z")), /not yet valid/);
    const first = kernel.replaceBallot(command(), [], new Date("2030-01-01T12:00:00.000Z"));
    assert.deepEqual(first, { method: "ranked-choice", revision: 1, rankings: [] });
    const second = command({ operationId: "operation_boundary_two", expectedRevision: 1 });
    assert.equal(kernel.replaceBallot(second, [IDS.songA], new Date("2030-01-01T12:10:00.000Z")).revision, 2);
    assert.throws(() => kernel.replaceBallot(command({ operationId: "operation_late", expectedRevision: 2 }), [IDS.songA], new Date("2030-01-01T12:10:00.001Z")), /expired/);
    assert.equal(kernel.latestBallotCreatedAt(), "2030-01-01T12:10:00.000Z");
    assert.deepEqual(kernel.invariantViolations(), []);
    assert.throws(() => kernel.count("ballots; DROP TABLE communities"), /unsupported count target/);
    assert.equal(kernel.count("communities"), 2);
  });
});

test("SQLite migration checksum failure preserves data and migration execution failure rolls back", async () => {
  await withKernel(kernel => {
    const row = kernel.database.prepare("SELECT name, checksum FROM schema_migrations ORDER BY name LIMIT 1").get() as { name: string; checksum: string };
    kernel.database.prepare("UPDATE schema_migrations SET checksum='wrong' WHERE name=?").run(row.name);
    assert.throws(() => kernel.migrate(), /checksum mismatch/);
    assert.equal(kernel.count("communities"), 2);
    kernel.database.prepare("UPDATE schema_migrations SET checksum=? WHERE name=?").run(row.checksum, row.name);
    kernel.migrate();
  });
  const kernel = new SqliteKernel();
  try {
    kernel.database.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
    kernel.database.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END");
    assert.throws(() => kernel.migrate(), /synthetic ledger failure/);
    assert.equal(kernel.count("schema_migrations"), 0);
    assert.equal(kernel.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='communities'").get(), undefined);
    kernel.database.exec("DROP TRIGGER fail_migration");
    kernel.migrate();
    kernel.seedSyntheticFirstLoop(IDS);
    assert.equal(kernel.replaceBallot(command(), [IDS.songA], new Date("2030-01-01T12:01:00Z")).revision, 1);
  } finally { kernel.close(); }
});


test("foundation verifier accepts the real synthetic fixture", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../tools/verify-foundation.mjs", import.meta.url))], { encoding: "utf8", timeout: 5_000 });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Foundation build verification passed/);
});

for (const [name, fixture] of [
  ["non-synthetic community", { communityId: "community_invalid", events: [{ visibility: "public" }], organizer: { email: "person@example.com" } }],
  ["non-public event", { communityId: "community_example_test", events: [{ visibility: "unlisted" }], organizer: { email: "person@example.com" } }],
  ["unexpected organizer", { communityId: "community_example_test", events: [{ visibility: "public" }], organizer: { email: "other@example.com" } }],
] as const) test(`foundation verifier rejects ${name}`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "woodshed-foundation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "test/fixtures/synthetic"), { recursive: true });
  await writeFile(path.join(directory, "test/fixtures/synthetic/community.json"), JSON.stringify(fixture));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../tools/verify-foundation.mjs", import.meta.url))], { cwd: directory, encoding: "utf8", timeout: 5_000 });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AssertionError/);
  assert.doesNotMatch(result.stdout, /verification passed/);
});
