import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  collectRemoteInventory,
  createApiTokenClient,
  createIdentityRevision,
  executeJournaledMutation,
  generateEffectiveConfig,
  parseLiveArguments,
  publicOperationResult,
  runLiveOperation,
} from "../../../tools/cloudflare/live-driver.mjs";
import { createJournal, saveJournal, validateJournal } from "../../../tools/cloudflare/journal.mjs";
import { createEvidenceEnvelope } from "../../../tools/cloudflare/evidence.mjs";
import { D1_MIGRATIONS } from "../../../tools/cloudflare/migrations.mjs";
import { publicErrorMessage } from "../../../tools/cloudflare-staging.mjs";

const sourceSha = "a".repeat(40);
const accountId = "b".repeat(32);
const databaseId = "11111111-2222-4333-8444-555555555555";
const workerName = "woodshed-staging-synthetic";
const origin = `https://${workerName}.synthetic.workers.dev`;

function inventory() {
  return {
    environment: "staging",
    expectedSourceSha: sourceSha,
    staging: { accountId, databaseId, databaseName: `${workerName}-db`, origin, workerName },
    forbidden: {
      accountIds: ["c".repeat(32)],
      databaseIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
      origins: ["https://protected.invalid"],
      workerNames: ["protected-worker"],
    },
  };
}

async function failedApplyFixture(t: any, { quarantineFails = false } = {}) {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-incident-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-incident-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const freshInventory = inventory();
  delete (freshInventory.staging as Partial<typeof freshInventory.staging>).databaseId;
  await writeFile(inventoryPath, JSON.stringify(freshInventory));

  const databases: Array<{ uuid: string; name: string }> = [];
  const applyFailure = new Error("synthetic post-provision apply failure");
  let quarantineInspections = 0;
  const adapterFactory = () => ({
    whoami: async () => ({ accountId }),
    d1List: async () => databases,
    deploymentsList: async () => [],
    versionsList: async () => [],
    secretList: async () => [],
    d1Create: async (name: string) => { databases.push({ uuid: databaseId, name }); },
    d1TimeTravelInfo: async () => { throw applyFailure; },
  });
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectAccountSubdomain: async () => "synthetic",
    inspectWorkersDev: async () => {
      quarantineInspections += 1;
      if (quarantineFails) throw new Error("synthetic quarantine failure");
      return { exists: false, enabled: false };
    },
  };
  const common = {
    root: testRoot,
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: "run-incident",
    owner: "owner-incident",
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory,
    tokenClientFactory: () => tokenClient,
    fetch: async () => new Response(null, { status: 404 }),
  };
  await runLiveOperation({ ...common, operation: "plan" }, dependencies);
  return { applyFailure, common, dependencies, journalPath, quarantineInspections: () => quarantineInspections };
}

test("live CLI requires the explicit staging environment and closed flag set", () => {
  const parsed = parseLiveArguments([
    "apply", "--env", "staging", "--inventory", "/private/inventory.json",
    "--journal", "/private/journal.json", "--run-id", "run-a", "--owner", "owner-a",
  ]);
  assert.equal(parsed.operation, "apply");
  assert.equal(parsed.environment, "staging");
  assert.throws(() => parseLiveArguments(["apply", "--env", "default"]), /explicit staging environment/);
  assert.throws(() => parseLiveArguments(["apply", "--env", "staging", "--unknown", "value"]), /unknown option/);
  assert.throws(() => parseLiveArguments(["preflight", "--env", "staging", "--allow-protected", "true"]), /unknown option/);
  assert.throws(() => parseLiveArguments(["promote", "--env", "staging"]), /unknown staging operation/);
});

test("the executable boundary emits neither configured secrets nor private identifiers", () => {
  const token = "synthetic-cloud-token-private";
  const liveSecret = "s".repeat(40);
  const message = publicErrorMessage(new Error(`failed ${token} ${liveSecret}`), { CLOUDFLARE_API_TOKEN: token, LIVE_COMMAND_SECRET: liveSecret });
  assert.doesNotMatch(message, new RegExp(`${token}|${liveSecret}|${accountId}|${databaseId}|${workerName}`));
  assert.match(message, /\[REDACTED\]/);
});

