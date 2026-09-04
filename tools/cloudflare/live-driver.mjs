import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  assertCredentialedPreflight,
  assertSharedAccountInventory,
  assertSchemaInvariants,
  createWranglerAdapter,
  runMigrationFirstDeployment,
} from "./deployment.mjs";
import { createFinalEvidencePacket, saveEvidencePacket } from "./evidence.mjs";
import { validateStagingInventory } from "./inventory.mjs";
import { createJournal, loadJournal, saveJournal, saveNewJournal, TEARDOWN_ENTRY_PHASES } from "./journal.mjs";
import { D1_MIGRATIONS, verifyMigrationDirectory } from "./migrations.mjs";
import { assertRollbackCompatible, createJournalRetention, runStackTeardown } from "./recovery.mjs";
import { createSyntheticFixturePlan } from "./staging-fixtures.mjs";
import { runDeployedAcceptance } from "./staging-smoke.mjs";
import { signLiveCommand } from "../../packages/application/src/live-service.ts";
import { canonicalJson } from "../../packages/contracts/src/snapshot.ts";

const OPERATIONS = new Set(["preflight", "plan", "apply", "verify", "teardown", "status", "absence-check"]);
const OPTION_NAMES = new Map([
  ["--env", "environment"],
  ["--inventory", "inventoryPath"],
  ["--journal", "journalPath"],
  ["--run-id", "runId"],
  ["--owner", "owner"],
]);
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DATABASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const D1_CREATE_REFUSAL_INCIDENTS = new Set(["d1-create-refused", "d1-acceptance-mismatch"]);
const D1_INTEGRITY_UNAVAILABLE = "unsupported-on-d1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRunId(runId) {
  if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId) || /^\.*$/.test(runId)) throw new Error("valid run ID is required");
  return runId;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

const defaultSetTimer = (callback, delay) => setTimeout(callback, delay);
const defaultClearTimer = (handle) => clearTimeout(handle);

function confirmation(outcome, attempts, checkedAt, lastError = null) {
  return { outcome, attempts, checkedAt: checkedAt.toISOString(), lastError };
}

function rateLimited(error) {
  return error !== null
    && (typeof error === "object" || typeof error === "function")
    && (error.status === 429 || error.statusCode === 429);
}

function waitForRetry(delay, setTimer, clearTimer) {
  return new Promise((resolve) => {
    let handle = null;
    handle = setTimer(() => {
      clearTimer(handle);
      resolve();
    }, delay);
  });
}

export async function confirmAbsence(probe, {
  setTimer = defaultSetTimer,
  clearTimer = defaultClearTimer,
  now = () => new Date(),
  maxAttempts: attemptLimit = 8,
  initialDelayMs = 500,
  factor = 2,
  maxDelayMs = 8_000,
  budgetMs = 45_000,
  random = Math.random,
} = {}) {
  const startedAt = now().getTime();
  let attempts = 0;

  while (attempts < attemptLimit) {
    attempts += 1;
    let present;
    try {
      present = await probe();
    } catch (error) {
      if (rateLimited(error)) return confirmation("could-not-confirm", attempts, now(), error);
      throw error;
    }

    if (!present) return confirmation("proven-absent", attempts, now());
    // Every attempt observed it and nothing errored: that is the strongest evidence available
    // that it really is present. Only running out of wall-clock or hitting a rate limit leaves
    // the question genuinely open.
    if (attempts >= attemptLimit) return confirmation("present", attempts, now());

    const checkedAt = now();
    const elapsedMs = checkedAt.getTime() - startedAt;
    const backoffMs = Math.min(maxDelayMs, initialDelayMs * factor ** (attempts - 1));
    const delayMs = backoffMs / 2 + (backoffMs / 2) * random();
    if (elapsedMs >= budgetMs || delayMs > budgetMs - elapsedMs) {
      return confirmation("could-not-confirm", attempts, checkedAt);
    }
    await waitForRetry(delayMs, setTimer, clearTimer);
  }

  return confirmation("could-not-confirm", attempts, now());
}

function effectiveConfigDirectory(root, runId) {
  return path.join(root, ".cloudflare-staging", `run-${sha256(safeRunId(runId)).slice(0, 16)}`);
}

export function parseLiveArguments(argv) {
  if (!Array.isArray(argv) || !OPERATIONS.has(argv[0])) throw new Error("unknown staging operation");
  const result = { operation: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const field = OPTION_NAMES.get(option);
    if (!field) throw new Error("unknown option");
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw new Error("option value is required");
    if (field in result) throw new Error("duplicate option");
    result[field] = value;
  }
  if (result.environment !== "staging") throw new Error("explicit staging environment is required");
  if (result.runId !== undefined) safeRunId(result.runId);
  return result;
}

function assertEffectiveConfigInput({ inventory, databaseId, sourceSha }) {
  if (inventory?.environment !== "staging" || inventory?.staging?.accountId === undefined) throw new Error("validated staging inventory is required");
  if (!DATABASE_ID.test(databaseId ?? "")) throw new Error("assigned database identity is required");
  if (!/^[a-f0-9]{40,64}$/i.test(sourceSha ?? "")) throw new Error("frozen source SHA is required");
  for (const field of ["databaseName", "workerName"]) {
    if (!SAFE_NAME.test(inventory.staging[field] ?? "") || !inventory.staging[field].includes("staging")) throw new Error("safe staging resource name is required");
  }
}

