import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  assertDeploymentIdentity,
  assertCredentialedPreflight,
  assertSharedAccountInventory,
  assertSchemaInvariants,
  createWranglerAdapter,
  persistAssignedDatabaseIdentity,
  reconcileMigrationLedger,
  runBoundedSubprocess,
  runMigrationFirstDeployment,
} from "../../../tools/cloudflare/deployment.mjs";
import { createJournal } from "../../../tools/cloudflare/journal.mjs";
import { D1_MIGRATIONS } from "../../../tools/cloudflare/migrations.mjs";

const sourceSha = "a".repeat(40);
const identity = {
  accountId: "b".repeat(32),
  databaseId: "11111111-1111-4111-8111-111111111111",
  databaseName: "woodshed-staging-run-a",
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
  assert.deepEqual(await adapter.json(["secret", "list"], { workerName: "woodshed-staging-run-a" }), [{ id: "safe" }]);
  await adapter.secretPut("LIVE_COMMAND_SECRET", "r".repeat(32), { workerName: "woodshed-staging-run-a" });
  assert.equal(calls[0].file, "/repo/node_modules/.bin/wrangler");
  assert.deepEqual(calls[0].args.slice(-4), ["--config", "/repo/deploy/cloudflare/wrangler.jsonc", "--env", "staging"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal((calls[0].options as any).env.CLOUDFLARE_API_TOKEN, "private-token");
  assert.equal((calls[0].options as any).env.HOME, "/repo/.cloudflare-staging/wrangler-home");
  assert.equal((calls[0].options as any).env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
  assert.deepEqual(calls[0].args.slice(-6, -4), ["--env-file", "/repo/.cloudflare-staging/wrangler-home/empty-environment"]);
  assert.deepEqual(calls[1].args.slice(0, 6), ["secret", "list", "--name", "woodshed-staging-run-a", "--format", "json"]);
  assert.deepEqual(calls[2].args.slice(0, 5), ["secret", "put", "LIVE_COMMAND_SECRET", "--name", "woodshed-staging-run-a"]);
  assert.equal((calls[2].options as any).input, "r".repeat(32));
  assert.doesNotMatch(JSON.stringify(calls.map(({ file, args }) => ({ file, args }))), /private-token|rrrrrrrr/);
  assert.equal((adapter as any).invoke, undefined);
  await assert.rejects(adapter.json(["deploy", "--name", "production"]), /not allowlisted/);
  await assert.rejects(adapter.json(["secret", "list"], { workerName: "production" }), /safe staging Worker name/);
});

test("adapter does not suppress Wrangler structured output", async () => {
  let childEnv: NodeJS.ProcessEnv | undefined;
  const adapter = createWranglerAdapter({
    root: "/repo",
    token: "synthetic-private-token",
    spawn: async (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      childEnv = options.env;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    },
  });

  await adapter.d1List();

  assert.equal(childEnv?.WRANGLER_LOG, "log");
  assert.notEqual(childEnv?.WRANGLER_LOG, "none");
  assert.notEqual(childEnv?.WRANGLER_LOG, "error");
  assert.equal(childEnv?.WRANGLER_LOG_PATH, "/repo/.cloudflare-staging/wrangler.log");
});

test("deployments list tolerates Wrangler code 10007 not-found errors on stdout", async () => {
  const adapter = createWranglerAdapter({
    root: "/repo",
    token: "synthetic-private-token",
    spawn: async () => ({
      exitCode: 1,
      stdout: "This Worker does not exist on your account. [code: 10007]",
      stderr: "",
    }),
  });

  assert.deepEqual(await adapter.deploymentsList("woodshed-staging-synthetic"), []);
});

test("deployments list tolerates Wrangler code 10007 not-found errors on stderr", async () => {
  const adapter = createWranglerAdapter({
    root: "/repo",
    token: "synthetic-private-token",
    spawn: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "This Worker does not exist on your account. [code: 10007]",
    }),
  });

  assert.deepEqual(await adapter.deploymentsList("woodshed-staging-synthetic"), []);
});

test("deployments list rejects failures without Wrangler code 10007 on either stream", async () => {
  const adapter = createWranglerAdapter({
    root: "/repo",
    token: "synthetic-private-token",
    spawn: async () => ({ exitCode: 1, stdout: "request failed", stderr: "worker not found" }),
  });

  await assert.rejects(adapter.deploymentsList("woodshed-staging-synthetic"), /Wrangler command failed/);
});

