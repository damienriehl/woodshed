import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRollbackCompatible,
  buildFailureReport,
  runQuarantinedD1Recovery,
  runStackTeardown,
} from "../../../tools/cloudflare/recovery.mjs";

const lifecycle = {
  durableObject: "legacy-sqlite-v1",
  d1Schema: "schema-v1",
  durableObjectShape: "live-v1",
  bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"],
  secrets: ["LIVE_COMMAND_SECRET"],
};

test("rollback accepts only a same-lifecycle, storage-compatible version", () => {
  assert.equal(assertRollbackCompatible(lifecycle, structuredClone(lifecycle)), true);
  assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, durableObject: "pre-lifecycle" }), /Durable Object lifecycle/);
  assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, d1Schema: "schema-v0" }), /D1 schema/);
  assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, durableObjectShape: "live-v0" }), /stored-value shape/);
  for (const field of ["durableObject", "d1Schema", "durableObjectShape"] as const) {
    for (const invalid of [undefined, null, ""]) {
      assert.throws(() => assertRollbackCompatible({ ...lifecycle, [field]: invalid }, { ...lifecycle, [field]: invalid }), /evidence is required/);
    }
  }
});

test("D1 recovery quarantines first and refuses drift or a writable origin", async () => {
  const calls: string[] = [];
  const base = {
    journal: { runId: "run-a", owner: "owner-a", identity: { accountId: "account", databaseId: "db", workerName: "worker", origin: "https://staging.invalid" }, recovery: { bookmark: "bookmark" } },
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" },
    expectedSnapshot: { revision: "7", originWritable: true },
    inspectSnapshot: async () => ({ revision: "7", originWritable: calls.length === 0 }),
    quarantineOrigin: async () => { calls.push("quarantine"); },
    restoreD1: async () => { calls.push("restore"); },
    verifyD1: async () => { calls.push("verify"); return { ledger: true, schema: true, foreignKeys: true, aggregates: true, behavior: true }; },
  };
  await runQuarantinedD1Recovery(base);
  assert.deepEqual(calls, ["quarantine", "restore", "verify"]);

  await assert.rejects(runQuarantinedD1Recovery({ ...base, inspectSnapshot: async () => ({ revision: "8", originWritable: false }) }), /last-write identity changed/);
});

test("D1 recovery reconciles a lost restore response only after full verification", async () => {
  const verification = { ledger: true, schema: true, foreignKeys: true, aggregates: true, behavior: true };
  const base = {
    journal: { runId: "run-a", owner: "owner-a", recovery: { bookmark: "bookmark" } },
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" },
    expectedSnapshot: { revision: "7", originWritable: false },
    inspectSnapshot: async () => ({ revision: "7", originWritable: false }),
    quarantineOrigin: async () => assert.fail("already quarantined"),
    restoreD1: async () => { throw new Error("response lost"); },
  };
  const result = await runQuarantinedD1Recovery({ ...base, verifyD1: async () => verification });
  assert.equal(result.reconciled, true);
  await assert.rejects(
    runQuarantinedD1Recovery({ ...base, verifyD1: async () => ({ ...verification, ledger: false }) }),
    /response lost/,
  );
});

