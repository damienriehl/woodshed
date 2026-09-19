import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { transitionQueueEntry } from "../../../packages/domain/src/live.ts";
import { LivePerformanceService, LiveError, signLiveCommand, type LiveCommand } from "../../../packages/application/src/live-service.ts";
import { MemoryAuthorityCoordinator } from "../../../packages/application/src/live-coordinator.ts";
import { MemoryOfflineStore, OfflineOutbox } from "../../../packages/application/src/offline.ts";
import { SqliteAuthorityCoordinator } from "../../../packages/storage-sqlite/src/live-authority.ts";

const secret="test-device-credential";
function command(overrides:Partial<LiveCommand>={}):LiveCommand {
  const base={schemaVersion:1 as const,communityId:"community_demo",eventId:"event_demo",actorId:"person_host",deviceInstallationId:"device_stage",authorityEpoch:1,baseRevision:0,operationId:"operation_one",issuedAt:"2030-01-01T12:00:00.000Z",expiresAt:"2030-01-01T12:05:00.000Z",action:"queue" as const,entryId:"entry_song_one",payload:{songId:"song_one"}};
  return signLiveCommand({...base,...overrides},secret);
}
const now=()=>new Date("2030-01-01T12:01:00.000Z");
const communityForEvent=(eventId:string)=>eventId.startsWith("event_")?"community_demo":null;

describe("live queue contract",()=>{
  it("allows the complete legal performance lifecycle and rejects shortcuts",()=>{
    assert.equal(transitionQueueEntry("suggested","planned"),"planned");
    assert.equal(transitionQueueEntry("planned","queued"),"queued");
    assert.equal(transitionQueueEntry("queued","current"),"current");
    assert.equal(transitionQueueEntry("current","performed"),"performed");
    assert.equal(transitionQueueEntry("skipped","restored"),"restored");
    assert.throws(()=>transitionQueueEntry("performed","current"));
  });
});

describe("single-writer live authority",()=>{
  it("acquires one epoch and requires a server-confirmed handoff",()=>{
    const coordinator=new MemoryAuthorityCoordinator();
    assert.equal(coordinator.acquire("event_demo","device_stage").epoch,1);
    assert.throws(()=>coordinator.acquire("event_demo","device_other"));
    const pending=coordinator.requestHandoff("event_demo","device_stage","device_other");
    assert.equal(coordinator.confirmHandoff("event_demo",pending.token,"device_other").epoch,2);
    assert.equal(coordinator.current("event_demo")?.deviceInstallationId,"device_other");
  });
  it("can cancel a pending handoff, revoke a lost device, and recover after restart",()=>{
    const coordinator=new MemoryAuthorityCoordinator(); coordinator.acquire("event_demo","device_stage");
    const pending=coordinator.requestHandoff("event_demo","device_stage","device_other");
    coordinator.cancelHandoff("event_demo",pending.token,"device_stage");
    assert.equal(coordinator.current("event_demo")?.deviceInstallationId,"device_stage");
    const snapshot=coordinator.snapshot(); const restarted=MemoryAuthorityCoordinator.restore(snapshot);
    assert.equal(restarted.revokeAndRecover("event_demo","device_stage","device_recovery").epoch,2);
  });
  it("persists the confirmed single writer across a SQLite coordinator restart",()=>{const first=new SqliteAuthorityCoordinator();first.acquire("event_demo","device_stage");const reopened=first.restart();assert.equal(reopened.current("event_demo")?.deviceInstallationId,"device_stage");assert.equal(reopened.revokeAndRecover("event_demo","device_stage","device_recovery").epoch,2);reopened.close();});
});

