const SENSITIVE_KEY = /(?:authorization|cookie|secret|token|device.?id|request.?body|database.?result|ballot|credential|hash)/i;

export function redactEvidence(value, configuredSecrets = []) {
  const secrets = configuredSecrets.filter((item) => typeof item === "string" && item.length > 0);
  function visit(item, key = "") {
    if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    if (typeof item !== "string") return item;
    let output = item.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
    return output;
  }
  return visit(value);
}

export function createEvidenceEnvelope({ runId, sourceSha, phase, outcomes = {}, counts = {}, ids = {} }) {
  return redactEvidence({ contract: "woodshed-cloudflare-staging-evidence/v1", runId, sourceSha, phase, outcomes, counts, ids, productionAuthority: false, target: "experimental Cloudflare subset" });
}