test("teardown is run-owned, dependency ordered, re-entrant, and proves every domain absent", async () => {
  const calls: string[] = [];
  const state = new Map([
    ["route", true], ["credential", true], ["secret", true], ["worker", true], ["durable-object", true], ["d1", true], ["token", true],
  ]);
  const journal = {
    runId: "run-a", owner: "owner-a", phase: "quarantined",
    identity: { accountId: "account", databaseId: "db", workerName: "worker", origin: "https://staging.invalid" },
    resources: [...state.keys()].map((domain) => ({ domain, id: `${domain}-run-a`, runId: "run-a", owner: "owner-a", ...(domain === "token" ? { provenance: "run-minted" } : {}) })),
  };
  const result = await runStackTeardown({
    journal,
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" },
    expectedRevision: "7",
    inspectRevision: async () => "7",
    listDependents: async () => [],
    inspectResource: async ({ domain }: { domain: string }) => ({ exists: state.get(domain), runId: "run-a", owner: "owner-a" }),
    removeResource: async ({ domain }: { domain: string }) => { calls.push(domain); state.set(domain, false); },
    verifyTokenInactive: async () => true,
  });
  assert.deepEqual(calls, ["route", "credential", "secret", "worker", "durable-object", "d1", "token"]);
  assert.equal(result.complete, true);
  assert.deepEqual(Object.values(result.absence), [true, true, true, true, true, true, true]);

  calls.length = 0;
  assert.equal((await runStackTeardown({
    journal, lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", listDependents: async () => [],
    inspectResource: async ({ domain }: { domain: string }) => ({ exists: state.get(domain), runId: "run-a", owner: "owner-a" }),
    removeResource: async ({ domain }: { domain: string }) => { calls.push(domain); }, verifyTokenInactive: async () => true,
  })).complete, true);
  assert.deepEqual(calls, []);
});

test("teardown removes every duplicate-domain resource and an applicable hostname", async () => {
  const resourceSpecs = [
    ["route", "route-a"], ["route", "route-b"], ["hostname", "host-a"],
    ["credential", "credential-a"], ["secret", "secret-a"], ["worker", "worker-a"],
    ["durable-object", "do-a"], ["d1", "d1-a"], ["token", "token-a"],
  ];
  const state = new Map(resourceSpecs.map(([, id]) => [id, true]));
  const journal = {
    runId: "run-a", owner: "owner-a", phase: "quarantined", identity: {},
    resources: resourceSpecs.map(([domain, id]) => ({ domain, id, runId: "run-a", owner: "owner-a", ...(domain === "token" ? { provenance: "run-minted" } : {}) })),
  };
  const removed: string[] = [];
  const result = await runStackTeardown({
    journal, lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", listDependents: async () => [],
    inspectResource: async ({ id }: { id: string }) => ({ exists: state.get(id), runId: "run-a", owner: "owner-a" }),
    removeResource: async ({ id }: { id: string }) => { removed.push(id); state.set(id, false); },
    verifyTokenInactive: async () => true,
  });
  assert.deepEqual(removed, resourceSpecs.map(([, id]) => id));
  assert.equal(Object.keys(result.absence).length, resourceSpecs.length);
  assert.equal(result.complete, true);
});

test("teardown rejects duplicate identities before removing anything", async () => {
  const domains = ["route", "credential", "secret", "worker", "durable-object", "d1", "token"];
  const resources = domains.map((domain) => ({ domain, id: domain + "-a", runId: "run-a", owner: "owner-a", ...(domain === "token" ? { provenance: "run-minted" } : {}) }));
  resources.push({ ...{ ...resources[0]! } });
  let removals = 0;
  await assert.rejects(runStackTeardown({
    journal: { runId: "run-a", owner: "owner-a", phase: "quarantined", resources },
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", listDependents: async () => [], inspectResource: async () => ({ exists: true, runId: "run-a", owner: "owner-a" }),
    removeResource: async () => { removals += 1; }, verifyTokenInactive: async () => true,
  }), /duplicate teardown resource identity/);
  assert.equal(removals, 0);
});

test("teardown fails closed on identity mismatch or unexpected dependents", async () => {
  const journal = { runId: "run-a", owner: "owner-a", phase: "quarantined", identity: {}, resources: ["route", "credential", "secret", "worker", "durable-object", "d1", "token"].map((domain) => ({ domain, id: domain + "-run-a", runId: "run-a", owner: "owner-a", ...(domain === "token" ? { provenance: "run-minted" } : {}) })) };
  const base = {
    journal, lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", inspectResource: async () => ({ exists: true, runId: "other", owner: "other" }),
    removeResource: async () => assert.fail("must not delete"), verifyTokenInactive: async () => true,
  };
  await assert.rejects(runStackTeardown({ ...base, listDependents: async () => [] }), /identity mismatch/);
  await assert.rejects(runStackTeardown({ ...base, inspectResource: async () => ({ exists: true, runId: "run-a", owner: "owner-a" }), listDependents: async () => ["unknown-child"] }), /unexpected dependent/);
});