export async function generateEffectiveConfig(options) {
  const { root, runId, inventory, databaseId, sourceSha, workersDev = false, deleteDurableObject = false } = options;
  requiredString(root, "repository root");
  safeRunId(runId);
  assertEffectiveConfigInput({ inventory, databaseId, sourceSha });
  const runTag = sha256(runId).slice(0, 16);
  const directory = effectiveConfigDirectory(root, runId);
  const migrationsDirectory = path.join(directory, "migrations");
  await mkdir(migrationsDirectory, { recursive: true, mode: 0o700 });
  const lifecycleTag = `woodshed-staging-create-${runTag}`;
  const deletionTag = deleteDurableObject ? `woodshed-staging-delete-${runTag}` : undefined;
  const migrations = [{ tag: lifecycleTag, new_sqlite_classes: ["LiveCoordinator"] }];
  if (deletionTag) migrations.push({ tag: deletionTag, deleted_classes: ["LiveCoordinator"] });
  const staging = {
    account_id: inventory.staging.accountId,
    name: inventory.staging.workerName,
    workers_dev: workersDev,
    preview_urls: false,
    d1_databases: [{
      binding: "DB",
      database_name: inventory.staging.databaseName,
      database_id: databaseId,
      migrations_dir: "./migrations",
    }],
    durable_objects: { bindings: deleteDurableObject ? [] : [{ name: "LIVE_COORDINATOR", class_name: "LiveCoordinator" }] },
    migrations,
    vars: {
      WOODSHED_PRIVATE_CONTENT: "disabled",
      WOODSHED_DESTINATION: "cloudflare",
      APP_ORIGIN: inventory.staging.origin,
      WOODSHED_SOURCE_SHA: sourceSha,
    },
  };
  const config = {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: "woodshed-staging-contract",
    main: deleteDurableObject ? "./teardown-worker.mjs" : "../../apps/api-worker/src/index.ts",
    compatibility_date: "2025-07-18",
    compatibility_flags: ["nodejs_compat"],
    env: { staging },
  };
  const configDigest = sha256(canonicalJson(config));
  staging.vars.WOODSHED_CONFIG_DIGEST = configDigest;
  if (deleteDurableObject) await writeFile(path.join(directory, "teardown-worker.mjs"), "export default { fetch() { return new Response(null, { status: 503 }); } };\n", { mode: 0o600 });
  const configPath = path.join(directory, deleteDurableObject ? "wrangler-delete.json" : workersDev ? "wrangler-active.json" : "wrangler-private.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { configPath, migrationsDirectory, configDigest, lifecycleTag, deletionTag };
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} inventory is unreadable`);
  return value;
}

function databaseEntry(value) {
  const id = value?.uuid ?? value?.id;
  return typeof id === "string" && typeof value?.name === "string" ? { id, name: value.name } : null;
}

function workerNames(...collections) {
  const names = new Set();
  for (const item of collections.flat()) {
    const name = item?.script_name ?? item?.worker_name ?? item?.name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return [...names].sort().map((name) => ({ name }));
}

function deploymentRoutes(...collections) {
  const routes = [];
  for (const item of collections.flat()) {
    if (Array.isArray(item?.routes)) routes.push(...item.routes);
    if (typeof item?.url === "string") routes.push({ url: item.url });
  }
  return routes;
}

export async function collectRemoteInventory({ adapter, inventory }) {
  if (!adapter || inventory?.environment !== "staging") throw new Error("credentialed staging collector inputs are required");
  let collected;
  try {
    collected = await Promise.all([
      adapter.whoami(inventory.staging.accountId),
      adapter.d1List(),
      adapter.deploymentsList(inventory.staging.workerName),
      adapter.versionsList(inventory.staging.workerName),
      adapter.secretList(inventory.staging.workerName),
    ]);
  } catch {
    throw new Error("credentialed Cloudflare inventory collection failed");
  }
  const [identity, rawDatabases, deployments, versions, secrets] = collected;
  if (!identity || typeof identity.accountId !== "string") throw new Error("Cloudflare account inventory is unreadable");
  const databases = array(rawDatabases, "Cloudflare databases").map(databaseEntry);
  if (databases.some((item) => item === null)) throw new Error("Cloudflare databases inventory is unreadable");
  const deploymentList = array(deployments, "Cloudflare deployments");
  const versionList = array(versions, "Cloudflare versions");
  const secretNames = array(secrets, "Cloudflare secret names").map((item) => item?.name).filter((name) => typeof name === "string");
  if (secretNames.length !== secrets.length) throw new Error("Cloudflare secret names inventory is unreadable");
  return {
    accountId: identity.accountId,
    databases,
    workers: workerNames(deploymentList, versionList),
    routes: deploymentRoutes(deploymentList, versionList),
    secretNames,
    deployments: deploymentList,
    versions: versionList,
  };
}

export function createIdentityRevision(remote) {
  if (!remote || !Array.isArray(remote.databases) || !Array.isArray(remote.workers) || !Array.isArray(remote.routes)) throw new Error("remote identity is unreadable");
  return sha256(canonicalJson(normalizedIdentity(remote)));
}

function normalizedIdentity(remote) {
  const uniqueSorted = (items) => [...new Map(items.map((item) => [canonicalJson(item), item])).values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    accountId: remote.accountId,
    databases: uniqueSorted(remote.databases.map(({ id, name }) => ({ id, name }))),
    workers: uniqueSorted(remote.workers.map(({ name }) => ({ name }))),
    routes: uniqueSorted(remote.routes),
    deployments: uniqueSorted((remote.deployments ?? []).map((item) => ({ id: item?.id ?? item?.deployment_id, worker: item?.script_name ?? item?.worker_name ?? item?.name ?? null }))),
    versions: uniqueSorted((remote.versions ?? []).map((item) => ({ id: item?.id ?? item?.version_id, worker: item?.script_name ?? item?.worker_name ?? item?.name ?? null }))),
  };
}

function sameResource(left, right) {
  return left?.domain === right.domain && left?.id === right.id;
}

export async function executeJournaledMutation(options) {
  const { journal, expectedRevision, inspectRevision, resource, kind, persistJournal, inspect, mutate, owns, reconcileExisting, finalize, intentMetadata = {} } = options;
  if (![inspectRevision, persistJournal, inspect, mutate, owns].every((value) => typeof value === "function")) throw new Error("journaled mutation boundaries are required");
  if (reconcileExisting !== undefined && typeof reconcileExisting !== "function") throw new Error("journaled mutation reconciliation is invalid");
  if (await inspectRevision() !== expectedRevision) throw new Error("remote identity changed");
  if (!resource || typeof resource.domain !== "string" || typeof resource.id !== "string" || !resource.id) throw new Error("resource ownership is required");
  let owned = journal.resources.find((item) => sameResource(item, resource));
  if (!owned) {
    owned = { ...resource, runId: journal.runId, owner: journal.owner, status: "planned" };
    journal.resources.push(owned);
  } else if (owned.runId !== journal.runId || owned.owner !== journal.owner) {
    throw new Error("journal resource identity mismatch");
  }
  let intent = journal.mutations.find((item) => item?.kind === kind && item?.domain === resource.domain && item?.id === resource.id);
  const existingIntent = Boolean(intent);
  if (!intent) {
    intent = { ...intentMetadata, kind, domain: resource.domain, id: resource.id, status: "pending" };
    journal.mutations.push(intent);
  } else if (!["pending", "applied"].includes(intent.status)) {
    throw new Error("mutation intent cannot be reconciled");
  }
  await persistJournal(journal);
  const before = await inspect();
  let result;
  if (before?.exists) {
    const reconciled = reconcileExisting === undefined
      ? existingIntent && owns(before)
      : await reconcileExisting({ intent, state: before });
    if (!reconciled) throw new Error("existing resource is not owned by this run");
    result = { reconciled: true, state: before };
  } else {
    if (existingIntent) throw new Error("pending mutation is absent remotely; no replay authorized");
    try {
      if (await inspectRevision() !== expectedRevision) throw new Error("remote identity changed");
      await mutate();
      const after = await inspect();
      if (!after?.exists || !owns(after)) throw new Error("mutation postcondition failed");
      result = { reconciled: false, state: after };
    } catch (error) {
      const afterLoss = await inspect();
      const reconciled = afterLoss?.exists && (reconcileExisting === undefined
        ? owns(afterLoss)
        : await reconcileExisting({ intent, state: afterLoss }));
      if (!reconciled) throw new Error("mutation outcome is uncertain; no retry authorized", { cause: error });
      result = { reconciled: true, state: afterLoss };
    }
  }
  intent.status = "applied";
  owned.status = "owned";
  if (finalize !== undefined) {
    if (typeof finalize !== "function") throw new Error("mutation finalizer is invalid");
    await finalize({ journal, intent, owned, result });
  }
  await persistJournal(journal);
  return result;
}

export const LIVE_OPERATIONS = Object.freeze([...OPERATIONS]);

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error("repository state is unreadable");
  return result.stdout.trim();
}

export function inspectSourceState(root) {
  return {
    actualSourceSha: git(root, ["rev-parse", "HEAD"]),
    worktreeClean: git(root, ["status", "--porcelain"]) === "",
  };
}

async function nearestExistingRealPath(value) {
  let candidate = path.resolve(value);
  for (;;) {
    try { return await realpath(candidate); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function outsideRepository(root, file, label) {
  const [resolvedRoot, resolvedTargetAncestor] = await Promise.all([realpath(root), nearestExistingRealPath(file)]);
  const relative = path.relative(resolvedRoot, resolvedTargetAncestor);
  if (!relative.startsWith(`..${path.sep}`) && relative !== "..") throw new Error(`${label} must remain outside the public repository`);
}

async function readPrivateJson(root, file) {
  await outsideRepository(root, file, "private inventory");
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("private inventory is unreadable or malformed"); }
}

function requireCredentials(environment, operation) {
  if (operation === "status") return {};
  const token = requiredString(environment.CLOUDFLARE_API_TOKEN, "Cloudflare API token environment variable");
  const liveSecret = operation === "preflight" || operation === "plan" || operation === "apply"
    ? requiredString(environment.LIVE_COMMAND_SECRET, "live command secret environment variable")
    : environment.LIVE_COMMAND_SECRET;
  if (typeof liveSecret === "string" && liveSecret.length < 32) throw new Error("live command secret does not meet the minimum length");
  const organizerToken = operation === "verify"
    ? requiredString(environment.WOODSHED_STAGING_ORGANIZER_TOKEN, "organizer token environment variable")
    : environment.WOODSHED_STAGING_ORGANIZER_TOKEN;
  return { token, liveSecret, organizerToken };
}

function unwrapApi(result, label) {
  if (!result || result.success !== true || !result.result || typeof result.result !== "object") throw new Error(`${label} response is unreadable`);
  return result.result;
}

export function createApiTokenClient({ token, fetch = globalThis.fetch, apiBase = "https://api.cloudflare.com/client/v4/user/tokens", accountApiBase = "https://api.cloudflare.com/client/v4/accounts", zoneApiBase = "https://api.cloudflare.com/client/v4/zones" }) {
  if (typeof token !== "string" || !token || typeof fetch !== "function") throw new Error("token lifecycle inputs are required");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  async function request(pathname, init = {}, base = apiBase) {
    let response;
    try { response = await fetch(`${base}${pathname}`, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
    catch (error) { throw new Error("token lifecycle request failed", { cause: error }); }
    return response;
  }
  async function inspectPath(pathname) {
    const response = await request(pathname);
    if (response.status === 401) return { exists: null, active: null, unauthorized: true };
    if (response.status === 404) return { exists: false, active: false, unauthorized: false };
    if (response.status === 403) throw new Error("token verification is unauthorized");
    if (!response.ok) throw new Error("token verification failed");
    let payload;
    try { payload = await response.json(); } catch { throw new Error("token verification response is unreadable"); }
    const result = unwrapApi(payload, "token verification");
    if (typeof result.id !== "string" || result.id.length < 8 || typeof result.status !== "string") throw new Error("token verification response is unreadable");
    return { exists: result.status === "active", active: result.status === "active", id: result.id };
  }
  return Object.freeze({
    async inspect() { return inspectPath("/verify"); },
    async inspectId(id) {
      if (typeof id !== "string" || id.length < 8) throw new Error("journaled deployment token identity is required");
      return inspectPath(`/${encodeURIComponent(id)}`);
    },
    async revoke(id) {
      if (typeof id !== "string" || id.length < 8) throw new Error("journaled deployment token identity is required");
      const response = await request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error("deployment token revocation failed");
      return true;
    },
    async listWorkerScripts(accountId) {
      if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("valid staging account identity is required");
      const response = await request(`/${encodeURIComponent(accountId)}/workers/scripts?per_page=100&page=1`, {}, accountApiBase);
      if (!response.ok) throw new Error("account-wide Worker inventory failed");
      let payload;
      try { payload = await response.json(); } catch { throw new Error("account-wide Worker inventory is unreadable"); }
      const result = payload?.success === true ? payload.result : undefined;
      const pages = payload?.result_info?.total_pages ?? 1;
      if (!Array.isArray(result) || !Number.isSafeInteger(pages) || pages !== 1 || result.some((item) => typeof item?.id !== "string" || !item.id)) throw new Error("account-wide Worker inventory is unreadable or incomplete");
      return result.map(({ id }) => ({ name: id }));
    },
    async inspectWorkersDev(accountId, workerName) {
      if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId) || typeof workerName !== "string" || !SAFE_NAME.test(workerName)) throw new Error("valid staging exposure identity is required");
      const response = await request(`/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, {}, accountApiBase);
      if (response.status === 404) return { exists: false, enabled: false };
      // The status rides on the error so the retry can tell a 429 from an ordinary failure;
      // without it the rate-limit branch is unreachable against the real client.
      if (!response.ok) throw Object.assign(new Error("workers.dev exposure inventory failed"), { status: response.status });
      let payload;
      try { payload = await response.json(); } catch { throw new Error("workers.dev exposure inventory is unreadable"); }
      if (payload?.success !== true || typeof payload.result?.enabled !== "boolean" || typeof payload.result?.previews_enabled !== "boolean") throw new Error("workers.dev exposure inventory is unreadable");
      return { exists: true, enabled: payload.result.enabled || payload.result.previews_enabled };
    },
    async inspectAccountSubdomain(accountId) {
      if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("valid staging account identity is required");
      const response = await request(`/${encodeURIComponent(accountId)}/workers/subdomain`, {}, accountApiBase);
      if (!response.ok) throw new Error("workers.dev account subdomain inventory failed");
      let payload;
      try { payload = await response.json(); } catch { throw new Error("workers.dev account subdomain inventory is unreadable"); }
      if (payload?.success !== true || typeof payload.result?.subdomain !== "string" || !SAFE_NAME.test(payload.result.subdomain)) throw new Error("workers.dev account subdomain inventory is unreadable");
      return payload.result.subdomain;
    },
    async listWorkerRoutes(accountId) {
      if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("valid staging account identity is required");
      const zonesResponse = await request(`?account.id=${encodeURIComponent(accountId)}&per_page=50&page=1`, {}, zoneApiBase);
      if (!zonesResponse.ok) throw new Error("account-wide route inventory failed");
      let zonesPayload;
      try { zonesPayload = await zonesResponse.json(); } catch { throw new Error("account-wide route inventory is unreadable"); }
      const zonePages = zonesPayload?.result_info?.total_pages ?? 1;
      if (zonesPayload?.success !== true || !Array.isArray(zonesPayload.result) || !Number.isSafeInteger(zonePages) || zonePages !== 1 || zonesPayload.result.some((zone) => typeof zone?.id !== "string" || !zone.id)) throw new Error("account-wide route inventory is unreadable or incomplete");
      const routeSets = await Promise.all(zonesPayload.result.map(async ({ id }) => {
        const response = await request(`/${encodeURIComponent(id)}/workers/routes?per_page=100&page=1`, {}, zoneApiBase);
        if (!response.ok) throw new Error("account-wide route inventory failed");
        let payload;
        try { payload = await response.json(); } catch { throw new Error("account-wide route inventory is unreadable"); }
        const pages = payload?.result_info?.total_pages ?? 1;
        if (payload?.success !== true || !Array.isArray(payload.result) || !Number.isSafeInteger(pages) || pages !== 1 || payload.result.some((route) => typeof route?.pattern !== "string")) throw new Error("account-wide route inventory is unreadable or incomplete");
        return payload.result.map(({ pattern, script }) => ({ pattern, script: typeof script === "string" ? script : null }));
      }));
      return routeSets.flat();
    },
    async listWorkerDomains(accountId) {
      if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("valid staging account identity is required");
      const response = await request(`/${encodeURIComponent(accountId)}/workers/domains?per_page=100&page=1`, {}, accountApiBase);
      if (!response.ok) throw new Error("account-wide Worker domain inventory failed");
      let payload;
      try { payload = await response.json(); } catch { throw new Error("account-wide Worker domain inventory is unreadable"); }
      const pages = payload?.result_info?.total_pages ?? 1;
      if (payload?.success !== true || !Array.isArray(payload.result) || !Number.isSafeInteger(pages) || pages !== 1 || payload.result.some((domain) => typeof domain?.hostname !== "string" || !domain.hostname)) throw new Error("account-wide Worker domain inventory is unreadable or incomplete");
      return payload.result.map(({ hostname, service, environment }) => ({ hostname, script: typeof service === "string" ? service : null, environment: typeof environment === "string" ? environment : null }));
    },
  });
}