describe("partition-safe live command replay",()=>{
  it("applies authenticated commands once with immutable history and an audit receipt",()=>{
    const coordinator=new MemoryAuthorityCoordinator(); coordinator.acquire("event_demo","device_stage");
    const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent});
    const queued=service.execute(command()); assert.equal(queued.status,"applied");
    assert.deepEqual(service.execute(command()),queued);
    const current=service.execute(command({operationId:"operation_two",baseRevision:1,action:"make-current",payload:{}}));
    const performed=service.execute(command({operationId:"operation_three",baseRevision:2,action:"perform",payload:{}}));
    assert.equal(current.entry.state,"current"); assert.equal(performed.entry.state,"performed");
    assert.equal(service.history("event_demo").length,1); assert.equal(service.audit("event_demo").length,3);
    assert.equal(Object.hasOwn(service.audit("event_demo")[0]??{},"payload"),false);
  });
  it("rejects altered, expired, cross-event, superseded-epoch, stale, and duplicate-perform commands",()=>{
    const coordinator=new MemoryAuthorityCoordinator(); coordinator.acquire("event_demo","device_stage");
    const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent}); service.execute(command());
    const cases:[string,LiveCommand][]=[
      ["authentication-failed",{...command({operationId:"altered"}),payload:{songId:"altered"}}],
      ["expired",command({operationId:"expired",issuedAt:"2029-12-31T11:00:00.000Z",expiresAt:"2029-12-31T11:05:00.000Z"})],
      ["scope-mismatch",command({operationId:"cross",eventId:"event_other"})],
      ["stale-revision",command({operationId:"stale",baseRevision:0})],
    ];
    for(const [code,value] of cases)assert.throws(()=>service.execute(value),(error:unknown)=>error instanceof LiveError&&error.code===code);
    const current=service.execute(command({operationId:"current",baseRevision:1,action:"make-current",payload:{}}));
    service.execute(command({operationId:"performed",baseRevision:2,action:"perform",payload:{}}));
    assert.throws(()=>service.execute(command({operationId:"performed_again",baseRevision:3,action:"perform",payload:{}})),/invalid-transition/);
    assert.equal(current.entry.state,"current");
  });
  it("demotes safe stale queue intent to an explicit suggestion without overwriting",()=>{
    const coordinator=new MemoryAuthorityCoordinator();coordinator.acquire("event_demo","device_stage");
    const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent});service.execute(command());
    const result=service.execute(command({operationId:"offline_two",baseRevision:0,entryId:"entry_song_two",payload:{songId:"song_two"}}));
    assert.equal(result.status,"suggested");assert.equal(result.entry.state,"suggested");
  });
  it("rejects the old organizer after a confirmed handoff and an event closed before replay",()=>{const coordinator=new MemoryAuthorityCoordinator();coordinator.acquire("event_demo","device_stage");const pending=coordinator.requestHandoff("event_demo","device_stage","device_other");coordinator.confirmHandoff("event_demo",pending.token,"device_other");const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent});assert.throws(()=>service.execute(command()),(error:unknown)=>error instanceof LiveError&&error.code==="superseded-authority");const closedCoordinator=new MemoryAuthorityCoordinator();closedCoordinator.acquire("event_demo","device_stage");const closed=new LivePerformanceService({coordinator:closedCoordinator,credentialFor:()=>secret,now,eventOpen:()=>false,communityForEvent});assert.throws(()=>closed.execute(command()),(error:unknown)=>error instanceof LiveError&&error.code==="event-closed");});
  it("bounds live command floods",()=>{const coordinator=new MemoryAuthorityCoordinator();coordinator.acquire("event_demo","device_stage");const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,maxOperationsPerEvent:1,communityForEvent});service.execute(command());assert.throws(()=>service.execute(command({operationId:"operation_two",baseRevision:1,entryId:"entry_two",payload:{songId:"song_two"}})),(error:unknown)=>error instanceof LiveError&&error.code==="rate-limited");});
  it("purges completed-event queue, receipt, audit, and history state",()=>{const coordinator=new MemoryAuthorityCoordinator();coordinator.acquire("event_demo","device_stage");const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent});service.execute(command());service.purgeEvent("event_demo");assert.deepEqual(service.history("event_demo"),[]);assert.deepEqual(service.audit("event_demo"),[]);assert.equal(service.execute(command()).revision,1);});
  it("scopes operation receipts per event and rejects malformed command times",()=>{
    const coordinator=new MemoryAuthorityCoordinator();coordinator.acquire("event_demo","device_stage");coordinator.acquire("event_other","device_stage");
    const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent});
    assert.equal(service.execute(command()).status,"applied");
    assert.equal(service.execute(command({eventId:"event_other",entryId:"entry_other",payload:{songId:"song_other"}})).status,"applied");
    assert.throws(()=>service.execute(command({operationId:"bad-time",issuedAt:"not-a-date",expiresAt:"also-not-a-date"})),(error:unknown)=>error instanceof LiveError&&error.code==="expired");
  });
  it("rejects unknown actions and cross-community new entries before mutation",()=>{
    const coordinator=new MemoryAuthorityCoordinator();coordinator.acquire("event_demo","device_stage");
    const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent});
    const unknownAction={...command(),action:"launch"};
    assert.throws(()=>service.execute(unknownAction),(error:unknown)=>error instanceof LiveError&&error.code==="invalid-command");
    const crossCommunity=command({communityId:"community_other",operationId:"cross-community",entryId:"new-entry"});
    assert.throws(()=>service.execute(crossCommunity),(error:unknown)=>error instanceof LiveError&&error.code==="scope-mismatch");
    assert.deepEqual(service.audit("event_demo"),[]);
  });
  it("runtime-validates numeric revisions, identifiers, payloads, and authentication",()=>{
    const coordinator=new MemoryAuthorityCoordinator();coordinator.acquire("event_demo","device_stage");
    const service=new LivePerformanceService({coordinator,credentialFor:()=>secret,now,communityForEvent});
    for(const malformed of [
      {...command(),baseRevision:NaN},
      {...command(),authorityEpoch:0},
      {...command(),entryId:""},
      {...command(),payload:[]},
      {...command(),authentication:"not-a-signature"},
    ]) assert.throws(()=>service.execute(malformed),error=>error instanceof LiveError);
    assert.deepEqual(service.audit("event_demo"),[]);
  });
});

