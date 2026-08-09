import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  ArchiveCoordinator, BoundedEncryptedArchiveBuffer, InMemoryArchiveRepository, MemoryKeyCustody,
  canonicalManifest, createCommunityArchive, openCommunityArchive,
  validateArchiveEntryName, type CommunityArchive,
} from "../../../packages/archive/src/index.ts";

const now = new Date("2026-08-09T12:00:00Z");
const keys = generateKeyPairSync("x25519");
const records = [
  { type:"community", id:"community_source", parentId:null, tombstone:false, consentScope:"community", attributes:{ name:"Example Circle" } },
  { type:"person", id:"person_one", parentId:"community_source", tombstone:false, consentScope:"event-only", attributes:{ displayName:"Example Member" } },
  { type:"event", id:"event_one", parentId:"community_source", tombstone:false, consentScope:"community", attributes:{ name:"Example Gathering" } },
] as const;

function archive(destinationCommunityId="community_destination",sourceCommunityId="community_source") {
  return createCommunityArchive({
    archiveId:"archive_one", sourceCommunityId, destinationCommunityId,
    createdAt:"2026-08-09T11:00:00Z", expiresAt:"2026-08-09T13:00:00Z", schemaVersion:1,
    records:[...records], assets:[{ id:"asset_one", sha256:"a".repeat(64), authorizedForExport:true }],
    audit:[{ sequence:1, previousHash:null, hash:"b".repeat(64) }],
  }, { recipientPublicKey:keys.publicKey, keyCustody:new MemoryKeyCustody(), now });
}

test("request lifecycle is audited, quota bounded, signed, revocable, and expires cryptographically", async () => {
  const repo = new InMemoryArchiveRepository();
  const coordinator = new ArchiveCoordinator(repo, { maxActivePerCommunity:1, maxArchiveBytes:200_000, downloadTtlMs:60_000 });
  const request = coordinator.request({ communityId:"community_source", actorId:"admin_one", capability:"archive:export", now });
  assert.equal(request.state,"requested");
  const prepared = coordinator.prepare(request.id, archive(), now);
  assert.equal(prepared.state,"prepared");
  assert.throws(()=>coordinator.request({ communityId:"community_source", actorId:"admin_two", capability:"archive:export", now }),/quota/i);
  const authorization = coordinator.authorizeDownload(request.id,"admin_one",now);
  assert.equal(coordinator.download(authorization,now).state,"downloaded");
  assert.throws(()=>coordinator.download(authorization,now),/unavailable/i);
  coordinator.revoke(request.id,"admin_one",now);
  assert.throws(()=>coordinator.download(authorization,now),/revoked/i);
  assert.equal(repo.audit.length >= 4,true);
  const expiring=coordinator.request({communityId:"community_source",actorId:"admin_one",capability:"archive:export",now});
  coordinator.prepare(expiring.id,archive(),now);coordinator.expire(new Date("2026-08-09T14:00:00Z"));
  assert.equal(repo.requests.get(expiring.id)?.state,"expired");
  assert.throws(()=>openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now:new Date("2026-08-09T14:00:00Z")}),/expired/i);
});

test("archive preparation and revocation remain scoped to the requesting community and actor",()=>{
  const repo=new InMemoryArchiveRepository();const coordinator=new ArchiveCoordinator(repo);
  const request=coordinator.request({communityId:"community_source",actorId:"admin_one",capability:"archive:export",now});
  assert.throws(()=>coordinator.prepare(request.id,archive("community_destination","community_other"),now),/community/i);
  coordinator.prepare(request.id,archive(),now);
  assert.throws(()=>coordinator.revoke(request.id,"admin_other",now),/denied/i);
});