async function withAccountWideWorkers(inventory, remote, tokenClient) {
  if (typeof tokenClient?.listWorkerScripts !== "function") throw new Error("account-wide Worker inventory is required");
  if (typeof tokenClient?.listWorkerRoutes !== "function") throw new Error("account-wide route inventory is required");
  if (typeof tokenClient?.listWorkerDomains !== "function") throw new Error("account-wide Worker domain inventory is required");
  const [accountWorkers, accountRoutes, accountDomains] = await Promise.all([
    tokenClient.listWorkerScripts(inventory.staging.accountId),
    tokenClient.listWorkerRoutes(inventory.staging.accountId),
    tokenClient.listWorkerDomains(inventory.staging.accountId),
  ]);
  const workers = workerNames(remote.workers, accountWorkers);
  const routes = [...remote.routes, ...accountRoutes, ...accountDomains];
  return { ...remote, workers, routes };
}

async function collectProtectedInventory({ adapter, inventory, tokenClient }) {
  return withAccountWideWorkers(inventory, await collectRemoteInventory({ adapter, inventory }), tokenClient);
}

async function workersDevEnabled(inventory, journal, tokenClient) {
  if (typeof tokenClient?.inspectWorkersDev !== "function") throw new Error("authenticated workers.dev exposure inventory is required");
  return (await tokenClient.inspectWorkersDev(inventory.staging.accountId, journal.identity.workerName)).enabled;
}

function confirmWorkersDevAbsence(inventory, journal, tokenClient, { setTimer, clearTimer, now }) {
  return confirmAbsence(() => workersDevEnabled(inventory, journal, tokenClient), { setTimer, clearTimer, now });
}

// wrangler's secret commands once resolved --name plus --env into "<name>-staging", creating a
// Worker the journal never owned. That is fixed at argument composition, so this should never
// fire -- which is why it refuses rather than deletes: a journal is authority to remove only
// what it owns, so an unowned near-miss is a fact for a human, never a cleanup target.
export async function assertNoEnvironmentSuffixedWorker(inventory, journal, tokenClient) {
  const suffixed = `${journal.identity.workerName}-staging`;
  const scripts = await tokenClient.listWorkerScripts(inventory.staging.accountId);
  if (scripts.some((script) => script?.name === suffixed)) throw new Error("unowned environment-suffixed Worker blocks cleanup completion");
}

async function recordUnconfirmedOriginAbsence(journalPath, journal, absence, { disableFailed = false } = {}) {
  // Cloudflare publishes no read-after-write guarantee for the workers.dev subdomain, so
  // an exhausted retry means unknown -- not absent, and not quarantine failure. Record what
  // was checked and when, and whether the disable itself errored: "the disable failed and I
  // could not confirm" is a different incident from "it succeeded and I could not confirm".
  journal.incident = {
    ...(journal.incident ?? {}),
    originAbsence: { status: absence.outcome, checkedAt: absence.checkedAt, attempts: absence.attempts, disableFailed },
  };
  await persist(journalPath, journal);
}

function inventoryMatchesJournal(journalIdentity, inventoryIdentity) {
  for (const field of ["accountId", "databaseName", "workerName", "origin"]) if (journalIdentity[field] !== inventoryIdentity[field]) return false;
  return inventoryIdentity.databaseId === undefined || journalIdentity.databaseId === inventoryIdentity.databaseId;
}

function protectedRevision(remote, identity) {
  const databases = remote.databases.filter((item) => !(item.name === identity.databaseName && (identity.databaseId === undefined || item.id === identity.databaseId)));
  const workers = remote.workers.filter((item) => item.name !== identity.workerName);
  const routes = remote.routes.filter((item) => !(item?.workersDev !== undefined && item?.name === identity.workerName) && item?.url !== identity.origin);
  return createIdentityRevision({ accountId: remote.accountId, databases, workers, routes, deployments: [], versions: [] });
}

async function preflightContext(options, dependencies) {
  const { root, inventoryPath, credentialEnvironment, operation } = options;
  const credentials = requireCredentials(credentialEnvironment, operation);
  const inventoryInput = await readPrivateJson(root, inventoryPath);
  const sourceState = dependencies.sourceState?.(root) ?? inspectSourceState(root);
  const inventory = validateStagingInventory(inventoryInput, sourceState);
  const hostname = new URL(inventory.staging.origin).hostname;
  if (!hostname.endsWith(".workers.dev") || !hostname.startsWith(`${inventory.staging.workerName}.`)) throw new Error("live driver requires an exact run-owned workers.dev origin");
  const adapter = dependencies.adapterFactory({ root, token: credentials.token, accountId: inventory.staging.accountId });
  const tokenClient = dependencies.tokenClientFactory({ token: credentials.token });
  const [remote, tokenState] = await Promise.all([
    collectRemoteInventory({ adapter, inventory }),
    tokenClient.inspect(),
  ]);
  if (!tokenState.active) throw new Error("operator token is not active");
  if (typeof tokenClient.inspectAccountSubdomain !== "function") throw new Error("authenticated workers.dev account subdomain is required");
  const accountSubdomain = await tokenClient.inspectAccountSubdomain(inventory.staging.accountId);
  const expectedOrigin = `https://${inventory.staging.workerName}.${accountSubdomain}.workers.dev`;
  if (inventory.staging.origin !== expectedOrigin) throw new Error("staging origin does not belong to the authenticated account");
  const isolationRemote = await withAccountWideWorkers(inventory, remote, tokenClient);
  const proof = assertCredentialedPreflight(inventory, isolationRemote, { localSecretAvailable: typeof credentials.liveSecret === "string" && credentials.liveSecret.length >= 32 });
  return { credentials, inventory, adapter, tokenClient, remote: isolationRemote, tokenState, proof, sourceState };
}

function requiredOptions(options, fields) {
  for (const field of fields) requiredString(options[field], field);
}

function resourceId(journal, domain) {
  return journal.resources.find((item) => item?.domain === domain)?.id;
}

function putResource(journal, domain, id) {
  const current = journal.resources.find((item) => item?.domain === domain);
  if (current) {
    if (current.runId !== journal.runId || current.owner !== journal.owner) throw new Error("journal resource identity mismatch");
    current.id = id;
    return current;
  }
  const resource = { domain, id, runId: journal.runId, owner: journal.owner, status: "planned" };
  journal.resources.push(resource);
  return resource;
}

function parseBookmark(value) {
  const bookmark = value?.bookmark ?? value?.result?.bookmark ?? value?.bookmarks?.[0]?.bookmark;
  if (typeof bookmark !== "string" || bookmark.length === 0) throw new Error("D1 recovery bookmark is unreadable");
  return bookmark;
}

function d1Results(value) {
  const batches = Array.isArray(value) ? value : [value];
  const rows = [];
  for (const batch of batches) {
    if (!batch || batch.success !== true || !Array.isArray(batch.results)) throw new Error("D1 structured result is unreadable");
    rows.push(...batch.results);
  }
  return rows;
}

async function inspectLedger(adapter, databaseName) {
  const tables = d1Results(await adapter.d1Execute(databaseName, { command: "SELECT name FROM sqlite_schema WHERE type='table' AND name='d1_migrations'" }));
  if (tables.length === 0) return [];
  return d1Results(await adapter.d1Execute(databaseName, { command: "SELECT name FROM d1_migrations ORDER BY id" })).map(({ name }) => ({ name }));
}

async function expectedSchema(root) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    for (const { filename } of D1_MIGRATIONS) database.exec(await readFile(path.join(root, "migrations", "d1", filename), "utf8"));
    const objects = database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name").all();
    const byType = (type) => objects.filter((item) => item.type === type).map((item) => item.name).sort();
    return { tables: byType("table"), indexes: byType("index"), triggers: byType("trigger"), definitionDigest: schemaDefinitionDigest(objects) };
  } finally {
    database.close();
  }
}

function schemaDefinitionDigest(objects) {
  return sha256(canonicalJson(objects.map(({ type, name, sql: definition }) => ({ type, name, definition: definition.replaceAll(/\s+/g, " ").trim() }))));
}

export async function remoteSchema(adapter, databaseName, migration009) {
  const [objectResult, foreignKeyResult, violationResult] = await Promise.all([
    adapter.d1Execute(databaseName, { command: "SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name" }),
    adapter.d1Execute(databaseName, { command: "PRAGMA foreign_keys" }),
    adapter.d1Execute(databaseName, { command: "PRAGMA foreign_key_check" }),
  ]);
  const objects = d1Results(objectResult);
  const foreignKeys = d1Results(foreignKeyResult);
  const violations = d1Results(violationResult);
  const byType = (type) => objects.filter((item) => item.type === type).map((item) => item.name).sort();
  const triggers = byType("trigger");
  return {
    foreignKeysEnabled: Number(foreignKeys[0]?.foreign_keys) === 1,
    foreignKeyViolations: violations.length,
    integrity: D1_INTEGRITY_UNAVAILABLE,
    tables: byType("table"), indexes: byType("index"), triggers, constraints: [], definitionDigest: schemaDefinitionDigest(objects),
    choiceConfigSeeded: triggers.includes("event_choice_config_seed"),
    migration009,
  };
}

export function recordVerifiedSchemaEvidence(journal, actual, expected) {
  assertSchemaInvariants(actual, { ...expected, constraints: [] });
  journal.schema = {
    digest: sha256(canonicalJson(expected)),
    foreignKeysEnabled: actual.foreignKeysEnabled,
    foreignKeyViolations: actual.foreignKeyViolations,
    integrity: D1_INTEGRITY_UNAVAILABLE,
  };
  return journal.schema;
}

async function recoveryCredentialCounts(adapter, databaseName) {
  const rows = d1Results(await adapter.d1Execute(databaseName, { command: "SELECT token_hash,participation_id FROM participation_recovery ORDER BY token_hash,participation_id" }));
  if (rows.some((item) => typeof item?.token_hash !== "string" || typeof item?.participation_id !== "string")) throw new Error("migration 009 preservation snapshot is unreadable");
  return { rows: rows.length, associations: new Set(rows.map((item) => item.participation_id)).size, associationDigest: sha256(canonicalJson(rows)) };
}

