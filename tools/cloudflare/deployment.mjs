import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { attestMigration } from "./journal.mjs";

const REQUIRED_BINDINGS = ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"];

function parseJson(value, label = "Cloudflare structured output") {
  try { return typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error(`${label} is malformed`); }
}

const GLOBAL_JSON_COMMANDS = new Map([["d1 list", ["--json"]]]);
const WORKER_JSON_COMMANDS = new Map([
  ["deployments list", ["--json"]],
  ["versions list", ["--json"]],
  ["secret list", ["--format", "json"]],
]);

export function runBoundedSubprocess(file, args, options) {
  const {
    cwd, env, input, timeoutMs,
    killGraceMs = 5_000,
    maxOutputBytes = 1_048_576,
    spawn = nodeSpawn,
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(killGraceMs) || killGraceMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("bounded subprocess limits must be positive integers");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env, shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let outputBytes = 0;
    let failure; let killTimer; let settled = false;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      try { child.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        settle(failure);
      }, killGraceMs);
    };
    const collect = (stream, target) => stream.on("data", (chunk) => {
      if (failure) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > maxOutputBytes) return stop(new Error("subprocess output limit exceeded"));
      if (target === "stdout") stdout += value.toString(); else stderr += value.toString();
    });
    collect(child.stdout, "stdout"); collect(child.stderr, "stderr");
    const timeout = setTimeout(() => stop(new Error("subprocess timed out")), timeoutMs);
    const settle = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(killTimer);
      if (error) reject(error); else resolve(result);
    };
    child.once("error", (error) => settle(failure ?? error));
    child.once("close", (exitCode, signal) => settle(failure, { exitCode, signal, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

export function createWranglerAdapter({ root, token, spawn, timeoutMs = 60_000, killGraceMs = 5_000, maxOutputBytes = 1_048_576 }) {
  if (!root || !token) throw new Error("repository root and process-scoped Cloudflare token are required");
  const binary = path.join(root, "node_modules", ".bin", "wrangler");
  const config = path.join(root, "deploy", "cloudflare", "wrangler.jsonc");
  async function invoke(args, { input } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Wrangler arguments must be strings");
    if (args.some((arg) => /(?:route|domain|dns)/i.test(arg))) throw new Error("route mutation commands are not supported");
    const completeArgs = [...args, "--config", config, "--env", "staging"];
    const executionOptions = {
      cwd: root, env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
      input, timeoutMs, killGraceMs, maxOutputBytes, shell: false,
    };
    const result = spawn
      ? await spawn(binary, completeArgs, executionOptions)
      : await runBoundedSubprocess(binary, completeArgs, executionOptions);
    if (!result || result.exitCode !== 0) throw new Error("Wrangler command failed");
    return result;
  }
  return Object.freeze({
    async json(args, { workerName } = {}) {
      const key = args.join(" ");
      let structuredArgs = GLOBAL_JSON_COMMANDS.get(key);
      if (WORKER_JSON_COMMANDS.has(key)) {
        if (typeof workerName !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName) || !workerName.includes("staging")) throw new Error("safe staging Worker name is required");
        structuredArgs = ["--name", workerName, ...WORKER_JSON_COMMANDS.get(key)];
      }
      if (!structuredArgs) throw new Error("Wrangler command is not allowlisted");
      const result = await invoke([...args, ...structuredArgs]);
      return parseJson(result.stdout);
    },
    async secretPut(name, value, { workerName } = {}) {
      if (name !== "LIVE_COMMAND_SECRET" || typeof value !== "string" || value.length < 32) throw new Error("valid root secret is required");
      if (typeof workerName !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName) || !workerName.includes("staging")) throw new Error("safe staging Worker name is required");
      return invoke(["secret", "put", name, "--name", workerName], { input: value });
    },
  });
}

export function assertCredentialedPreflight(inventory, remote, { localSecretAvailable = false } = {}) {
  if (!remote || remote.accountId !== inventory.staging.accountId) throw new Error("authenticated Cloudflare account does not match staging inventory");
  for (const field of ["databases", "workers", "routes", "secretNames", "deployments"]) {
    if (!Array.isArray(remote[field])) throw new Error(`Cloudflare ${field} inventory is unreadable`);
  }
  const serializedTargets = JSON.stringify({ databases: remote.databases, workers: remote.workers, routes: remote.routes }).toLowerCase();
  if (/hootenanny|production|(?:^|[^a-z])prod(?:[^a-z]|$)/i.test(serializedTargets)) throw new Error("dedicated staging account contains a protected target");
  const forbiddenDatabaseIds = new Set(inventory.forbidden.databaseIds.map((value) => value.toLowerCase()));
  const forbiddenWorkerNames = new Set(inventory.forbidden.workerNames.map((value) => value.toLowerCase()));
  const forbiddenOrigins = new Set(inventory.forbidden.origins.map((value) => new URL(value).origin.toLowerCase()));
  if (remote.databases.some((item) => typeof item?.id === "string" && forbiddenDatabaseIds.has(item.id.toLowerCase()))
    || remote.workers.some((item) => typeof item?.name === "string" && forbiddenWorkerNames.has(item.name.toLowerCase()))
    || remote.routes.some((item) => {
      const candidate = item?.origin ?? item?.url ?? item?.pattern;
      if (typeof candidate !== "string") return false;
      try { return forbiddenOrigins.has(new URL(candidate).origin.toLowerCase()); } catch { return false; }
    })) {
    throw new Error("dedicated staging account contains an explicitly forbidden target");
  }
  const databaseCollision = remote.databases.some((item) =>
    item?.name === inventory.staging.databaseName ||
    (inventory.staging.databaseId && item?.id === inventory.staging.databaseId));
  if (databaseCollision || remote.workers.some((item) => item?.name === inventory.staging.workerName)) {
    throw new Error("disposable target already exists and is not journal-owned");
  }
  if (!localSecretAvailable) throw new Error("local root secret continuity is required before apply");
  return { accountScope: "dedicated-staging", targetAbsent: true, secretInventoryReadable: true };
}

export async function persistAssignedDatabaseIdentity({ journal, database, persistJournal }) {
  if (!database || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(database.id) || database.name !== journal.identity.databaseName) {
    throw new Error("created database identity is invalid");
  }
  if (journal.identity.databaseId && journal.identity.databaseId !== database.id) throw new Error("created database identity changed");
  journal.identity.databaseId = database.id.toLowerCase();
  if (!journal.resources.some((item) => item?.domain === "d1" && item?.id === journal.identity.databaseId)) {
    journal.resources.push({ domain: "d1", id: journal.identity.databaseId, runId: journal.runId, owner: journal.owner });
  }
  await persistJournal(journal);
  return journal.identity.databaseId;
}

function ledgerNames(remote) {
  const parsed = parseJson(remote, "remote migration ledger");
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.name !== "string")) throw new Error("remote migration ledger is malformed");
  return parsed.map(({ name }) => name);
}

