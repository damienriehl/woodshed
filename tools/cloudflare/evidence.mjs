import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

const SENSITIVE_KEY = /(?:authorization|cookie|secret|token|device.?id|request.?body|database.?result|ballot|credential|hash)/i;
const TOP_LEVEL_FIELDS = ["runId", "sourceSha", "phase", "outcomes", "counts", "ids"];
const OUTCOME_FIELDS = ["acceptance", "security", "cleanupComplete", "disposableResidueExpected", "productionAuthority"];
const SECURITY_FIELDS = ["wrongOrigin", "missingCsrf", "missingSession", "retiredSessionReplay", "participantOrganizer"];
const COUNT_FIELDS = ["fixtureRows", "choiceRevision", "liveRevision", "liveEntries"];
const ID_FIELDS = ["deploymentId", "databaseId", "durableObjectNamespaceId", "workerId"];

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(field + " must be an object");
  return value;
}

function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error("unknown field in " + field + ": " + unknown.join(", "));
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(field + " must be a non-empty string");
  return value;
}

function validateBooleanFields(value, allowed, field) {
  const output = record(value, field);
  rejectUnknown(output, allowed, field);
  for (const [key, item] of Object.entries(output)) if (key !== "security" && typeof item !== "boolean") throw new Error(field + "." + key + " must be boolean");
  return output;
}