function deploymentId(deployments, versions) {
  for (const value of [...deployments, ...versions]) {
    const id = value?.id ?? value?.deployment_id ?? value?.version_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  throw new Error("deployed version identity is unreadable");
}

function deploymentIds(deployments, versions) {
  return [...deployments, ...versions].map((value) => value?.id ?? value?.deployment_id ?? value?.version_id).filter((id) => typeof id === "string").sort();
}

function collectionIds(values) {
  return values.map((value) => value?.id ?? value?.deployment_id ?? value?.version_id).filter((id) => typeof id === "string").sort();
}

async function deploymentProof(adapter, workerName) {
  const [deployments, versions] = await Promise.all([adapter.deploymentsList(workerName), adapter.versionsList(workerName)]);
  return { deploymentId: deploymentId(deployments, versions), deploymentIds: deploymentIds(deployments, versions), workerDeploymentIds: collectionIds(deployments), versionIds: collectionIds(versions) };
}

function newDeploymentId(beforeIds, proof) {
  const newDeployments = proof.workerDeploymentIds.filter((id) => !beforeIds.includes(id));
  if (newDeployments.length === 1) return newDeployments[0];
  if (newDeployments.length > 1) throw new Error("deployment identity advance is ambiguous");
  const newVersions = proof.versionIds.filter((id) => !beforeIds.includes(id));
  if (newVersions.length !== 1) throw new Error(newVersions.length > 1 ? "deployment identity advance is ambiguous" : "deployment identity did not advance");
  return newVersions[0];
}

async function releaseMarker(fetch, origin) {
  let response;
  try { response = await fetch(new URL("/api/staging-release", origin), { redirect: "error", signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error("served release marker reachability is unknown"); }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("served release marker request failed");
  let marker;
  try { marker = await response.json(); } catch { throw new Error("served release marker is unreadable"); }
  if (!marker || typeof marker.sourceSha !== "string" || typeof marker.configDigest !== "string" || marker.lifecycle !== "legacy-sqlite-v1" || !Array.isArray(marker.bindings)) throw new Error("served release marker is unreadable");
  return marker;
}

function assertMarker(expected, actual) {
  const bindingsMatch = Array.isArray(expected.bindings) && expected.bindings.length === actual?.bindings?.length && expected.bindings.every((binding) => actual.bindings.includes(binding));
  if (!actual || actual.sourceSha !== expected.sourceSha || actual.configDigest !== expected.configDigest || actual.lifecycle !== "legacy-sqlite-v1" || !bindingsMatch) {
    throw new Error("served release does not match frozen source and configuration");
  }
}

async function copyMigration(root, target, filename) {
  await copyFile(path.join(root, "migrations", "d1", filename), path.join(target, filename));
}

async function assertRunMigrationPrefix(directory, journal, nextFilename) {
  const actual = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const expected = journal.migrations.filter((item) => item.status === "applied").map((item) => item.filename);
  if (nextFilename) expected.push(nextFilename);
  expected.sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("run migration directory does not match the attested ledger prefix");
}

function sql(value) {
  if (typeof value !== "string") throw new Error("synthetic fixture value is invalid");
  return `'${value.replaceAll("'", "''")}'`;
}

async function writeFixtureSql(config, plan, now) {
  const statements = [
    `INSERT INTO communities(id,name) VALUES (${sql(plan.communityId)},'Synthetic Staging Community')`,
    `INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES (${sql(plan.eventId)},${sql(plan.communityId)},'Synthetic Staging Event','live','public','open')`,
    ...plan.songIds.map((id, index) => `INSERT INTO canonical_songs(id,community_id,title) VALUES (${sql(id)},${sql(plan.communityId)},'Synthetic Song ${index + 1}')`),
    ...plan.songIds.map((id) => `INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES (${sql(plan.eventId)},${sql(id)},${sql(now)})`),
    `INSERT INTO guest_participations(id,community_id,event_id) VALUES (${sql(plan.organizerParticipationId)},${sql(plan.communityId)},${sql(plan.eventId)})`,
    `INSERT INTO participant_sessions(id_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (${sql(plan.tokenHash)},${sql(plan.organizerParticipationId)},${sql(plan.communityId)},${sql(plan.eventId)},'community-admin','invite',${sql(new Date(Date.parse(now) + 3_600_000).toISOString())})`,
  ];
  const file = path.join(config.migrationsDirectory, "synthetic-fixtures.sql");
  await writeFile(file, `${statements.join(";\n")};\n`, { mode: 0o600 });
  return file;
}

function signedLiveCommand({ commandCredential, authorityEpoch, plan, now = new Date() }) {
  const issuedAt = now.toISOString();
  const unsigned = {
    schemaVersion: 1,
    communityId: plan.communityId,
    eventId: plan.eventId,
    actorId: plan.organizerParticipationId,
    deviceInstallationId: plan.deviceInstallationId,
    authorityEpoch,
    baseRevision: 0,
    operationId: plan.operationIds.live,
    issuedAt,
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    action: "queue",
    entryId: `entry_staging_${sha256(plan.runId).slice(0, 16)}`,
    payload: { songId: plan.songIds[0] },
  };
  return signLiveCommand(unsigned, commandCredential);
}

async function persist(journalPath, journal) {
  await saveJournal(journalPath, journal);
}

function defaultDependencies(overrides = {}) {
  return {
    adapterFactory: overrides.adapterFactory ?? ((options) => createWranglerAdapter(options)),
    tokenClientFactory: overrides.tokenClientFactory ?? ((options) => createApiTokenClient({ ...options, fetch: overrides.fetch ?? globalThis.fetch })),
    fetch: overrides.fetch ?? globalThis.fetch,
    sourceState: overrides.sourceState,
    acceptance: overrides.acceptance ?? runDeployedAcceptance,
    now: overrides.now ?? (() => new Date()),
    setTimer: overrides.setTimer ?? defaultSetTimer,
    clearTimer: overrides.clearTimer ?? defaultClearTimer,
  };
}

async function loadOwnedJournal(options) {
  requiredOptions(options, ["journalPath", "runId", "owner"]);
  await outsideRepository(options.root, options.journalPath, "private journal");
  return loadJournal(options.journalPath, { runId: options.runId, owner: options.owner });
}

async function currentProtectedRevision(adapter, inventory, identity, tokenClient) {
  const remote = await collectProtectedInventory({ adapter, inventory, tokenClient });
  assertSharedAccountInventory(inventory, remote);
  return protectedRevision(remote, identity);
}

async function currentIdentityRevision(adapter, inventory, tokenClient) {
  const remote = await collectProtectedInventory({ adapter, inventory, tokenClient });
  assertSharedAccountInventory(inventory, remote);
  return createIdentityRevision(remote);
}

async function planOperation(options, dependencies) {
  requiredOptions(options, ["inventoryPath", "journalPath", "runId", "owner"]);
  safeRunId(options.runId);
  await outsideRepository(options.root, options.journalPath, "private journal");
  const context = await preflightContext(options, dependencies);
  await mkdir(path.dirname(path.resolve(options.journalPath)), { recursive: true, mode: 0o700 });
  await outsideRepository(options.root, options.journalPath, "private journal");
  const journal = createJournal({
    runId: options.runId,
    owner: options.owner,
    sourceSha: context.inventory.expectedSourceSha,
    identity: context.inventory.staging,
  });
  journal.preflight = {
    protectedRevision: protectedRevision(context.remote, journal.identity),
    targetRevision: createIdentityRevision(context.remote),
    operatorTokenPresent: true,
  };
  journal.governance = {
    deploymentOwner: journal.owner,
    incidentOwner: journal.owner,
    completionAuthority: journal.owner,
    approval: "non-graduating-owner-self-check",
    productionPromotion: false,
  };
  journal.lease = { active: true, runId: journal.runId, owner: journal.owner, revision: journal.preflight.protectedRevision };
  for (const [domain, id] of [
    ["d1", `planned-${sha256(journal.identity.databaseName).slice(0, 16)}`],
    ["worker", journal.identity.workerName],
    ["durable-object", `LiveCoordinator-${sha256(journal.runId).slice(0, 16)}`],
    ["route", `workers-dev-${sha256(journal.identity.origin).slice(0, 16)}`],
    ["hostname", `not-provisioned-${sha256(journal.identity.origin).slice(0, 16)}`],
    ["credential", `organizer-session-${sha256(journal.runId).slice(0, 16)}`],
    ["secret", "LIVE_COMMAND_SECRET"],
  ]) putResource(journal, domain, id);
  await saveNewJournal(options.journalPath, journal);
  return { operation: "plan", phase: journal.phase, mutationCount: 0 };
}

async function applyOperation(options, dependencies) {
  requiredOptions(options, ["inventoryPath", "journalPath", "runId", "owner"]);
  const credentials = requireCredentials(options.credentialEnvironment, "apply");
  const inventory = validateStagingInventory(await readPrivateJson(options.root, options.inventoryPath), dependencies.sourceState?.(options.root) ?? inspectSourceState(options.root));
  const journal = await loadOwnedJournal(options);
  if (["quarantined", "cleanup-complete"].includes(journal.phase)) throw new Error("apply is not authorized for the journal phase");
  if (!inventoryMatchesJournal(journal.identity, inventory.staging) || journal.sourceSha !== inventory.expectedSourceSha) throw new Error("private inventory no longer matches the journal");
  let adapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId });
  const tokenClient = dependencies.tokenClientFactory({ token: credentials.token });
  await assertOperatorTokenActive(tokenClient);
  let remote = await collectProtectedInventory({ adapter, inventory, tokenClient });
  assertSharedAccountInventory(inventory, remote);
  const protectedBefore = protectedRevision(remote, journal.identity);
  if (protectedBefore !== journal.preflight?.protectedRevision) throw new Error("remote identity changed");

  if (!journal.identity.databaseId) {
    const expectedRevision = createIdentityRevision(remote);
    const plannedD1 = resourceId(journal, "d1");
    const refuseUnacceptedDatabase = async ({ intent, state }) => {
      const acceptedId = intent.status === "applied" ? intent.providerAcceptance?.id : undefined;
      if (acceptedId === state.id && state.name === journal.identity.databaseName) return true;
      if (intent.status === "pending") {
        journal.incident = {
          kind: "d1-create-refused",
          failedPhase: journal.phase,
          owner: journal.owner,
          nextAction: "tear-down-pending-run-before-retrying",
          wholeStackRollback: false,
        };
        await persist(options.journalPath, journal);
        throw new Error(`a database named ${journal.identity.databaseName} already exists; tear down the pending run before retrying`);
      }
      journal.incident = {
        kind: "d1-acceptance-mismatch",
        databaseName: journal.identity.databaseName,
        failedPhase: journal.phase,
        owner: journal.owner,
        nextAction: "tear-down-refused-run-before-retrying",
        wholeStackRollback: false,
      };
      await persist(options.journalPath, journal);
      return false;
    };
    const created = await executeJournaledMutation({
      journal, expectedRevision,
      inspectRevision: () => currentIdentityRevision(adapter, inventory, tokenClient),
      resource: { domain: "d1", id: plannedD1 }, kind: "d1-create",
      persistJournal: (value) => persist(options.journalPath, value),
      inspect: async () => {
        const state = (await adapter.d1List()).map(databaseEntry).find((item) => item?.name === journal.identity.databaseName);
        return state ? { exists: true, ...state } : { exists: false };
      },
      mutate: async () => { await adapter.d1Create(journal.identity.databaseName); return { exists: true }; },
      owns: (state) => state.name === journal.identity.databaseName && typeof state.id === "string",
      reconcileExisting: refuseUnacceptedDatabase,
      finalize: async ({ intent, result }) => {
        const database = result.state;
        if (!DATABASE_ID.test(database?.id ?? "") || database.name !== journal.identity.databaseName) throw new Error("created database identity is invalid");
        intent.providerAcceptance = { id: database.id.toLowerCase() };
        journal.identity.databaseId = database.id.toLowerCase();
        journal.resources = journal.resources.filter((item) => !(item.domain === "d1" && item.id === plannedD1));
        putResource(journal, "d1", journal.identity.databaseId).status = "owned";
        journal.phase = "resources-ready";
      },
    });
    if (!created.state?.id || journal.phase !== "resources-ready") throw new Error("created database identity is unreadable");
  } else {
    const exact = remote.databases.find((item) => item.id === journal.identity.databaseId && item.name === journal.identity.databaseName);
    if (!exact) throw new Error("journaled D1 identity is absent or changed");
  }

  const privateConfig = await generateEffectiveConfig({ root: options.root, runId: journal.runId, inventory, databaseId: journal.identity.databaseId, sourceSha: journal.sourceSha, workersDev: false });
  journal.config = { privateDigest: privateConfig.configDigest, lifecycleTag: privateConfig.lifecycleTag };
  adapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId, configPath: privateConfig.configPath });
  if (!journal.recovery?.bookmark) {
    const bookmark = parseBookmark(await adapter.d1TimeTravelInfo(journal.identity.databaseName));
    journal.recovery = { bookmark };
    journal.phase = "bookmark-captured";
    await persist(options.journalPath, journal);
  }
  await verifyMigrationDirectory(path.join(options.root, "migrations", "d1"));
  const schemaExpected = await expectedSchema(options.root);
  const expectedSnapshot = { protectedRevision: await currentProtectedRevision(adapter, inventory, journal.identity, tokenClient), databaseId: journal.identity.databaseId };
  const inspectSnapshot = async () => ({ protectedRevision: await currentProtectedRevision(adapter, inventory, journal.identity, tokenClient), databaseId: journal.identity.databaseId });

  putResource(journal, "worker", journal.identity.workerName);
  putResource(journal, "durable-object", resourceId(journal, "durable-object"));
  if (!journal.mutations.some((item) => item?.kind === "durable-object-create")) journal.mutations.push({ kind: "durable-object-create", domain: "durable-object", id: resourceId(journal, "durable-object"), status: "pending" });
  await persist(options.journalPath, journal);
  const existingMigration009 = journal.migrations.find((item) => item.filename === "009_multiple_recovery_credentials.sql");
  let migration009 = existingMigration009?.postcondition?.migration009 ?? existingMigration009?.precondition?.migration009;
  if (!Array.isArray(journal.deploymentBaseline)) {
    const [baselineDeployments, baselineVersions] = await Promise.all([adapter.deploymentsList(journal.identity.workerName), adapter.versionsList(journal.identity.workerName)]);
    journal.deploymentBaseline = deploymentIds(baselineDeployments, baselineVersions);
    if (journal.deploymentBaseline.length > 0 && !journal.mutations.some((item) => item?.kind === "worker-deploy")) throw new Error("unexpected target deployment exists before journaled deploy");
    await persist(options.journalPath, journal);
  }
  const deployed = await runMigrationFirstDeployment({
    journal,
    lease: journal.lease,
    manifest: D1_MIGRATIONS,
    expectedSnapshot,
    inspectSnapshot,
    inspectLedger: () => inspectLedger(adapter, journal.identity.databaseName),
    persistJournal: (value) => persist(options.journalPath, value),
    applyMigration: async (migration) => {
      await assertRunMigrationPrefix(privateConfig.migrationsDirectory, journal);
      if (migration.filename === "009_multiple_recovery_credentials.sql") {
        const before = await recoveryCredentialCounts(adapter, journal.identity.databaseName);
        migration009 = { beforeRows: before.rows, beforeAssociations: before.associations, beforeAssociationDigest: before.associationDigest };
        const attestation = journal.migrations.find((item) => item.filename === migration.filename);
        attestation.precondition = { migration009 };
        await persist(options.journalPath, journal);
      }
      await copyMigration(options.root, privateConfig.migrationsDirectory, migration.filename);
      await assertRunMigrationPrefix(privateConfig.migrationsDirectory, journal, migration.filename);
      if (await currentProtectedRevision(adapter, inventory, journal.identity, tokenClient) !== journal.preflight?.protectedRevision) throw new Error("remote identity changed");
      await adapter.d1MigrationsApply(journal.identity.databaseName);
    },
    verifyMigration: async (migration) => {
      const [ledger, objectResult] = await Promise.all([
        inspectLedger(adapter, journal.identity.databaseName),
        adapter.d1Execute(journal.identity.databaseName, { command: "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'" }),
      ]);
      const objects = d1Results(objectResult);
      const attestation = journal.migrations.find((item) => item.filename === migration.filename);
      if (attestation) attestation.postcondition = { ledgerLength: ledger.length, schemaObjectCount: Number(objects[0]?.count ?? 0) };
      if (migration.filename === "009_multiple_recovery_credentials.sql") {
        const after = await recoveryCredentialCounts(adapter, journal.identity.databaseName);
        migration009 = { ...migration009, afterRows: after.rows, afterAssociations: after.associations, afterAssociationDigest: after.associationDigest };
        if (attestation) attestation.postcondition.migration009 = migration009;
      }
      return ledger.some((item) => item.name === migration.filename) && Number(objects[0]?.count ?? 0) > 0;
    },
    verifyFinalSchema: async () => {
      journal.phase = "schema-expanded";
      const actual = await remoteSchema(adapter, journal.identity.databaseName, migration009);
      recordVerifiedSchemaEvidence(journal, actual, schemaExpected);
      await persist(options.journalPath, journal);
    },
    deployWorker: async () => { await adapter.deploy(journal.identity.workerName); return deploymentProof(adapter, journal.identity.workerName); },
    inspectDeployment: () => deploymentProof(adapter, journal.identity.workerName),
    verifyDeployment: async (actual) => {
      if (!actual?.deploymentId || !Array.isArray(actual.deploymentIds)) throw new Error("deployment identity is missing");
      const intent = journal.mutations.find((item) => item?.kind === "worker-deploy");
      if (intent?.deploymentId) {
        if (!actual.deploymentIds.includes(intent.deploymentId)) throw new Error("journaled deployment identity changed");
        actual.deploymentId = intent.deploymentId;
      } else {
        actual.deploymentId = newDeploymentId(journal.deploymentBaseline, actual);
      }
    },
  });
  journal.deployment = { initialId: deployed.deployment.deploymentId, sourceSha: journal.sourceSha, configDigest: privateConfig.configDigest, bindings: ["APP_ORIGIN", "DB", "LIVE_COORDINATOR"], rollback: "forward-fix-only", lifecycle: "legacy-sqlite-v1" };
  await persist(options.journalPath, journal);

  remote = await collectProtectedInventory({ adapter, inventory, tokenClient });
  await executeJournaledMutation({
    journal, expectedRevision: createIdentityRevision(remote),
    inspectRevision: () => currentIdentityRevision(adapter, inventory, tokenClient),
    resource: { domain: "secret", id: "LIVE_COMMAND_SECRET" }, kind: "secret-put",
    persistJournal: (value) => persist(options.journalPath, value),
    inspect: async () => ({ exists: (await adapter.secretList(journal.identity.workerName)).some((item) => item?.name === "LIVE_COMMAND_SECRET"), id: "LIVE_COMMAND_SECRET" }),
    mutate: () => adapter.secretPut("LIVE_COMMAND_SECRET", credentials.liveSecret, { workerName: journal.identity.workerName }),
    owns: (state) => state.id === "LIVE_COMMAND_SECRET",
  });

  const activeConfig = await generateEffectiveConfig({ root: options.root, runId: journal.runId, inventory, databaseId: journal.identity.databaseId, sourceSha: journal.sourceSha, workersDev: true });
  journal.config.activeDigest = activeConfig.configDigest;
  const activeAdapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId, configPath: activeConfig.configPath });
  remote = await collectProtectedInventory({ adapter, inventory, tokenClient });
  const activeExpected = { workerName: journal.identity.workerName, sourceSha: journal.sourceSha, configDigest: activeConfig.configDigest, bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"], lifecycle: "legacy-sqlite-v1" };
  const privateDeploymentIds = (await deploymentProof(adapter, journal.identity.workerName)).deploymentIds;
  const activation = await executeJournaledMutation({
    journal, expectedRevision: createIdentityRevision(remote),
    inspectRevision: () => currentIdentityRevision(adapter, inventory, tokenClient),
    resource: { domain: "route", id: resourceId(journal, "route") }, kind: "workers-dev-enable",
    intentMetadata: { beforeDeploymentIds: privateDeploymentIds },
    persistJournal: (value) => persist(options.journalPath, value),
    inspect: async () => {
      const marker = await releaseMarker(dependencies.fetch, journal.identity.origin);
      return marker ? { exists: true, id: resourceId(journal, "route"), marker } : { exists: false };
    },
    mutate: () => activeAdapter.deploy(journal.identity.workerName),
    owns: (state) => state.id === resourceId(journal, "route") && state.marker?.sourceSha === journal.sourceSha && state.marker?.configDigest === activeConfig.configDigest,
  });
  const marker = activation.state?.marker ?? await releaseMarker(dependencies.fetch, journal.identity.origin);
  assertMarker(activeExpected, marker);
  const finalDeployment = await deploymentProof(activeAdapter, journal.identity.workerName);
  const activationIntent = journal.mutations.find((item) => item?.kind === "workers-dev-enable");
  journal.deployment.activeId = newDeploymentId(activationIntent?.beforeDeploymentIds ?? privateDeploymentIds, finalDeployment);
  journal.phase = "alias-live";
  await persist(options.journalPath, journal);
  return { operation: "apply", phase: journal.phase, migrationCount: journal.migrations.length, rollback: "forward-fix-only", wholeStackRollback: false };
}

