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
  it("binds cutover to the exact refresh watermark that passed conformance",()=>{
    const registry=new AuthorityRegistry();
    registry.transition("live","shadow-imported",{refreshWatermark:8});
    registry.transition("live","conformance-verified",{conformanceId:"proof-8"});
    assert.throws(()=>registry.transition("live","Woodshed-authoritative",{cutoverWatermark:9,commandsDrained:true,legacyWriterFrozen:true,exactlyOneWriter:true}),/exact conformed watermark/i);
    registry.transition("live","Woodshed-authoritative",{cutoverWatermark:8,commandsDrained:true,legacyWriterFrozen:true,exactlyOneWriter:true});
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
    assert.match(evaluateCutover(undefined).failures.join(" "), /invalid/);
    assert.match(evaluateCutover({ artifactVersion:2 }).failures.join(" "), /version/);
    assert.match(evaluateCutover({ ...completeArtifact(), capability:"unknown" }).failures.join(" "), /capability/);
    assert.match(evaluateCutover({ ...completeArtifact(), rollback:{} }).failures.join(" "), /malformed/);
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
    const mismatch = compareShadow([{ ...pairs[0]!, woodshed: { revision: 3, state: "active" } }], { invariants: [] });
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

describe("authority evidence and retirement boundaries",()=>{
  it("consumes cutover gates through real shadow, conformance, authority and retirement transitions",()=>{
    const registry=new AuthorityRegistry(),artifact=completeArtifact();
    registry.assertRead("ballot","legacy");registry.assertWrite("ballot","legacy");
    assert.throws(()=>registry.assertRead("ballot","woodshed"),/no readable shadow/);
    assert.throws(()=>registry.transition("ballot","shadow-imported",{}),/watermark/);
    registry.transition("ballot","shadow-imported",{refreshWatermark:0});registry.assertRead("ballot","woodshed");
    assert.throws(()=>registry.transition("ballot","conformance-verified",{}),/conformance evidence/);
    assert.throws(()=>registry.refresh("ballot",-1),/monotonic/);assert.throws(()=>registry.refresh("ballot",1.5),/monotonic/);
    const shadow=compareShadow([{capability:"ballot",id:"synthetic-ballot",legacy:{votes:3},woodshed:{votes:3}}],{invariants:[pair=>pair.woodshed.votes===3]});
    assert.equal(shadow.mismatches.length+shadow.invariantFailures.length,0);
    registry.transition("ballot","conformance-verified",{conformanceId:"shadow-proof"});
    assert.equal(evaluateCutover(artifact).readyForAuthority,true);
    registry.transition("ballot","Woodshed-authoritative",{cutoverWatermark:0,commandsDrained:artifact.approvals.commandDrain,legacyWriterFrozen:artifact.approvals.writerFreeze,exactlyOneWriter:artifact.approvals.exactlyOneWriter});
    assert.throws(()=>registry.assertWrite("ballot","legacy"),/not the authority/);
    assert.throws(()=>registry.transition("ballot","legacy-retired",{}),/retirement approval/);
    artifact.approvals.legacyRetirementApproved=true;assert.equal(evaluateCutover(artifact).readyForLegacyRetirement,true);
    registry.transition("ballot","legacy-retired",{retirementApproval:"retirement-approved"});
    registry.assertRead("ballot","woodshed");registry.assertWrite("ballot","woodshed");
    assert.throws(()=>registry.assertRead("ballot","legacy"),/retired/);
    assert.throws(()=>registry.rollback("ballot",{strategy:"journal-replay",evidenceId:"proof"}),/only applies/);
    const snapshot=registry.get("ballot");snapshot.evidence.length=0;
    assert.deepEqual(registry.get("ballot").evidence,["shadow-proof","retirement-approved"]);
  });
  it("rolls back before writes without recovery, and preserves authority during a forward fix",()=>{
    const registry=new AuthorityRegistry();
    const cutover=()=>{registry.transition("event","shadow-imported",{refreshWatermark:2});registry.transition("event","conformance-verified",{conformanceId:"proof"});registry.transition("event","Woodshed-authoritative",{cutoverWatermark:2,commandsDrained:true,legacyWriterFrozen:true,exactlyOneWriter:true})};
    cutover();registry.rollback("event",{strategy:"none"});registry.assertWrite("event","legacy");
    cutover();registry.assertWrite("event","woodshed");
    assert.throws(()=>registry.rollback("event",{strategy:"freeze-snapshot-cutback"}),/unsafe rollback/);
    registry.rollback("event",{strategy:"irreversible-forward-fix",evidenceId:"forward-fix"});
    assert.equal(registry.get("event").state,"Woodshed-authoritative");assert.equal(registry.get("event").acceptedWrites,true);
    registry.rollback("event",{strategy:"freeze-snapshot-cutback",evidenceId:"snapshot-proof"});
    assert.equal(registry.get("event").acceptedWrites,false);registry.assertWrite("event","legacy");
  });
});

describe("cutover failure inventory",()=>{
  it("rejects incomplete and malformed nested inventories before readiness evaluation",()=>{
    const malformed:unknown[]=[[],{...completeArtifact(),owner:undefined},{...completeArtifact(),release:null},{...completeArtifact(),baseline:[]},{...completeArtifact(),observations:[null]}, {...completeArtifact(),observations:[{at:5,status:"pass",evidenceId:"proof"}]},{...completeArtifact(),rollback:{commands:[],expected:{errorRateMax:NaN,mismatchRateMax:0}}},{...completeArtifact(),approvals:{...completeArtifact().approvals,writerFreeze:"true"}}];
    for(const artifact of malformed){const result=evaluateCutover(artifact);assert.equal(result.readyForAuthority,false);assert.equal(result.readyForLegacyRetirement,false);assert.ok(result.failures.length)}
  });
  it("reports release, recovery, observation, metric and approval failures together",()=>{
    const a=completeArtifact();a.approver=a.owner;a.release.exactReleaseMarker="wrong";a.baseline.queries=[];a.recovery.journalStart=undefined;
    a.rollback.commands=[];a.rollback.expected.errorRateMax=-1;a.observability.queueDepth=1;
    a.observations=[{at:"+5m",status:"fail",evidenceId:"failed-proof"},{at:"+1h",status:"pass",evidenceId:""}];
    a.approvals={readFirstUat:false,commandDrain:false,writerFreeze:false,shadowReconciled:false,exactlyOneWriter:false,publicationApproved:false,legacyRetirementApproved:true};
    const result=evaluateCutover(a);assert.equal(result.readyForAuthority,false);assert.equal(result.readyForLegacyRetirement,false);
    for(const message of ["distinct owner","frozen release","baseline queries","journal replay start","rollback commands","observability gate","read-first UAT","command drain","writer freeze","shadow reconciliation","exactly one writer","publication approval"])assert.ok(result.failures.some(f=>f.includes(message)),message);
    assert.equal(result.observationFailures.length,4);
    a.recovery.strategy="none";assert.match(evaluateCutover(a).failures.join(" "),/safe recovery strategy/);
  });
  it("rejects unknown nested proof fields and permits metrics exactly at declared thresholds",()=>{
    const a=completeArtifact();a.observability.errorRate=a.rollback.expected.errorRateMax;
    assert.equal(evaluateCutover(a).readyForAuthority,true);
    const unknown={...a,release:{...a.release,unreviewed:true},observations:[...a.observations,{at:"+24h",status:"pass",evidenceId:"proof",unreviewed:true}]};
    assert.deepEqual(evaluateCutover(unknown).failures,["release inventory contains unknown fields","observation inventory contains unknown fields"]);
    a.observability.errorRate+=.0001;assert.match(evaluateCutover(a).failures.join(" "),/observability/);
  });
  it("identifies failed invariants independently of equality and handles empty comparisons",()=>{
    assert.deepEqual(compareShadow([],{invariants:[]}),{compared:0,mismatches:[],invariantFailures:[]});
    const report=compareShadow([{capability:"live",id:"synthetic-id",legacy:{b:2,a:1},woodshed:{a:1,b:2}}],{invariants:[()=>true,p=>p.woodshed.a===2]});
    assert.equal(report.mismatches.length,0);assert.equal(report.invariantFailures.length,1);assert.equal(report.invariantFailures[0]?.invariant,1);
    assert.match(report.invariantFailures[0]!.idHash,/^[a-f0-9]{16}$/);assert.equal(JSON.stringify(report).includes("synthetic-id"),false);
  });
});

describe("recommendation edge cohorts and scoring",()=>{
  const base={version:"v1",seed:"synthetic",config:{demand:1,feasibility:1},input:[{id:"b",demand:1,feasibility:null},{id:"a",demand:0,feasibility:1}],organizerTrials:[]};
  it("fails human validation gates with empty cohorts and zero-position trials",()=>{
    const empty=validateRecommendation(base);assert.deepEqual(empty.measures,{acceptance:0,medianOverrideBurden:1,comprehension:0,overrideBurdenSamples:[]});
    assert.deepEqual(empty.gates,{deterministic:true,acceptance:false,overrideBurden:false,comprehension:false});
    const report=validateRecommendation({...base,organizerTrials:[{acceptedTopFive:false,changedPositions:0,totalPositions:0,understoodFactors:false}]});
    assert.deepEqual(report.measures.overrideBurdenSamples,[1]);assert.equal(report.gates.overrideBurden,false);
  });
  it("ranks ties canonically, defaults missing weights and rejects malformed candidates",()=>{
    const first=validateRecommendation(base),reversed=validateRecommendation({...base,input:[...base.input].reverse()});
    assert.equal(first.outputFingerprint,reversed.outputFingerprint);assert.notEqual(first.inputFingerprint,reversed.inputFingerprint);
    assert.equal(validateRecommendation({...base,config:{}}).gates.deterministic,true);
    for(const input of [{},[{id:1,demand:1,feasibility:1}],[{id:"a",demand:"1",feasibility:1}],[{id:"a",demand:1}]])assert.throws(()=>validateRecommendation({...base,input}),/recommendation/);
  });
  it("uses sorted override burden and requires acceptance as well as low edit count",()=>{
    const report=validateRecommendation({...base,organizerTrials:[{acceptedTopFive:true,changedPositions:4,totalPositions:4,understoodFactors:true},{acceptedTopFive:true,changedPositions:1,totalPositions:4,understoodFactors:true},{acceptedTopFive:false,changedPositions:0,totalPositions:4,understoodFactors:false}]});
    assert.deepEqual(report.measures.overrideBurdenSamples,[0,.25,1]);assert.equal(report.measures.medianOverrideBurden,.25);
    assert.equal(report.measures.acceptance,1/3);assert.equal(report.gates.overrideBurden,true);assert.equal(report.gates.acceptance,false);assert.equal(report.gates.comprehension,false);
  });
});

import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

it("recommendation CLI validates synthetic input and preserves existing evidence on failed writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "woodshed-recommendation-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "input.json"), output = join(root, "evidence.json");
  const payload = { datasetKind: "synthetic", containsPrivateData: false, evidenceTime: "2030-01-01T00:00:00Z", version: "test-v1", config: { demand: 1, feasibility: 1 }, seed: "synthetic", input: [{ id: "song_synthetic", demand: 1, feasibility: null }], organizerTrials: [] };
  await writeFile(source, JSON.stringify(payload));
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../tools/validation/run-recommendation.mjs", import.meta.url)), ...args], { encoding: "utf8" });
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  };
  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /usage:/);
  assert.equal(run([source, output]).status, 0);
  const original = await readFile(output, "utf8");
  const parsed = JSON.parse(original);
  assert.equal(parsed.generatedAt, payload.evidenceTime);
  assert.equal(parsed.datasetKind, "synthetic");
  assert.equal(parsed.gates.acceptance, false);
  assert.equal(run([source, output]).status, 1);
  assert.equal(await readFile(output, "utf8"), original);
  await writeFile(source, "{malformed");
  const invalid = run([source, join(root, "invalid.json")]);
  assert.equal(invalid.status, 1);
  await assert.rejects(readFile(join(root, "invalid.json")), { code: "ENOENT" });
  await writeFile(source, JSON.stringify({ ...payload, datasetKind: "unknown" }));
  assert.equal(run([source, join(root, "refused.json")]).status, 1);
  await assert.rejects(readFile(join(root, "refused.json")), { code: "ENOENT" });
});