describe("offline outbox and device safety",()=>{
  it("syncs on foreground triggers without Background Sync and surfaces every disposition",async()=>{
    const storage=new MemoryOfflineStore(); const outbox=new OfflineOutbox(storage,{maxOperations:2});
    await outbox.enqueue(command()); await outbox.enqueue(command({operationId:"operation_two",entryId:"entry_two",payload:{songId:"song_two"}}));
    await assert.rejects(()=>outbox.enqueue(command({operationId:"operation_three"})),/quota/);
    const statuses=await outbox.sync("manual",async item=>item.operationId==="operation_one"?"applied":"conflict");
    assert.deepEqual(statuses.map(item=>item.status),["applied","conflict"]);assert.equal(outbox.backgroundSyncRequired,false);
    assert.deepEqual(await outbox.sync("online",async()=>"applied"),[{operationId:"operation_two",status:"applied"}]);assert.deepEqual(await outbox.sync("focus",async()=>"applied"),[]);
  });
  it("coalesces concurrent syncs and keeps processing after a transport exception",async()=>{
    const storage=new MemoryOfflineStore(),outbox=new OfflineOutbox(storage);
    await outbox.enqueue(command());await outbox.enqueue(command({operationId:"operation_two",entryId:"entry_two",payload:{songId:"song_two"}}));
    let sends=0,release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    const first=outbox.sync("manual",async item=>{sends++;if(item.operationId==="operation_one"){await blocked;throw new Error("offline");}return "applied";});
    const second=outbox.sync("online",async()=>{throw new Error("must be coalesced");});
    release();
    assert.deepEqual(await first,[{operationId:"operation_one",status:"delayed"},{operationId:"operation_two",status:"applied"}]);
    assert.deepEqual(await second,await first);assert.equal(sends,2);
    assert.deepEqual((await storage.operations()).map(item=>item.operationId),["operation_one"]);
  });
  it("purges event data on close/revocation/expiry and all data on clear-this-device",async()=>{
    const storage=new MemoryOfflineStore();const outbox=new OfflineOutbox(storage);await outbox.enqueue(command());
    await storage.putCheckpoint("event_demo",{revision:4,authorityEpoch:1});await outbox.purgeEvent("event_demo","event-closed");
    assert.equal((await storage.operations()).length,0);assert.equal(await storage.checkpoint("event_demo"),null);
    await outbox.enqueue(command());await outbox.clearThisDevice();assert.equal((await storage.operations()).length,0);
  });
});