test("teardown re-reads protected identity after its final mutation", async () => {
  const resources = ["route", "credential", "secret", "worker", "durable-object", "d1"].map((domain) => ({ domain, id: domain + "-run-a", runId: "run-a", owner: "owner-a" }));
  const state = new Map(resources.map(({ domain }) => [domain, true]));
  let revision = "7";
  await assert.rejects(runStackTeardown({
    journal: { runId: "run-a", owner: "owner-a", phase: "quarantined", resources },
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => revision, listDependents: async () => [],
    inspectResource: async ({ domain }: { domain: string }) => ({ exists: state.get(domain), runId: "run-a", owner: "owner-a" }),
    removeResource: async ({ domain }: { domain: string }) => { state.set(domain, false); if (domain === "d1") revision = "8"; },
    verifyTokenInactive: async () => true,
  }), /last-write identity changed/);
});

test("failure reports retain safe next action but sanitize sensitive observability", () => {
  const report = buildFailureReport({
    phase: "worker-deployed", nextAction: "quarantine-origin", incidentOwner: "owner-a",
    observations: { workerExceptions: 1, d1Failures: 0, durableObjectFailures: 1, authorization: "Bearer token", requestBody: "ballot", note: "secret-value" },
  }, ["secret-value"]);
  assert.equal(report.nextAction, "quarantine-origin");
  assert.equal((report.observations as Record<string, unknown>).workerExceptions, 1);
  assert.doesNotMatch(JSON.stringify(report), /Bearer token|ballot|secret-value/);
  assert.equal(report.productionAuthority, false);
});

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attestMigration, createJournal, loadJournal, saveJournal, validateJournal } from "../../../tools/cloudflare/journal.mjs";
// @ts-expect-error JavaScript inventory validation intentionally has no declaration surface.
import { describeInventoryFields, parseStructuredInventory, validateStagingInventory } from "../../../tools/cloudflare/inventory.mjs";
import { createJournalRetention, RESOURCE_ORDER } from "../../../tools/cloudflare/recovery.mjs";

const sha = "a".repeat(40);
function inventory(): any {
  return { environment: "staging", expectedSourceSha: sha, staging: { accountId: "a".repeat(32), databaseId: "11111111-2222-4333-8444-555555555555", databaseName: "music-staging-db", origin: "https://music-staging.invalid", workerName: "music-staging" }, forbidden: { accountIds: ["b".repeat(32)], databaseIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], origins: ["https://music.invalid"], workerNames: ["music-live"] } };
}
function journal(): any { return createJournal({ runId: "coverage-run", owner: "coverage-owner", sourceSha: sha, identity: inventory().staging, now: "2026-01-01T00:00:00.000Z" }); }
const source = { actualSourceSha: sha, worktreeClean: true };
const migration = { filename: "0001.sql", sha256: "b".repeat(64), sourceSha: sha };

const invalidJournals: Array<[string, (value: any) => any, RegExp]> = [
  ["null", () => null, /expected object/], ["array", () => [], /expected object/],
  ["version", v => ({ ...v, version: 2 }), /unsupported version/],
  ["run", v => ({ ...v, runId: "" }), /runId/], ["owner", v => ({ ...v, owner: 1 }), /owner/],
  ["source", v => ({ ...v, sourceSha: "abc" }), /sourceSha/], ["phase", v => ({ ...v, phase: "unknown" }), /phase/],
  ["identity", v => ({ ...v, identity: null }), /identity/],
  ["database id type", v => ({ ...v, identity: { ...v.identity, databaseId: 42 } }), /databaseId/],
  ["database id empty", v => ({ ...v, identity: { ...v.identity, databaseId: "" } }), /databaseId/],
  ["provisioned database missing", v => ({ ...v, phase: "resources-ready", identity: { ...v.identity, databaseId: undefined } }), /required after provisioning/],
  ...["resources", "mutations", "migrations"].map(field => [field, (v: any) => ({ ...v, [field]: null }), /ownership arrays/] as [string, (v: any) => any, RegExp]),
  ...[null, { ...migration, filename: 7 }, { ...migration, sha256: "short" }, { ...migration, sourceSha: "c".repeat(40) }, { ...migration, status: "unknown" }].map((entry, index) => [`migration ${index}`, (v: any) => ({ ...v, migrations: [entry] }), /migration attestation/] as [string, (v: any) => any, RegExp]),
  ...[null, { status: 7, cleanupComplete: false }, { status: "pending", cleanupComplete: "false" }].map((entry, index) => [`acceptance ${index}`, (v: any) => ({ ...v, acceptance: entry }), /acceptance state/] as [string, (v: any) => any, RegExp]),
  ...[null, {}, { rows: [], parentChildTables: [], durableObjectIdentity: "fixture", tokenHash: "bad" }].map((entry, index) => [`fixture ${index}`, (v: any) => ({ ...v, acceptance: { status: "pending", cleanupComplete: false, fixturePlan: entry } }), /fixture ownership/] as [string, (v: any) => any, RegExp]),
];
for (const [name, mutate, error] of invalidJournals) test(`journal rejects invalid ${name}`, () => assert.throws(() => validateJournal(mutate(journal())), error));