async function applyWithIncidentCapture(options, dependencies) {
  try {
    return await applyOperation(options, dependencies);
  } catch (error) {
    let quarantineFailed = false;
    try {
      const journal = await loadOwnedJournal(options);
      if (journal.identity.databaseId && !["quarantined", "cleanup-complete"].includes(journal.phase)) {
        const failedPhase = journal.phase;
        journal.incident = { failedPhase, owner: journal.owner, nextAction: "reconcile-and-forward-fix-or-teardown", wholeStackRollback: false };
        await persist(options.journalPath, journal);
        const credentials = requireCredentials(options.credentialEnvironment, "apply");
        const inventory = validateStagingInventory(await readPrivateJson(options.root, options.inventoryPath), dependencies.sourceState?.(options.root) ?? inspectSourceState(options.root));
        const privateConfig = await generateEffectiveConfig({ root: options.root, runId: journal.runId, inventory, databaseId: journal.identity.databaseId, sourceSha: journal.sourceSha, workersDev: false });
        const adapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId });
        const privateAdapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId, configPath: privateConfig.configPath });
        const tokenClient = dependencies.tokenClientFactory({ token: credentials.token });
        await quarantine(options, dependencies, { adapter, privateAdapter, tokenClient, journal, inventory });
      }
    } catch {
      quarantineFailed = true;
      try {
        const journal = await loadOwnedJournal(options);
        journal.incident = { ...(journal.incident ?? {}), owner: journal.owner, quarantineFailed: true, nextAction: "treat-origin-as-live-and-reconcile", wholeStackRollback: false };
        await persist(options.journalPath, journal);
      } catch {}
    }
    if (quarantineFailed) throw new Error("apply failed and automatic origin quarantine failed; treat the origin as live", { cause: error });
    throw error;
  }
}

