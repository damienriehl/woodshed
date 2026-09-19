import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { canonicalJson } from "../../../packages/contracts/src/snapshot.ts";
import {
  ArchiveCoordinator, BoundedEncryptedArchiveBuffer, InMemoryArchiveRepository, MemoryArchiveExportAuthorizer, MemoryKeyCustody,
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

const exportAuthorization=()=>new MemoryArchiveExportAuthorizer([{communityId:"community_source",actorId:"admin_one"}]);

test("request lifecycle is audited, quota bounded, signed, revocable, and expires cryptographically", async () => {
  const repo = new InMemoryArchiveRepository();
  const coordinator = new ArchiveCoordinator(repo, { maxActivePerCommunity:1, maxArchiveBytes:200_000, downloadTtlMs:60_000 },undefined,exportAuthorization());
  const request = coordinator.request({ communityId:"community_source", actorId:"admin_one", now });
  assert.equal(request.state,"requested");
  const prepared = coordinator.prepare(request.id, archive(), now);
  assert.equal(prepared.state,"prepared");
  assert.throws(()=>coordinator.request({ communityId:"community_source", actorId:"admin_two", now }),/denied/i);
  const authorization = coordinator.authorizeDownload(request.id,"admin_one",now);
  assert.equal(coordinator.download(authorization,now).state,"downloaded");
  assert.throws(()=>coordinator.download(authorization,now),/unavailable/i);
  coordinator.revoke(request.id,"admin_one",now);
  assert.throws(()=>coordinator.download(authorization,now),/revoked/i);
  assert.equal(repo.audit.length >= 4,true);
  const expiring=coordinator.request({communityId:"community_source",actorId:"admin_one",now});
  coordinator.prepare(expiring.id,archive(),now);coordinator.expire(new Date("2026-08-09T14:00:00Z"));
  assert.equal(repo.requests.get(expiring.id)?.state,"expired");
  assert.throws(()=>openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now:new Date("2026-08-09T14:00:00Z")}),/expired/i);
});

test("archive preparation and revocation remain scoped to the requesting community and actor",()=>{
  const repo=new InMemoryArchiveRepository();const coordinator=new ArchiveCoordinator(repo,undefined,undefined,exportAuthorization());
  const request=coordinator.request({communityId:"community_source",actorId:"admin_one",now});
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
  for(const envelope of cases){const coordinator=new ArchiveCoordinator(new InMemoryArchiveRepository(),undefined,undefined,exportAuthorization());const request=coordinator.request({communityId:"community_source",actorId:"admin_one",now});assert.throws(()=>coordinator.prepare(request.id,envelope,now),/lifecycle/i)}
});