test("Wrangler home preparation creates a private home and empty environment without invoking Wrangler", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "woodshed-wrangler-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  createWranglerAdapter({ root, token: "synthetic-private-token" });

  const isolatedHome = path.join(root, ".cloudflare-staging", "wrangler-home");
  const emptyEnvironment = path.join(isolatedHome, "empty-environment");
  assert.equal((await stat(isolatedHome)).mode & 0o777, 0o700);
  assert.equal((await stat(emptyEnvironment)).mode & 0o777, 0o600);
  assert.equal(await readFile(emptyEnvironment, "utf8"), "");
});

test("Wrangler worker inventories translate only script_not_found code 10007 to empty", async () => {
  const missing = createWranglerAdapter({
    root: "/repo",
    token: "synthetic-private-token",
    spawn: async () => ({ exitCode: 1, stdout: "", stderr: "workers.api.error.script_not_found [code: 10007]" }),
  });
  assert.deepEqual(await missing.secretList("woodshed-staging-synthetic"), []);
  assert.deepEqual(await missing.deploymentsList("woodshed-staging-synthetic"), []);
  assert.deepEqual(await missing.versionsList("woodshed-staging-synthetic"), []);

  const ambiguous = createWranglerAdapter({
    root: "/repo",
    token: "synthetic-private-token",
    spawn: async () => ({ exitCode: 1, stdout: "", stderr: "worker not found" }),
  });
  await assert.rejects(ambiguous.secretList("woodshed-staging-synthetic"), /Wrangler command failed/);
});

