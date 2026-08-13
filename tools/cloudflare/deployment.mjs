import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { attestMigration } from "./journal.mjs";

const REQUIRED_BINDINGS = ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"];

function parseJson(value, label = "Cloudflare structured output") {
  try { return typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error(`${label} is malformed`); }
}

function defaultSpawn(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(file, args, {
      cwd: options.cwd, env: options.env, shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); });
    if (options.input !== undefined) child.stdin.end(options.input); 
  });
}

export function createWranglerAdapter({ root, token, spawn = defaultSpawn, timeoutMs = 60_000 }) {
  if (!root || !token) throw new Error("repository root and process-scoped Cloudflare token are required");
  const binary = path.join(root, "node_modules", ".bin", "wrangler");
  const config = path.join(root, "deploy", "cloudflare", "wrangler.jsonc");
  async function invoke(args, { input } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Wrangler arguments must be strings");
    if (args.some((arg) => /(?:route|domain|dns)/i.test(arg))) throw new Error("route mutation commands are not supported");
    const completeArgs = [...args, "--config", config, "--env", "staging"];
    const result = await spawn(binary, completeArgs, {
      cwd: root, env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
      input, timeoutMs, shell: false,
    });
    if (!result || result.exitCode !== 0) throw new Error("Wrangler command failed");
    return result;
  }
  return Object.freeze({
    invoke,
    async json(args) {
      const result = await invoke([...args, "--json"]);
      return parseJson(result.stdout);
    },
    async secretPut(name, value) {
      if (name !== "LIVE_COMMAND_SECRET" || typeof value !== "string" || value.length < 32) throw new Error("valid root secret is required");
      return invoke(["secret", "put", name], { input: value });
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
  if (remote.databases.some((item) => item?.id === inventory.staging.databaseId) || remote.workers.some((item) => item?.name === inventory.staging.workerName)) {
    throw new Error("disposable target already exists and is not journal-owned");
  }
  if (!localSecretAvailable) throw new Error("local root secret continuity is required before apply");
  return { accountScope: "dedicated-staging", targetAbsent: true, secretInventoryReadable: true };
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
  if (!preservation || preservation.beforeRows !== preservation.afterRows || preservation.beforeAssociations !== preservation.afterAssociations) {
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
    deployWorker, verifyDeployment,
  } = options;
  if (!lease?.active || lease.runId !== journal.runId || lease.owner !== journal.owner) throw new Error("active ownership lease is required");
  if (!sameSnapshot(await inspectSnapshot(), expectedSnapshot)) throw new Error("Cloudflare inventory changed before mutation");

  const reconciliation = reconcileMigrationLedger({ remote: await inspectLedger(), manifest, journal });
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

  reconcileMigrationLedger({ remote: await inspectLedger(), manifest, journal });
  await verifyFinalSchema();
  if (!sameSnapshot(await inspectSnapshot(), expectedSnapshot)) throw new Error("Cloudflare inventory changed before deploy");
  const deployment = await deployWorker();
  await verifyDeployment(deployment);
  journal.phase = "worker-deployed";
  await persistJournal(journal);
  return { journal, deployment, rollback: "forward-fix-only", lifecycle: "legacy-sqlite-v1" };
}