test("archive export authorization is server-owned, scoped, and deny-by-default",()=>{
  const denied=new ArchiveCoordinator(new InMemoryArchiveRepository());
  assert.throws(()=>denied.request({communityId:"community_source",actorId:"admin_one",now}),/denied/i);
  const forged={communityId:"community_source",actorId:"admin_one",capability:"archive:export",now};
  assert.throws(()=>denied.request(forged),/denied/i);
  const authorized=new ArchiveCoordinator(new InMemoryArchiveRepository(),undefined,undefined,exportAuthorization());
  assert.throws(()=>authorized.request({communityId:"community_other",actorId:"admin_one",now}),/denied/i);
  assert.throws(()=>authorized.request({communityId:"community_source",actorId:"admin_two",now}),/denied/i);
  assert.equal(authorized.request({communityId:"community_source",actorId:"admin_one",now}).state,"requested");
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

test("export quota, invalid preparation and download failures preserve the pending request",()=>{
  const repo=new InMemoryArchiveRepository();
  const coordinator=new ArchiveCoordinator(repo,{maxActivePerCommunity:1,maxArchiveBytes:200_000,downloadTtlMs:60_000},undefined,exportAuthorization());
  const request=coordinator.request({communityId:"community_source",actorId:"admin_one",now});
  assert.throws(()=>coordinator.request({communityId:"community_source",actorId:"admin_one",now}),/quota/);
  assert.throws(()=>coordinator.prepare("missing",archive(),now),/not found/);
  assert.throws(()=>coordinator.authorizeDownload(request.id,"admin_one",now),/denied/);
  for(const envelope of [{...archive(),envelopeVersion:2},{...archive(),archiveId:""},{...archive(),recipientKeyId:""}])
    assert.throws(()=>coordinator.prepare(request.id,envelope as ReturnType<typeof archive>,now),/envelope|identity/);
  assert.equal(repo.requests.get(request.id)?.state,"requested");
  coordinator.prepare(request.id,archive(),now);
  assert.throws(()=>coordinator.prepare(request.id,archive(),now),/not requested/);
  assert.throws(()=>coordinator.authorizeDownload(request.id,"admin_two",now),/denied/);
  const auth=coordinator.authorizeDownload(request.id,"admin_one",now);
  for(const signature of ["short","0".repeat(64)]) assert.throws(()=>coordinator.download({...auth,signature},now),/invalid/);
  assert.throws(()=>coordinator.download({...auth,actorId:"admin_two"},now),/invalid/);
  assert.throws(()=>coordinator.download(auth,new Date(auth.expiresAt)),/expired/);
  assert.equal(repo.requests.get(request.id)?.state,"prepared");
  const downloaded=coordinator.download(auth,now);
  const payload=openCommunityArchive(downloaded.envelope!,{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  coordinator.stageImport(payload);coordinator.commitImport(payload.archiveId);
  assert.deepEqual(repo.active.get(payload.destinationCommunityId)?.manifest,canonicalManifest(payload));
  assert.deepEqual(repo.audit.map(event=>event.action),["requested","prepared","downloaded"]);
});

test("size rejection is retryable and download lifetime is capped by archive expiry",()=>{
  const repo=new InMemoryArchiveRepository();
  const coordinator=new ArchiveCoordinator(repo,{maxActivePerCommunity:2,maxArchiveBytes:1,downloadTtlMs:24*60*60_000},undefined,exportAuthorization());
  const request=coordinator.request({communityId:"community_source",actorId:"admin_one",now});
  assert.throws(()=>coordinator.prepare(request.id,archive(),now),/size quota/);
  assert.equal(repo.requests.get(request.id)?.state,"requested");
  const permitted=new ArchiveCoordinator(repo,{maxActivePerCommunity:2,maxArchiveBytes:200_000,downloadTtlMs:24*60*60_000},undefined,exportAuthorization());
  permitted.prepare(request.id,archive(),now);
  const auth=permitted.authorizeDownload(request.id,"admin_one",now);
  assert.equal(auth.expiresAt,Date.parse("2026-08-09T13:00:00Z"));
  permitted.revoke(request.id,"admin_one",now);permitted.expire(new Date(auth.expiresAt));
  assert.equal(repo.requests.get(request.id)?.state,"revoked");
  assert.equal(repo.requests.get(request.id)?.envelope,undefined);
});

test("plaintext validation rejects broken references, duplicate identities, assets, audit links and unsupported attributes",()=>{
  const base=openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  const cases:[Partial<CommunityArchive>,RegExp][]=[
    [{archiveId:""},/required/], [{createdAt:"invalid"},/dates/],
    [{records:[...base.records,base.records[0]!] },/duplicate/],
    [{records:[{...base.records[0]!,parentId:"missing"}]},/relationship/],
    [{assets:[{id:"asset",sha256:"invalid",authorizedForExport:true}]},/invalid asset/],
    [{assets:[{id:"asset",sha256:"a".repeat(64),authorizedForExport:false}]},/unauthorized/],
    [{assets:[null] as unknown as CommunityArchive["assets"]},/asset type/],
    [{audit:[...base.audit,{sequence:2,previousHash:"c".repeat(64),hash:"d".repeat(64)}]},/continuity/],
    [{records:[{...base.records[0]!,attributes:{unsupported:undefined}}]},/unsupported archive value/],
    [{records:null as unknown as CommunityArchive["records"]},/resource limit/],
  ];
  for(const [patch,message] of cases) assert.throws(()=>createCommunityArchive({...base,...patch},{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now}),message);
  let attributes:Record<string,unknown>={leaf:true};for(let i=0;i<66;i++)attributes={child:attributes};
  assert.throws(()=>createCommunityArchive({...base,records:[{...base.records[0]!,attributes}]},{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now}),/nesting depth/);
  const deepRecords=Array.from({length:66},(_,i)=>({...base.records[0]!,id:`record_${i}`,parentId:i===0?null:`record_${i-1}`}));
  assert.throws(()=>createCommunityArchive({...base,records:deepRecords},{recipientPublicKey:keys.publicKey,keyCustody:new MemoryKeyCustody(),now}),/relationship depth/);
});

test("encryption authenticates lifecycle and identity headers and destroys the data key",()=>{
  const payload=openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  const dataKey=Buffer.alloc(32,7),custody=new MemoryKeyCustody();
  const envelope=createCommunityArchive(payload,{recipientPublicKey:keys.publicKey,keyCustody:{generateDataKey:()=>dataKey,destroyDataKey:key=>custody.destroyDataKey(key)},now});
  assert.deepEqual(dataKey,Buffer.alloc(32));
  for(const patch of [{archiveId:"different"},{sourceCommunityId:"different"},{expiresAt:"2026-08-09T14:00:00Z"},{schemaVersion:2}])
    assert.throws(()=>openCommunityArchive({...envelope,...patch},{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now}));
  assert.throws(()=>openCommunityArchive({...envelope,envelopeVersion:2} as unknown as typeof envelope,{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now}),/unsupported archive envelope/);
});

test("import snapshots are isolated, duplicate staging is idempotent, and empty manifests are meaningful",()=>{
  const repo=new InMemoryArchiveRepository(),coordinator=new ArchiveCoordinator(repo);
  const payload=openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  payload.records.push({...payload.records[1]!,id:"deleted_person",tombstone:true});
  coordinator.stageImport(payload);payload.records.length=0;coordinator.stageImport(payload);
  assert.equal(repo.staged.get(payload.archiveId)?.records.length,4);
  coordinator.commitImport(payload.archiveId);
  assert.deepEqual(repo.active.get(payload.destinationCommunityId)?.manifest.tombstones,["deleted_person"]);
  assert.equal(coordinator.cleanupImport(payload.archiveId),false);
  assert.throws(()=>coordinator.commitImport(payload.archiveId),/not staged/);
  assert.equal(coordinator.dryRunImport(payload,{destinationExists:true,mergePolicy:"replace"}).allowed,true);
  assert.deepEqual(canonicalManifest({...payload,assets:[],audit:[]}),{counts:{},relationshipGraph:[],consentScopes:[],tombstones:[],auditHead:null,assetHashes:[]});
  const buffer=new BoundedEncryptedArchiveBuffer(4),chunk=Buffer.from("abcd");buffer.push(new Uint8Array());buffer.push(chunk);chunk.fill(0);
  assert.equal(buffer.finish().toString(),"abcd");assert.equal(buffer.finish().length,0);buffer.push(Buffer.from("x"));buffer.clear();assert.equal(buffer.finish().length,0);
});

test("invalid custody key is destroyed even when payload encryption fails",()=>{
  const payload=openCommunityArchive(archive(),{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:"community_destination",now});
  const invalidKey=Buffer.alloc(31,9),custody=new MemoryKeyCustody();let destroyed=false;
  assert.throws(()=>createCommunityArchive(payload,{recipientPublicKey:keys.publicKey,keyCustody:{generateDataKey:()=>invalidKey,destroyDataKey:key=>{destroyed=true;custody.destroyDataKey(key)}},now}),/key length/i);
  assert.equal(destroyed,true);assert.deepEqual(invalidKey,Buffer.alloc(31));
});


// Model a faulty exporter: encryption authenticates successfully, but the
// decrypted document still needs structural and envelope consistency checks.
function authenticatedArchivePayload(encode: (value: CommunityArchive) => string) {
  const value = openCommunityArchive(archive(), { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: "community_destination", now });
  let retainedKey: Buffer | undefined;
  const envelope = createCommunityArchive(value, {
    recipientPublicKey: keys.publicKey, now,
    keyCustody: {
      generateDataKey() { const key = randomBytes(32); retainedKey = Buffer.from(key); return key; },
      destroyDataKey(key) { key.fill(0); },
    },
  });
  try {
    const { envelopeVersion, profile, schemaVersion, archiveId, sourceCommunityId, destinationCommunityId, createdAt, expiresAt, recipientKeyId } = envelope;
    const payloadIv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", retainedKey!, payloadIv);
    cipher.setAAD(Buffer.from(canonicalJson({ envelopeVersion, profile, schemaVersion, archiveId, sourceCommunityId, destinationCommunityId, createdAt, expiresAt, recipientKeyId })));
    const ciphertext = Buffer.concat([cipher.update(encode(value), "utf8"), cipher.final()]);
    return { ...envelope, payloadIv: payloadIv.toString("base64"), ciphertext: ciphertext.toString("base64"), payloadTag: cipher.getAuthTag().toString("base64") };
  } finally { retainedKey?.fill(0); }
}

test("authenticated archive payload passes decryption, validation, staging and activation", () => {
  const envelope = authenticatedArchivePayload(value => canonicalJson({ ...value, records: [...value.records, { type: "event", id: "event_verified", parentId: "community_source", tombstone: false, consentScope: "community", attributes: { name: "Synthetic verified event" } }] }));
  const opened = openCommunityArchive(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: "community_destination", now });
  const repository = new InMemoryArchiveRepository();
  const coordinator = new ArchiveCoordinator(repository);
  coordinator.stageImport(opened);
  coordinator.commitImport(opened.archiveId);
  assert.equal(repository.active.get("community_destination")?.manifest.counts.event, 2);
});

for (const [field, replacement] of [
  ["archiveId", "archive_other"],
  ["sourceCommunityId", "community_other"],
  ["destinationCommunityId", "community_other"],
  ["createdAt", "2026-08-09T10:00:00Z"],
  ["expiresAt", "2026-08-09T14:00:00Z"],
] as const) test(`authenticated payload cannot disagree with envelope ${field}`, () => {
  const envelope = authenticatedArchivePayload(value => canonicalJson({ ...value, [field]: replacement }));
  assert.throws(() => openCommunityArchive(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: "community_destination", now }), /archive envelope payload metadata mismatch/);
});

for (const [name, encode, expected] of [
  ["malformed JSON", () => "{", SyntaxError],
  ["unsupported schema", (value: CommunityArchive) => canonicalJson({ ...value, schemaVersion: 2 }), /unsupported archive schema/],
  ["broken relationship", (value: CommunityArchive) => canonicalJson({ ...value, records: [{ ...value.records[0], parentId: "missing_parent" }] }), /missing archive relationship/],
] as const) test(`authenticated payload rejects ${name} after successful decryption`, () => {
  const envelope = authenticatedArchivePayload(encode);
  assert.throws(() => openCommunityArchive(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: "community_destination", now }), expected);
});