test("live Wrangler methods remain staging-scoped, bounded, and keep credentials out of arguments", async () => {
  const calls: any[] = [];
  const adapter = createWranglerAdapter({
    root: "/repo",
    token: "private-token-value",
    accountId: "a".repeat(32),
    configPath: "/repo/.cloudflare-staging/run-safe/wrangler.json",
    spawn: async (file: string, args: string[], options: any) => {
      calls.push({ file, args, options });
      if (args[0] === "whoami") return { exitCode: 0, stdout: "a".repeat(32), stderr: "" };
      if (args[0] === "d1" && args[1] === "list") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (["deployments", "versions", "secret"].includes(args[0]!)) return { exitCode: 0, stdout: "[]", stderr: "" };
      if (args[0] === "d1" && args[1] === "time-travel") return { exitCode: 0, stdout: JSON.stringify({ bookmark: "bookmark-synthetic" }), stderr: "" };
      if (args[0] === "d1" && args[1] === "execute") return { exitCode: 0, stdout: JSON.stringify([{ success: true, results: [] }]), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await adapter.whoami("a".repeat(32));
  await adapter.d1List();
  await adapter.deploymentsList("woodshed-staging-synthetic");
  await adapter.versionsList("woodshed-staging-synthetic");
  await adapter.secretList("woodshed-staging-synthetic");
  await adapter.d1Create("woodshed-staging-synthetic-db");
  await adapter.d1TimeTravelInfo("woodshed-staging-synthetic-db");
  await adapter.d1Execute("woodshed-staging-synthetic-db", { command: "SELECT 1" });
  await adapter.d1MigrationsApply("woodshed-staging-synthetic-db");
  await adapter.deploy("woodshed-staging-synthetic");
  await adapter.secretDelete("LIVE_COMMAND_SECRET", "woodshed-staging-synthetic");
  await adapter.deleteWorker("woodshed-staging-synthetic");
  await adapter.d1Delete("woodshed-staging-synthetic-db");

  for (const call of calls) {
    assert.deepEqual(call.args.slice(-4), ["--config", "/repo/.cloudflare-staging/run-safe/wrangler.json", "--env", "staging"]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.CLOUDFLARE_API_TOKEN, "private-token-value");
    assert.equal(call.options.env.CLOUDFLARE_ACCOUNT_ID, "a".repeat(32));
    assert.equal(call.options.env.LIVE_COMMAND_SECRET, undefined);
    assert.equal(call.options.env.WOODSHED_STAGING_ORGANIZER_TOKEN, undefined);
  }
  assert.doesNotMatch(JSON.stringify(calls.map(({ file, args }) => ({ file, args }))), /private-token-value/);
  await assert.rejects(adapter.deploy("production"), /safe staging Worker name/);
  await assert.rejects(adapter.d1Create("production"), /safe staging database name/);
});

test("bounded subprocess output and timeout terminate reliably without double settlement", async () => {
  function childProcess() {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: (signal: string) => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true;
    return child;
  }

  const overflowing = childProcess();
  const overflow = runBoundedSubprocess("wrangler", [], { cwd: "/repo", env: {}, timeoutMs: 100, maxOutputBytes: 8, spawn: () => overflowing });
  overflowing.stdout.write("123456789");
  overflowing.emit("close", null, "SIGTERM");
  await assert.rejects(overflow, /output limit/);

  const timedOut = childProcess();
  const signals: string[] = [];
  timedOut.kill = (signal) => { signals.push(signal); return true; };
  await assert.rejects(runBoundedSubprocess("wrangler", [], {
    cwd: "/repo", env: {}, timeoutMs: 5, killGraceMs: 5, spawn: () => timedOut,
  }), /timed out/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("structured output and exact filename-only ledger fail closed without private digest provenance", () => {
  assert.throws(() => reconcileMigrationLedger({ remote: "not-json", manifest: D1_MIGRATIONS, journal: journal() }), /malformed/);
  assert.throws(() => reconcileMigrationLedger({ remote: [{ name: D1_MIGRATIONS[1]!.filename }], manifest: D1_MIGRATIONS, journal: journal() }), /exact prefix/);
  assert.throws(() => reconcileMigrationLedger({ remote: [{ name: D1_MIGRATIONS[0]!.filename }], manifest: D1_MIGRATIONS, journal: journal() }), /provenance/);
});

test("shared-account preflight allows declared protected inventory and blocks undeclared or targeted identities", () => {
  const forbiddenDatabaseId = "33333333-3333-4333-8333-333333333333";
  const inventory = { staging: identity, forbidden: {
    accountIds: ["c".repeat(32)], databaseIds: [forbiddenDatabaseId],
    origins: ["https://community.invalid"], workerNames: ["woodshed-community", "hootenanny-live"],
  } };
  const empty = { accountId: identity.accountId, databases: [], workers: [], routes: [], secretNames: [], deployments: [] };
  assert.deepEqual(assertCredentialedPreflight(inventory, empty, { localSecretAvailable: true }), {
    accountScope: "shared-account-staging", targetAbsent: true, secretInventoryReadable: true,
  });
  const declaredProtected = {
    ...empty,
    databases: [{ id: forbiddenDatabaseId.toUpperCase(), name: "HoOtEnAnNy-Live" }],
    workers: [{ name: "Hootenanny-Live" }, { name: "Woodshed-Community" }],
    routes: [
      { pattern: "community.invalid/*", script: "hootenanny-live" },
      { pattern: "*.community.invalid/*", script: "hootenanny-live" },
    ],
  };
  assert.equal(assertSharedAccountInventory(inventory, declaredProtected), true);
  assert.deepEqual(assertCredentialedPreflight(inventory, declaredProtected, { localSecretAvailable: true }), {
    accountScope: "shared-account-staging", targetAbsent: true, secretInventoryReadable: true,
  });
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, secretNames: null }, { localSecretAvailable: true }), /unreadable/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, workers: [{ name: "PrOdUcTiOn-Sibling" }] }, { localSecretAvailable: true }), /undeclared protected-looking target/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, databases: [{ id: "22222222-2222-4222-8222-222222222222", name: "Hootenanny-Live" }] }, { localSecretAvailable: true }), /undeclared protected-looking target/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, routes: [{ pattern: "production.invalid/*", script: "neutral" }] }, { localSecretAvailable: true }), /undeclared protected-looking target/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, routes: [{ pattern: "neutral.invalid/PrOdUcTiOn/*", script: "neutral" }] }, { localSecretAvailable: true }), /undeclared protected-looking target/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, routes: [{ hostname: "neutral.invalid", script: "hoot-api", environment: "production" }] }, { localSecretAvailable: true }), /undeclared protected-looking target/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, routes: [{ pattern: "*", script: "neutral" }] }, { localSecretAvailable: true }), /unreadable route inventory/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, workers: [{ name: identity.workerName }] }, { localSecretAvailable: true }), /already exists/);
  assert.throws(() => assertCredentialedPreflight(inventory, { ...empty, databases: [{ id: "22222222-2222-4222-8222-222222222222", name: identity.databaseName }] }, { localSecretAvailable: true }), /already exists/);
  assert.throws(() => assertCredentialedPreflight(inventory, empty), /secret continuity/);

  assert.throws(() => assertSharedAccountInventory({
    ...inventory,
    staging: { ...identity, workerName: "hootenanny-live" },
  }, empty), /declared forbidden target/);
  assert.throws(() => assertSharedAccountInventory({
    ...inventory,
    staging: { ...identity, databaseId: forbiddenDatabaseId.toUpperCase() },
  }, empty), /declared forbidden target/);
  assert.throws(() => assertSharedAccountInventory({
    ...inventory,
    staging: { ...identity, origin: "https://community.invalid" },
  }, empty), /declared forbidden target/);
});

