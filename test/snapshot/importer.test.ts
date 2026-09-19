import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createEnvelope, openEnvelope } from "../../packages/importer/src/envelope.ts";
import { InMemorySnapshotStore, SnapshotImporter } from "../../packages/importer/src/index.ts";
import { deriveSyntheticFixture } from "../../packages/privacy-fixtures/src/index.ts";
import { canonicalJson, parseNeutralSnapshot, sha256 } from "../../packages/contracts/src/snapshot.ts";

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

// Boundary cases use fresh snapshots so a rejection cannot contaminate later imports.
const rebuildHashes = (value: ReturnType<typeof snapshot>) => {
  value.counts = Object.fromEntries([...new Set(value.records.map(record => record.type))].map(type => [type, value.records.filter(record => record.type === type).length])) as typeof value.counts;
  value.recordHashes = Object.fromEntries(value.records.map(record => [record.sourceId, sha256(record)]));
  return value;
};

for (const value of [null, undefined, [], "snapshot", 1]) {
  test(`snapshot rejects non-object input ${String(value)}`, () => {
    assert.throws(() => parseNeutralSnapshot(value), /must be an object/);
  });
}
for (const field of ["snapshotId", "sourceIdentity", "destinationCommunityId", "createdAt", "expiresAt", "startWatermark", "endWatermark"]) {
  test(`snapshot requires a nonempty string ${field}`, () => {
    for (const value of [undefined, "", 7]) assert.throws(() => parseNeutralSnapshot({ ...snapshot(), [field]: value }), new RegExp(`${field} is required`));
  });
}
for (const [name, override, expected] of [
  ["unknown profile", { profile: "unknown/v1" }, /profile/],
  ["equal dates", { expiresAt: "2026-08-09T11:00:00Z" }, /dates/],
  ["reversed dates", { expiresAt: "2026-08-08T11:00:00Z" }, /dates/],
  ["invalid expiration", { expiresAt: "invalid" }, /dates/],
  ["signed watermark", { startWatermark: "-1", endWatermark: "-1" }, /numeric sequence/],
  ["fractional watermark", { startWatermark: "1.5", endWatermark: "1.5" }, /numeric sequence/],
  ["inconsistent watermark", { startWatermark: "1", endWatermark: "2" }, /consistent source/],
  ["non-array records", { records: {} }, /records must be an array/],
  ["too many records", { records: Array(100_001).fill(null) }, /record limit/],
  ["missing counts", { counts: undefined }, /counts/],
  ["array counts", { counts: [] }, /counts/],
  ["wrong count", { counts: { community: 2, person: 2, household: 1 } }, /counts/],
  ["extra count", { counts: { community: 1, person: 2, household: 1, absent: 0 } }, /counts/],
  ["array hashes", { recordHashes: [] }, /hash mismatch/],
] as const) {
  test(`snapshot rejects ${name}`, () => assert.throws(() => parseNeutralSnapshot({ ...snapshot(), ...override }), expected));
}
for (const record of [null, [], 3, {}, { type: 1 }, { sourceId: 1 }, { parentSourceId: 1 }, { tombstone: "false" }, { attributes: [] }, { attributes: null }]) {
  test(`snapshot rejects invalid record ${JSON.stringify(record)}`, () => {
    const value = snapshot();
    (value.records as unknown[])[0] = record && typeof record === "object" && !Array.isArray(record) ? { ...value.records[0], ...record } : record;
    // An empty object overrides no fields, so exercise a raw missing-field record instead.
    if (record && typeof record === "object" && Object.keys(record).length === 0) (value.records as unknown[])[0] = record;
    assert.throws(() => parseNeutralSnapshot(value), /record 0 is invalid/);
  });
}
for (const value of [NaN, Infinity, -Infinity, undefined, 1n, () => 1, Symbol("synthetic")]) {
  test(`snapshot rejects unsupported attribute ${String(value)}`, () => {
    const input = snapshot();
    input.records[0]!.attributes = { value } as typeof input.records[0]["attributes"];
    assert.throws(() => parseNeutralSnapshot(input), /non-finite|unsupported value/);
  });
}
test("snapshot rejects aggregate attribute overflow and UTF-8 byte overflow", () => {
  const aggregate = snapshot();
  aggregate.records[0]!.attributes = { chunks: Array(17).fill("x".repeat(1024 * 1024)) } as typeof aggregate.records[0]["attributes"];
  assert.throws(() => parseNeutralSnapshot(aggregate), /attribute size limit/);
  const unicode = snapshot();
  unicode.records[0]!.attributes = { value: "é".repeat(524_289) } as typeof unicode.records[0]["attributes"];
  assert.throws(() => parseNeutralSnapshot(unicode), /string size/);
});
test("snapshot detects altered values, extra hashes and substituted hash identifiers", () => {
  const changed = snapshot(); changed.records[0]!.attributes.name = "Altered synthetic name";
  assert.throws(() => parseNeutralSnapshot(changed), /hash mismatch/);
  const extra = snapshot(); extra.recordHashes.extra = "0".repeat(64);
  assert.throws(() => parseNeutralSnapshot(extra), /hash mismatch/);
  const substituted = snapshot(); substituted.recordHashes.unknown = substituted.recordHashes.c1!; delete substituted.recordHashes.c1;
  assert.throws(() => parseNeutralSnapshot(substituted), /hash mismatch/);
});
test("canonical hashes accept recursively reordered object keys and retain array order", () => {
  const value = snapshot();
  value.records[0]!.attributes = { nested: { z: null, a: true, list: [1, false, { b: "two", a: "one" }] } } as typeof value.records[0]["attributes"];
  rebuildHashes(value);
  const firstHash = value.recordHashes.c1;
  value.records[0]!.attributes = { nested: { list: [1, false, { a: "one", b: "two" }], a: true, z: null } } as typeof value.records[0]["attributes"];
  assert.equal(parseNeutralSnapshot(value).recordHashes.c1, firstHash);
  assert.notEqual(sha256([1, 2]), sha256([2, 1]));
});
test("empty full snapshot traverses encryption, validation and replacement of active records", async () => {
  const store = new InMemorySnapshotStore(); const importer = new SnapshotImporter(store, () => now);
  await importer.import(snapshot("1"));
  const empty = snapshot("2"); empty.records = []; rebuildHashes(empty);
  const envelope = createEnvelope(empty, { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
  const opened = openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now });
  assert.equal((await importer.import(opened)).status, "committed");
  assert.deepEqual(store.active(destination)?.records, []);
  assert.equal(store.staged.size, 0);
  assert.equal((await importer.import(opened)).status, "duplicate");
});
test("encrypted mixed scalar attributes round-trip through parser and isolated committed storage", async () => {
  const value = snapshot();
  value.records[0]!.attributes = { nullValue: null, enabled: false, score: 0, nested: { values: ["é", 4, true, null] } } as typeof value.records[0]["attributes"];
  rebuildHashes(value);
  const envelope = createEnvelope(value, { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
  const opened = openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now });
  assert.deepEqual(opened, value);
  const store = new InMemorySnapshotStore(); const importer = new SnapshotImporter(store, () => now);
  await importer.import(opened);
  (opened.records[0]!.attributes as Record<string, unknown>).enabled = true;
  assert.equal(store.active(destination)?.records[0]?.attributes.enabled, false);
});
for (const field of ["ephemeralPublicKey", "wrapIv", "wrapTag", "wrappedKey", "payloadIv", "payloadTag", "ciphertext"] as const) {
  test(`envelope rejects malformed base64 ${field} before importing`, () => {
    const envelope = createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
    for (const invalid of ["!!!!", "A", "AB==", 7]) {
      assert.throws(() => openEnvelope({ ...envelope, [field]: invalid } as typeof envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }), /invalid|too large/);
    }
  });
}
for (const [field, max] of [["ephemeralPublicKey", 256], ["wrapIv", 44], ["wrapTag", 16], ["wrappedKey", 32], ["payloadIv", 12], ["payloadTag", 16]] as const) {
  test(`envelope bounds decoded ${field} bytes`, () => {
    const envelope = createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
    assert.throws(() => openEnvelope({ ...envelope, [field]: Buffer.alloc(max + 1).toString("base64") }, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }), /invalid|too large/);
  });
}
test("envelope validates packed wrapping IV length and supported version", () => {
  const envelope = createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
  for (const length of [0, 32, 43]) assert.throws(() => openEnvelope({ ...envelope, wrapIv: Buffer.alloc(length).toString("base64") }, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }), /wrap IV is invalid/);
  assert.throws(() => openEnvelope({ ...envelope, envelopeVersion: 2 } as unknown as typeof envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }), /destination mismatch/);
  assert.throws(() => createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: "other", now }), /destination mismatch/);
});
for (const field of ["schemaVersion", "profile", "snapshotId", "sourceIdentity", "createdAt", "expiresAt"] as const) {
  test(`envelope authenticates ${field} header`, () => {
    const envelope = createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
    const changed = field === "schemaVersion" ? 2 : field === "expiresAt" ? "2026-08-12T11:00:00Z" : "altered";
    assert.throws(() => openEnvelope({ ...envelope, [field]: changed } as typeof envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }));
  });
}
test("expiration is exclusive across creation, opening and import", async () => {
  const value = snapshot(); const atExpiry = new Date(value.expiresAt);
  const envelope = createEnvelope(value, { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
  assert.throws(() => createEnvelope(value, { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now: atExpiry }), /expired/);
  assert.throws(() => openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now: atExpiry }), /expired/);
  const store = new InMemorySnapshotStore();
  await assert.rejects(new SnapshotImporter(store, () => atExpiry).import(value), /expired/);
  assert.equal(store.active(destination), undefined); assert.equal(store.staged.size, 0);
});
test("import rejects equal watermarks for different IDs and compares beyond number precision", async () => {
  const store = new InMemorySnapshotStore(); const importer = new SnapshotImporter(store, () => now);
  await importer.import(snapshot("9007199254740992"));
  await assert.rejects(importer.import({ ...snapshot("09007199254740992"), snapshotId: "different" }), /older/);
  assert.equal((await importer.import(snapshot("9007199254740993"))).status, "committed");
  assert.equal(store.active(destination)?.watermark, "9007199254740993");
});
test("snapshot idempotence is destination-scoped and rejection preserves active and staging state", async () => {
  const store = new InMemorySnapshotStore(); const importer = new SnapshotImporter(store, () => now);
  await importer.import(snapshot());
  const other = { ...snapshot(), destinationCommunityId: "synthetic_other_community" };
  assert.equal((await importer.import(other)).status, "committed");
  const before = structuredClone(store.active(destination));
  await assert.rejects(importer.import({ ...snapshot("3"), recordHashes: {} }), /hash/);
  assert.deepEqual(store.active(destination), before); assert.equal(store.staged.size, 0);
});
test("failed first import remains staged, then retry commits and clears staging", async () => {
  const store = new InMemorySnapshotStore(); const importer = new SnapshotImporter(store, () => now);
  store.failBeforeCommit = true;
  await assert.rejects(importer.import(snapshot()), /simulated crash/);
  assert.equal(store.active(destination), undefined);
  assert.equal(store.staged.get(snapshot().snapshotId)?.stagedAt, now);
  store.failBeforeCommit = false;
  assert.equal((await importer.import(snapshot())).status, "committed");
  assert.equal(store.staged.size, 0);
});
test("purge zeroes retained key buffers at exact expiry while preserving unexpired staging", () => {
  const store = new InMemorySnapshotStore();
  const expired = snapshot("1"); expired.expiresAt = now.toISOString();
  store.stage(expired, now); store.stage(snapshot("2"), now);
  const key = store.staged.get(expired.snapshotId)!.keyMaterial!; key.fill(9);
  assert.equal(store.purgeExpired(now), 1);
  assert.deepEqual(key, Buffer.alloc(32));
  assert.equal(store.staged.has("snapshot_2"), true);
  assert.equal(store.purgeExpired(now), 0);
});

