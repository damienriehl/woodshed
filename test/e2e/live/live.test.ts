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
