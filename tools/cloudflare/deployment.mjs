import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { attestMigration } from "./journal.mjs";

const REQUIRED_BINDINGS = ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"];
const PROTECTED_TARGET = /production|hootenanny|(?:^|[^a-z])prod(?:[^a-z]|$)/i;
const SAFE_RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function safeWorkerName(value) {
  return typeof value === "string" && SAFE_RESOURCE_NAME.test(value) && value.includes("staging") && !PROTECTED_TARGET.test(value);
}

const safeDatabaseName = safeWorkerName;

export function prepareWranglerHome(root) {
  if (typeof root !== "string" || root.length === 0) throw new Error("repository root is required");
  const isolatedHome = path.join(root, ".cloudflare-staging", "wrangler-home");
  const emptyEnvironment = path.join(isolatedHome, "empty-environment");
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  writeFileSync(emptyEnvironment, "", { mode: 0o600 });
  return Object.freeze({ isolatedHome, emptyEnvironment });
}

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

export function createWranglerAdapter({ root, token, accountId, configPath, spawn, timeoutMs = 60_000, killGraceMs = 5_000, maxOutputBytes = 1_048_576 }) {
  if (!root || !token) throw new Error("repository root and process-scoped Cloudflare token are required");
  if (accountId !== undefined && (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId))) throw new Error("valid staging account identity is required");
  const binary = path.join(root, "node_modules", ".bin", "wrangler");
  const config = path.resolve(configPath ?? path.join(root, "deploy", "cloudflare", "wrangler.jsonc"));
  const relativeConfig = path.relative(path.resolve(root), config);
  if (relativeConfig.startsWith("..") || path.isAbsolute(relativeConfig)) throw new Error("Wrangler config must remain inside the repository worktree");
  const isolatedHome = path.join(root, ".cloudflare-staging", "wrangler-home");
  const emptyEnvironment = path.join(isolatedHome, "empty-environment");
  if (!spawn) prepareWranglerHome(root);
  const inheritedNames = ["PATH", "USER", "SHELL", "TMPDIR", "TEMP", "TMP", "CI", "NO_COLOR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const childEnv = Object.fromEntries(inheritedNames.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  Object.assign(childEnv, { HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false", WRANGLER_LOG: "none", WRANGLER_LOG_PATH: path.join(root, ".cloudflare-staging", "wrangler.log"), WRANGLER_SEND_METRICS: "false" });
  if (accountId) childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
  async function invoke(args, { input, allowNotFound = false } = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Wrangler arguments must be strings");
    if (args.includes("--config") || args.includes("--env") || args.includes("-c") || args.includes("-e")) throw new Error("Wrangler environment selection is owned by the staging adapter");
    if (args.some((arg) => /(?:route|domain|dns)/i.test(arg))) throw new Error("route mutation commands are not supported");
    const completeArgs = [...args, "--env-file", emptyEnvironment, "--config", config, "--env", "staging"];
    const executionOptions = {
      cwd: root, env: childEnv,
      input, timeoutMs, killGraceMs, maxOutputBytes, shell: false,
    };
    const result = spawn
      ? await spawn(binary, completeArgs, executionOptions)
      : await runBoundedSubprocess(binary, completeArgs, executionOptions);
    if (!result || result.exitCode !== 0) {
      if (allowNotFound && /\[code:\s*10007\]/i.test(result?.stderr ?? "")) return { exitCode: result.exitCode, stdout: "[]", stderr: "" };
      throw new Error("Wrangler command failed");
    }
    return result;
  }
  async function workerJson(command, workerName) {
    if (!safeWorkerName(workerName)) throw new Error("safe staging Worker name is required");
    const result = await invoke([...command, "--name", workerName, ...(command[0] === "secret" ? ["--format", "json"] : ["--json"])], { allowNotFound: true });
    return parseJson(result.stdout);
  }
  const adapter = {
    async json(args, { workerName } = {}) {
      const key = args.join(" ");
      let structuredArgs = GLOBAL_JSON_COMMANDS.get(key);
      if (WORKER_JSON_COMMANDS.has(key)) {
        if (!safeWorkerName(workerName)) throw new Error("safe staging Worker name is required");
        structuredArgs = ["--name", workerName, ...WORKER_JSON_COMMANDS.get(key)];
      }
      if (!structuredArgs) throw new Error("Wrangler command is not allowlisted");
      const result = await invoke([...args, ...structuredArgs]);
      return parseJson(result.stdout);
    },
    async secretPut(name, value, { workerName } = {}) {
      if (name !== "LIVE_COMMAND_SECRET" || typeof value !== "string" || value.length < 32) throw new Error("valid root secret is required");
      if (!safeWorkerName(workerName)) throw new Error("safe staging Worker name is required");
      return invoke(["secret", "put", name, "--name", workerName], { input: value });
    },
    async whoami(accountId) {
      if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("valid staging account identity is required");
      const result = await invoke(["whoami", "--account", accountId]);
      if (!result.stdout.toLowerCase().includes(accountId.toLowerCase())) throw new Error("authenticated Cloudflare account identity is unreadable");
      return { accountId: accountId.toLowerCase() };
    },
    async d1List() { return adapter.json(["d1", "list"]); },
    async deploymentsList(workerName) { return workerJson(["deployments", "list"], workerName); },
    async versionsList(workerName) { return workerJson(["versions", "list"], workerName); },
    async secretList(workerName) { return workerJson(["secret", "list"], workerName); },
    async d1Create(databaseName) {
      if (!safeDatabaseName(databaseName)) throw new Error("safe staging database name is required");
      return invoke(["d1", "create", databaseName]);
    },
    async d1Delete(databaseName) {
      if (!safeDatabaseName(databaseName)) throw new Error("safe staging database name is required");
      return invoke(["d1", "delete", databaseName, "--skip-confirmation"]);
    },
    async d1TimeTravelInfo(databaseName) {
      if (!safeDatabaseName(databaseName)) throw new Error("safe staging database name is required");
      const result = await invoke(["d1", "time-travel", "info", databaseName, "--json"]);
      return parseJson(result.stdout, "D1 Time Travel output");
    },
    async d1Execute(databaseName, { command, file } = {}) {
      if (!safeDatabaseName(databaseName)) throw new Error("safe staging database name is required");
      if ((typeof command === "string") === (typeof file === "string")) throw new Error("exactly one D1 command or file is required");
      if (typeof command === "string" && (!command.trim() || command.includes("\0"))) throw new Error("valid D1 command is required");
      if (typeof file === "string") {
        const resolved = path.resolve(file);
        const relative = path.relative(path.resolve(root, ".cloudflare-staging"), resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("D1 mutation file must remain in the private staging directory");
      }
      const result = await invoke(["d1", "execute", databaseName, "--remote", "--json", typeof file === "string" ? "--file" : "--command", file ?? command]);
      return parseJson(result.stdout, "D1 execution output");
    },
    async d1MigrationsApply(databaseName) {
      if (!safeDatabaseName(databaseName)) throw new Error("safe staging database name is required");
      return invoke(["d1", "migrations", "apply", databaseName, "--remote"]);
    },
    async deploy(workerName) {
      if (!safeWorkerName(workerName)) throw new Error("safe staging Worker name is required");
      return invoke(["deploy", "--name", workerName]);
    },
    async deleteWorker(workerName) {
      if (!safeWorkerName(workerName)) throw new Error("safe staging Worker name is required");
      return invoke(["delete", "--name", workerName]);
    },
    async secretDelete(name, workerName) {
      if (name !== "LIVE_COMMAND_SECRET" || !safeWorkerName(workerName)) throw new Error("safe staging secret identity is required");
      return invoke(["secret", "delete", name, "--name", workerName]);
    },
  };
  return Object.freeze(adapter);
}

