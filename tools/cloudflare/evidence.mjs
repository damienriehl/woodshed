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
