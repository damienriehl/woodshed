import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import { CoordinationService } from "../../packages/application/src/coordination-service.ts";
import { emptyCoordinationSnapshot, type CoordinationMutation } from "../../packages/application/src/coordination-repository.ts";
import { SqliteCoordinationRepository } from "../../packages/storage-sqlite/src/coordination-repository.ts";
import { D1CoordinationRepository } from "../../packages/storage-d1/src/coordination-repository.ts";

const command=(operationId:string,expectedRevision=0)=>({communityId:"community_demo",eventId:"event_public",actorId:"organizer_a",roles:["organizer"],operationId,expectedRevision});
const input={songId:"song_alpha",key:"C",notes:"",rightsState:"cleared" as const,parts:[{id:"lead",name:"Lead",required:true}]};

test("SQLite coordination state and scoped receipts survive restart",()=>{
  const filename=path.join(mkdtempSync(path.join(tmpdir(),"woodshed-coordination-")),"db.sqlite");
  const firstDb=new DatabaseSync(filename);firstDb.exec(readFileSync(new URL("../../migrations/sqlite/006_coordination_repository.sql",import.meta.url),"utf8"));
  const first=new CoordinationService({repository:new SqliteCoordinationRepository(firstDb)});
  const created=first.createArrangement(command("create"),input);firstDb.close();
  const secondDb=new DatabaseSync(filename);const second=new CoordinationService({repository:new SqliteCoordinationRepository(secondDb)});
  assert.deepEqual(second.arrangement(created.id),created);
  assert.deepEqual(second.createArrangement(command("create"),input),created);
  assert.throws(()=>second.createArrangement(command("create"),{...input,key:"G"}),/replay-mismatch/);
  assert.equal((secondDb.prepare("SELECT count(*) count FROM coordination_audit_events").get() as {count:number}).count,1);
  secondDb.close();
});

test("SQLite provider callback deduplication survives restart atomically",()=>{
  const filename=path.join(mkdtempSync(path.join(tmpdir(),"woodshed-callback-")),"db.sqlite");
  const firstDb=new DatabaseSync(filename);firstDb.exec(readFileSync(new URL("../../migrations/sqlite/006_coordination_repository.sql",import.meta.url),"utf8"));
  const first=new CoordinationService({repository:new SqliteCoordinationRepository(firstDb)});
  first.connectProvider(command("connect-provider"),{connectionId:"calendar_restart",kind:"calendar",scopes:["free-busy:read"],retention:"delete-on-disconnect"});
  assert.equal(first.receiveProviderCallback("calendar_restart","callback_restart",{busy:["opaque"]}),"accepted");
  firstDb.close();
  const secondDb=new DatabaseSync(filename);const second=new CoordinationService({repository:new SqliteCoordinationRepository(secondDb)});
  assert.equal(second.receiveProviderCallback("calendar_restart","callback_restart",{busy:["opaque"]}),"duplicate");
  assert.throws(()=>second.receiveProviderCallback("calendar_restart","callback_restart",{busy:["changed"]}),/replay-mismatch/);
  assert.equal((secondDb.prepare("SELECT count(*) count FROM coordination_receipts WHERE operation_id='callback_restart'").get() as {count:number}).count,1);
  assert.equal((secondDb.prepare("SELECT count(*) count FROM coordination_audit_events WHERE capability='provider:callback'").get() as {count:number}).count,1);
  secondDb.close();
});

test("SQLite coordination repository rejects stale snapshot writers without partial audit or receipt",()=>{
  const db=new DatabaseSync(":memory:");db.exec(readFileSync(new URL("../../migrations/sqlite/006_coordination_repository.sql",import.meta.url),"utf8"));const first=new SqliteCoordinationRepository(db),second=new SqliteCoordinationRepository(db);const stale=second.load(),fresh=first.load();const mutation=(operationId:string):CoordinationMutation=>({scope:"community:event:actor",operationId,payloadHash:operationId,actorId:"actor",communityId:"community",eventId:"event",capability:"poll:create",result:{operationId}});first.commit(fresh,mutation("first"));assert.throws(()=>second.commit(stale,mutation("stale")),/storage conflict/);assert.equal((db.prepare("SELECT count(*) count FROM coordination_audit_events").get() as {count:number}).count,1);assert.equal((db.prepare("SELECT count(*) count FROM coordination_receipts").get() as {count:number}).count,1);db.close();
});