function routeHostname(route) {
  const candidate = route?.hostname ?? route?.origin ?? route?.url ?? route?.pattern;
  if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("unreadable route inventory");
  const raw = candidate.trim();
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname) throw new Error("unreadable route inventory");
    return { hostname: parsed.hostname.toLowerCase(), wildcard: false, pattern: raw };
  } catch {}

  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = withoutScheme.split("/", 1)[0]?.replace(/:\d+$/, "") ?? "";
  const wildcard = authority.startsWith("*.");
  const hostname = wildcard ? authority.slice(2) : authority;
  if (!hostname || hostname === "*" || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname)) {
    throw new Error("unreadable route inventory");
  }
  return { hostname: hostname.toLowerCase(), wildcard, pattern: raw };
}

function routeMatchesForbiddenOrigin(routeIdentity, forbiddenHostnames) {
  return forbiddenHostnames.some((forbidden) => routeIdentity.wildcard
    ? forbidden === routeIdentity.hostname || forbidden.endsWith(`.${routeIdentity.hostname}`)
    : forbidden === routeIdentity.hostname);
}

function assertMutationTargets(inventory) {
  const forbiddenAccountIds = new Set(inventory.forbidden.accountIds.map((value) => value.toLowerCase()));
  const forbiddenDatabaseIds = new Set(inventory.forbidden.databaseIds.map((value) => value.toLowerCase()));
  const forbiddenWorkerNames = new Set(inventory.forbidden.workerNames.map((value) => value.toLowerCase()));
  const forbiddenOrigins = new Set(inventory.forbidden.origins.map((value) => new URL(value).origin.toLowerCase()));
  const staging = inventory.staging;
  const declared = forbiddenAccountIds.has(staging.accountId.toLowerCase())
    || (typeof staging.databaseId === "string" && forbiddenDatabaseIds.has(staging.databaseId.toLowerCase()))
    || forbiddenWorkerNames.has(staging.workerName.toLowerCase())
    || forbiddenOrigins.has(new URL(staging.origin).origin.toLowerCase());
  if (declared) throw new Error("planned mutation targets a declared forbidden target");
  if (!safeWorkerName(staging.workerName) || !safeDatabaseName(staging.databaseName) || PROTECTED_TARGET.test(staging.origin)) {
    throw new Error("planned mutation targets a protected-looking target");
  }
}

