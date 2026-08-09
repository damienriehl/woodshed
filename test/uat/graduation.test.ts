import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AuthorityRegistry, compareShadow, evaluateCutover, validateRecommendation,
  type CutoverArtifact, type ShadowPair,
} from "../../packages/graduation/src/index.ts";
import { runRecommendationValidation } from "../../tools/validation/run-recommendation.mjs";

const completeArtifact = (overrides: Partial<CutoverArtifact> = {}): CutoverArtifact => ({
  artifactVersion: 1, capability: "ballot", owner: "release-owner", approver: "independent-approver",
  release: { sha: "a".repeat(40), configFingerprint: "b".repeat(64), schemaVersion: "12", privacyProvenance: "privacy-run-7", exactReleaseMarker: `release:${"a".repeat(40)}` },
  baseline: { queries: ["ballot-count"], resultFingerprint: "c".repeat(64) },
  recovery: { backupId: "backup-7", restoreProofId: "restore-drill-4", strategy: "journal-replay", journalStart: "journal-19" },
  deploy: { order: ["schema-expand", "reader", "writer", "route"], routingFlag: "authority.ballot", immutableOrigin: "https://release.invalid", immutableOriginVerified: true, alias: "https://app.invalid", aliasChangedAfterOriginVerification: true, pinnedCli: "wrangler@4.28.1" },
  observations: ["+5m", "+1h", "+4h", "+24h"].map(at => ({ at, status: "pass" as const, evidenceId: `evidence-${at}` })),
  rollback: { commands: ["route authority.ballot legacy", "drain woodshed-ballot", "replay journal-19"], expected: { errorRateMax: 0.01, mismatchRateMax: 0 } },
  observability: { errorRate: 0, mismatchRate: 0, queueDepth: 0, owner: "on-call", runbook: "docs/operations/cutover.md" },
  approvals: { readFirstUat: true, commandDrain: true, writerFreeze: true, shadowReconciled: true, exactlyOneWriter: true, publicationApproved: true, legacyRetirementApproved: false },
  ...overrides,
});

describe("per-capability authority graduation", () => {
  it("keeps ballot, event, assignment, and live authority independent", () => {
    const registry = new AuthorityRegistry();
    registry.transition("ballot", "shadow-imported", { refreshWatermark: 7 });
    registry.transition("ballot", "conformance-verified", { conformanceId: "uat-7" });
    assert.equal(registry.get("ballot").state, "conformance-verified");
    assert.equal(registry.get("live").state, "legacy-authoritative");
  });
  it("rejects skipped transitions, writes during shadow, and refresh after Woodshed writes", () => {
    const registry = new AuthorityRegistry();
    assert.throws(() => registry.transition("event", "Woodshed-authoritative", {}), /illegal authority transition/);
    assert.throws(() => registry.assertWrite("event", "woodshed"), /not the authority/);
    registry.transition("event", "shadow-imported", { refreshWatermark: 2 });
    registry.refresh("event", 3);
    registry.transition("event", "conformance-verified", { conformanceId: "proof" });
    registry.transition("event", "Woodshed-authoritative", { cutoverWatermark: 3, commandsDrained: true, legacyWriterFrozen: true, exactlyOneWriter: true });
    registry.assertWrite("event", "woodshed");
    assert.throws(() => registry.refresh("event", 4), /refresh forbidden/);
  });
  it("allows a newer legacy refresh after conformance but requires conformance again",()=>{
    const registry=new AuthorityRegistry();
    registry.transition("ballot","shadow-imported",{refreshWatermark:5});
    registry.transition("ballot","conformance-verified",{conformanceId:"proof-5"});
    registry.refresh("ballot",6);
    assert.equal(registry.get("ballot").state,"shadow-imported");
    assert.throws(()=>registry.transition("ballot","Woodshed-authoritative",{cutoverWatermark:6,commandsDrained:true,legacyWriterFrozen:true,exactlyOneWriter:true}),/illegal authority transition/);
    registry.transition("ballot","conformance-verified",{conformanceId:"proof-6"});
    assert.equal(registry.get("ballot").state,"conformance-verified");
  });
  it("requires safe rollback evidence once Woodshed accepts writes", () => {
    const registry = new AuthorityRegistry();
    registry.transition("assignment", "shadow-imported", { refreshWatermark: 1 });
    registry.transition("assignment", "conformance-verified", { conformanceId: "proof" });
    registry.transition("assignment", "Woodshed-authoritative", { cutoverWatermark: 1, commandsDrained: true, legacyWriterFrozen: true, exactlyOneWriter: true });
    registry.assertWrite("assignment", "woodshed");
    assert.throws(() => registry.rollback("assignment", { strategy: "none" }), /unsafe rollback/);
    registry.rollback("assignment", { strategy: "journal-replay", evidenceId: "journal-1" });
    assert.equal(registry.get("assignment").state, "legacy-authoritative");
  });
});