test("empty forbidden account IDs preserve shared-account deployment guards", () => {
  const inventory = { staging: identity, forbidden: {
    accountIds: [], databaseIds: ["33333333-3333-4333-8333-333333333333"],
    origins: ["https://community.invalid"], workerNames: ["woodshed-community", "hootenanny-live"],
  } };
  const matchingRemote = { accountId: identity.accountId, databases: [], workers: [], routes: [], secretNames: [], deployments: [] };

  assert.deepEqual(assertCredentialedPreflight(inventory, matchingRemote, { localSecretAvailable: true }), {
    accountScope: "shared-account-staging", targetAbsent: true, secretInventoryReadable: true,
  });
  assert.throws(
    () => assertSharedAccountInventory(inventory, { ...matchingRemote, accountId: "d".repeat(32) }),
    /authenticated Cloudflare account does not match staging inventory/,
  );

  const forbiddenAccountId = "c".repeat(32);
  assert.throws(() => assertSharedAccountInventory({
    ...inventory,
    staging: { ...inventory.staging, accountId: forbiddenAccountId },
    forbidden: { ...inventory.forbidden, accountIds: [forbiddenAccountId] },
  }, { ...matchingRemote, accountId: forbiddenAccountId }), /declared forbidden target/);
});

test("assigned D1 UUID is journaled with ownership before provisioning continues", async () => {
  const state = journal();
  delete (state.identity as any).databaseId;
  let persisted = false;
  const assigned = await persistAssignedDatabaseIdentity({
    journal: state,
    database: { id: identity.databaseId, name: identity.databaseName },
    persistJournal: async () => { persisted = true; },
  });
  assert.equal(assigned, identity.databaseId);
  assert.equal(state.identity.databaseId, identity.databaseId);
  assert.deepEqual(state.resources.at(-1), { domain: "d1", id: identity.databaseId, runId: state.runId, owner: state.owner });
  assert.equal(persisted, true);
});