test("effective config is run-isolated, explicit, content-attested, and supports a unique deletion lifecycle", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "woodshed-live-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = await generateEffectiveConfig({ root, runId: "run-a", inventory: inventory(), databaseId, sourceSha, workersDev: true });
  const parsed = JSON.parse(await readFile(active.configPath, "utf8"));
  assert.equal(parsed.env.staging.name, workerName);
  assert.equal(parsed.env.staging.workers_dev, true);
  assert.equal(parsed.env.staging.preview_urls, false);
  assert.equal(parsed.env.staging.vars.WOODSHED_SOURCE_SHA, sourceSha);
  assert.equal(parsed.env.staging.vars.WOODSHED_CONFIG_DIGEST, active.configDigest);
  assert.match(active.configPath, /\.cloudflare-staging/);
  assert.match(active.configDigest, /^[a-f0-9]{64}$/);

  const deletion = await generateEffectiveConfig({ root, runId: "run-a", inventory: inventory(), databaseId, sourceSha, workersDev: false, deleteDurableObject: true });
  const deletionConfig = JSON.parse(await readFile(deletion.configPath, "utf8"));
  assert.match(deletion.deletionTag ?? "", /^woodshed-staging-delete-[a-f0-9]{16}$/);
  assert.deepEqual(deletionConfig.env.staging.migrations.at(-1).deleted_classes, ["LiveCoordinator"]);
  assert.notEqual(deletion.deletionTag, deletionConfig.env.staging.migrations[0].tag);
  assert.equal(deletionConfig.main, "./teardown-worker.mjs");
  assert.doesNotMatch(await readFile(path.join(path.dirname(deletion.configPath), "teardown-worker.mjs"), "utf8"), /LiveCoordinator/);
});

test("authenticated collectors compose every preflight inventory surface", async () => {
  const calls: string[] = [];
  const adapter = {
    whoami: async () => { calls.push("whoami"); return { accountId }; },
    d1List: async () => { calls.push("d1-list"); return [{ uuid: databaseId, name: "neutral-staging-db" }]; },
    deploymentsList: async () => { calls.push("deployments-list"); return [{ id: "deployment-synthetic", script_name: "neutral-staging-worker", routes: [] }]; },
    versionsList: async () => { calls.push("versions-list"); return [{ id: "version-synthetic", script_name: "neutral-staging-worker" }]; },
    secretList: async () => { calls.push("secret-list"); return [{ name: "SAFE_NAME" }]; },
  };
  const remote = await collectRemoteInventory({ adapter, inventory: inventory() });
  assert.deepEqual(calls.sort(), ["d1-list", "deployments-list", "secret-list", "versions-list", "whoami"]);
  assert.equal(remote.accountId, accountId);
  assert.deepEqual(remote.databases, [{ id: databaseId, name: "neutral-staging-db" }]);
  assert.deepEqual(remote.secretNames, ["SAFE_NAME"]);
  assert.deepEqual(remote.workers, [{ name: "neutral-staging-worker" }]);
  assert.deepEqual(remote.routes, []);
});

test("identity revisions are stable across provider ordering and duplicate entries", () => {
  const first = {
    accountId,
    databases: [{ id: "2", name: "staging-b" }, { id: "1", name: "staging-a" }],
    workers: [{ name: "staging-b" }, { name: "staging-a" }],
    routes: [{ pattern: "b/*", script: "staging-b" }, { pattern: "a/*", script: "staging-a" }],
  };
  const second = {
    accountId,
    databases: [first.databases[1], first.databases[0], first.databases[1]],
    workers: [first.workers[1], first.workers[0]],
    routes: [first.routes[1], first.routes[0], first.routes[1]],
  };
  assert.equal(createIdentityRevision(first), createIdentityRevision(second));
});

test("journaled mutation persists intent before write, aborts drift, and reconciles response loss", async () => {
  const identity = inventory().staging;
  const journal = createJournal({ runId: "run-a", owner: "owner-a", sourceSha, identity });
  const calls: string[] = [];
  let exists = false;
  const result = await executeJournaledMutation({
    journal,
    expectedRevision: "revision-a",
    inspectRevision: async () => { calls.push("identity-read"); return "revision-a"; },
    resource: { domain: "worker", id: workerName },
    kind: "worker-create",
    persistJournal: async () => { calls.push("persist"); },
    inspect: async () => { calls.push("inspect"); return { exists, id: workerName }; },
    mutate: async () => { calls.push("mutate"); exists = true; throw new Error("response lost"); },
    owns: (state) => state.id === workerName,
  });
  assert.deepEqual(calls, ["identity-read", "persist", "inspect", "identity-read", "mutate", "inspect", "persist"]);
  assert.equal(result.reconciled, true);
  assert.equal(journal.mutations[0]?.status, "applied");
  assert.equal(journal.resources[0]?.domain, "worker");

  let mutations = 0;
  await assert.rejects(executeJournaledMutation({
    journal: createJournal({ runId: "run-b", owner: "owner-a", sourceSha, identity }),
    expectedRevision: "revision-a",
    inspectRevision: async () => "revision-b",
    resource: { domain: "d1", id: "planned-database" }, kind: "d1-create",
    persistJournal: async () => {}, inspect: async () => ({ exists: false }),
    mutate: async () => { mutations += 1; }, owns: () => false,
  }), /remote identity changed/);
  assert.equal(mutations, 0);

  const uncertain = createJournal({ runId: "run-c", owner: "owner-a", sourceSha, identity });
  uncertain.resources.push({ domain: "secret", id: "LIVE_COMMAND_SECRET", runId: uncertain.runId, owner: uncertain.owner });
  uncertain.mutations.push({ kind: "secret-put", domain: "secret", id: "LIVE_COMMAND_SECRET", status: "pending" });
  await assert.rejects(executeJournaledMutation({
    journal: uncertain, expectedRevision: "revision-a", inspectRevision: async () => "revision-a",
    resource: { domain: "secret", id: "LIVE_COMMAND_SECRET" }, kind: "secret-put",
    persistJournal: async () => {}, inspect: async () => ({ exists: false }),
    mutate: async () => { mutations += 1; }, owns: () => true,
  }), /no replay authorized/);
  assert.equal(mutations, 0);
});

