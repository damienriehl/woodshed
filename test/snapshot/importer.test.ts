import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createEnvelope, openEnvelope } from "../../packages/importer/src/envelope.ts";
import { InMemorySnapshotStore, SnapshotImporter } from "../../packages/importer/src/index.ts";
import { deriveSyntheticFixture } from "../../packages/privacy-fixtures/src/index.ts";
import { parseNeutralSnapshot, sha256 } from "../../packages/contracts/src/snapshot.ts";

const now = new Date("2026-08-09T12:00:00Z");
const keys = generateKeyPairSync("x25519");
const destination = "community_destination";
const snapshot = (watermark = "0002") => {
  const records = [
    { type: "community", sourceId: "c1", parentSourceId: null, tombstone: false, attributes: { name: "Fixture Community" } },
    { type: "person", sourceId: "p1", parentSourceId: "c1", tombstone: false, attributes: { displayName: "Fixture Person", contact: ["fixture", "invalid"].join(".") } },
    { type: "household", sourceId: "h1", parentSourceId: "c1", tombstone: false, attributes: { memberSourceIds: ["p1"] } },
    { type: "person", sourceId: "p2", parentSourceId: "h1", tombstone: true, attributes: {} },
  ];
  return {
    schemaVersion: 1 as const, profile: "hootenanny/v1", mode: "full" as const,
    snapshotId: `snapshot_${watermark}`, sourceIdentity: "source_pseudonym", destinationCommunityId: destination,
    createdAt: "2026-08-09T11:00:00Z", expiresAt: "2026-08-10T11:00:00Z",
    startWatermark: watermark, endWatermark: watermark, records,
    counts: { community: 1, person: 2, household: 1 },
    recordHashes: Object.fromEntries(records.map((record) => [record.sourceId, sha256(record)])),
  };
};

test("encrypted snapshot imports atomically and duplicate is idempotent", async () => {
  const store = new InMemorySnapshotStore();
  const importer = new SnapshotImporter(store,()=>now);
  const envelope = createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
  const result = await importer.import(openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }));
  assert.equal(result.status, "committed");
  assert.equal((await importer.import(openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }))).status, "duplicate");
  assert.equal(store.active(destination)?.records.length, 4);
});

test("encrypted snapshot validates recipient identity and bounded base64 input",()=>{
  const envelope=createEnvelope(snapshot(),{recipientPublicKey:keys.publicKey,destinationCommunityId:destination,now});
  assert.throws(()=>openEnvelope({...envelope,recipientKeyId:"wrong"},{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:destination,now}),/recipient key/i);
  assert.throws(()=>openEnvelope({...envelope,ciphertext:"not base64!"},{recipientPrivateKey:keys.privateKey,expectedDestinationCommunityId:destination,now}),/ciphertext/i);
});

test("rejects tamper, wrong recipient/destination, expiry and truncation", () => {
  const envelope = createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
  const bad = structuredClone(envelope); bad.ciphertext = Buffer.from(randomBytes(8)).toString("base64");
  assert.throws(() => openEnvelope(bad, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }));
  const other = generateKeyPairSync("x25519");
  assert.throws(() => openEnvelope(envelope, { recipientPrivateKey: other.privateKey, expectedDestinationCommunityId: destination, now }));
  assert.throws(() => openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: "community_other", now }));
  assert.throws(() => openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now: new Date("2026-08-11") }));
  assert.throws(() => createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now: new Date("2026-08-11") }), /expired/i);
});

test("rejects older, unknown/delta, missing parents; crash is invisible and retryable", async () => {
  const store = new InMemorySnapshotStore(); const importer = new SnapshotImporter(store,()=>now);
  await importer.import(snapshot("0002"));
  await assert.rejects(importer.import(snapshot("0001")), /older/);
  await assert.rejects(importer.import({ ...snapshot("0003"), schemaVersion: 2 as 1 }), /schema/);
  await assert.rejects(importer.import({ ...snapshot("0003"), mode: "delta" as "full" }), /full/);
  const orphan = snapshot("0003"); orphan.records[1]!.parentSourceId = "missing";
  await assert.rejects(importer.import(orphan), /parent/);
  store.failBeforeCommit = true;
  await assert.rejects(importer.import(snapshot("0003")), /simulated/);
  assert.equal(store.active(destination)?.watermark, "0002");
  store.failBeforeCommit = false;
  assert.equal((await importer.import(snapshot("0003"))).status, "committed");
});

test("validates required hashes, unique IDs, dates, expiry, and numeric watermark ordering", async () => {
  const store = new InMemorySnapshotStore();
  const importer = new SnapshotImporter(store,()=>now);
  await importer.import(snapshot("2"), now);
  assert.equal((await importer.import(snapshot("10"), now)).status, "committed");

  const noHashes = { ...snapshot("11"), recordHashes: {} };
  await assert.rejects(importer.import(noHashes, now), /hash/i);
  const duplicate = snapshot("11"); duplicate.records[1]!.sourceId = duplicate.records[0]!.sourceId;
  await assert.rejects(importer.import(duplicate, now), /duplicate/i);
  await assert.rejects(importer.import({ ...snapshot("11"), createdAt: "not-a-date" }, now), /date/i);
  await assert.rejects(importer.import({ ...snapshot("11"), expiresAt: "2026-08-09T11:30:00Z" }, now), /expired/i);
});

test("synthetic derivation preserves household structure without values", () => {
  const fixture = deriveSyntheticFixture(snapshot());
  assert.deepEqual(fixture.records.map(r => [r.type, r.parentSourceId, r.tombstone]), [
    ["community", null, false], ["person", "synthetic_community_1", false],
    ["household", "synthetic_community_1", false], ["person", "synthetic_household_1", true],
  ]);
  assert.deepEqual(fixture.records.find(({ type }) => type === "household")?.attributes.memberSourceIds, ["synthetic_person_1"]);
  assert.doesNotMatch(JSON.stringify(fixture), new RegExp(["Fixture", "Person"].join(" ")));
});

test("expired staging and key material purge is re-entrant", () => {
  const store = new InMemorySnapshotStore();
  store.stage(snapshot(), now);
  store.stage({ ...snapshot("0003"), expiresAt: "2026-08-08T12:00:00Z" }, new Date("2026-08-01"));
  assert.equal(store.purgeExpired(now), 1);
  assert.equal(store.purgeExpired(now), 0);
});

test("checked-in household lifecycle fixture satisfies the neutral contract", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/hootenanny-shaped/household-lifecycle.json", import.meta.url), "utf8"));
  assert.equal(parseNeutralSnapshot(fixture).records.length, 5);
});

test("snapshot attributes have bounded depth and scalar size",()=>{
  const deep=snapshot();let value:Record<string,unknown>={};deep.records[0]!.attributes=value;for(let i=0;i<66;i++){const next:Record<string,unknown>={};value.next=next;value=next}deep.recordHashes=Object.fromEntries(deep.records.map(record=>[record.sourceId,sha256(record)]));
  assert.throws(()=>parseNeutralSnapshot(deep),/depth/i);
  const wide=snapshot();wide.records[0]!.attributes={value:"x".repeat(1024*1024+1)} as typeof wide.records[0]["attributes"];wide.recordHashes=Object.fromEntries(wide.records.map(record=>[record.sourceId,sha256(record)]));
  assert.throws(()=>parseNeutralSnapshot(wide),/string size/i);
});