async function quarantine(options, dependencies, { adapter, privateAdapter, tokenClient, journal, inventory }) {
  // journalPath and the clock/fetch seams are always options.X / dependencies.X; only the
  // adapters and the journal differ per call site. Threading them explicitly grew this
  // signature to ten parameters and duplicated the same four lines at all three callers.
  const journalPath = options.journalPath;
  const { fetch, setTimer, clearTimer, now } = dependencies;
  const enabledBefore = await workersDevEnabled(inventory, journal, tokenClient);
  let intent = journal.mutations.find((item) => item?.kind === "workers-dev-disable");
  if (!intent) {
    intent = { kind: "workers-dev-disable", domain: "route", id: resourceId(journal, "route"), status: "pending" };
    if (enabledBefore) intent.beforeDeploymentIds = (await deploymentProof(adapter, journal.identity.workerName)).deploymentIds;
    journal.mutations.push(intent);
    await persist(journalPath, journal);
  }
  if (enabledBefore) {
    if (await currentProtectedRevision(adapter, inventory, journal.identity, tokenClient) !== journal.preflight?.protectedRevision) throw new Error("remote identity changed");
    assertMarker({ sourceSha: journal.sourceSha, configDigest: journal.config?.activeDigest, bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"] }, await releaseMarker(fetch, journal.identity.origin));
    try {
      if (await currentProtectedRevision(adapter, inventory, journal.identity, tokenClient) !== journal.preflight?.protectedRevision) throw new Error("remote identity changed");
      await privateAdapter.deploy(journal.identity.workerName);
    }
    catch (error) {
      const absence = await confirmWorkersDevAbsence(inventory, journal, tokenClient, { setTimer, clearTimer, now });
      if (absence.outcome === "present") throw error;
      if (absence.outcome === "could-not-confirm") {
        await recordUnconfirmedOriginAbsence(journalPath, journal, absence, { disableFailed: true });
        return absence.outcome;
      }
      await settleQuarantine({ privateAdapter, journal, journalPath, intent });
      return "proven-absent";
    }
  }
  const absence = await confirmWorkersDevAbsence(inventory, journal, tokenClient, { setTimer, clearTimer, now });
  if (absence.outcome === "present") throw new Error("origin quarantine absence proof failed");
  if (absence.outcome === "could-not-confirm") {
    await recordUnconfirmedOriginAbsence(journalPath, journal, absence);
    return absence.outcome;
  }
  await settleQuarantine({ privateAdapter, journal, journalPath, intent });
  return "proven-absent";
}

async function settleQuarantine({ privateAdapter, journal, journalPath, intent }) {
  if (Array.isArray(intent.beforeDeploymentIds)) {
    const proof = await deploymentProof(privateAdapter, journal.identity.workerName);
    intent.deploymentId = newDeploymentId(intent.beforeDeploymentIds, proof);
  } else {
    intent.notRequired = true;
  }
  intent.status = "applied";
  journal.phase = "quarantined";
  await persist(journalPath, journal);
}

async function verifyOperation(options, dependencies) {
  requiredOptions(options, ["inventoryPath", "journalPath", "runId", "owner"]);
  const credentials = requireCredentials(options.credentialEnvironment, "verify");
  const inventory = validateStagingInventory(await readPrivateJson(options.root, options.inventoryPath), dependencies.sourceState?.(options.root) ?? inspectSourceState(options.root));
  const journal = await loadOwnedJournal(options);
  if (!inventoryMatchesJournal(journal.identity, inventory.staging) || journal.sourceSha !== inventory.expectedSourceSha) throw new Error("private inventory no longer matches the journal");
  if (!["alias-live", "verified"].includes(journal.phase)) throw new Error("active exact staging release is required before verification");
  const activeConfig = await generateEffectiveConfig({ root: options.root, runId: journal.runId, inventory, databaseId: journal.identity.databaseId, sourceSha: journal.sourceSha, workersDev: true });
  const privateConfig = await generateEffectiveConfig({ root: options.root, runId: journal.runId, inventory, databaseId: journal.identity.databaseId, sourceSha: journal.sourceSha, workersDev: false });
  const adapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId, configPath: activeConfig.configPath });
  const privateAdapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId, configPath: privateConfig.configPath });
  const tokenClient = dependencies.tokenClientFactory({ token: credentials.token });
  await assertOperatorTokenActive(tokenClient);
  assertSharedAccountInventory(inventory, await collectProtectedInventory({ adapter, inventory, tokenClient }));
  if (journal.phase === "verified") {
    const acceptanceFailed = journal.acceptance?.status !== "passed";
    const savedEvidence = journal.acceptanceEvidence;
    const replayAbsence = await quarantine(options, dependencies, { adapter, privateAdapter, tokenClient, journal, inventory });
    if (acceptanceFailed || !savedEvidence) {
      const originState = journal.phase === "quarantined" ? "origin is quarantined" : "origin absence could not be confirmed";
      throw new Error(`deployed acceptance previously failed; ${originState}`);
    }
    // Same rule as the first-run path: a re-entrant verify must not report success over an
    // origin it could not prove closed.
    if (replayAbsence !== "proven-absent") throw new Error("deployed acceptance passed but origin absence could not be confirmed");
    return { operation: "verify", phase: journal.phase, outcomes: savedEvidence.outcomes, counts: savedEvidence.counts, originAbsence: replayAbsence, wholeStackRollback: false };
  }
  let originAbsence;
  const markerExpected = { sourceSha: journal.sourceSha, configDigest: activeConfig.configDigest, bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"] };
  const assertActiveOrigin = async () => {
    if (!await workersDevEnabled(inventory, journal, tokenClient)) throw new Error("authenticated workers.dev exposure is inactive");
    assertMarker(markerExpected, await releaseMarker(dependencies.fetch, journal.identity.origin));
  };
  await assertActiveOrigin();
  const preFixtureBookmark = parseBookmark(await adapter.d1TimeTravelInfo(journal.identity.databaseName));
  const fixturePlan = createSyntheticFixturePlan({ runId: journal.runId, organizerToken: credentials.organizerToken, preFixtureBookmark });
  putResource(journal, "credential", fixturePlan.tokenHash);
  await persist(options.journalPath, journal);
  const now = dependencies.now().toISOString();
  const fixtureFile = await writeFixtureSql(activeConfig, fixturePlan, now);
  const acceptanceFetch = async (input, init = {}) => {
    await assertActiveOrigin();
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method) && await currentProtectedRevision(adapter, inventory, journal.identity, tokenClient) !== journal.preflight?.protectedRevision) {
      throw new Error("remote identity changed");
    }
    return dependencies.fetch(input, { ...init, redirect: init.redirect ?? "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
  };
  let evidence;
  try {
    evidence = await dependencies.acceptance({
      origin: journal.identity.origin,
      journal,
      plan: fixturePlan,
      organizerToken: credentials.organizerToken,
      fetch: acceptanceFetch,
      persistJournal: (value) => persist(options.journalPath, value),
      inspectFixtures: async () => {
        const rows = d1Results(await adapter.d1Execute(journal.identity.databaseName, { command: `SELECT count(*) AS count FROM communities WHERE id=${sql(fixturePlan.communityId)} UNION ALL SELECT count(*) FROM events WHERE id=${sql(fixturePlan.eventId)} UNION ALL SELECT count(*) FROM canonical_songs WHERE id IN (${fixturePlan.songIds.map(sql).join(",")}) UNION ALL SELECT count(*) FROM event_eligible_songs WHERE event_id=${sql(fixturePlan.eventId)} UNION ALL SELECT count(*) FROM guest_participations WHERE id=${sql(fixturePlan.organizerParticipationId)} UNION ALL SELECT count(*) FROM participant_sessions WHERE id_hash=${sql(fixturePlan.tokenHash)}` }));
        const count = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
        return { complete: count === fixturePlan.rows.length, count };
      },
      seedFixtures: async () => {
        if (await currentProtectedRevision(adapter, inventory, journal.identity, tokenClient) !== journal.preflight?.protectedRevision) throw new Error("remote identity changed");
        return adapter.d1Execute(journal.identity.databaseName, { file: fixtureFile });
      },
      buildLiveCommand: ({ commandCredential, authorityEpoch, plan }) => signedLiveCommand({ commandCredential, authorityEpoch, plan, now: dependencies.now() }),
    });
    const compatibility = { durableObject: "legacy-sqlite-v1", d1Schema: journal.schema.digest, durableObjectShape: "live-v1", bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"], secrets: ["LIVE_COMMAND_SECRET"] };
    assertRollbackCompatible(compatibility, structuredClone(compatibility));
    journal.rollback = { workerCode: "same-lifecycle-only", initialLifecycle: "forward-fix-only", d1: "quarantined-bookmark-only", durableObject: "forward-fix-only", wholeStackRollback: false };
    journal.acceptanceEvidence = evidence;
    await persist(options.journalPath, journal);
  } finally {
    originAbsence = await quarantine(options, dependencies, { adapter, privateAdapter, tokenClient, journal, inventory });
  }
  // An unconfirmed origin is not a clean verify. The operator sees it in the result and the
  // CLI exits non-zero, because "verify succeeded" over a possibly-live exposure is the one
  // reading of this state that is never safe.
  if (originAbsence !== "proven-absent") throw new Error("deployed acceptance passed but origin absence could not be confirmed");
  return { operation: "verify", phase: journal.phase, outcomes: evidence.outcomes, counts: evidence.counts, originAbsence, wholeStackRollback: false };
}

function activeCredential(journal) {
  return journal.acceptance?.fixturePlan?.tokenHash;
}

async function inspectDeploymentToken(tokenClient, id) {
  return tokenClient.inspectId ? tokenClient.inspectId(id) : tokenClient.inspect();
}

async function assertOperatorTokenActive(tokenClient) {
  const current = await tokenClient.inspect();
  if (current?.active) return "operator";
  throw new Error("operator token is not active");
}

async function writeCredentialRevocation(config, journal, now) {
  const tokenHash = activeCredential(journal);
  if (!tokenHash) return null;
  const file = path.join(config.migrationsDirectory, "revoke-organizer.sql");
  await writeFile(file, `UPDATE participant_sessions SET revoked_at=${sql(now)} WHERE id_hash=${sql(tokenHash)};\n`, { mode: 0o600 });
  return file;
}

function refusedD1CreateIntent(journal) {
  const incidentKind = journal.incident?.kind;
  if (!D1_CREATE_REFUSAL_INCIDENTS.has(incidentKind)) throw new Error("refused D1 create incident is missing");
  const d1Intent = journal.mutations.find((mutation) => mutation?.kind === "d1-create");
  const acceptanceMismatch = incidentKind === "d1-acceptance-mismatch";
  const unexpectedAppliedMutation = journal.mutations.some((mutation) => mutation.status === "applied" && (!acceptanceMismatch || mutation !== d1Intent));
  if (journal.identity.databaseId || journal.resources.some((resource) => resource.status === "owned") || unexpectedAppliedMutation) {
    throw new Error("refused D1 create journal contains unexpected ownership");
  }
  if (!d1Intent || (!acceptanceMismatch && d1Intent.status !== "pending")) throw new Error("refused D1 create intent is missing");
  if (acceptanceMismatch && (journal.incident.databaseName !== journal.identity.databaseName || d1Intent.status !== "applied" || !d1Intent.providerAcceptance?.id)) {
    throw new Error("refused D1 create acceptance mismatch is invalid");
  }
  return d1Intent;
}

async function teardownOperation(options, dependencies) {
  requiredOptions(options, ["inventoryPath", "journalPath", "runId", "owner"]);
  const inventory = validateStagingInventory(await readPrivateJson(options.root, options.inventoryPath), dependencies.sourceState?.(options.root) ?? inspectSourceState(options.root));
  const journal = await loadOwnedJournal(options);
  if (!inventoryMatchesJournal(journal.identity, inventory.staging) || journal.sourceSha !== inventory.expectedSourceSha) throw new Error("private inventory no longer matches the journal");
  if (journal.phase === "cleanup-complete") {
    const evidencePath = `${options.journalPath}.evidence.json`;
    let packet;
    try { packet = JSON.parse(await readFile(evidencePath, "utf8")); }
    catch { throw new Error("completed teardown evidence is missing or unreadable"); }
    await saveEvidencePacket(evidencePath, packet);
    await rm(effectiveConfigDirectory(options.root, journal.runId), { recursive: true, force: true });
    return { operation: "teardown", phase: journal.phase, absenceCount: Object.keys(journal.teardown?.absence ?? {}).length, cleanupComplete: true, wholeStackRollback: false };
  }
  if (journal.phase === "pre-write" && D1_CREATE_REFUSAL_INCIDENTS.has(journal.incident?.kind)) {
    refusedD1CreateIntent(journal);
    const credentials = requireCredentials(options.credentialEnvironment, "teardown");
    const adapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId });
    const tokenClient = dependencies.tokenClientFactory({ token: credentials.token });
    await assertOperatorTokenActive(tokenClient);
    const remote = await collectProtectedInventory({ adapter, inventory, tokenClient });
    assertSharedAccountInventory(inventory, remote);
    const protectedAfter = protectedRevision(remote, journal.identity);
    if (protectedAfter !== journal.preflight?.protectedRevision) throw new Error("remote identity changed");
    const completedAt = dependencies.now().toISOString();
    const absence = Object.fromEntries(journal.resources.map((resource) => [`${resource.domain}:${resource.id}`, true]));
    journal.phase = "cleanup-complete";
    journal.acceptance = { status: "not-run", cleanupComplete: true };
    journal.incident = { ...journal.incident, resolvedAt: completedAt };
    journal.teardown = { absence, completedAt, durableObjectStateRemovedWithNamespace: false, refusedD1Create: true };
    journal.retention = createJournalRetention({ incidentResolvedAt: completedAt });
    const packet = createFinalEvidencePacket({
      runId: journal.runId,
      sourceSha: journal.sourceSha,
      phase: journal.phase,
      configDigest: sha256(canonicalJson({ sourceSha: journal.sourceSha, state: "configuration-not-generated" })),
      schemaDigest: sha256(canonicalJson([])),
      protectedRevisionBefore: journal.preflight.protectedRevision,
      protectedRevisionAfter: protectedAfter,
      migrationCount: 0,
      absence,
      rollback: { workerCode: "not-deployed", initialLifecycle: "not-deployed", d1: "not-owned", durableObject: "not-deployed", wholeStackRollback: false },
      completedAt,
    });
    const evidencePath = `${options.journalPath}.evidence.json`;
    await saveEvidencePacket(evidencePath, packet);
    await persist(options.journalPath, journal);
    await rm(effectiveConfigDirectory(options.root, journal.runId), { recursive: true, force: true });
    return { operation: "teardown", phase: journal.phase, absenceCount: Object.keys(absence).length, cleanupComplete: true, wholeStackRollback: false };
  }
  if (!TEARDOWN_ENTRY_PHASES.includes(journal.phase)) throw new Error("teardown requires a post-write journal phase");
  const credentials = requireCredentials(options.credentialEnvironment, "teardown");
  const privateConfig = await generateEffectiveConfig({ root: options.root, runId: journal.runId, inventory, databaseId: journal.identity.databaseId, sourceSha: journal.sourceSha, workersDev: false });
  const deleteConfig = await generateEffectiveConfig({ root: options.root, runId: journal.runId, inventory, databaseId: journal.identity.databaseId, sourceSha: journal.sourceSha, workersDev: false, deleteDurableObject: true });
  let adapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId, configPath: privateConfig.configPath });
  const tokenClient = dependencies.tokenClientFactory({ token: credentials.token });
  const absenceOptions = { setTimer: dependencies.setTimer, clearTimer: dependencies.clearTimer, now: dependencies.now };
  await assertOperatorTokenActive(tokenClient);
  assertSharedAccountInventory(inventory, await collectProtectedInventory({ adapter, inventory, tokenClient }));
  const expectedProtected = journal.preflight.protectedRevision;
  const inspectRevision = () => currentProtectedRevision(adapter, inventory, journal.identity, tokenClient);
  if (await inspectRevision() !== expectedProtected) throw new Error("remote identity changed");
  const assertWriteIdentity = async () => {
    if (await inspectRevision() !== expectedProtected) throw new Error("remote identity changed");
  };
  const workerExists = async () => {
    const [deployments, versions] = await Promise.all([adapter.deploymentsList(journal.identity.workerName), adapter.versionsList(journal.identity.workerName)]);
    return deployments.length > 0 || versions.length > 0;
  };
  const credentialRevocation = await writeCredentialRevocation(privateConfig, journal, dependencies.now().toISOString());
  // A Worker is matched by name alone, so inspectResource can only stamp the journal's own
  // identity onto whatever is remotely present -- which makes recovery's ownership check
  // compare the journal against itself. That was safe while teardown required "quarantined",
  // because reaching it implied this run had deployed. The widened entry accepts phases that
  // carry no such implication, so a run that crashed before deploying could delete a same-named
  // Worker a later run created. Require this run's own applied deploy before touching one.
  const DEPLOYED_PHASES = ["worker-deployed", "alias-live", "verified", "quarantined", "cleanup-complete"];
  const deployedByThisRun = journal.mutations.some((item) => item?.kind === "worker-deploy" && item.status === "applied")
    || DEPLOYED_PHASES.includes(journal.phase);
  const assertRunDeployedIt = (present) => {
    if (present && !deployedByThisRun) throw new Error("remote Worker predates this run's deployment; refusing to remove it");
    return present;
  };
  const inspectResource = async (resource) => {
    if (resource.domain === "route") {
      const absence = await confirmWorkersDevAbsence(inventory, journal, tokenClient, absenceOptions);
      return { exists: absence.outcome !== "proven-absent", runId: journal.runId, owner: journal.owner };
    }
    if (resource.domain === "credential") {
      if (!activeCredential(journal) || !journal.identity.databaseId) return { exists: false, runId: journal.runId, owner: journal.owner };
      const rows = d1Results(await adapter.d1Execute(journal.identity.databaseName, { command: `SELECT count(*) AS count FROM participant_sessions WHERE id_hash=${sql(activeCredential(journal))} AND revoked_at IS NULL` }));
      return { exists: Number(rows[0]?.count ?? 0) > 0, runId: journal.runId, owner: journal.owner };
    }
    if (resource.domain === "secret") return { exists: assertRunDeployedIt((await adapter.secretList(journal.identity.workerName)).some((item) => item?.name === "LIVE_COMMAND_SECRET")), runId: journal.runId, owner: journal.owner };
    if (resource.domain === "worker") return { exists: assertRunDeployedIt(await workerExists()), runId: journal.runId, owner: journal.owner };
    if (resource.domain === "durable-object") {
      const deletionProven = journal.mutations.some((item) => item?.kind === "durable-object-delete" && item.status === "applied" && item.tag === deleteConfig.deletionTag && item.configDigest === deleteConfig.configDigest);
      const creationApplied = journal.mutations.some((item) => item?.kind === "durable-object-create" && item.status === "applied");
      const neverCreated = resource.status === "planned" && !creationApplied;
      if (neverCreated) return { exists: false, runId: journal.runId, owner: journal.owner };
      if (!await workerExists() && !deletionProven) throw new Error("Durable Object absence is unproven without the deleted_classes lifecycle");
      return { exists: !deletionProven, runId: journal.runId, owner: journal.owner };
    }
    if (resource.domain === "d1") return { exists: (await adapter.d1List()).map(databaseEntry).some((item) => item?.id === journal.identity.databaseId && item?.name === journal.identity.databaseName), runId: journal.runId, owner: journal.owner };
    if (resource.domain === "token") {
      if (resource.provenance !== "run-minted") throw new Error("only a run-minted token may be revoked");
      const state = await inspectDeploymentToken(tokenClient, resource.id);
      const acceptedRevocation = journal.mutations.some((item) => item?.kind === "teardown-token" && item?.id === resource.id && item.revocationAccepted === true);
      if (state.unauthorized === true && !acceptedRevocation) throw new Error("deployment token absence is unauthorized");
      return { exists: state.unauthorized === true ? false : state.active === true && state.id === resource.id, runId: journal.runId, owner: journal.owner };
    }
    if (resource.domain === "hostname") return { exists: false, runId: journal.runId, owner: journal.owner };
    throw new Error("unsupported teardown resource domain");
  };
  const performRemoval = async (resource) => {
    if (resource.domain === "route") {
      await assertWriteIdentity();
      await adapter.deploy(journal.identity.workerName);
      return;
    }
    if (resource.domain === "credential") {
      if (credentialRevocation) {
        await assertWriteIdentity();
        await adapter.d1Execute(journal.identity.databaseName, { file: credentialRevocation });
      }
      return;
    }
    if (resource.domain === "secret") {
      await assertWriteIdentity();
      await adapter.secretDelete("LIVE_COMMAND_SECRET", journal.identity.workerName);
      return;
    }
    if (resource.domain === "worker") {
      const deletionAdapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId, configPath: deleteConfig.configPath });
      let deletionIntent = journal.mutations.find((item) => item?.kind === "durable-object-delete");
      if (!deletionIntent) {
        const [beforeDeployments, beforeVersions] = await Promise.all([deletionAdapter.deploymentsList(journal.identity.workerName), deletionAdapter.versionsList(journal.identity.workerName)]);
        deletionIntent = { kind: "durable-object-delete", domain: "durable-object", id: resourceId(journal, "durable-object"), status: "pending", tag: deleteConfig.deletionTag, beforeDeploymentIds: deploymentIds(beforeDeployments, beforeVersions) };
        journal.mutations.push(deletionIntent);
        await persist(options.journalPath, journal);
      }
      if (deletionIntent.status === "pending") {
        const [currentDeployments, currentVersions] = await Promise.all([deletionAdapter.deploymentsList(journal.identity.workerName), deletionAdapter.versionsList(journal.identity.workerName)]);
        const currentIds = deploymentIds(currentDeployments, currentVersions);
        let afterIds = currentIds;
        if (canonicalJson(currentIds) === canonicalJson(deletionIntent.beforeDeploymentIds)) {
          try {
            await assertWriteIdentity();
            await deletionAdapter.deploy(journal.identity.workerName);
          }
          catch (error) {
            const [afterDeployments, afterVersions] = await Promise.all([deletionAdapter.deploymentsList(journal.identity.workerName), deletionAdapter.versionsList(journal.identity.workerName)]);
            afterIds = deploymentIds(afterDeployments, afterVersions);
            if (canonicalJson(afterIds) === canonicalJson(deletionIntent.beforeDeploymentIds)) throw new Error("Durable Object deletion outcome is uncertain; no replay authorized", { cause: error });
          }
        }
        if (canonicalJson(afterIds) === canonicalJson(currentIds)) {
          const [afterDeployments, afterVersions] = await Promise.all([deletionAdapter.deploymentsList(journal.identity.workerName), deletionAdapter.versionsList(journal.identity.workerName)]);
          afterIds = deploymentIds(afterDeployments, afterVersions);
        }
        if (canonicalJson(afterIds) === canonicalJson(deletionIntent.beforeDeploymentIds)) throw new Error("Durable Object deletion deployment postcondition failed");
        deletionIntent.afterDeploymentIds = afterIds;
        deletionIntent.tag = deleteConfig.deletionTag;
        deletionIntent.configDigest = deleteConfig.configDigest;
        deletionIntent.status = "applied";
        await persist(options.journalPath, journal);
      }
      await assertWriteIdentity();
      await deletionAdapter.deleteWorker(journal.identity.workerName);
      adapter = deletionAdapter;
      return;
    }
    if (resource.domain === "durable-object") return;
    if (resource.domain === "d1") {
      await assertWriteIdentity();
      await adapter.d1Delete(journal.identity.databaseName);
      return;
    }
    if (resource.domain === "token") {
      if (resource.provenance !== "run-minted") throw new Error("only a run-minted token may be revoked");
      await assertWriteIdentity();
      await tokenClient.revoke(resource.id);
      const intent = journal.mutations.find((item) => item?.kind === "teardown-token" && item?.id === resource.id);
      if (!intent) throw new Error("deployment token revocation intent is missing");
      intent.revocationAccepted = true;
      await persist(options.journalPath, journal);
      return;
    }
    if (resource.domain === "hostname") return;
  };
  const removeResource = async (resource) => {
    const kind = `teardown-${resource.domain}`;
    let intent = journal.mutations.find((item) => item?.kind === kind && item?.id === resource.id);
    if (!intent) {
      intent = { kind, domain: resource.domain, id: resource.id, status: "pending" };
      journal.mutations.push(intent);
      await persist(options.journalPath, journal);
    }
    try {
      await performRemoval(resource);
    } catch (error) {
      const reconciled = await inspectResource(resource);
      if (reconciled?.exists !== false) throw new Error("teardown mutation outcome is uncertain; no retry authorized", { cause: error });
    }
    intent.status = "applied";
    await persist(options.journalPath, journal);
  };
  const result = await runStackTeardown({
    journal,
    lease: journal.lease,
    expectedRevision: expectedProtected,
    inspectRevision,
    listDependents: async (resource) => {
      if (resource.domain === "worker") {
        const absence = await confirmWorkersDevAbsence(inventory, journal, tokenClient, absenceOptions);
        if (absence.outcome !== "proven-absent") return ["owned-origin-still-active"];
      }
      if (["durable-object", "d1"].includes(resource.domain) && await workerExists()) return ["owned-worker-still-present"];
      return [];
    },
    inspectResource,
    removeResource,
    verifyTokenInactive: async () => {
      const tokenResource = journal.resources.find((item) => item?.domain === "token");
      if (!tokenResource) return true;
      const state = await inspectDeploymentToken(tokenClient, tokenResource.id);
      const acceptedRevocation = journal.mutations.some((item) => item?.kind === "teardown-token" && item.revocationAccepted === true);
      return state.active === false || (state.unauthorized === true && acceptedRevocation);
    },
  });
  for (const intent of journal.mutations.filter((item) => item?.kind?.startsWith("teardown-") && item.status === "pending")) {
    if (result.absence[`${intent.domain}:${intent.id}`] === true) intent.status = "applied";
  }
  await assertNoEnvironmentSuffixedWorker(inventory, journal, tokenClient);
  journal.phase = "cleanup-complete";
  journal.acceptance = { ...(journal.acceptance ?? { status: "not-run" }), cleanupComplete: true };
  journal.teardown = { absence: result.absence, completedAt: dependencies.now().toISOString(), durableObjectStateRemovedWithNamespace: result.durableObjectStateRemovedWithNamespace };
  journal.retention = createJournalRetention({ completedAt: journal.teardown.completedAt });
  const packet = createFinalEvidencePacket({
    runId: journal.runId,
    sourceSha: journal.sourceSha,
    phase: journal.phase,
    configDigest: journal.config?.activeDigest ?? journal.config?.privateDigest ?? sha256(canonicalJson({ sourceSha: journal.sourceSha, state: "configuration-not-generated" })),
    schemaDigest: journal.schema?.digest ?? sha256(canonicalJson(journal.migrations.map(({ filename, sha256: digest, status }) => ({ filename, digest, status })))),
    protectedRevisionBefore: expectedProtected,
    protectedRevisionAfter: result.protectedRevision,
    migrationCount: journal.migrations.length,
    absence: result.absence,
    rollback: journal.rollback ?? { workerCode: "not-deployed-or-forward-fix-only", initialLifecycle: "forward-fix-only", d1: "quarantined-bookmark-only", durableObject: "forward-fix-only", wholeStackRollback: false },
    completedAt: journal.teardown.completedAt,
  });
  const evidencePath = `${options.journalPath}.evidence.json`;
  await saveEvidencePacket(evidencePath, packet);
  await persist(options.journalPath, journal);
  await rm(effectiveConfigDirectory(options.root, journal.runId), { recursive: true, force: true });
  return { operation: "teardown", phase: journal.phase, absenceCount: Object.keys(result.absence).length, cleanupComplete: true, wholeStackRollback: false };
}