test("credentialed preflight calls no mutation and its public result contains no target identity", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-private-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  await writeFile(inventoryPath, JSON.stringify(inventory()));
  let mutations = 0;
  const adapter = {
    whoami: async () => ({ accountId }), d1List: async () => [], deploymentsList: async () => [],
    versionsList: async () => [], secretList: async () => [],
    d1Create: async () => { mutations += 1; }, deploy: async () => { mutations += 1; },
  };
  const result = await runLiveOperation({
    operation: "preflight", environment: "staging", inventoryPath,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  });
  assert.equal(mutations, 0);
  const output = JSON.stringify(publicOperationResult(result));
  assert.doesNotMatch(output, new RegExp(`${accountId}|${databaseId}|${workerName}`));
  assert.deepEqual(JSON.parse(output), { operation: "preflight", ok: true, mutationCount: 0, accountScope: "shared-account-staging" });
});

test("declared protected siblings are allowed while clean staging targets remain untouched", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-shared-account-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const sharedInventory = inventory();
  sharedInventory.forbidden.workerNames.push("hootenanny-live");
  sharedInventory.forbidden.origins.push("https://production-live.invalid");
  const stagingBefore = structuredClone(sharedInventory.staging);
  await writeFile(inventoryPath, JSON.stringify(sharedInventory));
  let mutations = 0;
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => [{ uuid: sharedInventory.forbidden.databaseIds[0]!.toUpperCase(), name: "HoOtEnAnNy-Live" }],
    deploymentsList: async () => [], versionsList: async () => [], secretList: async () => [],
    d1Create: async () => { mutations += 1; }, deploy: async () => { mutations += 1; },
  };
  const result = await runLiveOperation({
    operation: "preflight", environment: "staging", inventoryPath,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => ({
      inspect: async () => ({ active: true, id: "borrowed-operator-token" }),
      listWorkerScripts: async () => [{ name: "HoOtEnAnNy-Live" }],
      listWorkerRoutes: async () => [
        { pattern: "production-live.invalid/*", script: "HoOtEnAnNy-Live" },
        { pattern: "*.production-live.invalid/*", script: "HoOtEnAnNy-Live" },
      ],
      listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic",
    }),
  });
  assert.equal(result.accountScope, "shared-account-staging");
  assert.equal(result.mutationCount, 0);
  assert.equal(mutations, 0);
  assert.deepEqual(sharedInventory.staging, stagingBefore);
});

