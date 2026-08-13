import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { redactEvidence } from "../../../tools/cloudflare/evidence.mjs";
import { createJournal, loadJournal, saveJournal } from "../../../tools/cloudflare/journal.mjs";
import { executeStep, runStagingOperation } from "../../../tools/cloudflare-staging.mjs";

const identity = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111", workerName: "woodshed-staging-run-a", origin: "https://woodshed-staging.invalid" };

test("a journal is atomic, owner-bound, and corrupt state authorizes no teardown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "woodshed-journal-"));
  const file = path.join(directory, "run.json");
  const journal = createJournal({ runId: "run-a", owner: "owner-a", sourceSha: "a".repeat(40), identity });
  await saveJournal(file, journal);
  assert.equal((await loadJournal(file, { runId: "run-a", owner: "owner-a" })).phase, "pre-write");
  await assert.rejects(loadJournal(file, { runId: "run-b", owner: "owner-a" }), /does not own/);
  await writeFile(file, "{truncated");
  await assert.rejects(runStagingOperation({ operation: "teardown", journalPath: file, runId: "run-a", owner: "owner-a", boundaries: { mutate: async () => assert.fail("must not mutate") } }), /invalid journal/);
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