export function reconcileMigrationLedger({ remote, manifest, journal }) {
  const applied = ledgerNames(remote);
  const expected = manifest.map(({ filename }) => filename);
  if (applied.some((name, index) => name !== expected[index]) || applied.length > expected.length) throw new Error("remote migration ledger is not an exact prefix");
  for (const filename of applied) {
    const expectedMigration = manifest.find((item) => item.filename === filename);
    const attestation = journal.migrations.find((item) => item.filename === filename);
    if (!attestation || attestation.sha256 !== expectedMigration.sha256 || attestation.sourceSha !== journal.sourceSha) {
      throw new Error("remote migration lacks private digest provenance");
    }
  }
  return { applied, pending: manifest.slice(applied.length) };
}

function exactSet(actual, expected, label) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length || expected.some((item) => !actual.includes(item))) {
    throw new Error(`schema ${label} mismatch`);
  }
}

export function assertSchemaInvariants(actual, expected) {
  if (actual.foreignKeysEnabled !== true || actual.foreignKeyViolations !== 0) throw new Error("foreign key verification failed");
  if (actual.integrity !== "ok") throw new Error("integrity verification failed");
  for (const key of ["tables", "indexes", "triggers", "constraints"]) exactSet(actual[key], expected[key], key);
  if (actual.choiceConfigSeeded !== true) throw new Error("event choice configuration seed verification failed");
  const preservation = actual.migration009;
  const preservationCounts = preservation && [
    preservation.beforeRows,
    preservation.afterRows,
    preservation.beforeAssociations,
    preservation.afterAssociations,
  ];
  if (!preservationCounts
    || preservationCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || preservation.beforeRows !== preservation.afterRows
    || preservation.beforeAssociations !== preservation.afterAssociations) {
    throw new Error("migration 009 preservation verification failed");
  }
  return true;
}