test("every preflight failure path remains read-only and boundary errors disclose no private values", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-preflight-failures-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  await writeFile(inventoryPath, JSON.stringify(inventory()));
  const environment = { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) };
  let mutations = 0;
  const readOnlyAdapter = (workerEntries: Array<{ name: string }> = []) => ({
    whoami: async () => ({ accountId }),
    d1List: async () => [],
    deploymentsList: async () => workerEntries,
    versionsList: async () => [],
    secretList: async () => [],
    d1Create: async () => { mutations += 1; },
    deploy: async () => { mutations += 1; },
  });
  const input = { operation: "preflight", environment: "staging", inventoryPath, processEnvironment: environment };
  const sourceState = () => ({ actualSourceSha: sourceSha, worktreeClean: true });

  await assert.rejects(runLiveOperation({ ...input, processEnvironment: { CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN } }, {
    sourceState, adapterFactory: () => readOnlyAdapter(), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /live command secret environment variable/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(), tokenClientFactory: () => ({ inspect: async () => ({ active: false }) }),
  }), /operator token is not active/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter([{ name: "HoOtEnAnNy-Unlisted" }]), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [{ name: "production-worker" }], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation(input, {
    sourceState,
    adapterFactory: () => ({ ...readOnlyAdapter(), d1List: async () => { throw new Error(`${accountId} ${databaseId} ${workerName} synthetic-cloud-token`); } }),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), (error: any) => {
    assert.equal(error.message, "credentialed Cloudflare inventory collection failed");
    assert.doesNotMatch(error.message, new RegExp(`${accountId}|${databaseId}|${workerName}|synthetic-cloud-token`));
    return true;
  });
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "different-account" }),
  }), /origin does not belong to the authenticated account/);
  await assert.rejects(runLiveOperation(input, {
    sourceState,
    adapterFactory: () => ({
      ...readOnlyAdapter(),
      deploymentsList: async (name: string) => name === "neutral-worker" ? [{ script_name: name, routes: [{ pattern: "production.example.invalid/*" }] }] : [],
    }),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [{ name: "neutral-worker" }], listWorkerRoutes: async () => [{ pattern: "production.example.invalid/*", script: "neutral-worker" }], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation({ ...input, processEnvironment: { ...environment, CLOUDFLARE_PREFLIGHT_BYPASS: "true" } }, {
    sourceState, adapterFactory: () => readOnlyAdapter([{ name: "HoOtEnAnNy-Unlisted" }]), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [{ pattern: "staging.example.invalid/*", script: workerName }], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /already exists/);
  assert.equal(mutations, 0);
});

test("private-path enforcement resolves symlinked parents before reading", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-public-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "woodshed-live-path-check-"));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(testRoot, "inventory.json"), JSON.stringify(inventory()));
  const linked = path.join(outside, "private-link");
  await symlink(testRoot, linked, "dir");
  await assert.rejects(runLiveOperation({
    operation: "preflight", environment: "staging", root: testRoot,
    inventoryPath: path.join(linked, "inventory.json"),
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  }, { sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }) }), /outside the public repository/);
});

test("deployment token lifecycle uses authorization headers and never URL or body credentials", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let active = true;
  const client = createApiTokenClient({
    token: "synthetic-cloud-token",
    apiBase: "https://api.synthetic.invalid/tokens",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    zoneApiBase: "https://api.synthetic.invalid/zones",
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/zones?")) return Response.json({ success: true, result: [{ id: "zone-synthetic" }], result_info: { total_pages: 1 } });
      if (url.includes("/workers/routes")) return Response.json({ success: true, result: [{ pattern: "staging.example.invalid/*", script: "neutral-staging-worker" }], result_info: { total_pages: 1 } });
      if (url.includes("/workers/domains")) return Response.json({ success: true, result: [{ hostname: "staging.example.invalid", service: "neutral-staging-worker", environment: "staging" }], result_info: { total_pages: 1 } });
      if (url.endsWith("/workers/subdomain")) return Response.json({ success: true, result: { subdomain: "synthetic" } });
      if (url.includes("/subdomain")) return Response.json({ success: true, result: { enabled: false, previews_enabled: true } });
      if (url.includes("workers/scripts")) return Response.json({ success: true, result: [{ id: "neutral-staging-worker" }], result_info: { total_pages: 1 } });
      if (init.method === "DELETE") { active = false; return Response.json({ success: true, result: {} }); }
      return active
        ? Response.json({ success: true, result: { id: "synthetic-token-id", status: "active" } })
        : new Response(null, { status: 401 });
    },
  });
  const state = await client.inspect();
  assert.equal(state.active, true);
  assert.equal((await client.inspectId(state.id)).active, true);
  assert.deepEqual(await client.listWorkerScripts(accountId), [{ name: "neutral-staging-worker" }]);
  const incomplete = createApiTokenClient({ token: "synthetic-token", fetch: async () => Response.json({ success: true, result: [], result_info: { total_pages: 2 } }) });
  await assert.rejects(incomplete.listWorkerScripts(accountId), /unreadable or incomplete/);
  assert.deepEqual(await client.inspectWorkersDev(accountId, workerName), { exists: true, enabled: true });
  assert.equal(await client.inspectAccountSubdomain(accountId), "synthetic");
  assert.deepEqual(await client.listWorkerRoutes(accountId), [{ pattern: "staging.example.invalid/*", script: "neutral-staging-worker" }]);
  assert.deepEqual(await client.listWorkerDomains(accountId), [{ hostname: "staging.example.invalid", script: "neutral-staging-worker", environment: "staging" }]);
  await client.revoke(state.id);
  assert.deepEqual(await client.inspect(), { exists: null, active: null, unauthorized: true });
  assert.ok(calls.every(({ url, init }) => !url.includes("synthetic-cloud-token") && init.body === undefined));
  assert.ok(calls.every(({ init }) => new Headers(init.headers).get("authorization") === `${"Bear"}er synthetic-cloud-token`));

  const forbidden = createApiTokenClient({ token: "synthetic-cloud-token", fetch: async () => new Response(null, { status: 403 }) });
  await assert.rejects(forbidden.inspect(), /unauthorized/);

  const unreadablePreview = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    fetch: async () => Response.json({ success: true, result: { enabled: false } }),
  });
  await assert.rejects(unreadablePreview.inspectWorkersDev(accountId, workerName), /exposure inventory is unreadable/);
});

