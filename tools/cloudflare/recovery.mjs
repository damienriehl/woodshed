import { redactEvidence } from "./evidence.mjs";

const RESOURCE_ORDER = Object.freeze(["route", "hostname", "credential", "secret", "worker", "durable-object", "d1", "token"]);
const COMPATIBILITY_FIELDS = Object.freeze([
  ["durableObject", "Durable Object lifecycle"],
  ["d1Schema", "D1 schema"],
  ["durableObjectShape", "Durable Object stored-value shape"],
]);

function exactStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort(); const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function assertLease(journal, lease) {
  if (!lease?.active || lease.runId !== journal?.runId || lease.owner !== journal?.owner) throw new Error("active ownership lease is required");
}

export function assertRollbackCompatible(current, target) {
  if (!current || !target) throw new Error("rollback compatibility evidence is required");
  for (const [field, label] of COMPATIBILITY_FIELDS) {
    if (typeof current[field] !== "string" || current[field].trim() === "" || typeof target[field] !== "string" || target[field].trim() === "") {
      throw new Error(`${label} evidence is required`);
    }
    if (current[field] !== target[field]) throw new Error(`${label} is incompatible`);
  }
  if (!exactStrings(current.bindings, target.bindings)) throw new Error("binding set is incompatible");
  if (!exactStrings(current.secrets, target.secrets)) throw new Error("secret set is incompatible");
  return true;
}

function sameLastWrite(snapshot, revision) { return snapshot && snapshot.revision === revision; }

export async function runQuarantinedD1Recovery(options) {
  const { journal, lease, expectedSnapshot, inspectSnapshot, quarantineOrigin, restoreD1, verifyD1 } = options;
  assertLease(journal, lease);
  if (!journal?.recovery?.bookmark) throw new Error("D1 recovery bookmark is required");
  let snapshot = await inspectSnapshot();
  if (!sameLastWrite(snapshot, lease.revision) || !sameLastWrite(expectedSnapshot, lease.revision)) throw new Error("last-write identity changed");
  if (snapshot.originWritable) { await quarantineOrigin(); snapshot = await inspectSnapshot(); }
  if (snapshot.originWritable) throw new Error("D1 recovery requires a quarantined origin");
  if (!sameLastWrite(snapshot, lease.revision)) throw new Error("last-write identity changed");
  let restoreError;
  try {
    await restoreD1(journal.recovery.bookmark);
  } catch (error) {
    restoreError = error;
  }
  const verification = await verifyD1();
  for (const field of ["ledger", "schema", "foreignKeys", "aggregates", "behavior"]) {
    if (verification?.[field] !== true) {
      if (restoreError) throw restoreError;
      throw new Error(`D1 recovery ${field} verification failed`);
    }
  }
  return { restored: true, reconciled: Boolean(restoreError), durableObjectRestored: false, verification };
}

function ownedResource(resource, journal) {
  return resource && resource.runId === journal.runId && resource.owner === journal.owner && typeof resource.id === "string" && resource.id.length > 0
    && (resource.domain !== "token" || resource.provenance === "run-minted");
}

export async function runStackTeardown(options) {
  const { journal, lease, expectedRevision, inspectRevision, listDependents, inspectResource, removeResource, verifyTokenInactive } = options;
  assertLease(journal, lease);
  if (journal.phase !== "quarantined") throw new Error("origin must be quarantined before teardown");
  if (lease.revision !== expectedRevision || await inspectRevision() !== expectedRevision) throw new Error("last-write identity changed");
  if (!Array.isArray(journal.resources)) throw new Error("valid run-owned resource graph is required");
  const resources = journal.resources.map((resource) => {
    if (!RESOURCE_ORDER.includes(resource?.domain)) throw new Error("unsupported teardown resource domain");
    if (!ownedResource(resource, journal)) throw new Error("journal resource identity mismatch");
    return resource;
  });
  for (const domain of ["route", "credential", "secret", "worker", "durable-object", "d1"]) if (!resources.some((resource) => resource.domain === domain)) throw new Error("missing " + domain + " teardown authority");
  const resourceKeys = resources.map(({ domain, id }) => domain + ":" + id);
  if (new Set(resourceKeys).size !== resourceKeys.length) throw new Error("duplicate teardown resource identity");
  const absence = {};
  let lastVerifiedRevision = expectedRevision;
  for (const domain of RESOURCE_ORDER) {
    for (const resource of resources.filter((candidate) => candidate.domain === domain)) {
      lastVerifiedRevision = await inspectRevision();
      if (lastVerifiedRevision !== expectedRevision) throw new Error("last-write identity changed");
      const dependents = await listDependents(resource);
      if (!Array.isArray(dependents)) throw new Error("dependent inventory is unreadable");
      if (dependents.length > 0) throw new Error("unexpected dependent blocks teardown");
      const before = await inspectResource(resource);
      if (before?.exists) {
        if (before.runId !== journal.runId || before.owner !== journal.owner) throw new Error("remote resource identity mismatch");
        await removeResource(resource);
      }
      const after = await inspectResource(resource);
      const absenceKey = resource.domain + ":" + resource.id;
      absence[absenceKey] = after?.exists === false;
      if (!absence[absenceKey]) throw new Error(resource.domain + " absence proof failed");
    }
  }
  if (resources.some(({ domain }) => domain === "token") && await verifyTokenInactive() !== true) throw new Error("deployment token remains active");
  lastVerifiedRevision = await inspectRevision();
  if (lastVerifiedRevision !== expectedRevision) throw new Error("last-write identity changed");
  return { complete: Object.values(absence).every(Boolean), absence, protectedRevision: lastVerifiedRevision, durableObjectStateRemovedWithNamespace: Object.entries(absence).some(([key, absent]) => key.startsWith("durable-object:") && absent) };
}

export function buildFailureReport({ phase, nextAction, incidentOwner, observations = {} }, configuredSecrets = []) {
  return redactEvidence({ contract: "woodshed-cloudflare-staging-incident/v1", phase, nextAction, incidentOwner, observations, productionAuthority: false, target: "experimental Cloudflare subset" }, configuredSecrets);
}

export function createJournalRetention({ completedAt, incidentResolvedAt } = {}) {
  const start = incidentResolvedAt ?? completedAt;
  if (!start || Number.isNaN(Date.parse(start))) throw new Error("completion or incident-resolution timestamp is required");
  return { retainUntil: new Date(Date.parse(start) + 86_400_000).toISOString(), checks: ["+1h-absence-and-audit", "+24h-absence-and-audit"], disposalAuthority: "private operator retention policy" };
}

export { RESOURCE_ORDER };
