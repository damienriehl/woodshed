import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createEvidenceEnvelope, createFinalEvidencePacket, redactEvidence } from "../../../tools/cloudflare/evidence.mjs";
import { createJournal, loadJournal, saveJournal, validateJournal } from "../../../tools/cloudflare/journal.mjs";
import { executeStep, runLiveOperation, runStagingOperation } from "../../../tools/cloudflare-staging.mjs";

const identity = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111", databaseName: "woodshed-staging-run-a", workerName: "woodshed-staging-run-a", origin: "https://woodshed-staging.invalid" };

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

test("fresh D1 journal accepts an approved name before UUID assignment and requires UUID afterward", () => {
  const freshIdentity = { ...identity };
  delete (freshIdentity as Partial<typeof freshIdentity>).databaseId;
  const fresh = createJournal({ runId: "run-fresh", owner: "owner-a", sourceSha: "a".repeat(40), identity: freshIdentity });
  assert.equal(fresh.identity.databaseId, undefined);
  fresh.phase = "resources-ready";
  assert.throws(() => validateJournal(fresh), /databaseId is required after provisioning/);
});

test("cleanup-complete journal still requires a database ID without a closed D1 refusal", () => {
  const freshIdentity = { ...identity };
  delete (freshIdentity as Partial<typeof freshIdentity>).databaseId;
  const journal = createJournal({ runId: "run-cleanup", owner: "owner-a", sourceSha: "a".repeat(40), identity: freshIdentity });
  journal.phase = "cleanup-complete";
  assert.throws(() => validateJournal(journal), /databaseId is required after provisioning/);
});

test("cleanup-complete acceptance mismatch requires its refusal invariants", () => {
  const freshIdentity = { ...identity };
  delete (freshIdentity as Partial<typeof freshIdentity>).databaseId;
  const journal = createJournal({ runId: "run-mismatch-cleanup", owner: "owner-a", sourceSha: "a".repeat(40), identity: freshIdentity });
  journal.phase = "cleanup-complete";
  journal.incident = { kind: "d1-acceptance-mismatch", databaseName: identity.databaseName };
  journal.teardown = { refusedD1Create: true };
  const d1Intent: (typeof journal.mutations)[number] = { kind: "d1-create", domain: "d1", id: "planned-database", status: "applied", providerAcceptance: { id: identity.databaseId } };
  journal.mutations = [d1Intent];

  const invalidClosures = [
    { ...structuredClone(journal), incident: { kind: "d1-acceptance-mismatch" } },
    { ...structuredClone(journal), mutations: [] },
    {
      ...structuredClone(journal),
      resources: [{ domain: "d1", id: "planned-database", runId: journal.runId, owner: journal.owner, status: "owned" }],
    },
    {
      ...structuredClone(journal),
      mutations: [
        d1Intent,
        { kind: "secret-put", domain: "secret", id: "LIVE_COMMAND_SECRET", status: "applied" },
      ],
    },
  ];
  for (const invalid of invalidClosures) assert.throws(() => validateJournal(invalid), /databaseId is required after provisioning/);
});

test("journal validation rejects malformed D1 provider acceptance", () => {
  const mutations = [
    { kind: "secret-put", domain: "secret", id: "LIVE_COMMAND_SECRET", status: "applied", providerAcceptance: { id: identity.databaseId } },
    { kind: "d1-create", domain: "d1", id: "planned-database", status: "pending", providerAcceptance: { id: identity.databaseId } },
    { kind: "d1-create", domain: "d1", id: "planned-database", status: "applied", providerAcceptance: {} },
  ];
  for (const mutation of mutations) {
    const journal = createJournal({ runId: "run-acceptance", owner: "owner-a", sourceSha: "a".repeat(40), identity });
    journal.mutations.push(mutation as any);
    assert.throws(() => validateJournal(journal), /D1 provider acceptance/);
  }
});