test("teardown revokes a journal-owned run-minted token without revoking the borrowed operator token", async (t) => {
  const borrowed = createJournal({ runId: "run-borrowed", owner: "owner-borrowed", sourceSha, identity: inventory().staging });
  borrowed.resources.push({ domain: "token", id: "borrowed-operator-token-id", runId: borrowed.runId, owner: borrowed.owner } as any);
  assert.throws(() => validateJournal(borrowed), /token must be run-minted/);

  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-minted-token-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-minted-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  await writeFile(inventoryPath, JSON.stringify(inventory()));
  const remote = { accountId, databases: [], workers: [], routes: [], secretNames: [], deployments: [], versions: [] };
  const owned = createJournal({ runId: "run-minted", owner: "owner-minted", sourceSha, identity: inventory().staging });
  owned.phase = "quarantined";
  const revision = createIdentityRevision(remote);
  (owned as any).preflight = { protectedRevision: revision, targetRevision: revision, operatorTokenPresent: true };
  (owned as any).lease = { active: true, runId: owned.runId, owner: owned.owner, revision };
  (owned as any).acceptance = { status: "not-run", cleanupComplete: false };
  const deletion = await generateEffectiveConfig({ root: testRoot, runId: owned.runId, inventory: inventory(), databaseId, sourceSha, deleteDurableObject: true });
  owned.mutations.push({
    kind: "durable-object-delete", domain: "durable-object", id: "durable-owned", status: "applied",
    tag: deletion.deletionTag, configDigest: deletion.configDigest,
    beforeDeploymentIds: ["deployment-before"], afterDeploymentIds: ["deployment-after"],
  } as any);
  for (const [domain, id] of [
    ["route", "route-owned"], ["hostname", "hostname-owned"], ["credential", "credential-owned"],
    ["secret", "secret-owned"], ["worker", workerName], ["durable-object", "durable-owned"], ["d1", databaseId],
  ] as const) owned.resources.push({ domain, id, runId: owned.runId, owner: owned.owner });
  owned.resources.push({ domain: "token", id: "run-minted-token-id", provenance: "run-minted", runId: owned.runId, owner: owned.owner } as any);
  await writeFile(journalPath, JSON.stringify(owned));

  let mintedActive = true;
  const revoked: string[] = [];
  const adapter = {
    whoami: async () => ({ accountId }), d1List: async () => [], deploymentsList: async () => [],
    versionsList: async () => [], secretList: async () => [], d1Execute: async () => [{ success: true, results: [] }],
  };
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "borrowed-operator-token-id" }),
    inspectId: async (id: string) => id === "run-minted-token-id" && mintedActive ? { exists: true, active: true, id } : { exists: false, active: false, id },
    listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [],
    inspectWorkersDev: async () => ({ exists: false, enabled: false }),
    revoke: async (id: string) => { revoked.push(id); mintedActive = false; },
  };
  const result = await runLiveOperation({
    operation: "teardown", environment: "staging", root: testRoot, inventoryPath, journalPath,
    runId: owned.runId, owner: owned.owner, processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token" },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter, tokenClientFactory: () => tokenClient,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  });
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.absenceCount, 8);
  assert.deepEqual(revoked, ["run-minted-token-id"]);
  assert.equal((await tokenClient.inspect()).active, true);
});

test("apply failure after D1 identity assignment records an incident, quarantines, and rethrows", async (t) => {
  const fixture = await failedApplyFixture(t);
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error) => error === fixture.applyFailure);

  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.identity.databaseId, databaseId);
  assert.deepEqual(journal.incident, {
    failedPhase: "resources-ready",
    owner: "owner-incident",
    nextAction: "reconcile-and-forward-fix-or-teardown",
    wholeStackRollback: false,
  });
  assert.equal(journal.phase, "quarantined");
  assert.equal(fixture.quarantineInspections(), 2);
  assert.deepEqual(journal.mutations.find((item: any) => item.kind === "workers-dev-disable"), {
    kind: "workers-dev-disable",
    domain: "route",
    id: journal.resources.find((item: any) => item.domain === "route").id,
    status: "applied",
    notRequired: true,
  });
});