export function assertSharedAccountInventory(inventory, remote) {
  if (!remote || remote.accountId !== inventory.staging.accountId) throw new Error("authenticated Cloudflare account does not match staging inventory");
  for (const field of ["databases", "workers", "routes", "secretNames", "deployments"]) {
    if (!Array.isArray(remote[field])) throw new Error(`Cloudflare ${field} inventory is unreadable`);
  }
  assertMutationTargets(inventory);
  const forbiddenDatabaseIds = new Set(inventory.forbidden.databaseIds.map((value) => value.toLowerCase()));
  const forbiddenWorkerNames = new Set(inventory.forbidden.workerNames.map((value) => value.toLowerCase()));
  const forbiddenHostnames = inventory.forbidden.origins.map((value) => new URL(value).hostname.toLowerCase());

  for (const item of remote.databases) {
    if (typeof item?.id !== "string" || typeof item?.name !== "string") throw new Error("Cloudflare databases inventory is unreadable");
    const declared = forbiddenDatabaseIds.has(item.id.toLowerCase());
    if (PROTECTED_TARGET.test(item.name) && !declared) throw new Error("shared account contains an undeclared protected-looking target");
  }
  for (const item of remote.workers) {
    if (typeof item?.name !== "string") throw new Error("Cloudflare workers inventory is unreadable");
    const declared = forbiddenWorkerNames.has(item.name.toLowerCase());
    if (PROTECTED_TARGET.test(item.name) && !declared) throw new Error("shared account contains an undeclared protected-looking target");
  }
  for (const item of remote.routes) {
    const identity = routeHostname(item);
    const declaredOrigin = routeMatchesForbiddenOrigin(identity, forbiddenHostnames);
    const script = typeof item?.script === "string" ? item.script : null;
    const declaredScript = script !== null && forbiddenWorkerNames.has(script.toLowerCase());
    const environment = typeof item?.environment === "string" ? item.environment : null;
    if ((PROTECTED_TARGET.test(identity.pattern) && !declaredOrigin)
      || (script !== null && PROTECTED_TARGET.test(script) && !declaredScript)
      || (environment !== null && PROTECTED_TARGET.test(environment) && !declaredOrigin && !declaredScript)) {
      throw new Error("shared account contains an undeclared protected-looking target");
    }
  }
  return true;
}

export function assertCredentialedPreflight(inventory, remote, { localSecretAvailable = false } = {}) {
  assertSharedAccountInventory(inventory, remote);
  const databaseCollision = remote.databases.some((item) =>
    item?.name === inventory.staging.databaseName ||
    (inventory.staging.databaseId && item?.id === inventory.staging.databaseId));
  const stagingHostname = new URL(inventory.staging.origin).hostname.toLowerCase();
  const routeCollision = remote.routes.some((item) => {
    const identity = routeHostname(item);
    return item?.script === inventory.staging.workerName || item?.name === inventory.staging.workerName || (!identity.wildcard && identity.hostname === stagingHostname);
  });
  if (databaseCollision || remote.workers.some((item) => item?.name === inventory.staging.workerName) || routeCollision || remote.secretNames.includes("LIVE_COMMAND_SECRET")) {
    throw new Error("disposable target already exists and is not journal-owned");
  }
  if (!localSecretAvailable) throw new Error("local root secret continuity is required before apply");
  return { accountScope: "shared-account-staging", targetAbsent: true, secretInventoryReadable: true };
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
  if (expected.definitionDigest !== undefined && actual.definitionDigest !== expected.definitionDigest) throw new Error("schema definition fingerprint verification failed");
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
    || preservation.beforeAssociations !== preservation.afterAssociations
    || !/^[a-f0-9]{64}$/.test(preservation.beforeAssociationDigest ?? "")
    || preservation.beforeAssociationDigest !== preservation.afterAssociationDigest) {
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
      if (!sameSnapshot(await inspectSnapshot(), expectedSnapshot)) throw new Error("Cloudflare inventory changed before mutation");
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
      if (!sameSnapshot(await inspectSnapshot(), expectedSnapshot)) throw new Error("Cloudflare inventory changed before deploy");
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
