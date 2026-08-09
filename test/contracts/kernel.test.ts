import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    kernel.database.prepare("INSERT INTO ballots(id, community_id, event_id, participation_id, current_revision) VALUES (?, ?, ?, ?, 1)").run("ballot_demo_orphan", IDS.community, IDS.event, "participation_demo_second");
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
