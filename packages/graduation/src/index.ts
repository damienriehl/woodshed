import { sha256 } from "../../contracts/src/snapshot.ts";

export const CAPABILITIES = ["event", "ballot", "assignment", "live"] as const;
export type Capability = typeof CAPABILITIES[number];
export type AuthorityState = "legacy-authoritative" | "shadow-imported" | "conformance-verified" | "Woodshed-authoritative" | "legacy-retired";
type AuthorityRecord = { state: AuthorityState; refreshWatermark?: number; cutoverWatermark?: number; acceptedWrites: boolean; evidence: string[] };
type TransitionEvidence = { refreshWatermark?: number; conformanceId?: string; cutoverWatermark?: number; commandsDrained?: boolean; legacyWriterFrozen?: boolean; exactlyOneWriter?: boolean; retirementApproval?: string };
type Rollback = { strategy: "journal-replay" | "freeze-snapshot-cutback" | "irreversible-forward-fix" | "none"; evidenceId?: string };
const NEXT: Record<AuthorityState, AuthorityState | null> = { "legacy-authoritative": "shadow-imported", "shadow-imported": "conformance-verified", "conformance-verified": "Woodshed-authoritative", "Woodshed-authoritative": "legacy-retired", "legacy-retired": null };

export class AuthorityRegistry {
  private records = new Map<Capability, AuthorityRecord>(CAPABILITIES.map(c => [c, { state: "legacy-authoritative", acceptedWrites: false, evidence: [] }]));
  get(capability: Capability) { return structuredClone(this.records.get(capability)!); }
  transition(capability: Capability, next: AuthorityState, evidence: TransitionEvidence) {
    const current = this.records.get(capability)!;
    if (NEXT[current.state] !== next) throw new Error(`illegal authority transition: ${current.state} -> ${next}`);
    if (next === "shadow-imported" && !Number.isSafeInteger(evidence.refreshWatermark)) throw new Error("shadow import watermark required");
    if (next === "conformance-verified" && !evidence.conformanceId) throw new Error("conformance evidence required");
    if (next === "Woodshed-authoritative" && (!Number.isSafeInteger(evidence.cutoverWatermark) || !evidence.commandsDrained || !evidence.legacyWriterFrozen || !evidence.exactlyOneWriter)) throw new Error("cutover drain, freeze, watermark, and exactly-one-writer evidence required");
    if (next === "legacy-retired" && !evidence.retirementApproval) throw new Error("legacy retirement approval required");
    current.state = next;
    if (evidence.refreshWatermark !== undefined) current.refreshWatermark = evidence.refreshWatermark;
    if (evidence.cutoverWatermark !== undefined) current.cutoverWatermark = evidence.cutoverWatermark;
    current.evidence.push(...Object.values(evidence).filter(v => typeof v === "string"));
  }
  refresh(capability: Capability, watermark: number) {
    const current = this.records.get(capability)!;
    if (!(["shadow-imported", "conformance-verified"] as AuthorityState[]).includes(current.state) || current.acceptedWrites) throw new Error("refresh forbidden after Woodshed writes");
    if (!Number.isSafeInteger(watermark) || watermark < (current.refreshWatermark ?? 0)) throw new Error("refresh watermark must be monotonic");
    if (current.state === "conformance-verified") current.state = "shadow-imported";
    current.refreshWatermark = watermark;
    current.evidence.push(`refresh:${watermark}`);
  }
  assertRead(capability: Capability, system: "legacy" | "woodshed") {
    const state = this.records.get(capability)!.state;
    if (system === "woodshed" && state === "legacy-authoritative") throw new Error("Woodshed has no readable shadow");
    if (system === "legacy" && state === "legacy-retired") throw new Error("legacy is retired");
  }
  assertWrite(capability: Capability, system: "legacy" | "woodshed") {
    const record = this.records.get(capability)!;
    const allowed = record.state === "Woodshed-authoritative" || record.state === "legacy-retired" ? "woodshed" : "legacy";
    if (system !== allowed) throw new Error(`${system} is not the authority for ${capability}`);
    if (system === "woodshed") record.acceptedWrites = true;
  }
  rollback(capability: Capability, rollback: Rollback) {
    const current = this.records.get(capability)!;
    if (current.state !== "Woodshed-authoritative") throw new Error("rollback only applies after cutover");
    if (!current.acceptedWrites) { current.state = "legacy-authoritative"; return; }
    if (rollback.strategy === "none" || !rollback.evidenceId) throw new Error("unsafe rollback after Woodshed accepted writes");
    if (rollback.strategy === "irreversible-forward-fix") { current.evidence.push(rollback.evidenceId); return; }
    current.state = "legacy-authoritative"; current.acceptedWrites = false; current.evidence.push(rollback.evidenceId);
  }
}

