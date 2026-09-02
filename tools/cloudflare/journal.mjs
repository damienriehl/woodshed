import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const PHASES = new Set(["pre-write", "resources-ready", "bookmark-captured", "schema-expanded", "worker-deployed", "alias-live", "verified", "quarantined", "cleanup-complete"]);
const REQUIRED_IDENTITY = ["accountId", "databaseName", "workerName", "origin"];
const RESOURCE_DOMAINS = new Set(["route", "hostname", "credential", "secret", "worker", "durable-object", "d1", "token"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid journal: ${name} is required`);
  return value;
}

export function validateJournal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid journal: expected object");
  if (value.version !== 1) throw new Error("invalid journal: unsupported version");
  requiredString(value.runId, "runId"); requiredString(value.owner, "owner");
  if (!/^[a-f0-9]{40,64}$/i.test(requiredString(value.sourceSha, "sourceSha"))) throw new Error("invalid journal: sourceSha");
  if (!PHASES.has(value.phase)) throw new Error("invalid journal: phase");
  if (!value.identity || typeof value.identity !== "object") throw new Error("invalid journal: identity");
  for (const field of REQUIRED_IDENTITY) requiredString(value.identity[field], `identity.${field}`);
  if (value.identity.databaseId !== undefined && (typeof value.identity.databaseId !== "string" || value.identity.databaseId.length === 0)) throw new Error("invalid journal: identity.databaseId");
  if (value.phase !== "pre-write" && !value.identity.databaseId) throw new Error("invalid journal: identity.databaseId is required after provisioning");
  if (!Array.isArray(value.resources) || !Array.isArray(value.mutations) || !Array.isArray(value.migrations)) throw new Error("invalid journal: ownership arrays");
  if (value.preflight !== undefined && (!value.preflight || typeof value.preflight !== "object" || value.preflight.operatorTokenPresent !== true)) throw new Error("invalid journal: operator token presence");
  const resourceKeys = new Set();
  for (const resource of value.resources) {
    if (!resource || typeof resource !== "object" || !RESOURCE_DOMAINS.has(resource.domain) || typeof resource.id !== "string" || !resource.id || resource.runId !== value.runId || resource.owner !== value.owner || (resource.status !== undefined && !["planned", "owned"].includes(resource.status))) throw new Error("invalid journal: resource ownership");
    if (resource.domain === "token" && resource.provenance !== "run-minted") throw new Error("invalid journal: token must be run-minted");
    const key = `${resource.domain}:${resource.id}`;
    if (resourceKeys.has(key)) throw new Error("invalid journal: duplicate resource ownership");
    resourceKeys.add(key);
  }
  const mutationKeys = new Set();
  for (const mutation of value.mutations) {
    if (!mutation || typeof mutation !== "object" || typeof mutation.kind !== "string" || !mutation.kind || !["planned", "pending", "applied"].includes(mutation.status)) throw new Error("invalid journal: mutation intent");
    if (mutation.domain !== undefined && (!RESOURCE_DOMAINS.has(mutation.domain) || typeof mutation.id !== "string" || !mutation.id)) throw new Error("invalid journal: mutation resource identity");
    const key = `${mutation.kind}:${mutation.domain ?? ""}:${mutation.id ?? mutation.operationId ?? ""}`;
    if (mutationKeys.has(key)) throw new Error("invalid journal: duplicate mutation intent");
    mutationKeys.add(key);
    if (mutation.kind === "durable-object-delete") {
      if (!/^woodshed-staging-delete-[a-f0-9]{16}$/.test(mutation.tag ?? "") || !Array.isArray(mutation.beforeDeploymentIds) || mutation.beforeDeploymentIds.length === 0) throw new Error("invalid journal: Durable Object deletion attestation");
      if (mutation.status === "applied" && (!/^[a-f0-9]{64}$/.test(mutation.configDigest ?? "") || !Array.isArray(mutation.afterDeploymentIds) || mutation.afterDeploymentIds.length === 0)) throw new Error("invalid journal: Durable Object deletion attestation");
    }
  }
  for (const migration of value.migrations) {
    if (!migration || typeof migration !== "object" || typeof migration.filename !== "string" || !/^[a-f0-9]{64}$/.test(migration.sha256) || migration.sourceSha !== value.sourceSha || !["pending", "applied"].includes(migration.status)) {
      throw new Error("invalid journal: migration attestation");
    }
  }
  if (value.acceptance !== undefined) {
    if (!value.acceptance || typeof value.acceptance !== "object" || typeof value.acceptance.status !== "string" || typeof value.acceptance.cleanupComplete !== "boolean") throw new Error("invalid journal: acceptance state");
    const fixture = value.acceptance.fixturePlan;
    if (fixture !== undefined && (!fixture || typeof fixture !== "object" || !Array.isArray(fixture.rows) || !Array.isArray(fixture.parentChildTables) || typeof fixture.durableObjectIdentity !== "string" || typeof fixture.tokenHash !== "string" || !/^[a-f0-9]{64}/.test(fixture.tokenHash))) throw new Error("invalid journal: acceptance fixture ownership");
  }
  return value;
}

export function createJournal({ runId, owner, sourceSha, identity, now = new Date().toISOString() }) {
  return validateJournal({ version: 1, runId, owner, sourceSha, phase: "pre-write", identity: { ...identity }, resources: [], mutations: [], migrations: [], createdAt: now, updatedAt: now });
}

export function attestMigration(journal, migration) {
  validateJournal(journal);
  if (!migration || typeof migration.filename !== "string" || !/^[a-f0-9]{64}$/.test(migration.sha256) || migration.sourceSha !== journal.sourceSha) throw new Error("invalid migration attestation");
  if (journal.migrations.some(({ filename }) => filename === migration.filename)) throw new Error("migration already attested");
  journal.migrations.push({ filename: migration.filename, sha256: migration.sha256, sourceSha: migration.sourceSha, status: "pending" });
  return journal;
}

export async function saveJournal(file, value) {
  const journal = validateJournal(structuredClone(value));
  journal.updatedAt = new Date().toISOString();
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    renamed = true;
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
  return journal;
}

export async function saveNewJournal(file, value) {
  const journal = validateJournal(structuredClone(value));
  journal.updatedAt = new Date().toISOString();
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let linked = false;
  try {
    try {
      await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await link(temporary, file); }
    catch (error) {
      if (error?.code === "EEXIST") throw new Error("journal path already exists; use status or resume the owned run");
      throw error;
    }
    linked = true;
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
  if (!linked) throw new Error("new journal was not persisted");
  return journal;
}

export async function loadJournal(file, expected = {}) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, "utf8")); } catch (error) { throw new Error("invalid journal: unreadable or corrupt", { cause: error }); }
  const journal = validateJournal(parsed);
  if ((expected.runId && journal.runId !== expected.runId) || (expected.owner && journal.owner !== expected.owner)) throw new Error("journal does not own this run");
  return journal;
}