export function assertDeploymentIdentity(expected, actual) {
  if (!actual?.deploymentId) throw new Error("deployment identity is missing");
  if (actual.sourceSha !== expected.sourceSha || actual.configDigest !== expected.configDigest) throw new Error("deployed source identity does not match frozen release");
  exactSet(actual.bindings, expected.bindings ?? REQUIRED_BINDINGS, "bindings");
  if (actual.lifecycle !== expected.lifecycle || actual.lifecycle !== "legacy-sqlite-v1") throw new Error("Durable Object lifecycle mismatch");
  return true;
}

function sameSnapshot(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runMigrationFirstDeployment(options) {
  const {
    journal, lease, manifest, expectedSnapshot, inspectSnapshot, inspectLedger,
    persistJournal, applyMigration, verifyMigration, verifyFinalSchema,
    deployWorker, inspectDeployment, verifyDeployment,
  } = options;
  if (!lease?.active || lease.runId !== journal.runId || lease.owner !== journal.owner) throw new Error("active ownership lease is required");
  if (!sameSnapshot(await inspectSnapshot(), expectedSnapshot)) throw new Error("Cloudflare inventory changed before mutation");

  const reconciliation = reconcileMigrationLedger({ remote: await inspectLedger(), manifest, journal });
  for (const filename of reconciliation.applied) {
    const attestation = journal.migrations.find((item) => item.filename === filename);
    if (attestation.status === "pending") {
      const migration = manifest.find((item) => item.filename === filename);
      if (!await verifyMigration(migration)) throw new Error("reconciled migration postcondition failed");
      attestation.status = "applied";
      await persistJournal(journal);
    } else if (attestation.status !== "applied") {
      throw new Error("migration journal status is invalid");
    }
  }
  for (const migration of reconciliation.pending) {
    if (!sameSnapshot(await inspectSnapshot(), expectedSnapshot)) throw new Error("Cloudflare inventory changed before mutation");
    attestMigration(journal, { ...migration, sourceSha: journal.sourceSha });
    await persistJournal(journal);
    let postconditionVerified = false;
    try {
      await applyMigration(migration);
    } catch (error) {
      const recovered = reconcileMigrationLedger({ remote: await inspectLedger(), manifest, journal });
      if (!recovered.applied.includes(migration.filename) || !await verifyMigration(migration)) {
        throw new Error("migration outcome is uncertain; no replay authorized", { cause: error });
      }
      postconditionVerified = true;
    }
    if (!postconditionVerified && !await verifyMigration(migration)) throw new Error("migration postcondition failed");
    journal.migrations.find((item) => item.filename === migration.filename).status = "applied";
    await persistJournal(journal);
  }

  const finalReconciliation = reconcileMigrationLedger({ remote: await inspectLedger(), manifest, journal });
  if (finalReconciliation.pending.length !== 0) throw new Error("remote migration ledger is incomplete before deploy");
  await verifyFinalSchema();
  if (!sameSnapshot(await inspectSnapshot(), expectedSnapshot)) throw new Error("Cloudflare inventory changed before deploy");
  let intent = journal.mutations.find((item) => item?.kind === "worker-deploy");
  if (journal.mutations.filter((item) => item?.kind === "worker-deploy").length > 1) throw new Error("deployment journal contains duplicate intents");
  let deployment;
  if (intent) {
    if (!["pending", "applied"].includes(intent.status) || intent.sourceSha !== journal.sourceSha || typeof inspectDeployment !== "function") {
      throw new Error("deployment intent cannot be reconciled");
    }
    deployment = await inspectDeployment();
    if (!deployment) throw new Error("deployment outcome is uncertain; no replay authorized");
    await verifyDeployment(deployment);
    if (intent.status === "pending") {
      intent.status = "applied"; intent.deploymentId = deployment.deploymentId;
      await persistJournal(journal);
    }
  } else {
    intent = { kind: "worker-deploy", status: "pending", sourceSha: journal.sourceSha };
    journal.mutations.push(intent);
    await persistJournal(journal);
    try {
      deployment = await deployWorker();
    } catch (error) {
      if (typeof inspectDeployment !== "function") throw new Error("deployment outcome is uncertain; no replay authorized", { cause: error });
      deployment = await inspectDeployment();
      if (!deployment) throw new Error("deployment outcome is uncertain; no replay authorized", { cause: error });
    }
    await verifyDeployment(deployment);
    intent.status = "applied"; intent.deploymentId = deployment.deploymentId;
    await persistJournal(journal);
  }
  journal.phase = "worker-deployed";
  await persistJournal(journal);
  return { journal, deployment, rollback: "forward-fix-only", lifecycle: "legacy-sqlite-v1" };
}