test("mismatched applied D1 acceptance records an incident and preserves the foreign database through cleanup", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-d1-mismatch-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-d1-mismatch-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));

  const sourceSha = "b".repeat(40);
  const accountId = "c".repeat(32);
  const acceptedDatabaseId = "11111111-2222-4333-8444-555555555555";
  const remoteDatabaseId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const workerName = "woodshed-staging-review";
  const databaseName = `${workerName}-db`;
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const inventory = {
    environment: "staging",
    expectedSourceSha: sourceSha,
    staging: { accountId, databaseName, workerName, origin: `https://${workerName}.synthetic.workers.dev` },
    forbidden: {
      accountIds: ["d".repeat(32)],
      databaseIds: ["bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"],
      origins: ["https://protected.invalid"],
      workerNames: ["protected-worker"],
    },
  };
  await writeFile(inventoryPath, JSON.stringify(inventory));

  const state = {
    databases: [] as Array<{ uuid: string; name: string }>,
    mutations: [] as string[],
  };
  const recordMutation = (kind: string) => async () => { state.mutations.push(kind); };
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => state.databases,
    deploymentsList: async () => [],
    versionsList: async () => [],
    secretList: async () => [],
    d1Create: recordMutation("d1-create"),
    d1Delete: recordMutation("d1-delete"),
    deploy: recordMutation("deploy"),
    deleteWorker: recordMutation("worker-delete"),
    secretPut: recordMutation("secret-put"),
    secretDelete: recordMutation("secret-delete"),
  };
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectAccountSubdomain: async () => "synthetic",
    inspectWorkersDev: async () => ({ exists: false, enabled: false }),
  };
  const common = {
    root: testRoot,
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: "run-d1-acceptance-mismatch",
    owner: "owner-d1-review",
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => tokenClient,
    fetch: async () => new Response(null, { status: 404 }),
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  };

  await runLiveOperation({ ...common, operation: "plan" }, dependencies);
  const plannedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  const d1Resource = plannedJournal.resources.find((resource: any) => resource.domain === "d1");
  plannedJournal.mutations.push({
    kind: "d1-create",
    domain: "d1",
    id: d1Resource.id,
    status: "applied",
    providerAcceptance: { id: acceptedDatabaseId },
  });
  await saveJournal(journalPath, plannedJournal);
  state.databases = [{ uuid: remoteDatabaseId, name: databaseName }];

  await assert.rejects(runLiveOperation({ ...common, operation: "apply" }, dependencies), /existing resource is not owned by this run/);
  assert.equal(state.mutations.length, 0);
  const refusedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.deepEqual(refusedJournal.incident, {
    kind: "d1-acceptance-mismatch",
    databaseName,
    failedPhase: "pre-write",
    owner: "owner-d1-review",
    nextAction: "tear-down-refused-run-before-retrying",
    wholeStackRollback: false,
  });
  assert.doesNotMatch(JSON.stringify(refusedJournal.incident), new RegExp(`${acceptedDatabaseId}|${remoteDatabaseId}`));

  const teardown = await runLiveOperation({ ...common, operation: "teardown" }, dependencies);
  assert.equal(teardown.cleanupComplete, true);
  const absence = await runLiveOperation({ ...common, operation: "absence-check" }, dependencies);
  assert.deepEqual(absence, { operation: "absence-check", phase: "cleanup-complete", absenceCount: 0, passed: true });
  assert.equal(state.mutations.length, 0);
  assert.deepEqual(state.databases, [{ uuid: remoteDatabaseId, name: databaseName }]);
});

test("journal validation rejects forged ownership and incomplete Durable Object deletion proof", () => {
  const journal = createJournal({ runId: "run-a", owner: "owner-a", sourceSha: "a".repeat(40), identity });
  journal.resources.push({ domain: "worker", id: identity.workerName, runId: "another-run", owner: journal.owner });
  assert.throws(() => validateJournal(journal), /resource ownership/);

  journal.resources = [];
  journal.mutations.push({ kind: "durable-object-delete", domain: "durable-object", id: "run-owned-do", status: "applied" });
  assert.throws(() => validateJournal(journal), /deletion attestation/);
});