// Produce authentic ciphertext for malformed payloads, as an authorized sender
// could. This reaches plaintext validation beyond the transport's GCM checks.
function authenticatedPayload(plain: string) {
  const envelope = createEnvelope(snapshot(), { recipientPublicKey: keys.publicKey, destinationCommunityId: destination, now });
  const { ephemeralPublicKey, wrapIv, wrappedKey, wrapTag, payloadIv, ciphertext: _ciphertext, payloadTag: _payloadTag, ...header } = envelope;
  const packed = Buffer.from(wrapIv, "base64");
  const shared = diffieHellman({ privateKey: keys.privateKey, publicKey: createPublicKey({ key: Buffer.from(ephemeralPublicKey, "base64"), format: "der", type: "spki" }) });
  const wrapping = Buffer.from(hkdfSync("sha256", shared, packed.subarray(0, 32), Buffer.from("woodshed-snapshot-key-wrap-v1"), 32));
  const additional = Buffer.from(canonicalJson(header));
  const unwrap = createDecipheriv("aes-256-gcm", wrapping, packed.subarray(32));
  unwrap.setAAD(additional); unwrap.setAuthTag(Buffer.from(wrapTag, "base64"));
  const dek = Buffer.concat([unwrap.update(Buffer.from(wrappedKey, "base64")), unwrap.final()]);
  try {
    const cipher = createCipheriv("aes-256-gcm", dek, Buffer.from(payloadIv, "base64"));
    cipher.setAAD(additional);
    return { ...envelope, ciphertext: Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64"), payloadTag: cipher.getAuthTag().toString("base64") };
  } finally { dek.fill(0); wrapping.fill(0); shared.fill(0); }
}
for (const field of ["snapshotId", "sourceIdentity", "destinationCommunityId", "createdAt", "expiresAt"] as const) {
  test(`authenticated envelope rejects payload ${field} disagreement`, () => {
    const value = snapshot();
    value[field] = field === "createdAt" ? "2026-08-09T10:00:00Z" : field === "expiresAt" ? "2026-08-11T11:00:00Z" : "synthetic_changed";
    const envelope = authenticatedPayload(canonicalJson(value));
    assert.throws(() => openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }), /payload metadata mismatch/);
  });
}
test("authenticated malformed JSON and invalid contracts never reach committed state", async () => {
  const store = new InMemorySnapshotStore(); const importer = new SnapshotImporter(store, () => now);
  await importer.import(snapshot("1"));
  const before = structuredClone(store.active(destination));
  for (const plain of ["{", "null", canonicalJson({ ...snapshot(), counts: {} })]) {
    const envelope = authenticatedPayload(plain);
    assert.throws(() => openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination, now }));
    assert.deepEqual(store.active(destination), before);
    assert.equal(store.staged.size, 0);
  }
});
test("purge handles staging entries with no key material", () => {
  const store = new InMemorySnapshotStore(); const value = snapshot();
  store.stage(value, now); delete store.staged.get(value.snapshotId)!.keyMaterial;
  assert.equal(store.purgeExpired(new Date(value.expiresAt)), 1);
  assert.equal(store.staged.size, 0);
});
test("snapshot pipeline default clocks accept current snapshots and purge expired stages", async () => {
  const current = Date.now(); const value = snapshot("4");
  value.createdAt = new Date(current - 60_000).toISOString();
  value.expiresAt = new Date(current + 60_000).toISOString();
  const envelope = createEnvelope(value, { recipientPublicKey: keys.publicKey, destinationCommunityId: destination });
  const opened = openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: destination });
  const store = new InMemorySnapshotStore();
  assert.equal((await new SnapshotImporter(store).import(opened)).status, "committed");
  const expired = { ...value, snapshotId: "synthetic_expired", expiresAt: new Date(current - 1).toISOString() };
  store.stage(expired);
  assert.ok(store.staged.get(expired.snapshotId)!.stagedAt.getTime() >= current);
  assert.equal(store.purgeExpired(), 1);
  assert.equal(store.active(destination)?.snapshotId, value.snapshotId);
});
test("synthetic fixture replaces missing and non-string member references and drops all other attributes", () => {
  const value = snapshot();
  value.records[2]!.attributes = { memberSourceIds: ["p1", "absent", null, 2, { id: "p1" }], internalNote: "Synthetic input note" } as unknown as typeof value.records[0]["attributes"];
  rebuildHashes(value);
  const fixture = deriveSyntheticFixture(value);
  assert.deepEqual(fixture.records[2]!.attributes, { memberSourceIds: ["synthetic_person_1", "synthetic_missing_member", "synthetic_missing_member", "synthetic_missing_member", "synthetic_missing_member"] });
  assert.deepEqual(fixture.records[0]!.attributes, {});
  assert.deepEqual(fixture.records[1]!.attributes, {});
  assert.doesNotMatch(JSON.stringify(fixture), /Synthetic input note/);
  assert.deepEqual(parseNeutralSnapshot(fixture), fixture);
});
test("synthetic fixture omits a malformed household membership field", () => {
  const value = snapshot();
  value.records[2]!.attributes = { memberSourceIds: "p1" } as unknown as typeof value.records[0]["attributes"];
  rebuildHashes(value);
  assert.deepEqual(deriveSyntheticFixture(value).records[2]!.attributes, {});
});
test("empty synthetic fixture remains a valid full snapshot", () => {
  const value = snapshot(); value.records = []; rebuildHashes(value);
  const fixture = deriveSyntheticFixture(value);
  assert.deepEqual(fixture.records, []); assert.deepEqual(fixture.counts, {}); assert.deepEqual(fixture.recordHashes, {});
  assert.equal(parseNeutralSnapshot(fixture).sourceIdentity, "source_synthetic");
});
test("synthetic derivation rejects invalid source hashes before producing a fixture", () => {
  const value = snapshot(); value.records[1]!.attributes.displayName = "Changed synthetic source";
  assert.throws(() => deriveSyntheticFixture(value), /hash mismatch/);
});
test("derived synthetic fixture encrypts, validates and imports with rewritten identities intact", async () => {
  const fixture = deriveSyntheticFixture(snapshot());
  const envelope = createEnvelope(fixture, { recipientPublicKey: keys.publicKey, destinationCommunityId: fixture.destinationCommunityId, now });
  const opened = openEnvelope(envelope, { recipientPrivateKey: keys.privateKey, expectedDestinationCommunityId: fixture.destinationCommunityId, now });
  const store = new InMemorySnapshotStore();
  assert.equal((await new SnapshotImporter(store, () => now).import(opened)).status, "committed");
  const active = store.active("community_synthetic")!;
  assert.equal(active.snapshotId, "snapshot_synthetic_001");
  assert.deepEqual(active.records.find(record => record.type === "household")!.attributes.memberSourceIds, ["synthetic_person_1"]);
  assert.ok(active.records.every(record => record.sourceId.startsWith("synthetic_")));
  assert.equal(store.active(destination), undefined);
});