// These contracts run against both authority implementations, including their
// real consumer: signed queue commands across a confirmed ownership change.
for (const [name, create] of [
  ["memory", () => new MemoryAuthorityCoordinator()],
  ["SQLite", () => new SqliteAuthorityCoordinator()],
] as const) {
  describe(`${name} authority failure and recovery contracts`, () => {
    it("rejects absent leases and unauthorized handoffs without changing ownership", () => {
      const coordinator = create();
      try {
        assert.equal(coordinator.current("event_demo"), null);
        assert.throws(() => coordinator.requestHandoff("event_demo", "a", "b"), /handoff-denied/);
        assert.throws(() => coordinator.confirmHandoff("event_demo", "missing", "b"), /handoff-denied/);
        assert.throws(() => coordinator.cancelHandoff("event_demo", "missing", "a"), /handoff-denied/);
        assert.throws(() => coordinator.revokeAndRecover("event_demo", "a", "b"), /recovery-denied/);
        const lease = coordinator.acquire("event_demo", "a");
        lease.deviceInstallationId = "tampered";
        assert.equal(coordinator.current("event_demo")?.deviceInstallationId, "a");
        assert.throws(() => coordinator.acquire("event_demo", "b"), /authority-already-held/);
        assert.throws(() => coordinator.requestHandoff("event_demo", "b", "c"), /handoff-denied/);
        assert.throws(() => coordinator.requestHandoff("event_demo", "a", "a"), /handoff-denied/);
        assert.throws(() => coordinator.revokeAndRecover("event_demo", "b", "c"), /recovery-denied/);
        const pending = coordinator.requestHandoff("event_demo", "a", "b");
        assert.throws(() => coordinator.confirmHandoff("event_demo", "wrong", "b"), /handoff-denied/);
        assert.throws(() => coordinator.confirmHandoff("event_demo", pending.token, "c"), /handoff-denied/);
        assert.throws(() => coordinator.cancelHandoff("event_demo", "wrong", "a"), /handoff-denied/);
        assert.throws(() => coordinator.cancelHandoff("event_demo", pending.token, "b"), /handoff-denied/);
        assert.equal(coordinator.confirmHandoff("event_demo", pending.token, "b").epoch, 2);
        assert.throws(() => coordinator.confirmHandoff("event_demo", pending.token, "b"), /handoff-denied/);
      } finally { if (coordinator instanceof SqliteAuthorityCoordinator) coordinator.close(); }
    });

    it("invalidates replaced, cancelled, and recovered handoffs", () => {
      const coordinator = create();
      try {
        coordinator.acquire("event_demo", "a");
        const abandoned = coordinator.requestHandoff("event_demo", "a", "b");
        const replacement = coordinator.requestHandoff("event_demo", "a", "c");
        assert.throws(() => coordinator.confirmHandoff("event_demo", abandoned.token, "b"), /handoff-denied/);
        coordinator.cancelHandoff("event_demo", replacement.token, "a");
        assert.throws(() => coordinator.confirmHandoff("event_demo", replacement.token, "c"), /handoff-denied/);
        const pending = coordinator.requestHandoff("event_demo", "a", "b");
        assert.equal(coordinator.revokeAndRecover("event_demo", "a", "recovery").epoch, 2);
        assert.throws(() => coordinator.confirmHandoff("event_demo", pending.token, "b"), /handoff-denied/);
        assert.equal(coordinator.current("event_demo")?.deviceInstallationId, "recovery");
      } finally { if (coordinator instanceof SqliteAuthorityCoordinator) coordinator.close(); }
    });

    it("enforces the new writer in the real signing, authority, transition, and history chain", () => {
      const coordinator = create();
      try {
        coordinator.acquire("event_demo", "device_stage");
        const service = new LivePerformanceService({ coordinator, credentialFor: () => secret, now, communityForEvent });
        service.execute(command());
        const pending = coordinator.requestHandoff("event_demo", "device_stage", "device_backup");
        coordinator.confirmHandoff("event_demo", pending.token, "device_backup");
        assert.throws(() => service.execute(command({ operationId: "old", baseRevision: 1, action: "make-current" })), /superseded-authority/);
        const next = { deviceInstallationId: "device_backup", authorityEpoch: 2, payload: {} };
        assert.equal(service.execute(command({ ...next, operationId: "current", baseRevision: 1, action: "make-current" })).entry.state, "current");
        service.execute(command({ ...next, operationId: "performed", baseRevision: 2, action: "perform" }));
        assert.equal(service.history("event_demo")[0]?.authorityEpoch, 2);
        assert.equal(service.history("event_demo")[0]?.songId, "song_one");
        assert.equal(service.audit("event_demo").length, 3);
      } finally { if (coordinator instanceof SqliteAuthorityCoordinator) coordinator.close(); }
    });
  });
}

import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { D1LiveRuntime, deriveDeviceCredential } from "../../../packages/storage-d1/src/live-runtime.ts";
import { canonicalJson } from "../../../packages/contracts/src/snapshot.ts";
import { before, after } from "node:test";
import type { D1Database } from "@cloudflare/workers-types";