test("genuine D1 coordination repository atomically persists state, audit, and receipt",async()=>{
  const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["DB"]});
  try{const db=await mf.getD1Database("DB");await db.exec(readFileSync(new URL("../../migrations/d1/005_coordination_repository.sql",import.meta.url),"utf8"));const repository=new D1CoordinationRepository(db);const snapshot=emptyCoordinationSnapshot();snapshot.assignments.assignment_1={revision:1};const mutation:CoordinationMutation={scope:"community:event:actor",operationId:"op",payloadHash:"hash",actorId:"actor",communityId:"community",eventId:"event",capability:"assignment:volunteer",result:{revision:1}};await repository.commit(snapshot,mutation);assert.deepEqual((await repository.load()).assignments,snapshot.assignments);assert.deepEqual(await repository.receipt(mutation.scope,mutation.operationId),{payloadHash:"hash",result:{revision:1}});assert.equal((await db.prepare("SELECT count(*) count FROM coordination_audit_events").first<{count:number}>())?.count,1);}finally{await mf.dispose();}
});

function coverageMutation(operationId: string, scope = "community:event:actor"): CoordinationMutation {
  return { scope, operationId, payloadHash: `hash-${operationId}`, actorId: "actor", communityId: "community", eventId: "event", capability: "poll:create", result: { operationId } };
}

test("D1 coordination missing receipts, updates, stale writers and batch failures preserve committed state", async () => {
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB");
    await db.exec(readFileSync(new URL("../../migrations/d1/005_coordination_repository.sql", import.meta.url), "utf8"));
    const repository = new D1CoordinationRepository(db);
    assert.deepEqual(await repository.load(), emptyCoordinationSnapshot());
    assert.equal(await repository.receipt("missing", "missing"), undefined);
    const initial = await repository.load();
    initial.assignments.first = { revision: 1 };
    await repository.commit(initial, coverageMutation("first"));
    const stale = await repository.load();
    const next = await repository.load();
    next.assignments.first = { revision: 2 };
    await repository.commit(next, coverageMutation("second"));
    assert.equal(next.storageRevision, 2);
    const restarted = new D1CoordinationRepository(db);
    assert.deepEqual((await restarted.load()).assignments, { first: { revision: 2 } });
    assert.equal(await restarted.receipt("different-scope", "second"), undefined);
    assert.deepEqual(await restarted.receipt("community:event:actor", "second"), { payloadHash: "hash-second", result: { operationId: "second" } });
    await assert.rejects(repository.commit(stale, coverageMutation("stale")), /storage conflict/);
    assert.equal(stale.storageRevision, 1);
    assert.equal(await restarted.receipt("community:event:actor", "stale"), undefined);
    await assert.rejects(repository.commit(emptyCoordinationSnapshot(), coverageMutation("stale-initial")), /storage conflict/);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM coordination_audit_events").first<{ count: number }>())?.count, 2);
    await db.exec("CREATE TRIGGER fail_coordination_receipt BEFORE INSERT ON coordination_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    const failing = await repository.load();
    failing.assignments.first = { revision: 3 };
    await assert.rejects(repository.commit(failing, coverageMutation("failed")), /synthetic receipt failure/);
    assert.equal(failing.storageRevision, 2);
    assert.equal((await restarted.load()).storageRevision, 2);
    assert.deepEqual((await restarted.load()).assignments, { first: { revision: 2 } });
    assert.equal(await repository.receipt("community:event:actor", "failed"), undefined);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM coordination_audit_events").first<{ count: number }>())?.count, 2);
    await db.exec("DROP TRIGGER fail_coordination_receipt");
    await repository.commit(failing, coverageMutation("failed"));
    assert.equal((await restarted.load()).storageRevision, 3);
  } finally { await mf.dispose(); }
});

test("memory coordination repository isolates snapshots and rejects duplicate receipts before mutation", async () => {
  const { MemoryCoordinationRepository } = await import("../../packages/application/src/coordination-repository.ts");
  const repository = new MemoryCoordinationRepository();
  const service = new CoordinationService({ repository });
  const arrangement = service.createArrangement(command("memory-create"), input);
  const external = repository.load();
  external.arrangements[arrangement.id] = [];
  const receipt = repository.receipt("community_demo:event_public:organizer_a", "memory-create")!;
  (receipt.result as { key: string }).key = "changed";
  const restarted = new CoordinationService({ repository });
  assert.equal(restarted.arrangement(arrangement.id).key, "C");
  assert.equal(restarted.createArrangement(command("memory-create"), input).key, "C");
  const snapshot = repository.load();
  const revision = snapshot.storageRevision;
  assert.throws(() => repository.commit(snapshot, { ...coverageMutation("memory-create", "community_demo:event_public:organizer_a"), result: null }), /duplicate coordination receipt/);
  assert.equal(snapshot.storageRevision, revision);
  assert.equal(repository.load().storageRevision, revision);
});