test("journal disk roundtrip preserves attestation and ownership without mutating its input", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "journal-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "run.json");
  const value = journal();
  attestMigration(value, migration);
  value.acceptance = { status: "pending", cleanupComplete: false, fixturePlan: { rows: [], parentChildTables: [], durableObjectIdentity: "fixture", tokenHash: "f".repeat(64) } };
  const saved = await saveJournal(file, value);
  assert.equal(value.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.notEqual(saved.updatedAt, value.updatedAt);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadJournal(file, { runId: value.runId, owner: value.owner }), saved);
  for (const expected of [{ owner: "other" }, { runId: "other" }]) await assert.rejects(loadJournal(file, expected), /does not own/);
  saved.migrations[0]!.status = "applied";
  saved.phase = "schema-expanded";
  await saveJournal(file, saved);
  assert.equal((await loadJournal(file)).migrations[0]!.status, "applied");
  assert.deepEqual(await readdir(directory), ["run.json"]);
});

test("journal filesystem failures preserve the previous destination and clean temporary files", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "journal-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "destination");
  await mkdir(destination);
  await writeFile(path.join(destination, "keep.txt"), "keep");
  await assert.rejects(saveJournal(destination, journal()), { code: "EISDIR" });
  assert.deepEqual(await readdir(directory), ["destination"]);
  assert.equal(await readFile(path.join(destination, "keep.txt"), "utf8"), "keep");
  await assert.rejects(loadJournal(path.join(directory, "missing.json")), error => error instanceof Error && error.message.includes("unreadable or corrupt") && (error.cause as NodeJS.ErrnoException).code === "ENOENT");
  const corrupt = path.join(directory, "corrupt.json");
  await writeFile(corrupt, "{");
  await assert.rejects(loadJournal(corrupt), /unreadable or corrupt/);
  await writeFile(corrupt, JSON.stringify({ version: 2 }));
  await assert.rejects(loadJournal(corrupt), /unsupported version/);
});

test("migration attestation rejects malformed and duplicate entries without changing history", () => {
  const value = journal();
  for (const entry of [null, {}, { ...migration, sha256: "x" }, { ...migration, sourceSha: "c".repeat(40) }]) assert.throws(() => attestMigration(value, entry as any), /invalid migration attestation/);
  assert.deepEqual(value.migrations, []);
  attestMigration(value, migration);
  assert.throws(() => attestMigration(value, migration), /already attested/);
  assert.deepEqual(value.migrations, [{ ...migration, status: "pending" }]);
});