async function absenceOperation(options, dependencies) {
  requiredOptions(options, ["inventoryPath", "journalPath", "runId", "owner"]);
  const credentials = requireCredentials(options.credentialEnvironment, "absence-check");
  const inventory = validateStagingInventory(await readPrivateJson(options.root, options.inventoryPath), dependencies.sourceState?.(options.root) ?? inspectSourceState(options.root));
  const journal = await loadOwnedJournal(options);
  if (!inventoryMatchesJournal(journal.identity, inventory.staging) || journal.sourceSha !== inventory.expectedSourceSha) throw new Error("private inventory no longer matches the journal");
  if (journal.phase !== "cleanup-complete") throw new Error("completed teardown journal is required");
  const adapter = dependencies.adapterFactory({ root: options.root, token: credentials.token, accountId: inventory.staging.accountId });
  const tokenClient = dependencies.tokenClientFactory({ token: credentials.token });
  if (journal.teardown?.refusedD1Create === true && D1_CREATE_REFUSAL_INCIDENTS.has(journal.incident?.kind)) {
    refusedD1CreateIntent(journal);
    await assertOperatorTokenActive(tokenClient);
    const remote = await collectProtectedInventory({ adapter, inventory, tokenClient });
    assertSharedAccountInventory(inventory, remote);
    if (protectedRevision(remote, journal.identity) !== journal.preflight?.protectedRevision) throw new Error("remote identity changed");
    journal.absenceChecks = [...(journal.absenceChecks ?? []), { checkedAt: dependencies.now().toISOString(), domains: 0, passed: true, refusedD1Create: true }];
    await persist(options.journalPath, journal);
    return { operation: "absence-check", phase: journal.phase, absenceCount: 0, passed: true };
  }
  const remote = await collectRemoteInventory({ adapter, inventory });
  assertCredentialedPreflight(inventory, await withAccountWideWorkers(inventory, remote, tokenClient), { localSecretAvailable: true });
  const d1Absent = !remote.databases.some((item) => item.id === journal.identity.databaseId || item.name === journal.identity.databaseName);
  const workerAbsent = !remote.workers.some((item) => item.name === journal.identity.workerName);
  const durableObjectDeletionProven = journal.mutations.some((item) => item?.kind === "durable-object-delete" && item.status === "applied" && /^woodshed-staging-delete-[a-f0-9]{16}$/.test(item.tag ?? "") && /^[a-f0-9]{64}$/.test(item.configDigest ?? ""));
  const absenceOptions = { setTimer: dependencies.setTimer, clearTimer: dependencies.clearTimer, now: dependencies.now };
  // A D1 database or Worker still present already dooms the proof below, and the failure path
  // records no per-domain detail, so spending the route retry budget first buys nothing.
  if (!d1Absent || !workerAbsent) throw new Error("delayed absence proof failed");
  const routeAbsence = await confirmWorkersDevAbsence(inventory, journal, tokenClient, absenceOptions);
  const absent = {
    route: routeAbsence.outcome === "proven-absent",
    hostname: true,
    credential: d1Absent,
    secret: workerAbsent && !remote.secretNames.includes("LIVE_COMMAND_SECRET"),
    worker: workerAbsent,
    "durable-object": workerAbsent && durableObjectDeletionProven,
    d1: d1Absent,
  };
  const tokenResource = journal.resources.find((item) => item?.domain === "token");
  if (tokenResource) absent.token = (await inspectDeploymentToken(tokenClient, tokenResource.id)).active === false;
  if (Object.values(absent).some((value) => !value)) throw new Error("delayed absence proof failed");
  journal.absenceChecks = [...(journal.absenceChecks ?? []), { checkedAt: dependencies.now().toISOString(), domains: Object.keys(absent).length, passed: true }];
  await persist(options.journalPath, journal);
  return { operation: "absence-check", phase: journal.phase, absenceCount: Object.keys(absent).length, passed: true };
}