export type CutoverArtifact = {
  artifactVersion: 1; capability: Capability; owner: string; approver: string;
  release: { sha: string; configFingerprint: string; schemaVersion: string; privacyProvenance: string; exactReleaseMarker: string };
  baseline: { queries: string[]; resultFingerprint: string };
  recovery: { backupId: string; restoreProofId: string; strategy: Rollback["strategy"]; journalStart?: string };
  deploy: { order: string[]; routingFlag: string; immutableOrigin: string; immutableOriginVerified: boolean; alias: string; aliasChangedAfterOriginVerification: boolean; pinnedCli: string };
  observations: { at: string; status: "pass" | "fail"; evidenceId: string }[];
  rollback: { commands: string[]; expected: { errorRateMax: number; mismatchRateMax: number } };
  observability: { errorRate: number; mismatchRate: number; queueDepth: number; owner: string; runbook: string };
  approvals: { readFirstUat: boolean; commandDrain: boolean; writerFreeze: boolean; shadowReconciled: boolean; exactlyOneWriter: boolean; publicationApproved: boolean; legacyRetirementApproved: boolean };
};
export function evaluateCutover(a: CutoverArtifact) {
  const failures: string[] = [];
  const rejectUnknown = (label: string, value: unknown, allowed: readonly string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) { failures.push(`${label} inventory invalid`); return; }
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length) failures.push(`${label} inventory contains unknown fields`);
  };
  rejectUnknown("cutover", a, ["artifactVersion", "capability", "owner", "approver", "release", "baseline", "recovery", "deploy", "observations", "rollback", "observability", "approvals"]);
  rejectUnknown("release", a.release, ["sha", "configFingerprint", "schemaVersion", "privacyProvenance", "exactReleaseMarker"]);
  rejectUnknown("baseline", a.baseline, ["queries", "resultFingerprint"]);
  rejectUnknown("recovery", a.recovery, ["backupId", "restoreProofId", "strategy", "journalStart"]);
  rejectUnknown("deploy", a.deploy, ["order", "routingFlag", "immutableOrigin", "immutableOriginVerified", "alias", "aliasChangedAfterOriginVerification", "pinnedCli"]);
  rejectUnknown("rollback", a.rollback, ["commands", "expected"]);
  rejectUnknown("observability", a.observability, ["errorRate", "mismatchRate", "queueDepth", "owner", "runbook"]);
  rejectUnknown("approvals", a.approvals, ["readFirstUat", "commandDrain", "writerFreeze", "shadowReconciled", "exactlyOneWriter", "publicationApproved", "legacyRetirementApproved"]);
  if (!a.owner || !a.approver || a.owner === a.approver) failures.push("distinct owner and approver required");
  if (!/^[a-f0-9]{40}$/.test(a.release.sha) || !/^[a-f0-9]{64}$/.test(a.release.configFingerprint) || !a.release.schemaVersion || !a.release.privacyProvenance || a.release.exactReleaseMarker !== `release:${a.release.sha}`) failures.push("frozen release inventory invalid");
  if (!a.baseline.queries.length || !/^[a-f0-9]{64}$/.test(a.baseline.resultFingerprint)) failures.push("baseline queries and results required");
  if (!a.recovery.backupId || !a.recovery.restoreProofId || a.recovery.strategy === "none") failures.push("backup, restore proof, and safe recovery strategy required");
  if (a.recovery.strategy === "journal-replay" && !a.recovery.journalStart) failures.push("journal replay start required");
  const requiredOrder = ["schema-expand", "reader", "writer", "route"];
  if (requiredOrder.some((x, i) => a.deploy.order[i] !== x)) failures.push("deploy order is incomplete or unsafe");
  if (!a.deploy.routingFlag || !a.deploy.immutableOrigin || !a.deploy.immutableOriginVerified || !a.deploy.alias || !a.deploy.aliasChangedAfterOriginVerification || !/^wrangler@\d+\.\d+\.\d+$/.test(a.deploy.pinnedCli)) failures.push("routing, immutable-origin-before-alias evidence, and pinned deployment inventory required");
  const observationFailures: string[] = [];
  for (const at of ["+5m", "+1h", "+4h", "+24h"]) if (!a.observations.some(x => x.at === at && x.status === "pass" && x.evidenceId)) observationFailures.push(`missing ${at} observation`);
  if (!a.rollback.commands.length || a.rollback.expected.errorRateMax < 0 || a.rollback.expected.mismatchRateMax < 0) failures.push("exact rollback commands and thresholds required");
  if (!a.observability.owner || !a.observability.runbook || a.observability.errorRate > a.rollback.expected.errorRateMax || a.observability.mismatchRate > a.rollback.expected.mismatchRateMax || a.observability.queueDepth !== 0) failures.push("observability gate failed");
  const gates = a.approvals;
  if (!gates.readFirstUat) failures.push("read-first UAT required");
  if (!gates.commandDrain) failures.push("command drain required");
  if (!gates.writerFreeze) failures.push("legacy writer freeze required");
  if (!gates.shadowReconciled) failures.push("shadow reconciliation required");
  if (!gates.exactlyOneWriter) failures.push("exactly one writer required");
  if (!gates.publicationApproved) failures.push("publication approval required");
  return { readyForAuthority: failures.length === 0, readyForLegacyRetirement: failures.length === 0 && observationFailures.length === 0 && gates.legacyRetirementApproved, failures, observationFailures };
}