test("preflight uncertainty, absent lease, and identity drift cause zero mutations", async () => {
  let mutations = 0;
  const mutate = async () => { mutations += 1; };
  await assert.rejects(runStagingOperation({ operation: "apply", inventory: null, boundaries: { mutate } }), /inventory/);
  await assert.rejects(runStagingOperation({ operation: "apply", runId: "run-a", owner: "owner-a", inventory: identity, lease: null, expectedIdentity: identity, remoteIdentity: identity, boundaries: { mutate } }), /lease/);
  await assert.rejects(runStagingOperation({ operation: "apply", runId: "run-a", owner: "owner-a", inventory: identity, lease: { runId: "run-a", owner: "owner-a", active: true }, expectedIdentity: identity, remoteIdentity: { ...identity, workerName: "changed" }, boundaries: { mutate } }), /identity changed/);
  assert.equal(mutations, 0);
});

test("apply and verify reject active leases belonging to another run or owner", async () => {
  let mutations = 0;
  const mutate = async () => { mutations += 1; };
  const base = { runId: "run-a", owner: "owner-a", inventory: identity, expectedIdentity: identity, remoteIdentity: identity, boundaries: { mutate } };
  for (const operation of ["apply", "verify"]) {
    await assert.rejects(runStagingOperation({ ...base, operation, lease: { active: true, runId: "run-b", owner: "owner-a" } }), /lease/);
    await assert.rejects(runStagingOperation({ ...base, operation, lease: { active: true, runId: "run-a", owner: "owner-b" } }), /lease/);
  }
  assert.equal(mutations, 0);
});

test("pre-provisioning database-name drift blocks mutation before a UUID exists", async () => {
  let mutations = 0;
  const expectedIdentity = { ...identity, databaseId: undefined };
  const remoteIdentity = { ...expectedIdentity, databaseName: "woodshed-staging-other-run" };
  await assert.rejects(runStagingOperation({
    operation: "apply",
    runId: "run-a",
    owner: "owner-a",
    inventory: identity,
    lease: { active: true, runId: "run-a", owner: "owner-a" },
    expectedIdentity,
    remoteIdentity,
    boundaries: { mutate: async () => { mutations += 1; } },
  }), /identity changed/);
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
  const cookieOutput = redactEvidence({ message: "request failed; Cookie: woodshed_session_event=private-session; Path=/" });
  assert.doesNotMatch(JSON.stringify(cookieOutput), /private-session|woodshed_session_event/);
  const setCookieOutput = redactEvidence({ message: "response failed; Set-Cookie: woodshed_session_event=private-session; HttpOnly" });
  assert.doesNotMatch(JSON.stringify(setCookieOutput), /private-session|woodshed_session_event/);
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

test("final evidence reduces exact teardown identities to domain counts and refuses whole-stack rollback claims", () => {
  const privateResourceId = "private-resource-identity";
  const input = {
    runId: "run-a", sourceSha: "a".repeat(40), phase: "cleanup-complete",
    configDigest: "b".repeat(64), schemaDigest: "c".repeat(64), protectedRevisionBefore: "d".repeat(64), protectedRevisionAfter: "d".repeat(64), migrationCount: 11,
    absence: {
      [`route:${privateResourceId}`]: true,
      [`hostname:${privateResourceId}`]: true,
      [`credential:${privateResourceId}`]: true,
      [`secret:${privateResourceId}`]: true,
      [`worker:${privateResourceId}`]: true,
      [`durable-object:${privateResourceId}`]: true,
      [`d1:${privateResourceId}`]: true,
      [`token:${privateResourceId}`]: true,
    },
    rollback: { workerCode: "same-lifecycle-only", initialLifecycle: "forward-fix-only", d1: "quarantined-bookmark-only", durableObject: "forward-fix-only", wholeStackRollback: false },
    completedAt: "2030-01-01T12:00:00.000Z",
  };
  const packet = createFinalEvidencePacket(input);
  assert.equal(packet.cleanupComplete, true);
  assert.equal(packet.productionAuthority, false);
  assert.doesNotMatch(JSON.stringify(packet), new RegExp(privateResourceId));
  assert.deepEqual(packet.absence.worker, { count: 1, absent: true });
  assert.equal(packet.nonImpact.protectedInventoryStable, true);
  assert.throws(() => createFinalEvidencePacket({ ...input, absence: { ...input.absence, [`hostname:${privateResourceId}`]: undefined } }), /complete absence/);
  assert.throws(() => createFinalEvidencePacket({ ...input, rollback: { ...input.rollback, wholeStackRollback: true } }), /must not be claimed/);
});