export async function runLiveOperation(input, overrides = {}) {
  if (input.environment !== "staging") throw new Error("explicit staging environment is required");
  const options = { ...input, credentialEnvironment: input.processEnvironment ?? process.env, root: path.resolve(input.root ?? process.cwd()) };
  const dependencies = defaultDependencies(overrides);
  if (options.operation === "status") {
    const journal = await loadOwnedJournal(options);
    return { operation: "status", phase: journal.phase, cleanupComplete: journal.phase === "cleanup-complete" };
  }
  if (options.operation === "preflight") {
    requiredOptions(options, ["inventoryPath"]);
    const context = await preflightContext(options, dependencies);
    return { operation: "preflight", ok: true, mutationCount: 0, accountScope: context.proof.accountScope };
  }
  if (options.operation === "plan") return planOperation(options, dependencies);
  if (options.operation === "apply") return applyWithIncidentCapture(options, dependencies);
  if (options.operation === "verify") return verifyOperation(options, dependencies);
  if (options.operation === "teardown") return teardownOperation(options, dependencies);
  if (options.operation === "absence-check") return absenceOperation(options, dependencies);
  throw new Error("unknown staging operation");
}

export function publicOperationResult(result) {
  const allowed = ["operation", "phase", "ok", "originAbsence", "mutationCount", "accountScope", "migrationCount", "rollback", "wholeStackRollback", "cleanupComplete", "absenceCount", "passed", "outcomes", "counts"];
  return Object.fromEntries(Object.entries(result).filter(([key]) => allowed.includes(key)));
}