test("apply failure marks quarantineFailed and warns that the origin must be treated as live", async (t) => {
  const fixture = await failedApplyFixture(t, { quarantineFails: true });
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error: any) => {
    assert.equal(error.message, "apply failed and automatic origin quarantine failed; treat the origin as live");
    assert.equal(error.cause, fixture.applyFailure);
    return true;
  });

  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.identity.databaseId, databaseId);
  assert.equal(journal.incident.failedPhase, "resources-ready");
  assert.equal(journal.incident.quarantineFailed, true);
  assert.equal(journal.incident.nextAction, "treat-origin-as-live-and-reconcile");
  assert.equal(journal.incident.wholeStackRollback, false);
  assert.equal(fixture.quarantineInspections(), 1);
});

test("preview-only exposure fails quarantine absence proof", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-preview-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-preview-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  await writeFile(inventoryPath, JSON.stringify(stagingInventory));

  const remoteWithoutTarget = { accountId, databases: [], workers: [], routes: [], deployments: [], versions: [] };
  const activeConfigDigest = "d".repeat(64);
  const journal = createJournal({ runId: "run-preview", owner: "owner-preview", sourceSha, identity: stagingInventory.staging });
  journal.phase = "verified";
  journal.preflight = { protectedRevision: createIdentityRevision(remoteWithoutTarget), targetRevision: "synthetic", operatorTokenPresent: true };
  journal.config = { activeDigest: activeConfigDigest };
  journal.resources.push({ domain: "route", id: "workers-dev-preview", runId: journal.runId, owner: journal.owner, status: "owned" });
  await saveJournal(journalPath, journal);

  let deployCalls = 0;
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => [{ uuid: databaseId, name: stagingInventory.staging.databaseName }],
    deploymentsList: async () => [{ id: "deployment-before", script_name: workerName }],
    versionsList: async () => [],
    secretList: async () => [],
    deploy: async () => { deployCalls += 1; },
  };
  const exposureClient = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    fetch: async () => Response.json({ success: true, result: { enabled: false, previews_enabled: true } }),
  });
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectWorkersDev: exposureClient.inspectWorkersDev,
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => tokenClient,
    fetch: async () => Response.json({
      sourceSha,
      configDigest: activeConfigDigest,
      lifecycle: "legacy-sqlite-v1",
      bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"],
    }),
  };
  await assert.rejects(runLiveOperation({
    root: testRoot,
    operation: "verify",
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: journal.runId,
    owner: journal.owner,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic" },
  }, dependencies), /origin quarantine absence proof failed/);
  assert.equal(deployCalls, 1);
});