test("encrypted archive rejects wrong destination/key, tamper and truncation", () => {
  const value=archive();
  const opened=openCommunityArchive(value,{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  assert.equal(opened.records.length,3);
  assert.throws(()=>openCommunityArchive(value,{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"other",now}),/destination/i);
  const other=generateKeyPairSync("x25519");
  assert.throws(()=>openCommunityArchive(value,{recipientPrivateKey:other.privateKey,expectedDestinationCommunityId:"community_destination",now}));
  assert.throws(()=>openCommunityArchive({...value,ciphertext:value.ciphertext.slice(0,-8)},{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now}));
  assert.throws(()=>openCommunityArchive({...value,payloadTag:"A".repeat(value.payloadTag.length)},{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now}));
  assert.throws(()=>openCommunityArchive({...value,recipientKeyId:"wrong"},{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now}),/recipient key/i);
});

test("archive preparation rejects malformed, future, expired, and overlong lifecycle metadata",()=>{
  const cases=[
    {...archive(),createdAt:"not-a-date"},
    {...archive(),createdAt:"2026-08-09T12:01:00Z"},
    {...archive(),expiresAt:"2026-08-09T11:59:00Z"},
    {...archive(),expiresAt:"2026-09-09T13:00:00Z"},
  ];
  for(const envelope of cases){const coordinator=new ArchiveCoordinator(new InMemoryArchiveRepository());const request=coordinator.request({communityId:"community_source",actorId:"admin_one",capability:"archive:export",now});assert.throws(()=>coordinator.prepare(request.id,envelope,now),/lifecycle/i)}
});

test("dry run defaults to new community and reports conflicts without state changes", () => {
  const repo=new InMemoryArchiveRepository();
  const coordinator=new ArchiveCoordinator(repo);
  const payload=openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  const report=coordinator.dryRunImport(payload,{destinationExists:true});
  assert.equal(report.allowed,false);
  assert.match(report.conflicts[0]??"",/merge policy/i);
  assert.equal(repo.active.size,0);
  const allowed=coordinator.dryRunImport(payload,{destinationExists:false});
  assert.equal(allowed.allowed,true);
});

test("staging is isolated, commit atomic, interrupted cleanup is reentrant", () => {
  const repo=new InMemoryArchiveRepository(); const coordinator=new ArchiveCoordinator(repo);
  const payload=openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  coordinator.stageImport(payload); assert.equal(repo.active.size,0);
  repo.failBeforePointer=true; assert.throws(()=>coordinator.commitImport(payload.archiveId),/interrupted/i); assert.equal(repo.active.size,0);
  assert.equal(coordinator.cleanupImport(payload.archiveId),true); assert.equal(coordinator.cleanupImport(payload.archiveId),false);
  coordinator.stageImport(payload); repo.failBeforePointer=false; coordinator.commitImport(payload.archiveId);
  assert.equal(repo.active.get("community_destination")?.archiveId,payload.archiveId);
});

test("canonical manifest is semantic and round-trips A to B to A", () => {
  const payload=openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  const first=canonicalManifest(payload);
  const back=createCommunityArchive({...payload,archiveId:"archive_back",sourceCommunityId:"community_destination",destinationCommunityId:"community_source"},{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now});
  const second=canonicalManifest(openCommunityArchive(back,{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_source",now}));
  assert.deepEqual(second,first);
  assert.deepEqual(first.counts,{community:1,event:1,person:1});
});

test("rejects future schema and hostile archive shapes before allocation", () => {
  const base={archiveId:"x",sourceCommunityId:"a",destinationCommunityId:"b",createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+1000).toISOString(),schemaVersion:2,records:[],assets:[],audit:[]};
  assert.throws(()=>createCommunityArchive(base as CommunityArchive,{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now}),/schema/i);
  for(const name of ["../secret","/absolute","folder\\escape","ok/../../bad","nul\0name"])
    assert.throws(()=>validateArchiveEntryName(name),/entry name/i);
  const cyclic={...base,schemaVersion:1,records:[{type:"person",id:"a",parentId:"b",tombstone:false,consentScope:"community",attributes:{}},{type:"person",id:"b",parentId:"a",tombstone:false,consentScope:"community",attributes:{}}]};
  assert.throws(()=>createCommunityArchive(cyclic as CommunityArchive,{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now}),/cycle/i);
  const escalated={...base,schemaVersion:1,records:[{type:"person",id:"a",parentId:null,tombstone:false,consentScope:"administrator",attributes:{}}]};
  assert.throws(()=>createCommunityArchive(escalated as CommunityArchive,{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now}),/consent/i);
  const malformed={...base,schemaVersion:1,records:[{type:"person",id:"a",parentId:null,tombstone:"no",consentScope:"community",attributes:null}]};
  assert.throws(()=>createCommunityArchive(malformed as unknown as CommunityArchive,{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now}),/record type/i);
});

test("encrypted input is collected incrementally with a fail-closed byte quota",()=>{
  const collector=new BoundedEncryptedArchiveBuffer(8);collector.push(Buffer.from("abcd"));collector.push(Buffer.from("efgh"));assert.equal(collector.finish().toString(),"abcdefgh");
  const oversized=new BoundedEncryptedArchiveBuffer(4);oversized.push(Buffer.from("1234"));assert.throws(()=>oversized.push(Buffer.from("5")),/size limit/i);assert.equal(oversized.finish().length,0);
});
