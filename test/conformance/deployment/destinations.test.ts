import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { D1ArchiveDestination, SqliteArchiveDestination } from "../../../packages/archive/src/destinations.ts";
import type { CommunityArchive } from "../../../packages/archive/src/index.ts";

test("Node/SQLite to genuine D1 and back preserves the canonical community",async()=>{
  const archive:CommunityArchive={archiveId:"archive_portable",sourceCommunityId:"community_a",destinationCommunityId:"community_b",schemaVersion:1,createdAt:"2026-08-09T11:00:00Z",expiresAt:"2026-08-10T11:00:00Z",records:[{type:"community",id:"community_record",parentId:null,tombstone:false,consentScope:"community",attributes:{name:"Example Circle"}}],assets:[],audit:[]};
  const sqlite=new SqliteArchiveDestination(); sqlite.migrate();sqlite.stage(archive);sqlite.commit(archive.archiveId,"community_b");
  const miniflare=new Miniflare({compatibilityDate:"2025-07-18",modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:"woodshed-archive-conformance"}});
  try{
    const d1=new D1ArchiveDestination(await miniflare.getD1Database("DB"));await d1.migrate();const fromA=sqlite.read("community_b")!;await d1.stage(fromA);await d1.commit(fromA.archiveId,"community_b");assert.deepEqual(await d1.manifest("community_b"),sqlite.manifest("community_b"));
    const returning={...(await d1.read("community_b"))!,archiveId:"archive_return",sourceCommunityId:"community_b",destinationCommunityId:"community_a"};sqlite.stage(returning);sqlite.commit(returning.archiveId,"community_a");assert.deepEqual(sqlite.manifest("community_a"),await d1.manifest("community_b"));
    assert.equal(await d1.cleanup("missing"),false);
  }finally{sqlite.close();await miniflare.dispose()}
});

test("destinations validate plaintext contracts and cannot commit under another community",async()=>{
  const valid:CommunityArchive={archiveId:"archive_scoped",sourceCommunityId:"community_a",destinationCommunityId:"community_b",schemaVersion:1,createdAt:"2026-08-09T11:00:00Z",expiresAt:"2026-08-10T11:00:00Z",records:[],assets:[],audit:[]};
  const sqlite=new SqliteArchiveDestination();sqlite.migrate();
  try{
    sqlite.stage(valid);
    assert.throws(()=>sqlite.commit(valid.archiveId,"community_other"),/destination/i);
    assert.throws(()=>sqlite.stage({...valid,archiveId:"bad",records:[{type:"person",id:"p",parentId:null,tombstone:false,consentScope:"administrator",attributes:{}}]}),/consent/i);
  }finally{sqlite.close()}
});