const invalidInventories: Array<[string, (value: any) => any, RegExp]> = [
  ["root null", () => null, /inventory must be an object/], ["staging array", v => ({ ...v, staging: [] }), /staging must be an object/],
  ["forbidden null", v => ({ ...v, forbidden: null }), /forbidden must be an object/],
  ["staging unknown", v => ({ ...v, staging: { ...v.staging, zone: "x" } }), /unknown field in staging/],
  ["forbidden unknown", v => ({ ...v, forbidden: { ...v.forbidden, routes: [] } }), /unknown field in forbidden/],
  ...["accountId", "databaseId"].map(field => [field, (v: any) => ({ ...v, staging: { ...v.staging, [field]: "invalid" } }), /invalid shape/] as [string, (v: any) => any, RegExp]),
  ["unsafe database name", v => ({ ...v, staging: { ...v.staging, databaseName: "staging db" } }), /safe name/],
  ...["not a url", "http://staging.invalid", "https://name:password" + "@staging.invalid", "https://staging.invalid/path", "https://staging.invalid/?q=1", "https://staging.invalid/#fragment"].map(origin => [origin, (v: any) => ({ ...v, staging: { ...v.staging, origin } }), /absolute HTTPS origin/] as [string, (v: any) => any, RegExp]),
  ["ambiguous origin", v => ({ ...v, staging: { ...v.staging, origin: "https://music.invalid" } }), /unmistakably staging/],
  ...["accountIds", "databaseIds", "workerNames"].map(field => [field, (v: any) => ({ ...v, forbidden: { ...v.forbidden, [field]: ["invalid value"] } }), /contains an invalid/] as [string, (v: any) => any, RegExp]),
  ...["accountIds", "databaseIds", "origins", "workerNames"].map(field => [`blank ${field}`, (v: any) => ({ ...v, forbidden: { ...v.forbidden, [field]: [" "] } }), /non-empty array/] as [string, (v: any) => any, RegExp]),
  ["forbidden database", v => ({ ...v, forbidden: { ...v.forbidden, databaseIds: [v.staging.databaseId] } }), /database is forbidden/],
  ["forbidden origin", v => ({ ...v, forbidden: { ...v.forbidden, origins: [v.staging.origin + "/"] } }), /origin is forbidden/],
  ["forbidden worker", v => ({ ...v, forbidden: { ...v.forbidden, workerNames: [v.staging.workerName.toUpperCase()] } }), /Worker is forbidden/],
];
for (const [name, mutate, error] of invalidInventories) test(`inventory rejects ${name}`, () => assert.throws(() => validateStagingInventory(mutate(inventory()), source), error));

test("structured inventory parsing rejects failed commands and malformed or scalar payloads", () => {
  assert.throws(() => parseStructuredInventory("[]", { commandSucceeded: false }), /command failed/);
  assert.throws(() => parseStructuredInventory("{"), /malformed/);
  for (const value of ["null", "{}", "true", 1, undefined]) assert.throws(() => parseStructuredInventory(value), /must be an array/);
  assert.deepEqual(parseStructuredInventory("[]"), []);
  const records = [{ name: "music-staging" }];
  assert.strictEqual(parseStructuredInventory(records), records);
});

test("inventory normalization feeds a persisted owned journal and isolates forbidden arrays", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inventory-chain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = inventory();
  input.expectedSourceSha = sha.toUpperCase();
  input.staging.accountId = input.staging.accountId.toUpperCase();
  input.staging.databaseName = input.staging.databaseName.toUpperCase();
  input.staging.origin = "https://MUSIC-STAGING.invalid:443/";
  const normalized = validateStagingInventory(input, source);
  const file = path.join(directory, "owned.json");
  await saveJournal(file, createJournal({ runId: "inventory-run", owner: "owner", sourceSha: normalized.expectedSourceSha, identity: normalized.staging }));
  const loaded = await loadJournal(file, { runId: "inventory-run", owner: "owner" });
  assert.deepEqual(loaded.identity, inventory().staging);
  input.forbidden.accountIds.push("c".repeat(32));
  assert.equal(normalized.forbidden.accountIds.length, 1);
  assert.equal(Object.isFrozen(normalized.staging), true);
  assert.equal(Object.isFrozen(normalized.forbidden.accountIds), true);
  const fields = describeInventoryFields();
  fields.staging.length = 0;
  assert.equal(describeInventoryFields().staging.length, 5);
});

