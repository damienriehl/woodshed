import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRollbackCompatible,
  buildFailureReport,
  runQuarantinedD1Recovery,
  runStackTeardown,
} from "../../../tools/cloudflare/recovery.mjs";

const lifecycle = {
  durableObject: "legacy-sqlite-v1",
  d1Schema: "schema-v1",
  durableObjectShape: "live-v1",
  bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"],
  secrets: ["LIVE_COMMAND_SECRET"],
};

test("rollback accepts only a same-lifecycle, storage-compatible version", () => {
  assert.equal(assertRollbackCompatible(lifecycle, structuredClone(lifecycle)), true);
  assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, durableObject: "pre-lifecycle" }), /Durable Object lifecycle/);
  assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, d1Schema: "schema-v0" }), /D1 schema/);
  assert.throws(() => assertRollbackCompatible(lifecycle, { ...lifecycle, durableObjectShape: "live-v0" }), /stored-value shape/);
  for (const field of ["durableObject", "d1Schema", "durableObjectShape"] as const) {
    for (const invalid of [undefined, null, ""]) {
      assert.throws(() => assertRollbackCompatible({ ...lifecycle, [field]: invalid }, { ...lifecycle, [field]: invalid }), /evidence is required/);
    }
  }
});

test("D1 recovery quarantines first and refuses drift or a writable origin", async () => {
  const calls: string[] = [];
  const base = {
    journal: { runId: "run-a", owner: "owner-a", identity: { accountId: "account", databaseId: "db", workerName: "worker", origin: "https://staging.invalid" }, recovery: { bookmark: "bookmark" } },
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" },
    expectedSnapshot: { revision: "7", originWritable: true },
    inspectSnapshot: async () => ({ revision: "7", originWritable: calls.length === 0 }),
    quarantineOrigin: async () => { calls.push("quarantine"); },
    restoreD1: async () => { calls.push("restore"); },
    verifyD1: async () => { calls.push("verify"); return { ledger: true, schema: true, foreignKeys: true, aggregates: true, behavior: true }; },
  };
  await runQuarantinedD1Recovery(base);
  assert.deepEqual(calls, ["quarantine", "restore", "verify"]);

  await assert.rejects(runQuarantinedD1Recovery({ ...base, inspectSnapshot: async () => ({ revision: "8", originWritable: false }) }), /last-write identity changed/);
});

test("D1 recovery reconciles a lost restore response only after full verification", async () => {
  const verification = { ledger: true, schema: true, foreignKeys: true, aggregates: true, behavior: true };
  const base = {
    journal: { runId: "run-a", owner: "owner-a", recovery: { bookmark: "bookmark" } },
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" },
    expectedSnapshot: { revision: "7", originWritable: false },
    inspectSnapshot: async () => ({ revision: "7", originWritable: false }),
    quarantineOrigin: async () => assert.fail("already quarantined"),
    restoreD1: async () => { throw new Error("response lost"); },
  };
  const result = await runQuarantinedD1Recovery({ ...base, verifyD1: async () => verification });
  assert.equal(result.reconciled, true);
  await assert.rejects(
    runQuarantinedD1Recovery({ ...base, verifyD1: async () => ({ ...verification, ledger: false }) }),
    /response lost/,
  );
});

test("teardown is run-owned, dependency ordered, re-entrant, and proves every domain absent", async () => {
  const calls: string[] = [];
  const state = new Map([
    ["route", true], ["credential", true], ["secret", true], ["worker", true], ["durable-object", true], ["d1", true], ["token", true],
  ]);
  const journal = {
    runId: "run-a", owner: "owner-a", phase: "quarantined",
    identity: { accountId: "account", databaseId: "db", workerName: "worker", origin: "https://staging.invalid" },
    resources: [...state.keys()].map((domain) => ({ domain, id: `${domain}-run-a`, runId: "run-a", owner: "owner-a" })),
  };
  const result = await runStackTeardown({
    journal,
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" },
    expectedRevision: "7",
    inspectRevision: async () => "7",
    listDependents: async () => [],
    inspectResource: async ({ domain }: { domain: string }) => ({ exists: state.get(domain), runId: "run-a", owner: "owner-a" }),
    removeResource: async ({ domain }: { domain: string }) => { calls.push(domain); state.set(domain, false); },
    verifyTokenInactive: async () => true,
  });
  assert.deepEqual(calls, ["route", "credential", "secret", "worker", "durable-object", "d1", "token"]);
  assert.equal(result.complete, true);
  assert.deepEqual(Object.values(result.absence), [true, true, true, true, true, true, true]);

  calls.length = 0;
  assert.equal((await runStackTeardown({
    journal, lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", listDependents: async () => [],
    inspectResource: async ({ domain }: { domain: string }) => ({ exists: state.get(domain), runId: "run-a", owner: "owner-a" }),
    removeResource: async ({ domain }: { domain: string }) => { calls.push(domain); }, verifyTokenInactive: async () => true,
  })).complete, true);
  assert.deepEqual(calls, []);
});

