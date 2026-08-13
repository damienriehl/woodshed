import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createEvidenceEnvelope, redactEvidence } from "../../../tools/cloudflare/evidence.mjs";
import { createJournal, loadJournal, saveJournal } from "../../../tools/cloudflare/journal.mjs";
import { executeStep, runStagingOperation } from "../../../tools/cloudflare-staging.mjs";

const identity = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111", workerName: "woodshed-staging-run-a", origin: "https://woodshed-staging.invalid" };

test("a journal is atomic, owner-bound, and corrupt state authorizes no teardown", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "woodshed-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "run.json");
  const journal = createJournal({ runId: "run-a", owner: "owner-a", sourceSha: "a".repeat(40), identity });
  await saveJournal(file, journal);
  assert.equal((await loadJournal(file, { runId: "run-a", owner: "owner-a" })).phase, "pre-write");
  await assert.rejects(loadJournal(file, { runId: "run-b", owner: "owner-a" }), /does not own/);
  await writeFile(file, "{truncated");
  await assert.rejects(runStagingOperation({ operation: "teardown", journalPath: file, runId: "run-a", owner: "owner-a", boundaries: { mutate: async () => assert.fail("must not mutate") } }), /invalid journal/);
});

test("concurrent journal saves use unique temporary files and leave no residue", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "woodshed-journal-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "run.json");
  const value = createJournal({ runId: "run-a", owner: "owner-a", sourceSha: "a".repeat(40), identity });
  await Promise.all([saveJournal(file, value), saveJournal(file, value)]);
  assert.deepEqual(await readdir(directory), ["run.json"]);
  assert.equal((await loadJournal(file)).runId, "run-a");
});

test("preflight uncertainty, absent lease, and identity drift cause zero mutations", async () => {
  let mutations = 0;
  const mutate = async () => { mutations += 1; };
  await assert.rejects(runStagingOperation({ operation: "apply", inventory: null, boundaries: { mutate } }), /inventory/);
  await assert.rejects(runStagingOperation({ operation: "apply", inventory: identity, lease: null, expectedIdentity: identity, remoteIdentity: identity, boundaries: { mutate } }), /lease/);
  await assert.rejects(runStagingOperation({ operation: "apply", inventory: identity, lease: { runId: "run-a", owner: "owner-a", active: true }, expectedIdentity: identity, remoteIdentity: { ...identity, workerName: "changed" }, boundaries: { mutate } }), /identity changed/);
  assert.equal(mutations, 0);
});

test("uncertain mutation response is reconciled before any retry", async () => {
  const calls: string[] = [];
  const result = await executeStep({
    inspect: async () => { calls.push("inspect"); return calls.length === 1 ? { exists: false } : { exists: true, id: "owned" }; },
    mutate: async () => { calls.push("mutate"); throw new Error("response lost"); },
    owns: (state) => state.id === "owned",
  });
  assert.deepEqual(calls, ["inspect", "mutate", "inspect"]);
  assert.equal(result.reconciled, true);
});

test("redacted evidence cannot retain configured sensitive values or sensitive-shaped fields", () => {
  const secret = "top-secret-token";
  const output = redactEvidence({ phase: "verified", authorization: secret, nested: { deviceId: "device-1", requestBody: "private", safeCount: 2, note: `failed ${secret}` } }, [secret]);
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /top-secret|device-1|private/);
  assert.equal(output.nested.safeCount, 2);
});


test("shareable evidence accepts only allowlisted fields with exact types", () => {
  const valid = {
    runId: "run-a", sourceSha: "a".repeat(40), phase: "verified",
    outcomes: { acceptance: true, security: { wrongOrigin: true, missingCsrf: true, missingSession: true, participantOrganizer: true } },
    counts: { fixtureRows: 4 }, ids: { deploymentId: "deployment-a" },
  };
  assert.equal((createEvidenceEnvelope(valid).outcomes as Record<string, unknown>).acceptance, true);
  assert.throws(() => createEvidenceEnvelope({ ...valid, requestBody: "private" } as any), /unknown field.*requestBody/i);
  assert.throws(() => createEvidenceEnvelope({ ...valid, outcomes: { acceptance: "yes" } }), /acceptance.*boolean/i);
  assert.throws(() => createEvidenceEnvelope({ ...valid, outcomes: { unexpected: true } }), /unknown field.*unexpected/i);
  assert.throws(() => createEvidenceEnvelope({ ...valid, counts: { fixtureRows: -1 } }), /non-negative safe integer/i);
  assert.throws(() => createEvidenceEnvelope({ ...valid, ids: { arbitrary: "value" } }), /unknown field.*arbitrary/i);
});