describe("cutover and shadow UAT", () => {
  it("fails closed on partial deploy, missing inventory, unsafe writer overlap, and early retirement", () => {
    assert.equal(evaluateCutover(completeArtifact()).readyForAuthority, true);
    assert.match(evaluateCutover(completeArtifact({ owner: "" })).failures.join(" "), /owner/);
    assert.match(evaluateCutover(completeArtifact({ deploy: { ...completeArtifact().deploy, order: ["reader", "writer"] } })).failures.join(" "), /deploy order/);
    assert.match(evaluateCutover(completeArtifact({ approvals: { ...completeArtifact().approvals, exactlyOneWriter: false } })).failures.join(" "), /exactly one writer/);
    assert.match(evaluateCutover({ ...completeArtifact(), unexpected: true } as CutoverArtifact).failures.join(" "), /unknown fields/);
    assert.match(evaluateCutover(completeArtifact({ deploy: { ...completeArtifact().deploy, immutableOriginVerified: false } })).failures.join(" "), /immutable-origin-before-alias/);
    assert.equal(evaluateCutover(completeArtifact()).readyForLegacyRetirement, false);
    const retired = completeArtifact({ approvals: { ...completeArtifact().approvals, legacyRetirementApproved: true } });
    assert.equal(evaluateCutover(retired).readyForLegacyRetirement, true);
    assert.equal(evaluateCutover({ ...retired, observations: [] }).readyForAuthority, true);
    assert.equal(evaluateCutover({ ...retired, observations: [] }).readyForLegacyRetirement, false);
  });
  it("compares synthetic shadow records and invariants without leaking values", () => {
    const pairs: ShadowPair[] = (["ballot", "event", "assignment", "live"] as const).map(capability => ({ capability, id: `${capability}-1`, legacy: { revision: 2, state: "active" }, woodshed: { revision: 2, state: "active" } }));
    assert.deepEqual(compareShadow(pairs, { invariants: [p => p.legacy.revision === p.woodshed.revision] }), { compared: 4, mismatches: [], invariantFailures: [] });
    const mismatch = compareShadow([{ ...pairs[0], woodshed: { revision: 3, state: "active" } }], { invariants: [] });
    assert.equal(mismatch.mismatches[0]?.idHash.length, 16);
    assert.equal(JSON.stringify(mismatch).includes("live-1"), false);
  });
});

describe("recommendation validation evidence", () => {
  it("persists reproducibility and passes predeclared thresholds", () => {
    const report = validateRecommendation({ version: "draft-setlist/v1", config: { demand: .7, feasibility: .3 }, seed: "seed-7", input: [{ id: "song-a", demand: 1, feasibility: .5 }], organizerTrials: [{ acceptedTopFive: true, changedPositions: 1, totalPositions: 5, understoodFactors: true }] });
    assert.equal(report.gates.deterministic, true);
    assert.equal(report.gates.acceptance, true);
    assert.match(report.inputFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(report.thresholds.maxMedianOverrideBurden, .25);
  });
  it("writes synthetic evidence once and rejects a private-data declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "woodshed-recommendation-"));
    const source = join(root, "input.json"), evidence = join(root, "evidence.json");
    const payload = { datasetKind: "synthetic", containsPrivateData: false, evidenceTime: "2026-01-01T00:00:00.000Z", version: "draft-setlist/v1", config: { demand: .7, feasibility: .3 }, seed: "seed", input: [{ id: "synthetic-song", demand: 1, feasibility: null }], organizerTrials: [{ acceptedTopFive: true, changedPositions: 0, totalPositions: 1, understoodFactors: true }] };
    await writeFile(source, JSON.stringify(payload));
    await runRecommendationValidation(source, evidence);
    assert.equal(JSON.parse(await readFile(evidence, "utf8")).containsPrivateData, false);
    await assert.rejects(() => runRecommendationValidation(source, evidence), /exist/i);
    await writeFile(source, JSON.stringify({ ...payload, containsPrivateData: true }));
    await assert.rejects(() => runRecommendationValidation(source, join(root, "unsafe.json")), /synthetic/);
  });
});