test("mocked live boundaries complete plan through teardown in dependency order with absence proof", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-e2e-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  await mkdir(path.join(testRoot, "migrations", "d1"), { recursive: true });
  for (const migration of D1_MIGRATIONS) await copyFile(path.resolve("migrations/d1", migration.filename), path.join(testRoot, "migrations", "d1", migration.filename));
  const inventoryPath = path.join(privateDirectory, "inventory.json"), journalPath = path.join(privateDirectory, "journal.json");
  const freshInventory = inventory();
  delete (freshInventory.staging as Partial<typeof freshInventory.staging>).databaseId;
  await writeFile(inventoryPath, JSON.stringify(freshInventory));

  const schemaDatabase = new DatabaseSync(":memory:");
  t.after(() => schemaDatabase.close());
  schemaDatabase.exec("PRAGMA foreign_keys=ON");
  for (const migration of D1_MIGRATIONS) {
    const contents = await readFile(path.resolve("migrations/d1", migration.filename), "utf8");
    schemaDatabase.exec(contents);
  }
  const schemaObjects = schemaDatabase.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name").all();
  const state = {
    databases: [] as Array<{ uuid: string; name: string }>, deployments: [] as any[], versions: [] as any[],
    secrets: new Set<string>(), ledger: [] as string[], active: false, fixtureRows: 0, credentialActive: false,
    tokenActive: true, tokenId: "synthetic-token-id", durableDeleted: false, calls: [] as string[], revokedTokenIds: [] as string[], deploymentSequence: 0,
  };
  const assignedDatabaseId = databaseId;
  let activeDigest = "";
  let lastRemoteAction = "none";
  const read = <T>(value: T) => { lastRemoteAction = "read"; return value; };
  const assertIdentityRead = (mutation: string) => {
    assert.equal(lastRemoteAction, "identity-read", `${mutation} must be immediately preceded by a guarded identity read`);
    lastRemoteAction = mutation;
  };
  const adapterFactory = ({ configPath }: { configPath?: string }) => ({
    whoami: async () => read({ accountId }),
    d1List: async () => read(state.databases),
    deploymentsList: async () => read(state.deployments),
    versionsList: async () => read(state.versions),
    secretList: async () => read([...state.secrets].map((name) => ({ name }))),
    d1Create: async (name: string) => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.resources.some((item: any) => item.domain === "d1"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "d1-create" && item.status === "pending"));
      assertIdentityRead("d1-create");
      state.calls.push("d1-create"); state.databases = [{ uuid: assignedDatabaseId, name }]; throw new Error("response lost");
    },
    d1TimeTravelInfo: async () => read({ bookmark: "bookmark-synthetic" }),
    d1Execute: async (_name: string, options: { command?: string; file?: string }) => {
      if (options.file?.endsWith("synthetic-fixtures.sql")) { assertIdentityRead("fixture-seed"); state.fixtureRows = 8; state.credentialActive = true; return [{ success: true, results: [] }]; }
      if (options.file?.endsWith("revoke-organizer.sql")) { assertIdentityRead("credential-revoke"); state.credentialActive = false; state.calls.push("credential"); return [{ success: true, results: [] }]; }
      const command = options.command ?? "";
      if (command.includes("name='d1_migrations'")) return read([{ success: true, results: state.ledger.length ? [{ name: "d1_migrations" }] : [] }]);
      if (command.includes("FROM d1_migrations")) return read([{ success: true, results: state.ledger.map((name, id) => ({ id, name })) }]);
      if (command.includes("count(*) AS count FROM sqlite_schema")) return read([{ success: true, results: [{ count: Math.max(1, state.ledger.length) }] }]);
      if (command.includes("SELECT token_hash,participation_id FROM participation_recovery")) return read([{ success: true, results: [] }]);
      if (command.includes("SELECT type,name,sql FROM sqlite_schema")) return read([{ success: true, results: schemaObjects }]);
      if (command === "PRAGMA foreign_keys") return read([{ success: true, results: [{ foreign_keys: 1 }] }]);
      if (command === "PRAGMA foreign_key_check") return read([{ success: true, results: [] }]);
      if (command === "PRAGMA integrity_check") return read([{ success: true, results: [{ integrity_check: "ok" }] }]);
      if (command.includes("participant_sessions") && command.includes("revoked_at IS NULL")) return read([{ success: true, results: [{ count: state.credentialActive ? 1 : 0 }] }]);
      if (command.includes("UNION ALL")) return read([{ success: true, results: state.fixtureRows ? [{ count: 1 }, { count: 1 }, { count: 2 }, { count: 2 }, { count: 1 }, { count: 1 }] : [{ count: 0 }] }]);
      return read([{ success: true, results: [] }]);
    },
    d1MigrationsApply: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.equal(journal.migrations.at(-1).status, "pending");
      assertIdentityRead("migration-apply");
      state.calls.push(`migration-${state.ledger.length + 1}`); state.ledger.push(D1_MIGRATIONS[state.ledger.length]!.filename);
    },
    deploy: async () => {
      const config = JSON.parse(await readFile(configPath!, "utf8"));
      const staging = config.env.staging;
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      if (staging.migrations.some((item: any) => Array.isArray(item.deleted_classes))) assert.ok(journal.mutations.some((item: any) => item.kind === "durable-object-delete" && item.status === "pending"));
      else if (staging.workers_dev) assert.ok(journal.mutations.some((item: any) => item.kind === "workers-dev-enable" && item.status === "pending"));
      else if (!journal.mutations.some((item: any) => item.kind === "workers-dev-disable" && item.status === "pending")) {
        assert.ok(journal.mutations.some((item: any) => item.kind === "worker-deploy" && item.status === "pending"));
        assert.ok(journal.mutations.some((item: any) => item.kind === "durable-object-create" && item.status === "pending"));
      }
      assertIdentityRead("worker-deploy");
      state.active = staging.workers_dev === true;
      if (state.active) activeDigest = staging.vars.WOODSHED_CONFIG_DIGEST;
      state.durableDeleted = staging.migrations.some((item: any) => Array.isArray(item.deleted_classes));
      const id = `deployment-synthetic-${++state.deploymentSequence}`;
      state.deployments = [{ id, script_name: workerName, workers_dev: state.active }];
      state.versions = [{ id: `version-synthetic-${state.deploymentSequence}`, script_name: workerName }];
      state.calls.push(state.durableDeleted ? "durable-object" : state.active ? "route-enable" : "worker");
      const bindings = ["APP_ORIGIN", "DB", ...(state.secrets.has("LIVE_COMMAND_SECRET") ? ["LIVE_COMMAND_SECRET"] : []), ...(state.durableDeleted ? [] : ["LIVE_COORDINATOR"])];
      return { deploymentId: id, sourceSha, configDigest: staging.vars.WOODSHED_CONFIG_DIGEST, bindings, lifecycle: "legacy-sqlite-v1" };
    },
    secretPut: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "secret-put" && item.status === "pending"));
      assertIdentityRead("secret-put");
      state.secrets.add("LIVE_COMMAND_SECRET"); state.calls.push("secret-put");
    },
    secretDelete: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-secret" && item.status === "pending"));
      assertIdentityRead("secret-delete");
      state.secrets.clear(); state.calls.push("secret");
    },
    deleteWorker: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-worker" && item.status === "pending"));
      assertIdentityRead("worker-delete");
      state.deployments = []; state.versions = []; state.active = false; state.calls.push("worker-delete");
    },
    d1Delete: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-d1" && item.status === "pending"));
      assertIdentityRead("d1-delete");
      state.databases = []; state.calls.push("d1");
    },
  });
  const tokenClient = {
    inspect: async () => state.tokenActive ? { exists: true, active: true, id: state.tokenId } : { exists: false, active: false },
    inspectId: async (id: string) => state.tokenActive && id === state.tokenId ? { exists: true, active: true, id } : { exists: false, active: false },
    listWorkerScripts: async () => read([]),
    listWorkerRoutes: async () => read([]),
    listWorkerDomains: async () => { lastRemoteAction = "identity-read"; return []; },
    inspectWorkersDev: async () => read({ exists: state.deployments.length > 0, enabled: state.active }),
    inspectAccountSubdomain: async () => "synthetic",
    revoke: async (id: string) => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-token" && item.status === "pending"));
      state.revokedTokenIds.push(id); state.tokenActive = false; state.calls.push("token");
    },
  };
  const markerFetch = async (url: string) => state.active
    ? Response.json({ sourceSha, configDigest: activeDigest, lifecycle: "legacy-sqlite-v1", bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"] })
    : new Response(null, { status: 404 });
  const common = {
    root: testRoot, environment: "staging", inventoryPath, journalPath, runId: "run-live", owner: "owner-live",
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32), WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic" },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }), adapterFactory,
    tokenClientFactory: () => tokenClient, fetch: markerFetch, now: () => new Date("2030-01-01T12:00:00.000Z"),
    acceptance: async ({ journal, plan, persistJournal, seedFixtures, buildLiveCommand }: any) => {
      await seedFixtures(plan);
      const signed = await buildLiveCommand({ commandCredential: "c".repeat(64), authorityEpoch: 1, plan });
      assert.match(signed.authentication, /^[a-f0-9]{64}$/);
      assert.equal(signed.authorityEpoch, 1);
      assert.equal(signed.eventId, plan.eventId);
      journal.phase = "verified";
      journal.acceptance = { status: "passed", cleanupComplete: false, fixturePlan: plan };
      await persistJournal(journal);
      const evidence = createEvidenceEnvelope({ runId: journal.runId, sourceSha: journal.sourceSha, phase: journal.phase, outcomes: { acceptance: true, cleanupComplete: false, disposableResidueExpected: true, productionAuthority: false }, counts: { fixtureRows: plan.rows.length } });
      journal.acceptanceEvidence = evidence;
      await persistJournal(journal);
      return evidence;
    },
  };
  await runLiveOperation({ ...common, operation: "plan" }, dependencies);
  await assert.rejects(runLiveOperation({ ...common, operation: "plan" }, dependencies), /journal path already exists/);
  const plannedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(plannedJournal.preflight.operatorTokenPresent, true);
  assert.equal(plannedJournal.resources.some((item: any) => item.domain === "token"), false);
  state.tokenId = "replacement-operator-token-id";
  const applied = await runLiveOperation({ ...common, operation: "apply" }, dependencies);
  assert.equal(applied.phase, "alias-live");
  await runLiveOperation({ ...common, operation: "verify" }, dependencies);
  const tornDown = await runLiveOperation({ ...common, operation: "teardown" }, dependencies);
  assert.equal(tornDown.cleanupComplete, true);
  assert.equal((await runLiveOperation({ ...common, operation: "teardown", processEnvironment: {} }, dependencies)).cleanupComplete, true);
  const delayed = await runLiveOperation({ ...common, operation: "absence-check" }, dependencies);
  assert.equal(delayed.passed, true);
  assert.equal(delayed.absenceCount, 7);
  assert.deepEqual(state.calls.slice(-5), ["credential", "secret", "durable-object", "worker-delete", "d1"]);
  assert.equal(state.databases.length, 0);
  assert.equal(state.deployments.length, 0);
  assert.equal(state.tokenActive, true);
  assert.deepEqual(state.revokedTokenIds, []);
  const finalJournal = await readFile(journalPath, "utf8");
  assert.match(finalJournal, /woodshed-staging-delete-[a-f0-9]{16}/);
  assert.doesNotMatch(finalJournal, /organizer-synthetic|synthetic-cloud-token|ssssssssssssssssssssssssssssssss/);
  const evidence = await readFile(`${journalPath}.evidence.json`, "utf8");
  assert.doesNotMatch(evidence, new RegExp(`${accountId}|${databaseId}|${workerName}|${origin}`));
});
