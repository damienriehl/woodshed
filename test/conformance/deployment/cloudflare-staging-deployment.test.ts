import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDeploymentIdentity,
  assertCredentialedPreflight,
  assertSchemaInvariants,
  createWranglerAdapter,
  reconcileMigrationLedger,
  runMigrationFirstDeployment,
} from "../../../tools/cloudflare/deployment.mjs";
import { createJournal } from "../../../tools/cloudflare/journal.mjs";
import { D1_MIGRATIONS } from "../../../tools/cloudflare/migrations.mjs";

const sourceSha = "a".repeat(40);
const identity = {
  accountId: "b".repeat(32),
  databaseId: "11111111-1111-4111-8111-111111111111",
  workerName: "woodshed-staging-run-a",
  origin: "https://woodshed-staging.invalid",
};
const lease = { active: true, runId: "run-a", owner: "owner-a" };

function journal() {
  return createJournal({ runId: "run-a", owner: "owner-a", sourceSha, identity });
}

test("Wrangler adapter uses the pinned local binary, args without a shell, explicit config/env, and secret stdin", async () => {
  const calls: any[] = [];
  const adapter = createWranglerAdapter({
    root: "/repo",
    token: "private-token",
    spawn: async (file: string, args: string[], options: object) => {
      calls.push({ file, args, options });
      return { exitCode: 0, stdout: JSON.stringify([{ id: "safe" }]), stderr: "" };
    },
  });
  assert.deepEqual(await adapter.json(["d1", "list"]), [{ id: "safe" }]);
  await adapter.secretPut("LIVE_COMMAND_SECRET", "r".repeat(32));
  assert.equal(calls[0].file, "/repo/node_modules/.bin/wrangler");
  assert.deepEqual(calls[0].args.slice(-4), ["--config", "/repo/deploy/cloudflare/wrangler.jsonc", "--env", "staging"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal((calls[0].options as any).env.CLOUDFLARE_API_TOKEN, "private-token");
  assert.equal((calls[1].options as any).input, "r".repeat(32));
  assert.doesNotMatch(JSON.stringify(calls.map(({ file, args }) => ({ file, args }))), /private-token|rrrrrrrr/);
});

test("structured output and exact filename-only ledger fail closed without private digest provenance", () => {
  assert.throws(() => reconcileMigrationLedger({ remote: "not-json", manifest: D1_MIGRATIONS, journal: journal() }), /malformed/);
  assert.throws(() => reconcileMigrationLedger({ remote: [{ name: D1_MIGRATIONS[1]!.filename }], manifest: D1_MIGRATIONS, journal: journal() }), /exact prefix/);
  assert.throws(() => reconcileMigrationLedger({ remote: [{ name: D1_MIGRATIONS[0]!.filename }], manifest: D1_MIGRATIONS, journal: journal() }), /provenance/);
});

test("dedicated-account preflight blocks unreadable inventories, protected siblings, collisions, and missing secret continuity", () => {
  const inventory = { staging: identity };
  const empty = { accountId: identity.accountId, databases: [], workers: [], routes: [], secretNames: [], deployments: [] };
  assert.deepEqual(assertCredentialedPreflight(inventory, empty, { localSecretAvailable: true }), {
    accountScope: "dedicated-staging", targetAbsent: true, secretInventoryReadable: true,
  });
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, secretNames: null }, { localSecretAvailable: true }), /unreadable/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, workers: [{ name: "hootenanny" }] }, { localSecretAvailable: true }), /protected/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, workers: [{ name: identity.workerName }] }, { localSecretAvailable: true }), /already exists/);
  assert.throws(() => assertCredentialedPreflight(inventory, empty), /secret continuity/);
});

test("schema verification covers foreign keys, integrity, strict objects, choice seed, and migration 009 preservation", () => {
  const expected = {
    foreignKeysEnabled: true,
    foreignKeyViolations: 0,
    integrity: "ok",
    tables: ["events", "event_participants"],
    indexes: ["idx_event_participants_event"],
    triggers: ["seed_event_choice_config"],
    constraints: ["participant_event_composite", "recovery_token_unique"],
    choiceConfigSeeded: true,
    migration009: { beforeRows: 3, afterRows: 3, beforeAssociations: 3, afterAssociations: 3 },
  };
  assert.doesNotThrow(() => assertSchemaInvariants(expected, {
    tables: expected.tables, indexes: expected.indexes, triggers: expected.triggers, constraints: expected.constraints,
  }));
  assert.throws(() => assertSchemaInvariants({ ...expected, foreignKeyViolations: 1 }, expected), /foreign key/i);
  assert.throws(() => assertSchemaInvariants({ ...expected, migration009: { ...expected.migration009, afterAssociations: 2 } }, expected), /preservation/i);
});

test("deployment identity and bindings must match the frozen release and configuration", () => {
  const expected = { sourceSha, configDigest: "c".repeat(64), bindings: ["DB", "LIVE_COORDINATOR", "LIVE_COMMAND_SECRET", "APP_ORIGIN"], lifecycle: "legacy-sqlite-v1" };
  assert.doesNotThrow(() => assertDeploymentIdentity(expected, { ...expected, deploymentId: "version-1" }));
  assert.throws(() => assertDeploymentIdentity(expected, { ...expected, sourceSha: "d".repeat(40), deploymentId: "version-1" }), /source identity/);
  assert.throws(() => assertDeploymentIdentity(expected, { ...expected, bindings: ["DB"] , deploymentId: "version-1" }), /bindings/);
});

test("migration-first apply persists provenance, reconciles response loss, blocks drift, and deploys last", async () => {
  const events: string[] = [];
  const state = journal();
  let remoteLedger: string[] = [];
  const first = D1_MIGRATIONS[0]!;
  const result = await runMigrationFirstDeployment({
    journal: state,
    lease,
    manifest: [first],
    expectedSnapshot: { revision: "same" },
    inspectSnapshot: async () => ({ revision: "same" }),
    inspectLedger: async () => remoteLedger.map((name) => ({ name })),
    persistJournal: async () => { events.push("persist"); },
    applyMigration: async () => { events.push("migrate"); remoteLedger = [first.filename]; throw new Error("response lost"); },
    verifyMigration: async () => { events.push("verify-migration"); return true; },
    verifyFinalSchema: async () => { events.push("verify-schema"); },
    deployWorker: async () => { events.push("deploy"); return { deploymentId: "version-1" }; },
    verifyDeployment: async () => { events.push("verify-deploy"); },
  });
  assert.equal(result.deployment.deploymentId, "version-1");
  assert.deepEqual(events, ["persist", "migrate", "verify-migration", "persist", "verify-schema", "deploy", "verify-deploy", "persist"]);
  assert.equal(state.migrations[0]!.status, "applied");
  assert.equal(state.phase, "worker-deployed");

  let mutations = 0;
  await assert.rejects(runMigrationFirstDeployment({
    journal: journal(), lease, manifest: [],
    expectedSnapshot: { revision: "before" },
    inspectSnapshot: async () => ({ revision: "changed" }),
    inspectLedger: async () => [],
    persistJournal: async () => {},
    applyMigration: async () => { mutations += 1; },
    verifyMigration: async () => true,
    verifyFinalSchema: async () => {},
    deployWorker: async () => { mutations += 1; return {}; },
    verifyDeployment: async () => {},
  }), /inventory changed/);
  assert.equal(mutations, 0);
});