export type ShadowPair = { capability: Capability; id: string; legacy: Record<string, unknown>; woodshed: Record<string, unknown> };
const fingerprint = (value: unknown) => sha256(value);
export function compareShadow(pairs: readonly ShadowPair[], options: { invariants: readonly ((pair: ShadowPair) => boolean)[] }) {
  const mismatches = pairs.filter(p => fingerprint(p.legacy) !== fingerprint(p.woodshed)).map(p => ({ capability: p.capability, idHash: fingerprint(p.id).slice(0,16) }));
  const invariantFailures = pairs.flatMap(p => options.invariants.map((check, index) => ({ check, index })).filter(x => !x.check(p)).map(x => ({ capability: p.capability, idHash: fingerprint(p.id).slice(0,16), invariant: x.index })));
  return { compared: pairs.length, mismatches, invariantFailures };
}

type RecommendationTrial = { acceptedTopFive: boolean; changedPositions: number; totalPositions: number; understoodFactors: boolean };
export function validateRecommendation(input: { version: string; config: Record<string, number>; seed: string; input: unknown; organizerTrials: readonly RecommendationTrial[] }) {
  const burdens = input.organizerTrials.map(t => t.totalPositions ? t.changedPositions / t.totalPositions : 1).sort((a,b) => a-b);
  const median = burdens.length ? burdens[Math.floor((burdens.length - 1) / 2)]! : 1;
  const acceptance = input.organizerTrials.filter(t => t.acceptedTopFive && t.changedPositions <= 1).length / Math.max(1, input.organizerTrials.length);
  const comprehension = input.organizerTrials.filter(t => t.understoodFactors).length / Math.max(1, input.organizerTrials.length);
  const thresholds = { minTopFiveAcceptance: .7, maxMedianOverrideBurden: .25, minFactorComprehension: .8, minimumAggregateCohort: 3 } as const;
  const inputFingerprint = fingerprint(input.input), configFingerprint = fingerprint(input.config);
  const rank = () => Array.isArray(input.input) ? input.input.map((raw, index) => {
    const item = raw as { id?: unknown; demand?: unknown; feasibility?: unknown };
    if (typeof item.id !== "string" || typeof item.demand !== "number" || !(typeof item.feasibility === "number" || item.feasibility === null)) throw new Error(`invalid recommendation item at ${index}`);
    const demandWeight = input.config.demand ?? 0, feasibilityWeight = input.config.feasibility ?? 0;
    return { id: item.id, score: item.demand * demandWeight + (item.feasibility ?? 0) * feasibilityWeight, feasibilityStatus: item.feasibility === null ? "unknown" : "known" };
  }).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id)) : (() => { throw new Error("recommendation input must be an array"); })();
  const first = rank(), second = rank(), outputFingerprint = fingerprint(first);
  return { version: input.version, seed: input.seed, inputFingerprint, configFingerprint, outputFingerprint, thresholds, measures: { acceptance, medianOverrideBurden: median, comprehension, overrideBurdenSamples: burdens }, gates: { deterministic: fingerprint(first) === fingerprint(second), acceptance: acceptance >= thresholds.minTopFiveAcceptance, overrideBurden: median <= thresholds.maxMedianOverrideBurden, comprehension: comprehension >= thresholds.minFactorComprehension } };
}