test("teardown removes every duplicate-domain resource and an applicable hostname", async () => {
  const resourceSpecs = [
    ["route", "route-a"], ["route", "route-b"], ["hostname", "host-a"],
    ["credential", "credential-a"], ["secret", "secret-a"], ["worker", "worker-a"],
    ["durable-object", "do-a"], ["d1", "d1-a"], ["token", "token-a"],
  ];
  const state = new Map(resourceSpecs.map(([, id]) => [id, true]));
  const journal = {
    runId: "run-a", owner: "owner-a", phase: "quarantined", identity: {},
    resources: resourceSpecs.map(([domain, id]) => ({ domain, id, runId: "run-a", owner: "owner-a" })),
  };
  const removed: string[] = [];
  const result = await runStackTeardown({
    journal, lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", listDependents: async () => [],
    inspectResource: async ({ id }: { id: string }) => ({ exists: state.get(id), runId: "run-a", owner: "owner-a" }),
    removeResource: async ({ id }: { id: string }) => { removed.push(id); state.set(id, false); },
    verifyTokenInactive: async () => true,
  });
  assert.deepEqual(removed, resourceSpecs.map(([, id]) => id));
  assert.equal(Object.keys(result.absence).length, resourceSpecs.length);
  assert.equal(result.complete, true);
});

test("teardown rejects duplicate identities before removing anything", async () => {
  const domains = ["route", "credential", "secret", "worker", "durable-object", "d1", "token"];
  const resources = domains.map((domain) => ({ domain, id: domain + "-a", runId: "run-a", owner: "owner-a" }));
  resources.push({ ...{ ...resources[0]! } });
  let removals = 0;
  await assert.rejects(runStackTeardown({
    journal: { runId: "run-a", owner: "owner-a", phase: "quarantined", resources },
    lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", listDependents: async () => [], inspectResource: async () => ({ exists: true, runId: "run-a", owner: "owner-a" }),
    removeResource: async () => { removals += 1; }, verifyTokenInactive: async () => true,
  }), /duplicate teardown resource identity/);
  assert.equal(removals, 0);
});

test("teardown fails closed on identity mismatch or unexpected dependents", async () => {
  const journal = { runId: "run-a", owner: "owner-a", phase: "quarantined", identity: {}, resources: ["route", "credential", "secret", "worker", "durable-object", "d1", "token"].map((domain) => ({ domain, id: domain + "-run-a", runId: "run-a", owner: "owner-a" })) };
  const base = {
    journal, lease: { active: true, runId: "run-a", owner: "owner-a", revision: "7" }, expectedRevision: "7",
    inspectRevision: async () => "7", inspectResource: async () => ({ exists: true, runId: "other", owner: "other" }),
    removeResource: async () => assert.fail("must not delete"), verifyTokenInactive: async () => true,
  };
  await assert.rejects(runStackTeardown({ ...base, listDependents: async () => [] }), /identity mismatch/);
  await assert.rejects(runStackTeardown({ ...base, inspectResource: async () => ({ exists: true, runId: "run-a", owner: "owner-a" }), listDependents: async () => ["unknown-child"] }), /unexpected dependent/);
});

test("failure reports retain safe next action but sanitize sensitive observability", () => {
  const report = buildFailureReport({
    phase: "worker-deployed", nextAction: "quarantine-origin", incidentOwner: "owner-a",
    observations: { workerExceptions: 1, d1Failures: 0, durableObjectFailures: 1, authorization: "Bearer token", requestBody: "ballot", note: "secret-value" },
  }, ["secret-value"]);
  assert.equal(report.nextAction, "quarantine-origin");
  assert.equal((report.observations as Record<string, unknown>).workerExceptions, 1);
  assert.doesNotMatch(JSON.stringify(report), /Bearer token|ballot|secret-value/);
  assert.equal(report.productionAuthority, false);
});