const liveMaster = "coverage-only-live-master";
const fixedLease = { eventId: "event_demo", deviceInstallationId: "device_stage", epoch: 1, revoked: false };
async function d1Command(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown> & { authentication: string }> {
  const unsigned: Record<string, unknown> = { ...command(), ...overrides };
  delete unsigned.authentication;
  const credential = await deriveDeviceCredential(liveMaster, String(unsigned.communityId), String(unsigned.eventId), String(unsigned.deviceInstallationId));
  return { ...unsigned, authentication: createHmac("sha256", credential).update(canonicalJson(unsigned)).digest("hex") };
}

// The Durable Object is bundled from production source and runs in workerd;
// D1 is Miniflare's real SQLite-backed binding, not a query-result stub.
describe("persisted live runtime boundary contracts", () => {
  let mf: Miniflare;
  let db: D1Database;
  let runtime: D1LiveRuntime;
  before(async () => {
    const bundle = await build({ stdin: { contents: `export { LiveCoordinator } from "./apps/api-worker/src/live-do.ts";
      import { DurableObjectAuthorityCoordinator } from "./packages/application/src/live-coordinator.ts";
      export class AuthorityStorageFixture {
        constructor(state) { this.storage = state.storage; this.coordinator = new DurableObjectAuthorityCoordinator(state.storage); }
        async fetch(request) {
          const body = await request.json();
          if (body.seed) { await this.storage.put(body.eventId, body.seed); return Response.json({seeded:true}); }
          try { return Response.json(await this.coordinator.acquire(body.eventId, body.device)); }
          catch (error) { return Response.json({error:error.message}, {status:409}); }
        }
      }
      export default { fetch() { return new Response("ready"); } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"] });
    mf = new Miniflare({ compatibilityDate: "2025-07-18", compatibilityFlags: ["nodejs_compat"], modules: true, script: bundle.outputFiles[0]!.text, d1Databases: { DB: "live-coverage" }, durableObjects: { LIVE: "LiveCoordinator", AUTHORITY_STORAGE: "AuthorityStorageFixture" } });
    db = await mf.getD1Database("DB");
    for (const name of ["001_first_loop.sql", "002_participant_choice.sql", "003_rehearsal_coordination.sql", "004_live_performance.sql", "005_coordination_repository.sql", "006_worker_runtime.sql"]) {
      await db.exec(await readFile(new URL(`../../../migrations/d1/${name}`, import.meta.url), "utf8"));
    }
    await db.exec("INSERT INTO communities(id,name) VALUES ('community_demo','Demo'),('community_other','Other')");
    await db.exec("INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES ('event_demo','community_demo','Live','live','public','open'),('event_other','community_demo','Other','live','public','open')");
    await db.exec("INSERT INTO canonical_songs(id,community_id,title) VALUES ('song_one','community_demo','One'),('song_two','community_demo','Two')");
    await db.exec("INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES ('event_demo','song_one','2030-01-01'),('event_other','song_one','2030-01-01')");
    runtime = new D1LiveRuntime(db, liveMaster, now);
  });
  after(async () => { await mf?.dispose(); });

  it("returns empty state/history and denies missing or cross-community reads", async () => {
    assert.deepEqual(await runtime.state("event_demo", "community_demo"), { revision: 0, entries: [] });
    assert.deepEqual(await runtime.history("event_demo", "community_demo"), { performances: [] });
    for (const [event, community] of [["missing", "community_demo"], ["event_demo", "community_other"]]) {
      await assert.rejects(() => runtime.state(event!, community!), /denied/);
      await assert.rejects(() => runtime.history(event!, community!), /denied/);
    }
  });

  for (const [label, overrides, expected] of [
    ["missing identifier", { actorId: "" }, "invalid-command"],
    ["unsupported schema", { schemaVersion: 2 }, "invalid-command"],
    ["negative revision", { baseRevision: -1 }, "invalid-command"],
    ["fractional epoch", { authorityEpoch: 1.5 }, "invalid-command"],
    ["unknown action", { action: "launch" }, "invalid-command"],
    ["array payload", { payload: [] }, "invalid-command"],
    ["missing song", { payload: {} }, "invalid-payload"],
    ["ineligible song", { payload: { songId: "song_two" } }, "invalid-payload"],
    ["missing event", { eventId: "missing" }, "scope-mismatch"],
    ["cross community", { communityId: "community_other" }, "scope-mismatch"],
    ["future timestamp", { issuedAt: "2030-01-01T12:01:31.000Z" }, "expired"],
    ["equal timestamps", { expiresAt: "2030-01-01T12:00:00.000Z" }, "expired"],
    ["invalid timestamp", { issuedAt: "invalid" }, "expired"],
    ["elapsed expiry", { expiresAt: "2030-01-01T12:00:59.000Z" }, "expired"],
  ] as const) {
    it(`rejects ${label} without writing a receipt or revision`, async () => {
      const value = await d1Command(overrides);
      await assert.rejects(() => runtime.execute(value, fixedLease), new RegExp(expected));
      assert.deepEqual(await runtime.state("event_demo", "community_demo"), { revision: 0, entries: [] });
      assert.equal((await db.prepare("SELECT count(*) AS count FROM live_operation_receipts").first<{count:number}>())?.count, 0);
    });
  }

  it("rejects authentication of wrong length and wrong content before mutation", async () => {
    for (const authentication of ["short", "0".repeat(64)]) {
      await assert.rejects(() => runtime.execute({ ...command(), authentication }, fixedLease), /authentication-failed/);
    }
  });

  it("rejects every superseded lease identity and closed events", async () => {
    const value = await d1Command();
    for (const lease of [{ ...fixedLease, revoked: true }, { ...fixedLease, eventId: "event_other" }, { ...fixedLease, epoch: 2 }, { ...fixedLease, deviceInstallationId: "other" }]) {
      await assert.rejects(() => runtime.execute(value, lease), /superseded-authority/);
    }
    await db.exec("UPDATE events SET state='completed' WHERE id='event_demo'");
    try { await assert.rejects(() => runtime.execute(value, fixedLease), /event-closed/); }
    finally { await db.exec("UPDATE events SET state='live' WHERE id='event_demo'"); }
  });

  it("rolls back the real D1 batch if an audit write fails", async () => {
    await db.exec("CREATE TRIGGER reject_live_audit BEFORE INSERT ON live_audit_events BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END");
    try {
      const value = await d1Command();
      await assert.rejects(() => runtime.execute(value, fixedLease), /test audit unavailable/);
    } finally { await db.exec("DROP TRIGGER reject_live_audit"); }
    assert.deepEqual(await runtime.state("event_demo", "community_demo"), { revision: 0, entries: [] });
    assert.equal((await db.prepare("SELECT count(*) AS count FROM live_operation_receipts").first<{count:number}>())?.count, 0);
  });

  it("persists every lifecycle action, immutable performance history, replay checks, and event isolation", async () => {
    const actions = ["suggest", "plan", "queue", "skip", "restore", "defer", "restore", "make-current", "perform"];
    for (let index = 0; index < actions.length; index++) {
      const value = await d1Command({ operationId: `lifecycle_${index}`, baseRevision: index, action: actions[index], payload: index ? {} : { songId: "song_one" } });
      const result = await runtime.execute(value, fixedLease);
      assert.equal(result.revision, index + 1);
      assert.equal(result.entry.revision, index + 1);
      assert.equal(result.entry.audienceVisible, !["plan", "defer"].includes(actions[index]!));
      assert.equal(result.entry.songId, "song_one");
      assert.deepEqual(await runtime.execute(value, fixedLease), result);
      await assert.rejects(() => runtime.execute({ ...value, authentication: "0".repeat(64) }, fixedLease), /authentication-failed/);
    }
    const history = await runtime.history("event_demo", "community_demo");
    assert.equal(history.performances.length, 1);
    assert.equal(history.performances[0]?.revision, 9);
    assert.equal(history.performances[0]?.authorityEpoch, 1);
    const persisted = new D1LiveRuntime(db, liveMaster, now);
    assert.deepEqual(await persisted.history("event_demo", "community_demo"), history);
    assert.equal(((await persisted.state("event_demo", "community_demo")).entries[0] as Record<string, unknown>)?.state, "performed");
    for (const [overrides, error] of [
      [{ operationId: "lifecycle_0", action: "queue" }, "replay-mismatch"],
      [{ operationId: "stale", baseRevision: 0, action: "perform" }, "stale-revision"],
      [{ operationId: "duplicate_perform", baseRevision: 9, action: "perform" }, "invalid-transition"],
      [{ operationId: "cross_entry", eventId: "event_other" }, "scope-mismatch"],
    ] as const) {
      const value = await d1Command(overrides);
      await assert.rejects(() => runtime.execute(value, { ...fixedLease, eventId: String(value.eventId) }), new RegExp(error));
    }
    assert.deepEqual(await runtime.history("event_other", "community_demo"), { performances: [] });
  });

  it("acquires durable authority transactionally and restores revoked epochs in real DO storage", async () => {
    const namespace = await mf.getDurableObjectNamespace("AUTHORITY_STORAGE");
    const stub = namespace.get(namespace.idFromName("durable-acquire"));
    const acquire = (body: Record<string, unknown>) => stub.fetch("https://authority.test/", { method: "POST", body: JSON.stringify(body) });
    assert.equal((await (await acquire({ eventId: "event_demo", device: "first" })).json() as {epoch:number}).epoch, 1);
    assert.deepEqual(await (await acquire({ eventId: "event_demo", device: "second" })).json(), {error:"authority-already-held"});
    await acquire({ eventId: "event_demo", seed: { ...fixedLease, epoch: 9, revoked: true } });
    const renewed = await (await acquire({ eventId: "event_demo", device: "recovery" })).json() as {epoch:number;deviceInstallationId:string};
    assert.equal(renewed.epoch, 10);
    assert.equal(renewed.deviceInstallationId, "recovery");
    assert.equal((await (await acquire({ eventId: "event_other", device: "first" })).json() as {epoch:number}).epoch, 1);
  });

  it("exercises authority HTTP routing and a real persisted DO handoff into D1", async () => {
    const namespace = await mf.getDurableObjectNamespace("LIVE");
    const stub = namespace.get(namespace.idFromName("event_other"));
    async function request(path: string, body?: Record<string, unknown>) {
      return stub.fetch(`https://authority.test${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
    }
    assert.deepEqual(await (await request("/health")).json(), { status: "healthy", coordinator: "durable-object" });
    assert.equal(await (await request("/authority/current")).json(), null);
    assert.equal((await request("/missing")).status, 404);
    assert.equal((await request("/authority/acquire", {})).status, 400);
    const eventId = "event_other";
    const first = await request("/authority/acquire", { eventId, deviceInstallationId: "device_stage" });
    assert.equal(first.status, 200);
    assert.equal((await request("/authority/acquire", { eventId, deviceInstallationId: "other" })).status, 409);
    for (const body of [{ eventId: "wrong", fromDeviceInstallationId: "device_stage", toDeviceInstallationId: "next" }, { eventId, fromDeviceInstallationId: "wrong", toDeviceInstallationId: "next" }, { eventId, fromDeviceInstallationId: "device_stage", toDeviceInstallationId: "device_stage" }, { eventId, fromDeviceInstallationId: "device_stage" }]) {
      assert.equal((await request("/authority/handoffs", body)).status, 403);
    }
    const handoff = await (await request("/authority/handoffs", { eventId, fromDeviceInstallationId: "device_stage", toDeviceInstallationId: "next" })).json() as { token: string };
    for (const body of [{ eventId: "wrong", token: handoff.token, deviceInstallationId: "next" }, { eventId, token: "wrong", deviceInstallationId: "next" }, { eventId, token: handoff.token, deviceInstallationId: "wrong" }]) {
      assert.equal((await request("/authority/handoffs/confirm", body)).status, 403);
    }
    assert.equal((await request("/authority/handoffs/cancel", { eventId, token: handoff.token, deviceInstallationId: "next" })).status, 403);
    assert.equal((await request("/authority/handoffs/cancel", { eventId, token: handoff.token, deviceInstallationId: "device_stage" })).status, 200);
    assert.equal((await request("/authority/handoffs/confirm", { eventId, token: handoff.token, deviceInstallationId: "next" })).status, 403);
    const pending = await (await request("/authority/handoffs", { eventId, fromDeviceInstallationId: "device_stage", toDeviceInstallationId: "next" })).json() as { token: string };
    const confirmed = await request("/authority/handoffs/confirm", { eventId, token: pending.token, deviceInstallationId: "next" });
    const lease = await confirmed.json() as typeof fixedLease;
    assert.equal(lease.epoch, 2);
    const value = await d1Command({ eventId, deviceInstallationId: "next", authorityEpoch: 2, entryId: "entry_other", operationId: "other_queued" });
    assert.equal((await runtime.execute(value, lease)).entry.state, "queued");
    for (const body of [{ eventId, lostDeviceInstallationId: "wrong", recoveryDeviceInstallationId: "recovery" }, { eventId, lostDeviceInstallationId: "next", recoveryDeviceInstallationId: "next" }, { eventId, lostDeviceInstallationId: "next" }]) {
      assert.equal((await request("/authority/revoke-recover", body)).status, 403);
    }
    const recovered = await (await request("/authority/revoke-recover", { eventId, lostDeviceInstallationId: "next", recoveryDeviceInstallationId: "recovery" })).json() as typeof fixedLease;
    assert.equal(recovered.epoch, 3);
    await assert.rejects(() => runtime.execute(value, recovered), /superseded-authority/);
    const reopened = namespace.get(namespace.idFromName("event_other"));
    assert.deepEqual(await (await reopened.fetch("https://authority.test/authority/current")).json(), recovered);
  });
});

import { suggestedNext, type QueueEntry } from "../../../packages/domain/src/live.ts";

describe("live caller and empty-state coverage", () => {
  it("reacquires revoked authority with monotonically increasing epochs after restoration", () => {
    const memory = MemoryAuthorityCoordinator.restore({ leases: [["event_demo", { ...fixedLease, epoch: 7, revoked: true, confirmedAt: now().toISOString() }]], pending: [] });
    assert.equal(memory.current("event_demo"), null);
    assert.throws(() => memory.requestHandoff("event_demo", "device_stage", "next"), /handoff-denied/);
    assert.equal(memory.acquire("event_demo", "next").epoch, 8);
    const sqlite = new SqliteAuthorityCoordinator();
    try {
      sqlite.acquire("event_demo", "device_stage");
      sqlite.database.exec("UPDATE live_authority SET revoked=1,epoch=7 WHERE event_id='event_demo'");
      assert.equal(sqlite.current("event_demo"), null);
      assert.equal(sqlite.restart().acquire("event_demo", "next").epoch, 8);
    } finally { sqlite.close(); }
  });

  it("rejects revoked credentials, malformed envelopes, invalid payloads, and changed replays", () => {
    const coordinator = new MemoryAuthorityCoordinator();
    coordinator.acquire("event_demo", "device_stage");
    const service = new LivePerformanceService({ coordinator, credentialFor: () => secret, now, communityForEvent });
    for (const value of [null, [], false, { ...command(), issuedAt: 42 }, { ...command(), expiresAt: null }]) {
      assert.throws(() => service.execute(value), /invalid-command/);
    }
    assert.throws(() => service.execute({ ...command(), schemaVersion: 2 }), /unsupported-schema/);
    assert.throws(() => service.execute(command({ payload: {} })), /invalid-payload/);
    assert.throws(() => service.execute(command({ issuedAt: "2030-01-01T12:01:31.000Z" })), /expired/);
    assert.throws(() => service.execute(command({ expiresAt: "2030-01-01T12:00:00.000Z" })), /expired/);
    const revoked = new LivePerformanceService({ coordinator, credentialFor: () => null, now, communityForEvent });
    assert.throws(() => revoked.execute(command()), /device-revoked/);
    assert.deepEqual(service.audit("event_demo"), []);
    assert.equal(service.execute(command()).revision, 1);
    assert.throws(() => service.execute(command({ payload: { songId: "changed" } })), /replay-mismatch/);
    coordinator.acquire("event_other", "device_stage");
    assert.throws(() => service.execute(command({ eventId: "event_other", operationId: "other" })), /scope-mismatch/);
  });

  it("purges one event while retaining another event's audit, history, and receipts", () => {
    const coordinator = new MemoryAuthorityCoordinator();
    const service = new LivePerformanceService({ coordinator, credentialFor: () => secret, now, communityForEvent });
    for (const eventId of ["event_demo", "event_other"]) {
      coordinator.acquire(eventId, "device_stage");
      for (const [baseRevision, action] of [[0, "queue"], [1, "make-current"], [2, "perform"]] as const) {
        service.execute(command({ eventId, entryId: `${eventId}_entry`, operationId: `${eventId}_${action}`, baseRevision, action }));
      }
    }
    const retainedHistory = service.history("event_other"), retainedAudit = service.audit("event_other");
    const copy = service.history("event_other");
    copy[0]!.songId = "tampered";
    service.audit("event_other")[0]!.action = "tampered";
    service.purgeEvent("event_demo");
    assert.deepEqual(service.history("event_demo"), []);
    assert.deepEqual(service.audit("event_demo"), []);
    assert.deepEqual(service.history("event_other"), retainedHistory);
    assert.deepEqual(service.audit("event_other"), retainedAudit);
    assert.equal(service.execute(command({ eventId: "event_other", entryId: "event_other_entry", operationId: "event_other_perform", baseRevision: 2, action: "perform" })).revision, 3);
  });

  it("chooses the earliest queue/restored entry deterministically without mutating input", () => {
    const coordinator = new MemoryAuthorityCoordinator();
    coordinator.acquire("event_demo", "device_stage");
    const service = new LivePerformanceService({ coordinator, credentialFor: () => secret, now, communityForEvent });
    const entries: QueueEntry[] = [];
    for (const [index, entryId] of ["z", "a", "m"].entries()) {
      entries.push(service.execute(command({ entryId, operationId: entryId, baseRevision: index })).entry);
    }
    assert.equal(suggestedNext(entries)?.id, "a");
    assert.deepEqual(entries.map(entry => entry.id), ["z", "a", "m"]);
    assert.equal(suggestedNext([{ ...entries[0]!, state: "restored", createdAt: "2029-01-01" }, ...entries])?.id, "z");
    assert.equal(suggestedNext(entries.map(entry => ({ ...entry, state: "performed" }))), null);
    assert.equal(suggestedNext([]), null);
  });

  it("replays a real offline queue through authority, signing, receipts, and terminal rejection", async () => {
    const coordinator = new MemoryAuthorityCoordinator();
    coordinator.acquire("event_demo", "device_stage");
    const service = new LivePerformanceService({ coordinator, credentialFor: () => secret, now, communityForEvent });
    const storage = new MemoryOfflineStore(), outbox = new OfflineOutbox(storage);
    await assert.rejects(() => outbox.enqueue(command({ deviceInstallationId: "" })), /offline-elevation-denied/);
    await assert.rejects(() => outbox.enqueue(command({ authorityEpoch: 0 })), /offline-elevation-denied/);
    await outbox.enqueue(command());
    await outbox.enqueue(command({ operationId: "tampered", authentication: "0".repeat(64) }));
    const results = await outbox.sync("startup", async value => {
      try { service.execute(value); return "applied"; } catch { return "rejected"; }
    });
    assert.deepEqual(results, [{ operationId: "operation_one", status: "applied" }, { operationId: "tampered", status: "rejected" }]);
    assert.equal(service.audit("event_demo").length, 1);
    assert.deepEqual(await storage.operations(), []);
    assert.deepEqual(await outbox.sync("startup", async () => { throw new Error("empty outbox must not send"); }), []);
  });

  it("isolates stored commands and checkpoints and preserves another event during purge", async () => {
    const storage = new MemoryOfflineStore();
    const original = command();
    await storage.putOperation(original);
    (original.payload as Record<string, unknown>).songId = "mutated";
    const read = await storage.operations();
    assert.equal(read[0]?.payload.songId, "song_one");
    (read[0]!.payload as Record<string, unknown>).songId = "also mutated";
    assert.equal((await storage.operations())[0]?.payload.songId, "song_one");
    const checkpoint = { revision: 3, authorityEpoch: 2 };
    await storage.putCheckpoint("event_demo", checkpoint);
    checkpoint.revision = 99;
    const checkpointCopy = (await storage.checkpoint("event_demo"))!;
    assert.equal(checkpointCopy.revision, 3);
    checkpointCopy.revision = 100;
    assert.equal((await storage.checkpoint("event_demo"))?.revision, 3);
    await storage.putOperation(command({ eventId: "event_other", operationId: "other" }));
    await storage.putCheckpoint("event_other", { revision: 5, authorityEpoch: 1 });
    await storage.purgeEvent("event_demo");
    assert.deepEqual((await storage.operations()).map(value => value.eventId), ["event_other"]);
    assert.equal(await storage.checkpoint("event_demo"), null);
    assert.equal((await storage.checkpoint("event_other"))?.revision, 5);
    await storage.clear();
    assert.deepEqual(await storage.operations(), []);
    assert.equal(await storage.checkpoint("event_other"), null);
  });
});
