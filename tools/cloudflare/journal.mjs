import { chmod, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

const PHASES = new Set(["pre-write", "resources-ready", "bookmark-captured", "schema-expanded", "worker-deployed", "alias-live", "verified", "quarantined", "cleanup-complete"]);
const REQUIRED_IDENTITY = ["accountId", "databaseId", "workerName", "origin"];

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
  if (!Array.isArray(value.resources) || !Array.isArray(value.mutations) || !Array.isArray(value.migrations)) throw new Error("invalid journal: ownership arrays");
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
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  await chmod(file, 0o600);
  return journal;
}

export async function loadJournal(file, expected = {}) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, "utf8")); } catch (error) { throw new Error("invalid journal: unreadable or corrupt", { cause: error }); }
  const journal = validateJournal(parsed);
  if ((expected.runId && journal.runId !== expected.runId) || (expected.owner && journal.owner !== expected.owner)) throw new Error("journal does not own this run");
  return journal;
}