test("schema verification covers foreign keys, strict objects, choice seed, and migration 009 preservation", () => {
  const expected = {
    foreignKeysEnabled: true,
    foreignKeyViolations: 0,
    tables: ["events", "event_participants"],
    indexes: ["idx_event_participants_event"],
    triggers: ["seed_event_choice_config"],
    constraints: ["participant_event_composite", "recovery_token_unique"],
    definitionDigest: "d".repeat(64),
    choiceConfigSeeded: true,
    migration009: { beforeRows: 3, afterRows: 3, beforeAssociations: 3, afterAssociations: 3, beforeAssociationDigest: "f".repeat(64), afterAssociationDigest: "f".repeat(64) },
  };
  assert.doesNotThrow(() => assertSchemaInvariants(expected, {
    tables: expected.tables, indexes: expected.indexes, triggers: expected.triggers, constraints: expected.constraints, definitionDigest: expected.definitionDigest,
  }));
  assert.throws(() => assertSchemaInvariants({ ...expected, foreignKeyViolations: 1 }, expected), /foreign key/i);
  assert.throws(() => assertSchemaInvariants({ ...expected, migration009: { ...expected.migration009, afterAssociations: 2 } }, expected), /preservation/i);
  assert.throws(() => assertSchemaInvariants({ ...expected, migration009: { ...expected.migration009, afterAssociationDigest: "0".repeat(64) } }, expected), /preservation/i);
  assert.throws(() => assertSchemaInvariants({ ...expected, definitionDigest: "e".repeat(64) }, expected), /definition fingerprint/i);
  for (const field of ["beforeRows", "afterRows", "beforeAssociations", "afterAssociations"] as const) {
    for (const invalid of [undefined, null, "3", -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => assertSchemaInvariants({ ...expected, migration009: { ...expected.migration009, [field]: invalid } }, expected),
        /preservation/i,
        `expected ${field}=${String(invalid)} to fail closed`,
      );
    }
  }
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
  assert.deepEqual(events, ["persist", "migrate", "verify-migration", "persist", "verify-schema", "persist", "deploy", "verify-deploy", "persist", "persist"]);
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

test("deployment fails closed when the final remote migration ledger is incomplete", async () => {
  const first = D1_MIGRATIONS[0]!;
  let deployments = 0;
  let schemaVerifications = 0;
  await assert.rejects(runMigrationFirstDeployment({
    journal: journal(), lease, manifest: [first], expectedSnapshot: { revision: "same" },
    inspectSnapshot: async () => ({ revision: "same" }),
    inspectLedger: async () => [],
    persistJournal: async () => {},
    applyMigration: async () => {},
    verifyMigration: async () => true,
    verifyFinalSchema: async () => { schemaVerifications += 1; },
    deployWorker: async () => { deployments += 1; return { deploymentId: "must-not-deploy" }; },
    verifyDeployment: async () => {},
  }), /remote migration ledger is incomplete before deploy/);
  assert.equal(schemaVerifications, 0);
  assert.equal(deployments, 0);
});

test("restart reconciles pending migration and deployment intents from remote state without replay", async () => {
  const first = D1_MIGRATIONS[0]!;
  const state = journal();
  state.migrations.push({ filename: first.filename, sha256: first.sha256, sourceSha, status: "pending" });
  state.mutations.push({ kind: "worker-deploy", status: "pending", sourceSha });
  let migrations = 0; let deployments = 0; let persists = 0;
  const deployed = { deploymentId: "version-recovered" };
  const result = await runMigrationFirstDeployment({
    journal: state, lease, manifest: [first], expectedSnapshot: { revision: "same" },
    inspectSnapshot: async () => ({ revision: "same" }),
    inspectLedger: async () => [{ name: first.filename }],
    persistJournal: async () => { persists += 1; },
    applyMigration: async () => { migrations += 1; },
    verifyMigration: async () => true,
    verifyFinalSchema: async () => {},
    deployWorker: async () => { deployments += 1; throw new Error("must not replay"); },
    inspectDeployment: async () => deployed,
    verifyDeployment: async (actual: unknown) => assert.equal(actual, deployed),
  });
  assert.equal(migrations, 0);
  assert.equal(deployments, 0);
  assert.equal(state.migrations[0]!.status, "applied");
  assert.equal((state.mutations[0] as any).status, "applied");
  assert.equal(result.deployment, deployed);
  assert.ok(persists >= 2);
});

test("deployment response loss is reconciled only after durable intent and remote verification", async () => {
  const state = journal();
  const events: string[] = [];
  const deployed = { deploymentId: "version-after-loss" };
  const result = await runMigrationFirstDeployment({
    journal: state, lease, manifest: [], expectedSnapshot: { revision: "same" },
    inspectSnapshot: async () => ({ revision: "same" }), inspectLedger: async () => [],
    persistJournal: async () => { events.push(`persist:${(state.mutations.at(-1) as any)?.status ?? "none"}`); },
    applyMigration: async () => {}, verifyMigration: async () => true, verifyFinalSchema: async () => {},
    deployWorker: async () => { events.push("deploy"); throw new Error("response lost"); },
    inspectDeployment: async () => { events.push("inspect-deployment"); return deployed; },
    verifyDeployment: async () => { events.push("verify-deployment"); },
  });
  assert.equal(result.deployment, deployed);
  assert.deepEqual(events, ["persist:pending", "deploy", "inspect-deployment", "verify-deployment", "persist:applied", "persist:applied"]);
});