function validateEvidenceInput(input) {
  const envelope = record(input, "evidence");
  rejectUnknown(envelope, TOP_LEVEL_FIELDS, "evidence");
  const runId = requiredString(envelope.runId, "runId");
  const sourceSha = requiredString(envelope.sourceSha, "sourceSha");
  if (!/^[a-f0-9]{40,64}$/i.test(sourceSha)) throw new Error("sourceSha must be a full source SHA");
  const phase = requiredString(envelope.phase, "phase");
  const outcomes = validateBooleanFields(envelope.outcomes ?? {}, OUTCOME_FIELDS, "outcomes");
  if (outcomes.security !== undefined) outcomes.security = validateBooleanFields(outcomes.security, SECURITY_FIELDS, "outcomes.security");
  const counts = record(envelope.counts ?? {}, "counts");
  rejectUnknown(counts, COUNT_FIELDS, "counts");
  for (const [key, value] of Object.entries(counts)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("counts." + key + " must be a non-negative safe integer");
  const ids = record(envelope.ids ?? {}, "ids");
  rejectUnknown(ids, ID_FIELDS, "ids");
  for (const [key, value] of Object.entries(ids)) requiredString(value, "ids." + key);
  return { runId, sourceSha, phase, outcomes, counts, ids };
}

export function redactEvidence(value, configuredSecrets = []) {
  const secrets = configuredSecrets.filter((item) => typeof item === "string" && item.length > 0);
  function visit(item, key = "") {
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    if (typeof item !== "string") return item;
    let output = item
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/((?:^|[;\s])Cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
      .replace(/((?:^|[;\s])Set-Cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]");
    for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
    return output;
  }
  return visit(value);
}

export function createEvidenceEnvelope(input) {
  const { runId, sourceSha, phase, outcomes, counts, ids } = validateEvidenceInput(input);
  return redactEvidence({ contract: "woodshed-cloudflare-staging-evidence/v1", runId, sourceSha, phase, outcomes, counts, ids, productionAuthority: false, target: "experimental Cloudflare subset" });
}

const REQUIRED_ABSENCE_DOMAINS = ["route", "hostname", "credential", "secret", "worker", "durable-object", "d1"];
const ABSENCE_DOMAINS = [...REQUIRED_ABSENCE_DOMAINS, "token"];

export function createFinalEvidencePacket(input) {
  const value = record(input, "final evidence");
  rejectUnknown(value, ["runId", "sourceSha", "phase", "configDigest", "schemaDigest", "protectedRevisionBefore", "protectedRevisionAfter", "migrationCount", "absence", "rollback", "completedAt"], "final evidence");
  const runId = requiredString(value.runId, "runId");
  const sourceSha = requiredString(value.sourceSha, "sourceSha");
  const configDigest = requiredString(value.configDigest, "configDigest");
  const schemaDigest = requiredString(value.schemaDigest, "schemaDigest");
  const protectedRevisionBefore = requiredString(value.protectedRevisionBefore, "protectedRevisionBefore");
  const protectedRevisionAfter = requiredString(value.protectedRevisionAfter, "protectedRevisionAfter");
  if (!/^[a-f0-9]{40,64}$/i.test(sourceSha) || !/^[a-f0-9]{64}$/i.test(configDigest) || !/^[a-f0-9]{64}$/i.test(schemaDigest) || !/^[a-f0-9]{64}$/i.test(protectedRevisionBefore) || protectedRevisionAfter !== protectedRevisionBefore) throw new Error("final evidence digest is invalid or protected inventory changed");
  if (value.phase !== "cleanup-complete") throw new Error("final evidence requires completed teardown");
  if (!Number.isSafeInteger(value.migrationCount) || value.migrationCount < 0) throw new Error("migrationCount must be a non-negative safe integer");
  const completedAt = requiredString(value.completedAt, "completedAt");
  if (Number.isNaN(Date.parse(completedAt))) throw new Error("completedAt must be an ISO timestamp");
  const rawAbsence = record(value.absence, "absence");
  const reportedDomains = rawAbsence && Object.keys(rawAbsence).some((key) => key.startsWith("token:"))
    ? ABSENCE_DOMAINS
    : REQUIRED_ABSENCE_DOMAINS;
  const absence = Object.fromEntries(reportedDomains.map((domain) => {
    const entries = Object.entries(rawAbsence).filter(([key]) => key.startsWith(`${domain}:`));
    return [domain, { count: entries.length, absent: entries.length > 0 && entries.every(([, absent]) => absent === true) }];
  }));
  if (Object.values(absence).some(({ absent }) => !absent)) throw new Error("final evidence requires complete absence");
  const rollback = record(value.rollback, "rollback");
  rejectUnknown(rollback, ["workerCode", "initialLifecycle", "d1", "durableObject", "wholeStackRollback"], "rollback");
  if (rollback.wholeStackRollback !== false) throw new Error("whole-stack rollback must not be claimed");
  for (const field of ["workerCode", "initialLifecycle", "d1", "durableObject"]) requiredString(rollback[field], `rollback.${field}`);
  return {
    contract: "woodshed-cloudflare-staging-final-evidence/v1",
    runId,
    sourceSha,
    phase: "cleanup-complete",
    configDigest,
    schemaDigest,
    nonImpact: { protectedInventoryStable: true, beforeDigest: protectedRevisionBefore, afterDigest: protectedRevisionAfter },
    migrationCount: value.migrationCount,
    absence,
    rollback: { ...rollback },
    completedAt,
    cleanupComplete: true,
    productionAuthority: false,
    target: "experimental Cloudflare subset",
    nonImpactClaim: "production and Hootenanny were not deployed or re-pointed",
  };
}

export async function saveEvidencePacket(file, packet) {
  const validated = record(packet, "final evidence packet");
  rejectUnknown(validated, ["contract", "runId", "sourceSha", "phase", "configDigest", "schemaDigest", "nonImpact", "migrationCount", "absence", "rollback", "completedAt", "cleanupComplete", "productionAuthority", "target", "nonImpactClaim"], "final evidence packet");
  if (validated.contract !== "woodshed-cloudflare-staging-final-evidence/v1" || validated.phase !== "cleanup-complete" || validated.cleanupComplete !== true || validated.productionAuthority !== false || validated.target !== "experimental Cloudflare subset") throw new Error("final evidence packet contract is invalid");
  requiredString(validated.runId, "runId");
  if (!/^[a-f0-9]{40,64}$/i.test(requiredString(validated.sourceSha, "sourceSha")) || !/^[a-f0-9]{64}$/i.test(requiredString(validated.configDigest, "configDigest")) || !/^[a-f0-9]{64}$/i.test(requiredString(validated.schemaDigest, "schemaDigest"))) throw new Error("final evidence packet digest is invalid");
  if (!Number.isSafeInteger(validated.migrationCount) || validated.migrationCount < 0 || Number.isNaN(Date.parse(requiredString(validated.completedAt, "completedAt")))) throw new Error("final evidence packet metadata is invalid");
  const nonImpact = record(validated.nonImpact, "nonImpact");
  rejectUnknown(nonImpact, ["protectedInventoryStable", "beforeDigest", "afterDigest"], "nonImpact");
  if (nonImpact.protectedInventoryStable !== true || !/^[a-f0-9]{64}$/.test(nonImpact.beforeDigest ?? "") || nonImpact.afterDigest !== nonImpact.beforeDigest) throw new Error("final evidence packet non-impact proof is invalid");
  const absence = record(validated.absence, "absence");
  rejectUnknown(absence, ABSENCE_DOMAINS, "absence");
  if (REQUIRED_ABSENCE_DOMAINS.some((domain) => {
    const proof = record(absence[domain], `absence.${domain}`);
    rejectUnknown(proof, ["count", "absent"], `absence.${domain}`);
    return !Number.isSafeInteger(proof.count) || proof.count < 0 || proof.absent !== true;
  })) throw new Error("final evidence packet absence proof is invalid");
  if (absence.token !== undefined) {
    const proof = record(absence.token, "absence.token");
    rejectUnknown(proof, ["count", "absent"], "absence.token");
    if (!Number.isSafeInteger(proof.count) || proof.count < 0 || proof.absent !== true) throw new Error("final evidence packet absence proof is invalid");
  }
  const rollback = record(validated.rollback, "rollback");
  rejectUnknown(rollback, ["workerCode", "initialLifecycle", "d1", "durableObject", "wholeStackRollback"], "rollback");
  if (rollback.wholeStackRollback !== false || ["workerCode", "initialLifecycle", "d1", "durableObject"].some((field) => typeof rollback[field] !== "string" || !rollback[field])) throw new Error("final evidence packet rollback claim is invalid");
  if (validated.nonImpactClaim !== "production and Hootenanny were not deployed or re-pointed") throw new Error("final evidence packet non-impact claim is invalid");
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
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
  return validated;
}