function teardownOptions(): any {
  const value = journal();
  value.phase = "quarantined";
  value.resources = RESOURCE_ORDER.map((domain: string) => ({ domain, id: domain + "-fixture", runId: value.runId, owner: value.owner }));
  return { journal: value, lease: { active: true, runId: value.runId, owner: value.owner, revision: "rev-1" }, expectedRevision: "rev-1", inspectRevision: async () => "rev-1", listDependents: async () => [], inspectResource: async () => ({ exists: false }), removeResource: async () => assert.fail("must not remove an absent resource"), verifyTokenInactive: async () => true };
}
const invalidTeardowns: Array<[string, (value: any) => void, RegExp]> = [
  ["missing lease", v => { v.lease = undefined; }, /ownership lease/],
  ["inactive lease", v => { v.lease.active = false; }, /ownership lease/],
  ["foreign run", v => { v.lease.runId = "other"; }, /ownership lease/],
  ["foreign owner", v => { v.lease.owner = "other"; }, /ownership lease/],
  ["writable phase", v => { v.journal.phase = "alias-live"; }, /quarantined/],
  ["stale lease", v => { v.lease.revision = "rev-0"; }, /last-write identity/],
  ["stale remote", v => { v.inspectRevision = async () => "rev-2"; }, /last-write identity/],
  ["invalid graph", v => { v.journal.resources = null; }, /resource graph/],
  ["unknown domain", v => { v.journal.resources[0].domain = "zone"; }, /unsupported teardown/],
  ["null resource", v => { v.journal.resources[0] = null; }, /unsupported teardown/],
  ["foreign resource run", v => { v.journal.resources[0].runId = "other"; }, /journal resource identity/],
  ["foreign resource owner", v => { v.journal.resources[0].owner = "other"; }, /journal resource identity/],
  ["missing resource id", v => { v.journal.resources[0].id = ""; }, /journal resource identity/],
  ...["route", "credential", "secret", "worker", "durable-object", "d1", "token"].map(domain => [`missing ${domain}`, (v: any) => { v.journal.resources = v.journal.resources.filter((r: any) => r.domain !== domain); }, new RegExp(`missing ${domain} teardown authority`)] as [string, (v: any) => void, RegExp]),
  ["unreadable dependencies", v => { v.listDependents = async () => null; }, /dependent inventory is unreadable/],
  ["unproven absence", v => { v.inspectResource = async () => undefined; }, /absence proof failed/],
  ["active token", v => { v.verifyTokenInactive = async () => false; }, /token remains active/],
];
for (const [name, mutate, error] of invalidTeardowns) test(`teardown refuses ${name}`, async () => {
  const options = teardownOptions();
  mutate(options);
  await assert.rejects(runStackTeardown(options), error);
});

test("teardown rechecks ownership revision before touching each resource", async () => {
  const options = teardownOptions();
  let inspections = 0;
  options.inspectRevision = async () => ++inspections === 1 ? "rev-1" : "rev-2";
  options.listDependents = async () => assert.fail("must stop before reading the changed resource");
  await assert.rejects(runStackTeardown(options), /last-write identity changed/);
  assert.equal(inspections, 2);
});

test("persisted journal drives filesystem teardown, proves absence and supports restart", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "teardown-chain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = teardownOptions();
  const file = path.join(directory, "journal.json");
  await saveJournal(file, options.journal);
  options.journal = await loadJournal(file, { owner: options.lease.owner, runId: options.lease.runId });
  for (const resource of options.journal.resources) await writeFile(path.join(directory, resource.id + ".json"), JSON.stringify(resource));
  const removed: string[] = [];
  options.inspectResource = async (resource: any) => {
    try { return { ...JSON.parse(await readFile(path.join(directory, resource.id + ".json"), "utf8")), exists: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }; throw error; }
  };
  options.removeResource = async (resource: any) => { await rm(path.join(directory, resource.id + ".json")); removed.push(resource.domain); };
  options.verifyTokenInactive = async () => !(await options.inspectResource(options.journal.resources.find((r: any) => r.domain === "token"))).exists;
  const result = await runStackTeardown(options);
  assert.equal(result.complete, true);
  assert.equal(result.durableObjectStateRemovedWithNamespace, true);
  assert.deepEqual(removed, [...RESOURCE_ORDER]);
  assert.deepEqual(await readdir(directory), ["journal.json"]);
  options.journal = await loadJournal(file);
  removed.length = 0;
  assert.deepEqual(await runStackTeardown(options), result);
  assert.deepEqual(removed, []);
});

function recoveryOptions(): any {
  const value = journal();
  value.recovery = { bookmark: "local-checkpoint" };
  return { journal: value, lease: { active: true, runId: value.runId, owner: value.owner, revision: "rev-1" }, expectedSnapshot: { revision: "rev-1" }, inspectSnapshot: async () => ({ revision: "rev-1", originWritable: false }), quarantineOrigin: async () => assert.fail("already quarantined"), restoreD1: async (bookmark: string) => assert.equal(bookmark, "local-checkpoint"), verifyD1: async () => ({ ledger: true, schema: true, foreignKeys: true, aggregates: true, behavior: true }) };
}
for (const field of ["ledger", "schema", "foreignKeys", "aggregates", "behavior"]) test(`D1 recovery requires affirmative ${field} verification`, async () => {
  const options = recoveryOptions();
  const verified = await options.verifyD1();
  for (const invalid of [false, undefined, "true"]) {
    options.verifyD1 = async () => ({ ...verified, [field]: invalid });
    await assert.rejects(runQuarantinedD1Recovery(options), new RegExp(`${field} verification failed`));
  }
});

test("D1 recovery rejects absent bookmarks, absent snapshots and post-quarantine drift before restore", async () => {
  const options = recoveryOptions();
  options.restoreD1 = async () => assert.fail("must not restore");
  await assert.rejects(runQuarantinedD1Recovery({ ...options, journal: journal() }), /bookmark is required/);
  await assert.rejects(runQuarantinedD1Recovery({ ...options, expectedSnapshot: null }), /last-write identity/);
  await assert.rejects(runQuarantinedD1Recovery({ ...options, inspectSnapshot: async () => null }), /last-write identity/);
  await assert.rejects(runQuarantinedD1Recovery({ ...options, inspectSnapshot: async () => ({ revision: "rev-1", originWritable: true }), quarantineOrigin: async () => {} }), /quarantined origin/);
  let reads = 0;
  await assert.rejects(runQuarantinedD1Recovery({ ...options, inspectSnapshot: async () => ++reads === 1 ? { revision: "rev-1", originWritable: true } : { revision: "rev-2", originWritable: false }, quarantineOrigin: async () => {} }), /last-write identity/);
});

test("rollback treats binding and secret sets as exact unordered multisets", () => {
  assert.equal(assertRollbackCompatible(lifecycle, { ...lifecycle, bindings: [...lifecycle.bindings].reverse() }), true);
  assert.throws(() => assertRollbackCompatible(null as any, lifecycle), /evidence is required/);
  assert.throws(() => assertRollbackCompatible(lifecycle, null as any), /evidence is required/);
  for (const field of ["bindings", "secrets"]) for (const value of [null, [], ["unexpected"], [...lifecycle[field as "bindings" | "secrets"], "duplicate"]]) {
    assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, [field]: value }), /set is incompatible/);
  }
  assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "WRONG"] }), /binding set is incompatible/);
});

test("retention starts at incident resolution when present and rejects invalid timestamps", () => {
  assert.equal(createJournalRetention({ completedAt: "2026-02-28T23:30:00-06:00" }).retainUntil, "2026-03-02T05:30:00.000Z");
  const result = createJournalRetention({ completedAt: "2026-01-01T00:00:00Z", incidentResolvedAt: "2026-01-03T00:00:00Z" });
  assert.equal(result.retainUntil, "2026-01-04T00:00:00.000Z");
  assert.deepEqual(result.checks, ["+1h-absence-and-audit", "+24h-absence-and-audit"]);
  for (const value of [{}, { completedAt: "bad" }, { completedAt: "2026-01-01", incidentResolvedAt: "bad" }]) assert.throws(() => createJournalRetention(value), /timestamp is required/);
});
