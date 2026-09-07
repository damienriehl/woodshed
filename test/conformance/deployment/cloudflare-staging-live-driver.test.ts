import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  collectRemoteInventory,
  assertNoEnvironmentSuffixedWorker,
  confirmAbsence,
  confirmReleaseMarker,
  createApiTokenClient,
  createIdentityRevision,
  executeJournaledMutation,
  generateEffectiveConfig,
  parseLiveArguments,
  publicOperationResult,
  readReleaseMarker,
  recordVerifiedSchemaEvidence,
  releaseMarkerMatches,
  remoteSchema,
  runLiveOperation,
} from "../../../tools/cloudflare/live-driver.mjs";
import type { ReleaseMarker } from "../../../tools/cloudflare/live-driver.mjs";
import { runMigrationFirstDeployment } from "../../../tools/cloudflare/deployment.mjs";
import { createJournal, saveJournal, validateJournal } from "../../../tools/cloudflare/journal.mjs";
import { createEvidenceEnvelope } from "../../../tools/cloudflare/evidence.mjs";
import { D1_MIGRATIONS } from "../../../tools/cloudflare/migrations.mjs";
import { runStackTeardown } from "../../../tools/cloudflare/recovery.mjs";
import { createSyntheticFixturePlan } from "../../../tools/cloudflare/staging-fixtures.mjs";
import { runDeployedAcceptance } from "../../../tools/cloudflare/staging-smoke.mjs";
import { publicErrorMessage } from "../../../tools/cloudflare-staging.mjs";

const sourceSha = "a".repeat(40);
const accountId = "b".repeat(32);
const databaseId = "11111111-2222-4333-8444-555555555555";
const workerName = "woodshed-staging-synthetic";
const origin = `https://${workerName}.synthetic.workers.dev`;

function fakeRetryTimers() {
  const delays: number[] = [];
  const callbacks: Array<() => void> = [];
  let timerScheduled: (() => void) | undefined;
  return {
    delays,
    setTimer(callback: () => void, delay: number) {
      callbacks.push(callback);
      delays.push(delay);
      timerScheduled?.();
      timerScheduled = undefined;
      return callbacks.length;
    },
    clearTimer() {},
    async fireNext() {
      if (callbacks.length === 0) await new Promise<void>((resolve) => { timerScheduled = resolve; });
      const callback = callbacks.shift();
      assert.ok(callback);
      callback();
    },
  };
}

function immediateRetryTimers() {
  const delays: number[] = [];
  return {
    delays,
    setTimer(callback: () => void, delay: number) {
      delays.push(delay);
      queueMicrotask(callback);
      return delays.length;
    },
    clearTimer() {},
  };
}

function statefulExposureTokenClient(exposures: Array<{ enabled: boolean; previews_enabled?: boolean }>) {
  let reads = 0;
  const exposureClient = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    fetch: async () => {
      const exposure = exposures[reads];
      reads += 1;
      assert.ok(exposure, "unexpected workers.dev exposure read");
      return Response.json({ success: true, result: { previews_enabled: false, ...exposure } });
    },
  });
  return {
    reads: () => reads,
    tokenClient: {
      inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
      listWorkerScripts: async () => [],
      listWorkerRoutes: async () => [],
      listWorkerDomains: async () => [],
      inspectWorkersDev: exposureClient.inspectWorkersDev,
    },
  };
}

test("confirmAbsence proves absence without scheduling a retry", async () => {
  const timers = fakeRetryTimers();
  const result = await confirmAbsence(async () => false, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  });

  assert.deepEqual(result, {
    outcome: "proven-absent",
    attempts: 1,
    checkedAt: "2030-01-01T12:00:00.000Z",
    lastError: null,
  });
  assert.deepEqual(timers.delays, []);
});

test("confirmAbsence retries with non-decreasing full-jitter delays", async () => {
  const timers = fakeRetryTimers();
  let probeCalls = 0;
  const confirmation = confirmAbsence(async () => {
    probeCalls += 1;
    return probeCalls < 3;
  }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
    random: () => 1,
  });

  await timers.fireNext();
  await timers.fireNext();
  const result = await confirmation;

  assert.equal(result.outcome, "proven-absent");
  assert.equal(result.attempts, 3);
  assert.deepEqual(timers.delays, [500, 1_000]);
  assert.ok(timers.delays.every((delay, index) => index === 0 || delay >= timers.delays[index - 1]!));
});

test("confirmAbsence reports present after the whole attempt ladder observed it", async () => {
  // Every attempt saw it and nothing errored, so this is the strongest present-evidence the
  // endpoint can give -- it must re-arm the hard refusal, not degrade to unknown. Only the
  // wall-clock cut-off and the rate-limit exit below leave the question genuinely open.
  const timers = fakeRetryTimers();
  const confirmation = confirmAbsence(async () => true, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
    maxAttempts: 8,
    random: () => 1,
  });

  for (let retry = 0; retry < 7; retry += 1) await timers.fireNext();
  const result = await confirmation;

  assert.equal(result.outcome, "present");
  assert.notEqual(result.outcome, "proven-absent");
  assert.equal(result.attempts, 8);
});

test("confirmAbsence stops when the wall-clock budget is exhausted", async () => {
  const timers = fakeRetryTimers();
  let probeCalls = 0;
  const confirmation = confirmAbsence(async () => {
    probeCalls += 1;
    return true;
  }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date(probeCalls < 2 ? 0 : 101),
    maxAttempts: 8,
    initialDelayMs: 1,
    budgetMs: 100,
    random: () => 1,
  });

  await timers.fireNext();
  const result = await confirmation;

  assert.equal(result.outcome, "could-not-confirm");
  assert.ok(result.attempts < 8);
  assert.equal(result.attempts, 2);
});

test("confirmAbsence stops immediately on rate limiting", async () => {
  const timers = fakeRetryTimers();
  const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
  const result = await confirmAbsence(async () => { throw rateLimitError; }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  });

  assert.equal(result.outcome, "could-not-confirm");
  assert.equal(result.attempts, 1);
  assert.equal(result.lastError, rateLimitError);
  assert.deepEqual(timers.delays, []);
});

test("confirmAbsence propagates non-rate-limit probe errors", async () => {
  const error = Object.assign(new Error("bad request"), { status: 400 });
  await assert.rejects(confirmAbsence(async () => { throw error; }, {
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  }), (thrown) => thrown === error);
});

test("confirmAbsence waits before retrying with real timers", async () => {
  let probeCalls = 0;
  const startedAt = Date.now();
  const result = await confirmAbsence(async () => {
    probeCalls += 1;
    return probeCalls === 1;
  }, {
    initialDelayMs: 60,
    maxAttempts: 3,
    random: () => 1,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.outcome, "proven-absent");
  assert.equal(probeCalls, 2);
  assert.ok(elapsedMs >= 55, `expected a real delay of at least 55ms, received ${elapsedMs}ms`);
});

const expectedReleaseMarker: ReleaseMarker = {
  sourceSha,
  configDigest: "d".repeat(64),
  lifecycle: "legacy-sqlite-v1",
  bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"],
};

function markerResponse(marker: unknown) {
  return Response.json(marker);
}

async function markerMutationFixture(responses: Array<Response | Error>, options: { mutateError?: Error; finalizeError?: Error } = {}) {
  const journal = createJournal({ runId: "run-marker", owner: "owner-marker", sourceSha, identity: inventory().staging });
  let fetchCalls = 0;
  let mutations = 0;
  const fetch = async () => {
    const response = responses[Math.min(fetchCalls, responses.length - 1)];
    fetchCalls += 1;
    assert.ok(response);
    if (response instanceof Error) throw response;
    return response.clone();
  };
  const operation = executeJournaledMutation({
    journal,
    expectedRevision: "revision-marker",
    inspectRevision: async () => "revision-marker",
    resource: { domain: "route", id: "route-marker" },
    kind: "workers-dev-enable",
    persistJournal: async () => {},
    inspect: async () => {
      const marker = await readReleaseMarker(fetch, origin, { timeoutMs: 5_000 });
      return marker ? { exists: true, id: "route-marker", marker } : { exists: false };
    },
    mutate: async () => {
      mutations += 1;
      if (options.mutateError) throw options.mutateError;
    },
    owns: (state: any) => releaseMarkerMatches(expectedReleaseMarker, state.marker),
    confirmAfterMutation: () => confirmReleaseMarker(fetch, origin, expectedReleaseMarker, {
      setTimer: immediateRetryTimers().setTimer,
      clearTimer: immediateRetryTimers().clearTimer,
      now: () => new Date("2030-01-01T12:00:00.000Z"),
      random: () => 0,
    }),
    finalize: async () => {
      if (options.finalizeError) throw options.finalizeError;
    },
  });
  try {
    return { result: await operation, journal, fetchCalls: () => fetchCalls, mutations: () => mutations };
  } catch (error: any) {
    error.journal = journal;
    error.mutations = mutations;
    throw error;
  }
}

test("a missing marker followed by the exact marker is proven owned after exactly one deploy", async () => {
  const fixture = await markerMutationFixture([
    new Response(null, { status: 404 }),
    new Response(null, { status: 404 }),
    markerResponse(expectedReleaseMarker),
  ]);
  assert.equal(fixture.result.observation?.outcome, "proven-owned");
  assert.equal(fixture.mutations(), 1);
});

test("a wrong-source marker followed by the exact marker is proven owned after exactly one deploy", async () => {
  const wrong = { ...expectedReleaseMarker, sourceSha: "f".repeat(40) };
  const fixture = await markerMutationFixture([
    new Response(null, { status: 404 }),
    markerResponse(wrong),
    markerResponse(expectedReleaseMarker),
  ]);
  assert.equal(fixture.result.observation?.outcome, "proven-owned");
  assert.equal(fixture.mutations(), 1);
});

for (const scenario of [
  {
    name: "all missing marker reads are proven not owned and journal marker-missing",
    responses: [new Response(null, { status: 404 })],
    outcome: "proven-not-owned",
    cause: "marker-missing",
  },
  {
    name: "one stable wrong marker is proven not owned and journals marker-mismatch",
    responses: [markerResponse({ ...expectedReleaseMarker, sourceSha: "f".repeat(40) })],
    outcome: "proven-not-owned",
    cause: "marker-mismatch",
  },
  {
    name: "mixed missing and wrong markers remain unconfirmed",
    responses: [
      new Response(null, { status: 404 }),
      markerResponse({ ...expectedReleaseMarker, sourceSha: "f".repeat(40) }),
    ],
    outcome: "could-not-confirm",
    cause: "postcondition-failed",
  },
  {
    name: "a marker read timeout remains unconfirmed and journals edge-timeout",
    responses: [Object.assign(new Error("synthetic timeout"), { name: "TimeoutError" })],
    outcome: "could-not-confirm",
    cause: "edge-timeout",
  },
  {
    name: "a rate-limited marker read remains unconfirmed and journals edge-rate-limited",
    responses: [new Response(null, { status: 429 })],
    outcome: "could-not-confirm",
    cause: "edge-rate-limited",
  },
] as const) {
  test(scenario.name, async () => {
    let captured: any;
    try {
      await markerMutationFixture([
        new Response(null, { status: 404 }),
        ...scenario.responses,
      ]);
    } catch (error: any) {
      captured = error;
    }
    assert.ok(captured);
    assert.equal(captured.observation?.outcome, scenario.outcome);
    assert.equal(captured.stagingCause, scenario.cause);
    assert.equal(captured.journal?.incident?.cause?.code, scenario.cause);
    assert.equal(captured.mutations, 1);
  });
}

test("presence confirmation does not begin another marker fetch after its wall budget", async () => {
  const timers = immediateRetryTimers();
  const clock = [0, 0, 0, 45_000, 45_000];
  let fetchCalls = 0;
  const result = await confirmReleaseMarker(async () => {
    fetchCalls += 1;
    return markerResponse({ ...expectedReleaseMarker, sourceSha: "f".repeat(40) });
  }, origin, expectedReleaseMarker, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date(clock.shift() ?? 45_000),
    budgetMs: 45_000,
  });
  assert.equal(result.outcome, "proven-not-owned");
  assert.equal(result.attempts, 1);
  assert.equal(fetchCalls, 1);
});

test("a malformed marker body propagates marker-unreadable instead of becoming an outcome", async () => {
  let mutations = 0;
  const journal = createJournal({ runId: "run-malformed", owner: "owner-marker", sourceSha, identity: inventory().staging });
  const fetch = async () => markerResponse({ sourceSha, configDigest: expectedReleaseMarker.configDigest });
  await assert.rejects(executeJournaledMutation({
    journal,
    expectedRevision: "revision-marker",
    inspectRevision: async () => "revision-marker",
    resource: { domain: "route", id: "route-marker" }, kind: "workers-dev-enable",
    persistJournal: async () => {},
    inspect: async () => {
      const marker = await readReleaseMarker(fetch, origin);
      return marker ? { exists: true, id: "route-marker", marker } : { exists: false };
    },
    mutate: async () => { mutations += 1; },
    owns: () => false,
    confirmAfterMutation: () => confirmReleaseMarker(fetch, origin, expectedReleaseMarker),
  }), (error: any) => error.stagingCause === "marker-unreadable" && error.observation === undefined);
  assert.equal(mutations, 0);
  assert.equal(journal.incident?.cause?.code, "marker-unreadable");
});

test("marker reader errors preserve HTTP status and the abort-timeout flag", async () => {
  await assert.rejects(readReleaseMarker(async () => new Response(null, { status: 429 }), origin), (error: any) => {
    assert.equal(error.status, 429);
    assert.equal(error.aborted, false);
    return true;
  });
  await assert.rejects(readReleaseMarker(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, origin), (error: any) => {
    assert.equal(error.status, undefined);
    assert.equal(error.aborted, true);
    return true;
  });
});

test("a malformed post-mutation marker records marker-unreadable without a second observation ladder", async () => {
  let captured: any;
  try {
    await markerMutationFixture([
      new Response(null, { status: 404 }),
      markerResponse({ sourceSha, configDigest: expectedReleaseMarker.configDigest }),
    ]);
  } catch (error: any) {
    captured = error;
  }
  assert.ok(captured);
  assert.equal(captured.stagingCause, "marker-unreadable");
  assert.equal(captured.observation, undefined);
  assert.equal(captured.journal.incident.cause.code, "marker-unreadable");
  assert.equal(captured.mutations, 1);
  assert.equal(captured.journal.mutations.find((item: any) => item.kind === "workers-dev-enable").status, "pending");
});

test("a failed Wrangler deploy that is proven not owned is never replayed", async () => {
  let captured: any;
  try {
    await markerMutationFixture([
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    ], { mutateError: Object.assign(new Error("Wrangler command failed"), { stagingCause: "wrangler-command-failed" }) });
  } catch (error: any) {
    captured = error;
  }
  assert.ok(captured);
  assert.equal(captured.stagingCause, "wrangler-command-failed");
  assert.equal(captured.journal.incident.cause.code, "wrangler-command-failed");
  assert.equal(captured.mutations, 1);
});

test("a failed active Wrangler deploy proven not owned records its cause and ends in quarantine", async (t) => {
  const fixture = await activeEnableSettlementFixture(t, { activeDeployError: new Error("Wrangler command failed") });

  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error: any) => error.message === "Wrangler command failed" && error.stagingCause === "wrangler-command-failed");
  const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(fixture.state.activeDeployCalls, 1);
  assert.equal(saved.phase, "quarantined");
  assert.equal(saved.incident.cause.code, "wrangler-command-failed");
  assert.equal(saved.mutations.find((item: any) => item.kind === "workers-dev-enable").status, "pending");
});

test("a full marker assertion failure during settlement leaves the enable pending and phase unadvanced", async () => {
  assert.equal(releaseMarkerMatches(expectedReleaseMarker, { ...expectedReleaseMarker, bindings: expectedReleaseMarker.bindings.slice(1) }), false);
  assert.equal(releaseMarkerMatches(expectedReleaseMarker, { ...expectedReleaseMarker, lifecycle: "another-lifecycle" }), false);
  let captured: any;
  try {
    await markerMutationFixture([
      new Response(null, { status: 404 }),
      markerResponse(expectedReleaseMarker),
    ], { finalizeError: new Error("served release does not match frozen source and configuration") });
  } catch (error: any) {
    captured = error;
  }
  assert.ok(captured);
  assert.equal(captured.stagingCause, "postcondition-failed");
  assert.equal(captured.journal.incident.cause.code, "postcondition-failed");
  assert.equal(captured.journal.phase, "pre-write");
  assert.equal(captured.journal.mutations.find((item: any) => item.kind === "workers-dev-enable").status, "pending");
  assert.equal(captured.mutations, 1);
});

async function activeEnableSettlementFixture(
  t: any,
  options: {
    pendingActivation?: boolean;
    activeDeploymentIds?: string[];
    activeDeployError?: Error;
  } = {},
) {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-enable-settlement-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-enable-settlement-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  await mkdir(path.join(testRoot, "migrations", "d1"), { recursive: true });
  for (const migration of D1_MIGRATIONS) {
    await copyFile(path.resolve("migrations/d1", migration.filename), path.join(testRoot, "migrations", "d1", migration.filename));
  }
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  const freshInventory = structuredClone(stagingInventory);
  delete (freshInventory.staging as Partial<typeof freshInventory.staging>).databaseId;
  await writeFile(inventoryPath, JSON.stringify(freshInventory));

  const schemaDatabase = new DatabaseSync(":memory:");
  t.after(() => schemaDatabase.close());
  schemaDatabase.exec("PRAGMA foreign_keys=ON");
  for (const migration of D1_MIGRATIONS) schemaDatabase.exec(await readFile(path.resolve("migrations/d1", migration.filename), "utf8"));
  const schemaObjects = schemaDatabase.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name").all();

  const newDeploymentIds = options.activeDeploymentIds ?? ["deployment-active"];
  const state = {
    databasePresent: false,
    secretPresent: false,
    active: false,
    activeDeployCalls: 0,
    activeDigest: "",
    deployments: [] as Array<{ id: string; script_name: string }>,
    versions: [] as Array<{ id: string; script_name: string }>,
    settlementSnapshots: [] as any[],
    captureSettlement: false,
  };
  const captureSettlement = async () => {
    if (state.captureSettlement) state.settlementSnapshots.push(JSON.parse(await readFile(journalPath, "utf8")));
  };
  const adapterFactory = ({ configPath }: { configPath?: string } = {}) => ({
    whoami: async () => ({ accountId }),
    d1List: async () => state.databasePresent ? [{ uuid: databaseId, name: stagingInventory.staging.databaseName }] : [],
    deploymentsList: async () => { await captureSettlement(); return state.deployments; },
    versionsList: async () => { await captureSettlement(); return state.versions; },
    secretList: async () => state.secretPresent ? [{ name: "LIVE_COMMAND_SECRET" }] : [],
    d1Execute: async (_name: string, { command }: { command: string }) => {
      if (command.includes("name='d1_migrations'")) return [{ success: true, results: [{ name: "d1_migrations" }] }];
      if (command.includes("FROM d1_migrations")) return [{ success: true, results: D1_MIGRATIONS.map(({ filename }) => ({ name: filename })) }];
      if (command.includes("SELECT type,name,sql FROM sqlite_schema")) return [{ success: true, results: schemaObjects }];
      if (command === "PRAGMA foreign_keys") return [{ success: true, results: [{ foreign_keys: 1 }] }];
      if (command === "PRAGMA foreign_key_check") return [{ success: true, results: [] }];
      if (command.includes("count(*) AS count FROM sqlite_schema")) return [{ success: true, results: [{ count: schemaObjects.length }] }];
      return [{ success: true, results: [] }];
    },
    deploy: async () => {
      const config = JSON.parse(await readFile(configPath!, "utf8"));
      if (config.env.staging.workers_dev) {
        state.activeDeployCalls += 1;
        if (options.activeDeployError) throw options.activeDeployError;
        state.active = true;
        state.activeDigest = config.env.staging.vars.WOODSHED_CONFIG_DIGEST;
        state.deployments.push(...newDeploymentIds.map((id) => ({ id, script_name: workerName })));
        return;
      }
      state.active = false;
      state.deployments.push({ id: "deployment-private-after-quarantine", script_name: workerName });
    },
  });
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectAccountSubdomain: async () => "synthetic",
    inspectWorkersDev: async () => ({ exists: true, enabled: state.active }),
  };
  const common = {
    root: testRoot, environment: "staging", inventoryPath, journalPath,
    runId: "run-enable-settlement", owner: "owner-enable-settlement",
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  };
  const timers = immediateRetryTimers();
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory,
    tokenClientFactory: () => tokenClient,
    fetch: async () => {
      state.captureSettlement = true;
      return state.active
        ? markerResponse({ ...expectedReleaseMarker, configDigest: state.activeDigest })
        : new Response(null, { status: 404 });
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  };
  await runLiveOperation({ ...common, operation: "plan" }, dependencies);
  const activeConfig = await generateEffectiveConfig({
    root: testRoot,
    runId: common.runId,
    inventory: stagingInventory,
    databaseId,
    sourceSha,
    workersDev: true,
  });
  state.activeDigest = activeConfig.configDigest;
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.phase = "worker-deployed";
  journal.identity.databaseId = databaseId;
  journal.recovery = { bookmark: "bookmark-synthetic" };
  journal.deploymentBaseline = [];
  journal.migrations = D1_MIGRATIONS.map(({ filename, sha256 }) => ({ filename, sha256, sourceSha, status: "applied" }));
  const migration009 = journal.migrations.find((item: any) => item.filename === "009_multiple_recovery_credentials.sql");
  migration009.postcondition = { migration009: {
    beforeRows: 0, afterRows: 0, beforeAssociations: 0, afterAssociations: 0,
    beforeAssociationDigest: "f".repeat(64), afterAssociationDigest: "f".repeat(64),
  } };
  const d1Resource = journal.resources.find((item: any) => item.domain === "d1");
  d1Resource.id = databaseId;
  d1Resource.status = "owned";
  for (const domain of ["worker", "durable-object", "secret"]) journal.resources.find((item: any) => item.domain === domain).status = "owned";
  journal.mutations.push(
    { kind: "d1-create", domain: "d1", id: databaseId, status: "applied", providerAcceptance: { id: databaseId } },
    { kind: "durable-object-create", domain: "durable-object", id: journal.resources.find((item: any) => item.domain === "durable-object").id, status: "applied" },
    { kind: "worker-deploy", status: "applied", sourceSha, deploymentId: "deployment-private" },
    { kind: "secret-put", domain: "secret", id: "LIVE_COMMAND_SECRET", status: "applied" },
  );
  if (options.pendingActivation) {
    journal.mutations.push({
      kind: "workers-dev-enable", domain: "route", id: journal.resources.find((item: any) => item.domain === "route").id,
      status: "pending", beforeDeploymentIds: ["deployment-private", "version-private"],
    });
  }
  state.databasePresent = true;
  state.secretPresent = true;
  state.active = options.pendingActivation === true;
  state.deployments = [
    { id: "deployment-private", script_name: workerName },
    ...(options.pendingActivation ? newDeploymentIds.map((id) => ({ id, script_name: workerName })) : []),
  ];
  state.versions = [{ id: "version-private", script_name: workerName }];
  await saveJournal(journalPath, journal);
  return { common, dependencies, journalPath, state };
}

test("a reconciled enable persists marker proof, deployment identity, applied intent, and alias-live together", async (t) => {
  const fixture = await activeEnableSettlementFixture(t, { pendingActivation: true });

  const result = await runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies);

  assert.equal(result.phase, "alias-live");
  assert.equal(fixture.state.activeDeployCalls, 0);
  assert.ok(fixture.state.settlementSnapshots.length >= 2);
  for (const snapshot of fixture.state.settlementSnapshots) {
    const intent = snapshot.mutations.find((item: any) => item.kind === "workers-dev-enable");
    assert.equal(snapshot.phase, "worker-deployed");
    assert.equal(intent.status, "pending");
    assert.equal(intent.markerProof, undefined);
    assert.equal(snapshot.deployment?.activeId, undefined);
  }
  const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const intent = saved.mutations.find((item: any) => item.kind === "workers-dev-enable");
  assert.equal(saved.phase, "alias-live");
  assert.equal(intent.status, "applied");
  assert.equal(intent.deploymentId, "deployment-active");
  assert.equal(saved.deployment.activeId, "deployment-active");
  assert.deepEqual(intent.markerProof, { ...expectedReleaseMarker, configDigest: fixture.state.activeDigest });
});

test("an ambiguous enable deployment identity refuses without applying the intent or reaching alias-live", async (t) => {
  const fixture = await activeEnableSettlementFixture(t, { activeDeploymentIds: ["deployment-active-a", "deployment-active-b"] });

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies),
    /deployment identity advance is ambiguous/,
  );

  assert.equal(fixture.state.activeDeployCalls, 1);
  const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const intent = saved.mutations.find((item: any) => item.kind === "workers-dev-enable");
  assert.notEqual(saved.phase, "alias-live");
  assert.equal(intent.status, "pending");
  assert.equal(intent.markerProof, undefined);
  assert.equal(intent.deploymentId, undefined);
  assert.equal(saved.deployment.activeId, undefined);
});

async function acceptancePhaseFixture(t: any, phase: "alias-live" | "quarantined") {
  const fixture = await postWriteTeardownFixture(t, phase === "alias-live" ? "alias-live" : "worker-deployed");
  const stagingInventory = inventory();
  const activeConfig = await generateEffectiveConfig({
    root: fixture.common.root,
    runId: fixture.common.runId,
    inventory: stagingInventory,
    databaseId,
    sourceSha,
    workersDev: true,
  });
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  journal.phase = phase;
  journal.config = { ...(journal.config ?? {}), activeDigest: activeConfig.configDigest };
  journal.schema = { digest: "e".repeat(64) };
  await saveJournal(fixture.journalPath, journal);
  const baseAdapter = fixture.dependencies.adapterFactory();
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  let acceptanceCalls = 0;
  let exposureReads = 0;
  const dependencies = {
    ...fixture.dependencies,
    adapterFactory: () => ({
      ...baseAdapter,
      d1TimeTravelInfo: async () => ({ bookmark: "bookmark-before-acceptance" }),
    }),
    tokenClientFactory: () => ({
      ...baseTokenClient,
      inspectWorkersDev: async () => ({ exists: true, enabled: exposureReads++ === 0 }),
    }),
    fetch: async () => markerResponse({ ...expectedReleaseMarker, configDigest: activeConfig.configDigest }),
    acceptance: async ({ journal: acceptanceJournal, plan, persistJournal }: any) => {
      acceptanceCalls += 1;
      acceptanceJournal.phase = "verified";
      acceptanceJournal.acceptance = { status: "passed", cleanupComplete: false, fixturePlan: plan };
      await persistJournal(acceptanceJournal);
      const evidence = createEvidenceEnvelope({
        runId: acceptanceJournal.runId,
        sourceSha: acceptanceJournal.sourceSha,
        phase: acceptanceJournal.phase,
        outcomes: { acceptance: true },
        counts: { fixtureRows: plan.rows.length },
      });
      acceptanceJournal.acceptanceEvidence = evidence;
      await persistJournal(acceptanceJournal);
      return evidence;
    },
  };
  const common = {
    ...fixture.common,
    processEnvironment: {
      ...fixture.common.processEnvironment,
      WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic",
    },
  };
  return { common, dependencies, acceptanceCalls: () => acceptanceCalls };
}

test("verify runs acceptance from alias-live and refuses quarantined with the existing phase message", async (t) => {
  const live = await acceptancePhaseFixture(t, "alias-live");
  await runLiveOperation({ ...live.common, operation: "verify" }, live.dependencies);
  assert.equal(live.acceptanceCalls(), 1);

  const quarantined = await acceptancePhaseFixture(t, "quarantined");
  await assert.rejects(
    runLiveOperation({ ...quarantined.common, operation: "verify" }, quarantined.dependencies),
    /active exact staging release is required before verification/,
  );
});

test("a quarantined journal has no verify path to acceptance", async (t) => {
  const fixture = await acceptancePhaseFixture(t, "quarantined");

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "verify" }, fixture.dependencies),
    /active exact staging release is required before verification/,
  );

  assert.equal(fixture.acceptanceCalls(), 0);
});

function inventory() {
  return {
    environment: "staging",
    expectedSourceSha: sourceSha,
    staging: { accountId, databaseId, databaseName: `${workerName}-db`, origin, workerName },
    forbidden: {
      accountIds: ["c".repeat(32)],
      databaseIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
      origins: ["https://protected.invalid"],
      workerNames: ["protected-worker"],
    },
  };
}

function schemaInspectionFixture(foreignKeyViolations: any[] = []) {
  const commands: string[] = [];
  const objects = [
    { type: "table", name: "events", sql: "CREATE TABLE events (id TEXT PRIMARY KEY)" },
    { type: "trigger", name: "event_choice_config_seed", sql: "CREATE TRIGGER event_choice_config_seed AFTER INSERT ON events BEGIN SELECT 1; END" },
  ];
  const adapter = {
    d1Execute: async (_databaseName: string, { command }: { command: string }) => {
      commands.push(command);
      if (command.includes("SELECT type,name,sql FROM sqlite_schema")) return [{ success: true, results: objects }];
      if (command === "PRAGMA foreign_keys") return [{ success: true, results: [{ foreign_keys: 1 }] }];
      if (command === "PRAGMA foreign_key_check") return [{ success: true, results: foreignKeyViolations }];
      throw new Error(`unexpected D1 command: ${command}`);
    },
  };
  const migration009 = {
    beforeRows: 2,
    afterRows: 2,
    beforeAssociations: 2,
    afterAssociations: 2,
    beforeAssociationDigest: "f".repeat(64),
    afterAssociationDigest: "f".repeat(64),
  };
  return { adapter, commands, migration009 };
}

async function failedApplyFixture(t: any, { quarantineFails = false } = {}) {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-incident-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-incident-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const freshInventory = inventory();
  delete (freshInventory.staging as Partial<typeof freshInventory.staging>).databaseId;
  await writeFile(inventoryPath, JSON.stringify(freshInventory));

  const databases: Array<{ uuid: string; name: string }> = [];
  const applyFailure = new Error("synthetic post-provision apply failure");
  let quarantineInspections = 0;
  const adapterFactory = () => ({
    whoami: async () => ({ accountId }),
    d1List: async () => databases,
    deploymentsList: async () => [],
    versionsList: async () => [],
    secretList: async () => [],
    d1Create: async (name: string) => { databases.push({ uuid: databaseId, name }); },
    d1TimeTravelInfo: async () => { throw applyFailure; },
  });
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectAccountSubdomain: async () => "synthetic",
    inspectWorkersDev: async () => {
      quarantineInspections += 1;
      if (quarantineFails) throw new Error("synthetic quarantine failure");
      return { exists: false, enabled: false };
    },
  };
  const common = {
    root: testRoot,
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: "run-incident",
    owner: "owner-incident",
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory,
    tokenClientFactory: () => tokenClient,
    fetch: async () => new Response(null, { status: 404 }),
  };
  await runLiveOperation({ ...common, operation: "plan" }, dependencies);
  return { applyFailure, common, dependencies, journalPath, quarantineInspections: () => quarantineInspections };
}

async function preWorkerTeardownFixture(t: any, durableCreateStatus: "pending" | "applied") {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-pre-worker-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-pre-worker-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  await writeFile(inventoryPath, JSON.stringify(stagingInventory));

  let databasePresent = true;
  let databaseDeletes = 0;
  const remoteWithoutTarget = { accountId, databases: [], workers: [], routes: [], deployments: [], versions: [] };
  const journal = createJournal({
    runId: `run-pre-worker-${durableCreateStatus}`,
    owner: "owner-pre-worker",
    sourceSha,
    identity: stagingInventory.staging,
  });
  journal.phase = "quarantined";
  const revision = createIdentityRevision(remoteWithoutTarget);
  journal.preflight = { protectedRevision: revision, targetRevision: revision, operatorTokenPresent: true };
  journal.lease = { active: true, runId: journal.runId, owner: journal.owner, revision };
  journal.acceptance = { status: "not-run", cleanupComplete: false };
  for (const [domain, id, status] of [
    ["route", "route-pre-worker", "planned"],
    ["hostname", "hostname-pre-worker", "planned"],
    ["credential", "credential-pre-worker", "planned"],
    ["secret", "secret-pre-worker", "planned"],
    ["worker", workerName, "planned"],
    ["durable-object", "durable-pre-worker", durableCreateStatus === "applied" ? "owned" : "planned"],
    ["d1", databaseId, "owned"],
  ] as const) journal.resources.push({ domain, id, status, runId: journal.runId, owner: journal.owner });
  journal.mutations.push(
    { kind: "d1-create", domain: "d1", id: databaseId, status: "applied", providerAcceptance: { id: databaseId } },
    { kind: "durable-object-create", domain: "durable-object", id: "durable-pre-worker", status: durableCreateStatus },
  );
  await saveJournal(journalPath, journal);

  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => databasePresent ? [{ uuid: databaseId, name: stagingInventory.staging.databaseName }] : [],
    deploymentsList: async () => [],
    versionsList: async () => [],
    secretList: async () => [],
    d1Delete: async () => { databaseDeletes += 1; databasePresent = false; },
  };
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectWorkersDev: async () => ({ exists: false, enabled: false }),
  };
  const common = {
    root: testRoot,
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: journal.runId,
    owner: journal.owner,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token" },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => tokenClient,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  };
  return { common, dependencies, journalPath, databasePresent: () => databasePresent, databaseDeletes: () => databaseDeletes };
}

async function postWriteTeardownFixture(
  t: any,
  phase: "resources-ready" | "bookmark-captured" | "schema-expanded" | "worker-deployed" | "alias-live" = "worker-deployed",
  deploymentPath: "new" | "reconciled" = "new",
) {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-post-write-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-post-write-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  await writeFile(inventoryPath, JSON.stringify(stagingInventory));

  const revision = createIdentityRevision({ accountId, databases: [], workers: [], routes: [], deployments: [], versions: [] });
  const journal = createJournal({
    runId: `run-post-write-${phase}`,
    owner: "owner-post-write",
    sourceSha,
    identity: stagingInventory.staging,
  });
  journal.phase = phase === "resources-ready" ? "resources-ready" : "bookmark-captured";
  journal.preflight = { protectedRevision: revision, targetRevision: revision, operatorTokenPresent: true };
  journal.lease = { active: true, runId: journal.runId, owner: journal.owner, revision };
  journal.acceptance = { status: "not-run", cleanupComplete: false };
  for (const [domain, id, status] of [
    ["route", "route-post-write", "planned"],
    ["hostname", "hostname-post-write", "planned"],
    ["credential", "credential-post-write", "planned"],
    ["secret", "secret-post-write", "planned"],
    ["worker", workerName, "planned"],
    ["durable-object", "durable-post-write", "planned"],
    ["d1", databaseId, "owned"],
  ] as const) journal.resources.push({ domain, id, status, runId: journal.runId, owner: journal.owner });
  journal.mutations.push(
    { kind: "d1-create", domain: "d1", id: databaseId, status: "applied", providerAcceptance: { id: databaseId } },
    { kind: "durable-object-create", domain: "durable-object", id: "durable-post-write", status: "pending" },
  );
  if (deploymentPath === "reconciled") journal.mutations.push({ kind: "worker-deploy", status: "pending", sourceSha });
  await saveJournal(journalPath, journal);

  const state = {
    databasePresent: true,
    workerPresent: deploymentPath === "reconciled",
    deploymentSequence: deploymentPath === "reconciled" ? 1 : 0,
    durableIntentPersistedBeforeDeploymentVerification: false,
  };
  if (!["resources-ready", "bookmark-captured"].includes(phase)) {
    const deploymentFailure = new Error("synthetic deployment stopped after schema expansion");
    const deployment = runMigrationFirstDeployment({
      journal,
      lease: journal.lease,
      manifest: [],
      expectedSnapshot: { revision },
      inspectSnapshot: async () => ({ revision }),
      inspectLedger: async () => [],
      persistJournal: (value: any) => {
        const workerIntent = value.mutations.find((item: any) => item.kind === "worker-deploy");
        const durableIntent = value.mutations.find((item: any) => item.kind === "durable-object-create");
        if (workerIntent?.status === "pending" && durableIntent?.status === "applied") {
          state.durableIntentPersistedBeforeDeploymentVerification = true;
        }
        if (workerIntent?.status === "applied") {
          assert.equal(durableIntent?.status, "applied");
        }
        return saveJournal(journalPath, value);
      },
      applyMigration: async () => {},
      verifyMigration: async () => true,
      verifyFinalSchema: async () => {
        journal.phase = "schema-expanded";
        await saveJournal(journalPath, journal);
      },
      deployWorker: async () => {
        if (phase === "schema-expanded") throw deploymentFailure;
        state.workerPresent = true;
        state.deploymentSequence += 1;
        return { deploymentId: `deployment-post-write-${state.deploymentSequence}` };
      },
      inspectDeployment: async () => state.workerPresent
        ? { deploymentId: `deployment-post-write-${state.deploymentSequence}` }
        : undefined,
      verifyDeployment: async () => {
        assert.equal(state.durableIntentPersistedBeforeDeploymentVerification, true);
      },
    });
    if (phase === "schema-expanded") await assert.rejects(deployment, /deployment outcome is uncertain; no replay authorized/);
    else {
      await deployment;
      if (phase === "alias-live") {
        journal.phase = "alias-live";
        await saveJournal(journalPath, journal);
      }
    }
  }

  const deployments = () => state.workerPresent
    ? [{ id: `deployment-post-write-${state.deploymentSequence}`, script_name: workerName }]
    : [];
  const versions = () => state.workerPresent
    ? [{ id: `version-post-write-${state.deploymentSequence}`, script_name: workerName }]
    : [];
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => state.databasePresent ? [{ uuid: databaseId, name: stagingInventory.staging.databaseName }] : [],
    deploymentsList: async () => deployments(),
    versionsList: async () => versions(),
    secretList: async () => [],
    d1Execute: async () => [{ success: true, results: [{ count: 0 }] }],
    deploy: async () => { state.workerPresent = true; state.deploymentSequence += 1; },
    deleteWorker: async () => { state.workerPresent = false; },
    d1Delete: async () => { state.databasePresent = false; },
  };
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => state.workerPresent ? [{ name: workerName }] : [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectWorkersDev: async () => ({ exists: state.workerPresent, enabled: false }),
  };
  const common = {
    root: testRoot,
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: journal.runId,
    owner: journal.owner,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token" },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => tokenClient,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  };
  return {
    common,
    dependencies,
    journal,
    journalPath,
    revision,
    state,
    removeWorker: () => { state.workerPresent = false; },
  };
}

type ExposureTeardownOptions = {
  accountWorkerPresent?: boolean;
  deleteOutcome?: "absent" | "absent-throw" | "present-throw";
  exposureResults?: readonly ("absent" | "present" | "rate-limited")[];
  wranglerWorkerPresent?: boolean;
};

async function rateLimitedTeardownFixture(
  t: any,
  phase: "resources-ready" | "bookmark-captured" | "worker-deployed" = "worker-deployed",
  {
    accountWorkerPresent,
    deleteOutcome = "absent",
    exposureResults = ["rate-limited"],
    wranglerWorkerPresent = true,
  }: ExposureTeardownOptions = {},
) {
  const fixture = await postWriteTeardownFixture(t, phase);
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  const timers = immediateRetryTimers();
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const ownedLaterResourcesPresent = phase === "worker-deployed";
  if (ownedLaterResourcesPresent) {
    journal.acceptance = {
      status: "not-run",
      cleanupComplete: false,
      fixturePlan: createSyntheticFixturePlan({
        runId: journal.runId,
        organizerToken: "organizer-synthetic",
        preFixtureBookmark: "bookmark-synthetic",
      }),
    };
  }
  await saveJournal(fixture.journalPath, journal);

  let accountPresent = accountWorkerPresent ?? fixture.state.workerPresent;
  let credentialPresent = ownedLaterResourcesPresent;
  let secretPresent = ownedLaterResourcesPresent;
  let deployCalls = 0;
  let workerDeleteCalls = 0;
  let exposureReads = 0;
  let accountWorkerReads = 0;
  const removalCalls: string[] = [];
  const scriptReadSnapshots: Array<{ afterWorkerDelete: boolean; workerPresent: boolean; routeIntentStatus?: string; routeAbsence?: boolean }> = [];
  const exposureClient = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    fetch: async () => {
      const result = exposureResults[Math.min(exposureReads, exposureResults.length - 1)] ?? "rate-limited";
      exposureReads += 1;
      if (result === "rate-limited") return new Response(null, { status: 429 });
      return Response.json({ success: true, result: { enabled: result === "present", previews_enabled: false } });
    },
  });
  const dependencies = {
    ...fixture.dependencies,
    adapterFactory: (adapterOptions: any = {}) => {
      const baseAdapter = fixture.dependencies.adapterFactory();
      return {
        ...baseAdapter,
        deploymentsList: async () => wranglerWorkerPresent ? baseAdapter.deploymentsList() : [],
        versionsList: async () => wranglerWorkerPresent ? baseAdapter.versionsList() : [],
        secretList: async () => secretPresent ? [{ name: "LIVE_COMMAND_SECRET" }] : [],
        d1Execute: async (_name: string, options: { command?: string; file?: string }) => {
          if (options.file?.endsWith("revoke-organizer.sql")) {
            credentialPresent = false;
            removalCalls.push("credential");
            return [{ success: true, results: [] }];
          }
          if (options.command?.includes("participant_sessions")) return [{ success: true, results: [{ count: credentialPresent ? 1 : 0 }] }];
          return baseAdapter.d1Execute();
        },
        deploy: async () => {
          deployCalls += 1;
          const config = JSON.parse(await readFile(adapterOptions.configPath, "utf8"));
          const deletingDurableObject = config.env.staging.migrations.some((item: any) => Array.isArray(item.deleted_classes));
          removalCalls.push(deletingDurableObject ? "durable-object" : "route");
          accountPresent = true;
          await baseAdapter.deploy();
        },
        secretDelete: async () => {
          secretPresent = false;
          removalCalls.push("secret");
        },
        deleteWorker: async () => {
          workerDeleteCalls += 1;
          removalCalls.push("worker");
          if (deleteOutcome === "present-throw") throw new Error("synthetic Worker delete response lost while Worker remained present");
          accountPresent = false;
          await baseAdapter.deleteWorker();
          if (deleteOutcome === "absent-throw") throw new Error("synthetic Worker delete response lost after deletion");
        },
        d1Delete: async () => {
          removalCalls.push("d1");
          return baseAdapter.d1Delete();
        },
      };
    },
    tokenClientFactory: () => ({
      ...baseTokenClient,
      listWorkerScripts: async () => {
        accountWorkerReads += 1;
        const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
        scriptReadSnapshots.push({
          afterWorkerDelete: workerDeleteCalls > 0,
          workerPresent: accountPresent,
          routeIntentStatus: saved.mutations.find((item: any) => item.kind === "teardown-route")?.status,
          routeAbsence: saved.teardown?.absence?.["route:route-post-write"],
        });
        return accountPresent ? [{ name: workerName }] : [];
      },
      inspectWorkersDev: exposureClient.inspectWorkersDev,
    }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };
  return {
    ...fixture,
    dependencies,
    deployCalls: () => deployCalls,
    workerDeleteCalls: () => workerDeleteCalls,
    exposureReads: () => exposureReads,
    accountWorkerReads: () => accountWorkerReads,
    removalCalls,
    scriptReadSnapshots,
  };
}

type PendingDeployTeardownOptions = {
  deploymentBaseline?: readonly string[];
  recordDeploymentBaseline?: boolean;
  deploymentIds?: readonly string[];
  versionIds?: readonly string[];
  intentSourceSha?: string;
};

async function pendingDeployTeardownFixture(t: any, {
  deploymentBaseline = [],
  recordDeploymentBaseline = true,
  deploymentIds = ["deployment-lost-response"],
  versionIds = ["version-lost-response"],
  intentSourceSha = sourceSha,
}: PendingDeployTeardownOptions = {}) {
  const fixture = await postWriteTeardownFixture(t, "schema-expanded");
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const workerIntent = journal.mutations.find((item: any) => item.kind === "worker-deploy");
  const durableIntent = journal.mutations.find((item: any) => item.kind === "durable-object-create");
  assert.equal(journal.phase, "schema-expanded");
  assert.equal(workerIntent?.status, "pending");
  assert.equal(durableIntent?.status, "pending");
  workerIntent.sourceSha = intentSourceSha;
  if (recordDeploymentBaseline) journal.deploymentBaseline = [...deploymentBaseline];
  else delete journal.deploymentBaseline;
  await saveJournal(fixture.journalPath, journal);

  const remote = {
    present: deploymentIds.length > 0 || versionIds.length > 0,
    deployments: deploymentIds.map((id) => ({ id, script_name: workerName })),
    versions: versionIds.map((id) => ({ id, script_name: workerName })),
    removalSequence: 0,
  };
  const mutationCalls: string[] = [];
  const readEvents: string[] = [];
  let workersDevReads = 0;
  let journalAtFirstMutation: any;
  let journalAtFirstWorkersDevRead: any;
  const captureFirstMutation = async (name: string) => {
    mutationCalls.push(name);
    journalAtFirstMutation ??= JSON.parse(await readFile(fixture.journalPath, "utf8"));
  };
  const baseAdapter = fixture.dependencies.adapterFactory();
  const adapterFactory = () => ({
    ...baseAdapter,
    deploymentsList: async () => {
      readEvents.push("deployments");
      return remote.present ? remote.deployments : [];
    },
    versionsList: async () => {
      readEvents.push("versions");
      return remote.present ? remote.versions : [];
    },
    deploy: async (name: string) => {
      await captureFirstMutation("deploy");
      remote.present = true;
      remote.removalSequence += 1;
      remote.deployments = [...remote.deployments, { id: `deployment-removal-${remote.removalSequence}`, script_name: workerName }];
      remote.versions = [...remote.versions, { id: `version-removal-${remote.removalSequence}`, script_name: workerName }];
      await baseAdapter.deploy();
    },
    deleteWorker: async (name: string) => {
      await captureFirstMutation("worker-delete");
      remote.present = false;
      await baseAdapter.deleteWorker();
    },
    d1Delete: async (name: string) => {
      await captureFirstMutation("d1-delete");
      await baseAdapter.d1Delete();
    },
  });
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  const tokenClientFactory = () => ({
    ...baseTokenClient,
    listWorkerScripts: async () => remote.present ? [{ name: workerName }] : [],
    inspectWorkersDev: async () => {
      readEvents.push("workers-dev");
      workersDevReads += 1;
      journalAtFirstWorkersDevRead ??= JSON.parse(await readFile(fixture.journalPath, "utf8"));
      return { exists: remote.present, enabled: false };
    },
  });

  return {
    ...fixture,
    dependencies: { ...fixture.dependencies, adapterFactory, tokenClientFactory },
    mutationCalls,
    readEvents,
    workersDevReads: () => workersDevReads,
    journalAtFirstMutation: () => journalAtFirstMutation,
    journalAtFirstWorkersDevRead: () => journalAtFirstWorkersDevRead,
  };
}

function directTeardownOptions(journal: any, revision: string) {
  return {
    journal,
    lease: journal.lease,
    expectedRevision: revision,
    inspectRevision: async () => revision,
    listDependents: async () => [],
    inspectResource: async () => ({ exists: false, runId: journal.runId, owner: journal.owner }),
    removeResource: async () => {},
    verifyTokenInactive: async () => true,
  };
}

async function d1ReconciliationFixture(t: any, intentStatus?: "pending" | "applied", {
  providerAcceptanceId = databaseId,
  remoteDatabaseId = databaseId,
  responseLoss = false,
} = {}) {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-d1-reconcile-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-d1-reconcile-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const freshInventory = inventory();
  delete (freshInventory.staging as Partial<typeof freshInventory.staging>).databaseId;
  await writeFile(inventoryPath, JSON.stringify(freshInventory));

  const state = {
    databases: [] as Array<{ uuid: string; name: string }>,
    mutationCalls: [] as string[],
    timeTravelReads: 0,
  };
  const acceptedReplayStop = new Error("accepted D1 replay reached the next apply boundary");
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => state.databases,
    deploymentsList: async () => [],
    versionsList: async () => [],
    secretList: async () => [],
    d1Create: async (name: string) => {
      state.mutationCalls.push("d1-create");
      if (responseLoss) {
        state.databases = [{ uuid: remoteDatabaseId, name }];
        throw new Error("synthetic D1 create response loss");
      }
    },
    d1MigrationsApply: async () => { state.mutationCalls.push("d1-migrate"); },
    d1Execute: async () => { state.mutationCalls.push("d1-seed"); return []; },
    d1Delete: async () => { state.mutationCalls.push("d1-delete"); },
    deploy: async () => { state.mutationCalls.push("deploy"); },
    secretPut: async () => { state.mutationCalls.push("secret-put"); },
    secretDelete: async () => { state.mutationCalls.push("secret-delete"); },
    deleteWorker: async () => { state.mutationCalls.push("worker-delete"); },
    d1TimeTravelInfo: async () => { state.timeTravelReads += 1; throw acceptedReplayStop; },
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
    runId: `run-d1-${intentStatus ?? "response-loss"}`,
    owner: "owner-d1-reconcile",
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
  if (intentStatus) {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const d1Resource = journal.resources.find((item: any) => item.domain === "d1");
    journal.mutations.push({
      kind: "d1-create",
      domain: "d1",
      id: d1Resource.id,
      status: intentStatus,
      ...(intentStatus === "applied" ? { providerAcceptance: { id: providerAcceptanceId } } : {}),
    });
    await saveJournal(journalPath, journal);
    state.databases = [{ uuid: remoteDatabaseId, name: freshInventory.staging.databaseName }];
  }
  return { acceptedReplayStop, common, dependencies, freshInventory, journalPath, state };
}

test("live CLI requires the explicit staging environment and closed flag set", () => {
  const parsed = parseLiveArguments([
    "apply", "--env", "staging", "--inventory", "/private/inventory.json",
    "--journal", "/private/journal.json", "--run-id", "run-a", "--owner", "owner-a",
  ]);
  assert.equal(parsed.operation, "apply");
  assert.equal(parsed.environment, "staging");
  assert.throws(() => parseLiveArguments(["apply", "--env", "default"]), /explicit staging environment/);
  assert.throws(() => parseLiveArguments(["apply", "--env", "staging", "--unknown", "value"]), /unknown option/);
  assert.throws(() => parseLiveArguments(["preflight", "--env", "staging", "--allow-protected", "true"]), /unknown option/);
  assert.throws(() => parseLiveArguments(["promote", "--env", "staging"]), /unknown staging operation/);
});

test("the executable boundary emits neither configured secrets nor private identifiers", () => {
  const token = "synthetic-cloud-token-private";
  const liveSecret = "s".repeat(40);
  const message = publicErrorMessage(new Error(`failed ${token} ${liveSecret}`), { CLOUDFLARE_API_TOKEN: token, LIVE_COMMAND_SECRET: liveSecret });
  assert.doesNotMatch(message, new RegExp(`${token}|${liveSecret}|${accountId}|${databaseId}|${workerName}`));
  assert.match(message, /\[REDACTED\]/);
});

test("effective config is run-isolated, explicit, content-attested, and supports a unique deletion lifecycle", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "woodshed-live-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = await generateEffectiveConfig({ root, runId: "run-a", inventory: inventory(), databaseId, sourceSha, workersDev: true });
  const parsed = JSON.parse(await readFile(active.configPath, "utf8"));
  assert.equal(parsed.env.staging.name, workerName);
  assert.equal(parsed.env.staging.workers_dev, true);
  assert.equal(parsed.env.staging.preview_urls, false);
  assert.equal(parsed.env.staging.vars.WOODSHED_SOURCE_SHA, sourceSha);
  assert.equal(parsed.env.staging.vars.WOODSHED_CONFIG_DIGEST, active.configDigest);
  assert.match(active.configPath, /\.cloudflare-staging/);
  assert.match(active.configDigest, /^[a-f0-9]{64}$/);

  const privateDeployment = await generateEffectiveConfig({ root, runId: "run-a", inventory: inventory(), databaseId, sourceSha, workersDev: false });
  const privateConfig = JSON.parse(await readFile(privateDeployment.configPath, "utf8"));
  assert.equal(privateConfig.env.staging.workers_dev, false);
  assert.equal(privateConfig.env.staging.preview_urls, false);

  const deletion = await generateEffectiveConfig({ root, runId: "run-a", inventory: inventory(), databaseId, sourceSha, workersDev: false, deleteDurableObject: true });
  const deletionConfig = JSON.parse(await readFile(deletion.configPath, "utf8"));
  assert.match(deletion.deletionTag ?? "", /^woodshed-staging-delete-[a-f0-9]{16}$/);
  assert.deepEqual(deletionConfig.env.staging.migrations.at(-1).deleted_classes, ["LiveCoordinator"]);
  assert.notEqual(deletion.deletionTag, deletionConfig.env.staging.migrations[0].tag);
  assert.equal(deletionConfig.main, "./teardown-worker.mjs");
  assert.doesNotMatch(await readFile(path.join(path.dirname(deletion.configPath), "teardown-worker.mjs"), "utf8"), /LiveCoordinator/);
});

test("authenticated collectors compose every preflight inventory surface", async () => {
  const calls: string[] = [];
  const adapter = {
    whoami: async () => { calls.push("whoami"); return { accountId }; },
    d1List: async () => { calls.push("d1-list"); return [{ uuid: databaseId, name: "neutral-staging-db" }]; },
    deploymentsList: async () => { calls.push("deployments-list"); return [{ id: "deployment-synthetic", script_name: "neutral-staging-worker", routes: [] }]; },
    versionsList: async () => { calls.push("versions-list"); return [{ id: "version-synthetic", script_name: "neutral-staging-worker" }]; },
    secretList: async () => { calls.push("secret-list"); return [{ name: "SAFE_NAME" }]; },
  };
  const remote = await collectRemoteInventory({ adapter, inventory: inventory() });
  assert.deepEqual(calls.sort(), ["d1-list", "deployments-list", "secret-list", "versions-list", "whoami"]);
  assert.equal(remote.accountId, accountId);
  assert.deepEqual(remote.databases, [{ id: databaseId, name: "neutral-staging-db" }]);
  assert.deepEqual(remote.secretNames, ["SAFE_NAME"]);
  assert.deepEqual(remote.workers, [{ name: "neutral-staging-worker" }]);
  assert.deepEqual(remote.routes, []);
});

test("identity revisions are stable across provider ordering and duplicate entries", () => {
  const first = {
    accountId,
    databases: [{ id: "2", name: "staging-b" }, { id: "1", name: "staging-a" }],
    workers: [{ name: "staging-b" }, { name: "staging-a" }],
    routes: [{ pattern: "b/*", script: "staging-b" }, { pattern: "a/*", script: "staging-a" }],
  };
  const second = {
    accountId,
    databases: [first.databases[1], first.databases[0], first.databases[1]],
    workers: [first.workers[1], first.workers[0]],
    routes: [first.routes[1], first.routes[0], first.routes[1]],
  };
  assert.equal(createIdentityRevision(first), createIdentityRevision(second));
});

test("remote schema inspection omits unsupported D1 integrity checks", async () => {
  const fixture = schemaInspectionFixture();
  const actual = await remoteSchema(fixture.adapter, `${workerName}-db`, fixture.migration009);

  assert.deepEqual(fixture.commands, [
    "SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name",
    "PRAGMA foreign_keys",
    "PRAGMA foreign_key_check",
  ]);
  assert.equal(actual.integrity, "unsupported-on-d1");
});

test("successful schema verification records D1 integrity as unavailable", async () => {
  const fixture = schemaInspectionFixture();
  const actual = await remoteSchema(fixture.adapter, `${workerName}-db`, fixture.migration009);
  const expected = {
    tables: actual.tables,
    indexes: actual.indexes,
    triggers: actual.triggers,
    constraints: actual.constraints,
    definitionDigest: actual.definitionDigest,
  };
  const journal: any = {};

  recordVerifiedSchemaEvidence(journal, actual, expected);

  assert.match(journal.schema.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...journal.schema, digest: undefined }, {
    digest: undefined,
    foreignKeysEnabled: true,
    foreignKeyViolations: 0,
    integrity: "unsupported-on-d1",
  });
});

test("schema verification still rejects foreign-key violations", async () => {
  const fixture = schemaInspectionFixture([{ table: "event_participants", rowid: 1, parent: "events", fkid: 0 }]);
  const actual = await remoteSchema(fixture.adapter, `${workerName}-db`, fixture.migration009);
  const expected = {
    tables: actual.tables,
    indexes: actual.indexes,
    triggers: actual.triggers,
    constraints: actual.constraints,
    definitionDigest: actual.definitionDigest,
  };

  assert.throws(() => recordVerifiedSchemaEvidence({}, actual, expected), /foreign key verification failed/);
});

test("journaled mutation persists intent before write, aborts drift, and reconciles response loss", async () => {
  const identity = inventory().staging;
  const journal = createJournal({ runId: "run-a", owner: "owner-a", sourceSha, identity });
  const calls: string[] = [];
  let exists = false;
  const result = await executeJournaledMutation({
    journal,
    expectedRevision: "revision-a",
    inspectRevision: async () => { calls.push("identity-read"); return "revision-a"; },
    resource: { domain: "worker", id: workerName },
    kind: "worker-create",
    persistJournal: async () => { calls.push("persist"); },
    inspect: async () => { calls.push("inspect"); return { exists, id: workerName }; },
    mutate: async () => { calls.push("mutate"); exists = true; throw new Error("response lost"); },
    owns: (state) => state.id === workerName,
  });
  assert.deepEqual(calls, ["identity-read", "persist", "inspect", "identity-read", "mutate", "inspect", "persist"]);
  assert.equal(result.reconciled, true);
  assert.equal(journal.mutations[0]?.status, "applied");
  assert.equal(journal.resources[0]?.domain, "worker");

  let mutations = 0;
  await assert.rejects(executeJournaledMutation({
    journal: createJournal({ runId: "run-b", owner: "owner-a", sourceSha, identity }),
    expectedRevision: "revision-a",
    inspectRevision: async () => "revision-b",
    resource: { domain: "d1", id: "planned-database" }, kind: "d1-create",
    persistJournal: async () => {}, inspect: async () => ({ exists: false }),
    mutate: async () => { mutations += 1; }, owns: () => false,
  }), /remote identity changed/);
  assert.equal(mutations, 0);

  const uncertain = createJournal({ runId: "run-c", owner: "owner-a", sourceSha, identity });
  uncertain.resources.push({ domain: "secret", id: "LIVE_COMMAND_SECRET", runId: uncertain.runId, owner: uncertain.owner });
  uncertain.mutations.push({ kind: "secret-put", domain: "secret", id: "LIVE_COMMAND_SECRET", status: "pending" });
  await assert.rejects(executeJournaledMutation({
    journal: uncertain, expectedRevision: "revision-a", inspectRevision: async () => "revision-a",
    resource: { domain: "secret", id: "LIVE_COMMAND_SECRET" }, kind: "secret-put",
    persistJournal: async () => {}, inspect: async () => ({ exists: false }),
    mutate: async () => { mutations += 1; }, owns: () => true,
  }), /no replay authorized/);
  assert.equal(mutations, 0);
});

test("pending d1-create refuses a pre-existing same-named database without adopting or mutating it", async (t) => {
  const fixture = await d1ReconciliationFixture(t, "pending");
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error: any) => {
    assert.equal(error.message, `a database named ${fixture.freshInventory.staging.databaseName} already exists; tear down the pending run before retrying`);
    assert.doesNotMatch(error.message, new RegExp(`${accountId}|${databaseId}`));
    return true;
  });

  assert.equal(fixture.state.mutationCalls.length, 0);
  assert.equal(fixture.state.timeTravelReads, 0);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const d1Resource = journal.resources.find((item: any) => item.domain === "d1");
  assert.equal(journal.identity.databaseId, undefined);
  assert.equal(d1Resource.status, "planned");
  assert.match(d1Resource.id, /^planned-/);
  assert.equal(journal.mutations.find((item: any) => item.kind === "d1-create").status, "pending");
  assert.deepEqual(journal.incident, {
    kind: "d1-create-refused",
    failedPhase: "pre-write",
    owner: "owner-d1-reconcile",
    nextAction: "tear-down-pending-run-before-retrying",
    wholeStackRollback: false,
  });
});

test("applied d1-create with persisted provider acceptance reconciles the exact database", async (t) => {
  const fixture = await d1ReconciliationFixture(t, "applied");
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error) => error === fixture.acceptedReplayStop);

  assert.equal(fixture.state.mutationCalls.length, 0);
  assert.equal(fixture.state.timeTravelReads, 1);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.identity.databaseId, databaseId);
  assert.equal(journal.mutations.find((item: any) => item.kind === "d1-create").status, "applied");
  assert.equal(journal.resources.find((item: any) => item.domain === "d1").id, databaseId);
  assert.equal(journal.resources.find((item: any) => item.domain === "d1").status, "owned");
});

test("applied d1-create refuses a same-named database with a mismatched provider acceptance", async (t) => {
  const acceptedDatabaseId = "22222222-3333-4444-8555-666666666666";
  const fixture = await d1ReconciliationFixture(t, "applied", { providerAcceptanceId: acceptedDatabaseId });
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), /existing resource is not owned by this run/);

  assert.deepEqual(fixture.state.mutationCalls, []);
  assert.equal(fixture.state.timeTravelReads, 0);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const d1Resource = journal.resources.find((item: any) => item.domain === "d1");
  const d1Intent = journal.mutations.find((item: any) => item.kind === "d1-create");
  assert.equal(journal.identity.databaseId, undefined);
  assert.equal(d1Resource.status, "planned");
  assert.match(d1Resource.id, /^planned-/);
  assert.equal(d1Intent.status, "applied");
  assert.equal(d1Intent.providerAcceptance.id, acceptedDatabaseId);
});

test("d1-create response loss refuses the newly visible database without accepting ownership", async (t) => {
  const fixture = await d1ReconciliationFixture(t, undefined, { responseLoss: true });
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error: any) => {
    assert.equal(error.message, `a database named ${fixture.freshInventory.staging.databaseName} already exists; tear down the pending run before retrying`);
    return true;
  });

  assert.deepEqual(fixture.state.mutationCalls, ["d1-create"]);
  assert.equal(fixture.state.timeTravelReads, 0);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const d1Resource = journal.resources.find((item: any) => item.domain === "d1");
  const d1Intent = journal.mutations.find((item: any) => item.kind === "d1-create");
  assert.equal(journal.identity.databaseId, undefined);
  assert.equal(d1Resource.status, "planned");
  assert.match(d1Resource.id, /^planned-/);
  assert.equal(d1Intent.status, "pending");
  assert.equal(d1Intent.providerAcceptance, undefined);
  assert.equal(journal.incident.kind, "d1-create-refused");
});

test("teardown of a refused d1-create run preserves the foreign database", async (t) => {
  const fixture = await d1ReconciliationFixture(t, "pending");
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), /tear down the pending run before retrying/);

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);
  assert.equal(result.cleanupComplete, true);
  assert.equal(fixture.state.mutationCalls.length, 0);
  assert.deepEqual(fixture.state.databases, [{ uuid: databaseId, name: fixture.freshInventory.staging.databaseName }]);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.phase, "cleanup-complete");
  assert.equal(journal.teardown.refusedD1Create, true);

  const delayed = await runLiveOperation({ ...fixture.common, operation: "absence-check" }, fixture.dependencies);
  assert.deepEqual(delayed, { operation: "absence-check", phase: "cleanup-complete", absenceCount: 0, passed: true });
  assert.equal(fixture.state.mutationCalls.length, 0);
  assert.deepEqual(fixture.state.databases, [{ uuid: databaseId, name: fixture.freshInventory.staging.databaseName }]);
  const auditedJournal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.deepEqual(auditedJournal.absenceChecks.at(-1), {
    checkedAt: "2030-01-01T12:00:00.000Z",
    domains: 0,
    passed: true,
    refusedD1Create: true,
  });
});

test("teardown removes D1 when the Durable Object creation never applied", async (t) => {
  const fixture = await preWorkerTeardownFixture(t, "pending");

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  assert.equal(fixture.databaseDeletes(), 1);
  assert.equal(fixture.databasePresent(), false);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.phase, "cleanup-complete");
  assert.equal(journal.teardown.absence["durable-object:durable-pre-worker"], true);
  assert.equal(journal.teardown.absence[`d1:${databaseId}`], true);
});

test("teardown requires deleted_classes proof after Durable Object creation applied", async (t) => {
  const fixture = await preWorkerTeardownFixture(t, "applied");

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies),
    /Durable Object absence is unproven without the deleted_classes lifecycle/,
  );
  assert.equal(fixture.databaseDeletes(), 0);
  assert.equal(fixture.databasePresent(), true);
});

test("a genuine worker-deployed journal passes both teardown gates and cleanup replays idempotently", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  const deployedJournal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(deployedJournal.phase, "worker-deployed");

  const direct = await runStackTeardown(directTeardownOptions(structuredClone(deployedJournal), fixture.revision));
  assert.equal(direct.complete, true);
  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "absence-check" }, fixture.dependencies),
    (error: any) => error?.message === "completed teardown journal is required",
  );

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);
  assert.equal(result.cleanupComplete, true);
  assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "cleanup-complete");
  assert.equal((await runLiveOperation({ ...fixture.common, operation: "teardown", processEnvironment: {} }, fixture.dependencies)).cleanupComplete, true);
});

test("worker-deployed teardown still requires an active ownership lease", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  const journal = structuredClone(fixture.journal);
  journal.lease!.active = false;

  await assert.rejects(
    runStackTeardown(directTeardownOptions(journal, fixture.revision)),
    (error: any) => error?.message === "active ownership lease is required",
  );
});

test("worker-deployed teardown still refuses a changed identity revision", async (t) => {
  const fixture = await postWriteTeardownFixture(t);

  await assert.rejects(
    runStackTeardown({ ...directTeardownOptions(structuredClone(fixture.journal), fixture.revision), inspectRevision: async () => "changed" }),
    (error: any) => error?.message === "last-write identity changed",
  );
});

test("worker-deployed teardown still refuses resource ownership by another run or owner", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  const wrongRun = structuredClone(fixture.journal);
  wrongRun.resources[0]!.runId = "another-run";
  const wrongOwner = structuredClone(fixture.journal);
  wrongOwner.resources[0]!.owner = "another-owner";

  for (const journal of [wrongRun, wrongOwner]) {
    await assert.rejects(
      runStackTeardown(directTeardownOptions(journal, fixture.revision)),
      (error: any) => error?.message === "journal resource identity mismatch",
    );
  }
});

test("worker-deployed teardown still requires every resource domain authority", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  const journal = structuredClone(fixture.journal);
  journal.resources = journal.resources.filter((resource: any) => resource.domain !== "credential");

  await assert.rejects(
    runStackTeardown(directTeardownOptions(journal, fixture.revision)),
    (error: any) => error?.message === "missing credential teardown authority",
  );
});

test("teardown completes from schema-expanded", async (t) => {
  const fixture = await postWriteTeardownFixture(t, "schema-expanded");
  assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "schema-expanded");

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "cleanup-complete");
});

test("teardown completes from bookmark-captured", async (t) => {
  const fixture = await postWriteTeardownFixture(t, "bookmark-captured");
  assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "bookmark-captured");

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "cleanup-complete");
});

for (const phase of ["bookmark-captured", "resources-ready"] as const) {
  test(`workerless teardown from ${phase} skips workers.dev and never deploys`, async (t) => {
    const fixture = await rateLimitedTeardownFixture(t, phase);
    let result: Awaited<ReturnType<typeof runLiveOperation>> | undefined;
    let operationError: unknown;

    try {
      result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);
    } catch (error) {
      operationError = error;
    }

    assert.equal(fixture.deployCalls(), 0, operationError instanceof Error ? operationError.message : "teardown must not deploy");
    assert.equal(operationError, undefined);
    assert.equal(result?.cleanupComplete, true);
    assert.equal(fixture.exposureReads(), 0);
    const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(journal.phase, "cleanup-complete");
    assert.equal(journal.teardown.absence["route:route-post-write"], true);
  });
}

test("an unconfirmable route defers only until authenticated Worker absence", async (t) => {
  const fixture = await rateLimitedTeardownFixture(t);

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  assert.equal(fixture.removalCalls.filter((call) => call === "route").length, 1, "the private route config deploys exactly once");
  assert.equal(fixture.exposureReads(), 1, "the deferred route is not re-probed as a Worker dependent");
  assert.equal(fixture.workerDeleteCalls(), 1);
  assert.deepEqual(fixture.removalCalls, ["route", "credential", "secret", "durable-object", "worker", "d1"]);
  const postDeleteProof = fixture.scriptReadSnapshots.find((snapshot) => snapshot.afterWorkerDelete && !snapshot.workerPresent);
  assert.ok(postDeleteProof, "authenticated account-wide script listing must prove post-delete Worker absence");
  assert.equal(postDeleteProof.routeIntentStatus, "pending");
  assert.equal(postDeleteProof.routeAbsence, undefined, "the private config deploy must not record route absence");
  const completed = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(completed.teardown.absence["route:route-post-write"], true);
  assert.equal(completed.teardown.routeAbsenceProofMethods["route:route-post-write"], "owning-worker-deletion");
  assert.equal(completed.teardown.absence[`worker:${workerName}`], true);
  assert.equal(completed.mutations.find((item: any) => item.kind === "teardown-route")?.status, "applied");
  const packet = JSON.parse(await readFile(`${fixture.journalPath}.evidence.json`, "utf8"));
  assert.equal(packet.absence.route.proofMethod, "owning-worker-deletion");
  assert.doesNotMatch(JSON.stringify(packet), /route-post-write/);
});

test("a route absence proved by its provider read records provider-read without sharing its identifier", async (t) => {
  const fixture = await postWriteTeardownFixture(t);

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.teardown.routeAbsenceProofMethods["route:route-post-write"], "provider-read");
  const packet = JSON.parse(await readFile(`${fixture.journalPath}.evidence.json`, "utf8"));
  assert.equal(packet.absence.route.proofMethod, "provider-read");
  assert.doesNotMatch(JSON.stringify(packet), /route-post-write/);
});

test("delayed absence keeps one independent workers.dev read and accepts a rate-limited answer", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  let workersDevReads = 0;
  const exposureClient = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    fetch: async () => {
      workersDevReads += 1;
      return new Response(null, { status: 429 });
    },
  });

  const delayed = await runLiveOperation({ ...fixture.common, operation: "absence-check" }, {
    ...fixture.dependencies,
    tokenClientFactory: () => ({ ...baseTokenClient, inspectWorkersDev: exposureClient.inspectWorkersDev }),
  });

  assert.equal(delayed.passed, true);
  assert.equal(workersDevReads, 1);
});

test("delayed absence fails when the independently observed workers.dev origin is enabled", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  const timers = immediateRetryTimers();
  let workersDevReads = 0;

  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "absence-check" }, {
    ...fixture.dependencies,
    tokenClientFactory: () => ({
      ...baseTokenClient,
      inspectWorkersDev: async () => {
        workersDevReads += 1;
        return { exists: true, enabled: true };
      },
    }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  }), /delayed absence proof failed/);

  assert.ok(workersDevReads > 0, "the public origin must still be observed after Worker absence");
});

for (const scenario of [
  {
    name: "remains present",
    exposureResults: Array(8).fill("present") as "present"[],
  },
  {
    name: "becomes unreadable",
    exposureResults: [...Array(8).fill("present"), "rate-limited"] as ("present" | "rate-limited")[],
  },
]) {
  test(`a confirmed-present route that ${scenario.name} after remediation refuses before later deletion`, async (t) => {
    const fixture = await rateLimitedTeardownFixture(t, "worker-deployed", { exposureResults: scenario.exposureResults });

    await assert.rejects(
      runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies),
      (error: any) => error?.message === "route absence proof failed",
    );

    assert.equal(fixture.removalCalls.filter((call) => call === "route").length, 1);
    assert.equal(fixture.removalCalls.some((call) => ["credential", "secret", "worker", "d1"].includes(call)), false);
    assert.equal(fixture.workerDeleteCalls(), 0);
    const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(saved.mutations.find((item: any) => item.kind === "teardown-route")?.status, "pending");
    assert.equal(saved.teardown?.absence?.["route:route-post-write"], undefined);
  });
}

test("an account-wide foreign Worker refuses before any deletion even when Wrangler sees no deployment", async (t) => {
  const fixture = await rateLimitedTeardownFixture(t, "resources-ready", {
    accountWorkerPresent: true,
    wranglerWorkerPresent: false,
  });

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies),
    /remote Worker predates this run's deployment; refusing to remove it/,
  );

  assert.deepEqual(fixture.removalCalls, []);
  assert.equal(fixture.workerDeleteCalls(), 0);
  assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).mutations.some((item: any) => item.kind?.startsWith("teardown-")), false);
});

test("a thrown Worker delete reconciles both Worker and deferred route from account-wide absence", async (t) => {
  const fixture = await rateLimitedTeardownFixture(t, "worker-deployed", { deleteOutcome: "absent-throw" });

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  assert.equal(fixture.workerDeleteCalls(), 1);
  assert.ok(fixture.scriptReadSnapshots.some((snapshot) => snapshot.afterWorkerDelete && !snapshot.workerPresent));
  const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(saved.teardown.absence[`worker:${workerName}`], true);
  assert.equal(saved.teardown.absence["route:route-post-write"], true);
  assert.equal(saved.mutations.find((item: any) => item.kind === "teardown-worker")?.status, "applied");
  assert.equal(saved.mutations.find((item: any) => item.kind === "teardown-route")?.status, "applied");
});

test("a Worker delete whose account-wide listing remains present leaves both proofs pending", async (t) => {
  const fixture = await rateLimitedTeardownFixture(t, "worker-deployed", { deleteOutcome: "present-throw" });

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies),
    /teardown mutation outcome is uncertain; no retry authorized/,
  );

  assert.equal(fixture.workerDeleteCalls(), 1);
  assert.ok(fixture.scriptReadSnapshots.some((snapshot) => snapshot.afterWorkerDelete && snapshot.workerPresent));
  const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(saved.mutations.find((item: any) => item.kind === "teardown-worker")?.status, "pending");
  assert.equal(saved.mutations.find((item: any) => item.kind === "teardown-route")?.status, "pending");
  assert.equal(saved.teardown?.absence?.[`worker:${workerName}`], undefined);
  assert.equal(saved.teardown?.absence?.["route:route-post-write"], undefined);
});

test("an empty Wrangler deployment proxy cannot certify deferred route absence", async (t) => {
  const fixture = await rateLimitedTeardownFixture(t, "worker-deployed", { wranglerWorkerPresent: false });

  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies));

  assert.equal(fixture.exposureReads(), 1, "account-wide Worker presence must force route remediation despite the empty Wrangler proxy");
  assert.equal(fixture.removalCalls.filter((call) => call === "route").length, 1);
  const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(saved.mutations.find((item: any) => item.kind === "teardown-route")?.status, "pending");
  assert.equal(saved.teardown?.absence?.["route:route-post-write"], undefined);
});

test("re-entered teardown proves an already-absent Worker and route without workers.dev", async (t) => {
  const fixture = await rateLimitedTeardownFixture(t, "resources-ready");

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  assert.equal(fixture.exposureReads(), 0);
  assert.equal(fixture.removalCalls.includes("route"), false);
  assert.equal(fixture.workerDeleteCalls(), 0);
  const saved = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(saved.teardown.absence["route:route-post-write"], true);
  assert.equal(saved.teardown.absence[`worker:${workerName}`], true);
});

test("teardown refuses a foreign Worker that appears after the entry ownership guard", async (t) => {
  const fixture = await postWriteTeardownFixture(t, "resources-ready");
  const baseAdapter = fixture.dependencies.adapterFactory();
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  const timers = immediateRetryTimers();
  let deploymentsListCalls = 0;
  let accountWorkerReads = 0;
  let deployCalls = 0;
  const dependencies = {
    ...fixture.dependencies,
    adapterFactory: () => ({
      ...baseAdapter,
      deploymentsList: async () => {
        deploymentsListCalls += 1;
        return deploymentsListCalls >= 4
          ? [{ id: "deployment-from-another-run", script_name: workerName }]
          : [];
      },
      versionsList: async () => [],
      deploy: async () => {
        deployCalls += 1;
        await baseAdapter.deploy();
      },
    }),
    tokenClientFactory: () => ({
      ...baseTokenClient,
      listWorkerScripts: async () => {
        accountWorkerReads += 1;
        return accountWorkerReads >= 5 ? [{ name: workerName }] : [];
      },
      inspectWorkersDev: async () => ({ exists: true, enabled: true }),
    }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, dependencies),
    /remote Worker predates this run's deployment; refusing to remove it/,
  );

  assert.equal(deployCalls, 0);
  assert.notEqual(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "cleanup-complete");
});

for (const phase of ["resources-ready", "alias-live"] as const) {
  test(`teardown completes from ${phase}`, async (t) => {
    const fixture = await postWriteTeardownFixture(t, phase);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, phase);

    const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

    assert.equal(result.cleanupComplete, true);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "cleanup-complete");
  });
}

for (const { name, exposures } of [
  {
    name: "teardown retries a stale route absence read",
    exposures: [{ enabled: false }, { enabled: true }, { enabled: false }, { enabled: false }],
  },
  {
    name: "teardown retries a stale exposure dependent before removing the worker",
    exposures: [{ enabled: false }, { enabled: false }, { enabled: true }, { enabled: false }],
  },
]) {
  test(name, async (t) => {
    const fixture = await postWriteTeardownFixture(t);
    const exposure = statefulExposureTokenClient(exposures);
    const baseTokenClient = fixture.dependencies.tokenClientFactory();
    const timers = immediateRetryTimers();

    const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, {
      ...fixture.dependencies,
      tokenClientFactory: () => ({
        ...exposure.tokenClient,
        listWorkerScripts: baseTokenClient.listWorkerScripts,
      }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    assert.equal(result.cleanupComplete, true);
    assert.equal(exposure.reads(), 4);
    assert.equal(timers.delays.length, 1);
  });
}

test("teardown propagates a route probe error when the Worker is present", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  let exposureReads = 0;

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, {
      ...fixture.dependencies,
      tokenClientFactory: () => ({
        ...baseTokenClient,
        inspectWorkersDev: async () => {
          exposureReads += 1;
          throw new Error("synthetic route probe failure");
        },
      }),
    }),
    (error: any) => error?.message === "synthetic route probe failure",
  );
  assert.equal(exposureReads, 1);
});

test("teardown propagates a dependent probe error when the Worker is present", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  let exposureReads = 0;

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, {
      ...fixture.dependencies,
      tokenClientFactory: () => ({
        ...baseTokenClient,
        inspectWorkersDev: async () => {
          exposureReads += 1;
          if (exposureReads === 3) throw new Error("synthetic dependent probe failure");
          return { exists: true, enabled: false };
        },
      }),
    }),
    (error: any) => error?.message === "synthetic dependent probe failure",
  );
  assert.equal(exposureReads, 3);
});

test("teardown preserves a failed acceptance result from a verified journal", async (t) => {
  const fixture = await postWriteTeardownFixture(t);
  const plan = createSyntheticFixturePlan({ runId: fixture.journal.runId, organizerToken: "organizer-synthetic", preFixtureBookmark: "bookmark-synthetic" });
  await assert.rejects(runDeployedAcceptance({
    origin,
    journal: fixture.journal,
    plan,
    organizerToken: "organizer-synthetic",
    persistJournal: (journal: any) => saveJournal(fixture.journalPath, journal),
    inspectFixtures: async () => ({ complete: false, count: 0 }),
    seedFixtures: async () => { throw new Error("synthetic acceptance failure"); },
    fetch: async () => assert.fail("HTTP must not run after fixture failure"),
    buildLiveCommand: () => assert.fail("live command must not be built after fixture failure"),
  }), /fixture seed failed; run requires quarantine/);
  assert.equal(fixture.journal.phase, "verified");
  assert.equal(fixture.journal.acceptance?.status, "failed");

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));

  assert.equal(result.cleanupComplete, true);
  assert.equal(journal.acceptance.status, "failed");
  assert.equal(journal.acceptance.cleanupComplete, true);
});

test("worker-deployed teardown with an absent worker still requires deleted_classes proof", async (t) => {
  const fixture = await postWriteTeardownFixture(t, "worker-deployed", "reconciled");
  const deployedJournal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(deployedJournal.mutations.find((item: any) => item.kind === "durable-object-create")?.status, "applied");
  fixture.removeWorker();

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies),
    (error: any) => error?.message === "Durable Object absence is unproven without the deleted_classes lifecycle",
  );
});

test("credentialed preflight calls no mutation and its public result contains no target identity", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-private-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  await writeFile(inventoryPath, JSON.stringify(inventory()));
  let mutations = 0;
  const adapter = {
    whoami: async () => ({ accountId }), d1List: async () => [], deploymentsList: async () => [],
    versionsList: async () => [], secretList: async () => [],
    d1Create: async () => { mutations += 1; }, deploy: async () => { mutations += 1; },
  };
  const result = await runLiveOperation({
    operation: "preflight", environment: "staging", inventoryPath,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  });
  assert.equal(mutations, 0);
  const output = JSON.stringify(publicOperationResult(result));
  assert.doesNotMatch(output, new RegExp(`${accountId}|${databaseId}|${workerName}`));
  assert.deepEqual(JSON.parse(output), { operation: "preflight", ok: true, mutationCount: 0, accountScope: "shared-account-staging" });
});

test("declared protected siblings are allowed while clean staging targets remain untouched", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-shared-account-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const sharedInventory = inventory();
  sharedInventory.forbidden.workerNames.push("hootenanny-live");
  sharedInventory.forbidden.origins.push("https://production-live.invalid");
  const stagingBefore = structuredClone(sharedInventory.staging);
  await writeFile(inventoryPath, JSON.stringify(sharedInventory));
  let mutations = 0;
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => [{ uuid: sharedInventory.forbidden.databaseIds[0]!.toUpperCase(), name: "HoOtEnAnNy-Live" }],
    deploymentsList: async () => [], versionsList: async () => [], secretList: async () => [],
    d1Create: async () => { mutations += 1; }, deploy: async () => { mutations += 1; },
  };
  const result = await runLiveOperation({
    operation: "preflight", environment: "staging", inventoryPath,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => ({
      inspect: async () => ({ active: true, id: "borrowed-operator-token" }),
      listWorkerScripts: async () => [{ name: "HoOtEnAnNy-Live" }],
      listWorkerRoutes: async () => [
        { pattern: "production-live.invalid/*", script: "HoOtEnAnNy-Live" },
        { pattern: "*.production-live.invalid/*", script: "HoOtEnAnNy-Live" },
      ],
      listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic",
    }),
  });
  assert.equal(result.accountScope, "shared-account-staging");
  assert.equal(result.mutationCount, 0);
  assert.equal(mutations, 0);
  assert.deepEqual(sharedInventory.staging, stagingBefore);
});

test("every preflight failure path remains read-only and boundary errors disclose no private values", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-preflight-failures-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  await writeFile(inventoryPath, JSON.stringify(inventory()));
  const environment = { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) };
  let mutations = 0;
  const readOnlyAdapter = (workerEntries: Array<{ name: string }> = []) => ({
    whoami: async () => ({ accountId }),
    d1List: async () => [],
    deploymentsList: async () => workerEntries,
    versionsList: async () => [],
    secretList: async () => [],
    d1Create: async () => { mutations += 1; },
    deploy: async () => { mutations += 1; },
  });
  const input = { operation: "preflight", environment: "staging", inventoryPath, processEnvironment: environment };
  const sourceState = () => ({ actualSourceSha: sourceSha, worktreeClean: true });

  await assert.rejects(runLiveOperation({ ...input, processEnvironment: { CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN } }, {
    sourceState, adapterFactory: () => readOnlyAdapter(), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /live command secret environment variable/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(), tokenClientFactory: () => ({ inspect: async () => ({ active: false }) }),
  }), /operator token is not active/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter([{ name: "HoOtEnAnNy-Unlisted" }]), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [{ name: "production-worker" }], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation(input, {
    sourceState,
    adapterFactory: () => ({ ...readOnlyAdapter(), d1List: async () => { throw new Error(`${accountId} ${databaseId} ${workerName} synthetic-cloud-token`); } }),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), (error: any) => {
    assert.equal(error.message, "credentialed Cloudflare inventory collection failed");
    assert.doesNotMatch(error.message, new RegExp(`${accountId}|${databaseId}|${workerName}|synthetic-cloud-token`));
    return true;
  });
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "different-account" }),
  }), /origin does not belong to the authenticated account/);
  await assert.rejects(runLiveOperation(input, {
    sourceState,
    adapterFactory: () => ({
      ...readOnlyAdapter(),
      deploymentsList: async (name: string) => name === "neutral-worker" ? [{ script_name: name, routes: [{ pattern: "production.example.invalid/*" }] }] : [],
    }),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [{ name: "neutral-worker" }], listWorkerRoutes: async () => [{ pattern: "production.example.invalid/*", script: "neutral-worker" }], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation({ ...input, processEnvironment: { ...environment, CLOUDFLARE_PREFLIGHT_BYPASS: "true" } }, {
    sourceState, adapterFactory: () => readOnlyAdapter([{ name: "HoOtEnAnNy-Unlisted" }]), tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /undeclared protected-looking target/);
  await assert.rejects(runLiveOperation(input, {
    sourceState, adapterFactory: () => readOnlyAdapter(),
    tokenClientFactory: () => ({ inspect: async () => ({ active: true, id: "synthetic-token-id" }), listWorkerScripts: async () => [], listWorkerRoutes: async () => [{ pattern: "staging.example.invalid/*", script: workerName }], listWorkerDomains: async () => [], inspectAccountSubdomain: async () => "synthetic" }),
  }), /already exists/);
  assert.equal(mutations, 0);
});

test("private-path enforcement resolves symlinked parents before reading", async (t) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-public-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "woodshed-live-path-check-"));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(testRoot, "inventory.json"), JSON.stringify(inventory()));
  const linked = path.join(outside, "private-link");
  await symlink(testRoot, linked, "dir");
  await assert.rejects(runLiveOperation({
    operation: "preflight", environment: "staging", root: testRoot,
    inventoryPath: path.join(linked, "inventory.json"),
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32) },
  }, { sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }) }), /outside the public repository/);
});

test("deployment token lifecycle uses authorization headers and never URL or body credentials", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let active = true;
  const client = createApiTokenClient({
    token: "synthetic-cloud-token",
    apiBase: "https://api.synthetic.invalid/tokens",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    zoneApiBase: "https://api.synthetic.invalid/zones",
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/zones?")) return Response.json({ success: true, result: [{ id: "zone-synthetic" }], result_info: { total_pages: 1 } });
      if (url.includes("/workers/routes")) return Response.json({ success: true, result: [{ pattern: "staging.example.invalid/*", script: "neutral-staging-worker" }], result_info: { total_pages: 1 } });
      if (url.includes("/workers/domains")) return Response.json({ success: true, result: [{ hostname: "staging.example.invalid", service: "neutral-staging-worker", environment: "staging" }], result_info: { total_pages: 1 } });
      if (url.endsWith("/workers/subdomain")) return Response.json({ success: true, result: { subdomain: "synthetic" } });
      if (url.includes("/subdomain")) return Response.json({ success: true, result: { enabled: false, previews_enabled: true } });
      if (url.includes("workers/scripts")) return Response.json({ success: true, result: [{ id: "neutral-staging-worker" }], result_info: { total_pages: 1 } });
      if (init.method === "DELETE") { active = false; return Response.json({ success: true, result: {} }); }
      return active
        ? Response.json({ success: true, result: { id: "synthetic-token-id", status: "active" } })
        : new Response(null, { status: 401 });
    },
  });
  const state = await client.inspect();
  assert.equal(state.active, true);
  assert.equal((await client.inspectId(state.id)).active, true);
  assert.deepEqual(await client.listWorkerScripts(accountId), [{ name: "neutral-staging-worker" }]);
  const incomplete = createApiTokenClient({ token: "synthetic-token", fetch: async () => Response.json({ success: true, result: [], result_info: { total_pages: 2 } }) });
  await assert.rejects(incomplete.listWorkerScripts(accountId), /unreadable or incomplete/);
  assert.deepEqual(await client.inspectWorkersDev(accountId, workerName), { exists: true, enabled: true });
  assert.equal(await client.inspectAccountSubdomain(accountId), "synthetic");
  assert.deepEqual(await client.listWorkerRoutes(accountId), [{ pattern: "staging.example.invalid/*", script: "neutral-staging-worker" }]);
  assert.deepEqual(await client.listWorkerDomains(accountId), [{ hostname: "staging.example.invalid", script: "neutral-staging-worker", environment: "staging" }]);
  await client.revoke(state.id);
  assert.deepEqual(await client.inspect(), { exists: null, active: null, unauthorized: true });
  assert.ok(calls.every(({ url, init }) => !url.includes("synthetic-cloud-token") && init.body === undefined));
  assert.ok(calls.every(({ init }) => new Headers(init.headers).get("authorization") === `${"Bear"}er synthetic-cloud-token`));

  const forbidden = createApiTokenClient({ token: "synthetic-cloud-token", fetch: async () => new Response(null, { status: 403 }) });
  await assert.rejects(forbidden.inspect(), /unauthorized/);

  const unreadablePreview = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    fetch: async () => Response.json({ success: true, result: { enabled: false } }),
  });
  await assert.rejects(unreadablePreview.inspectWorkersDev(accountId, workerName), /exposure inventory is unreadable/);
});

test("teardown revokes a journal-owned run-minted token without revoking the borrowed operator token", async (t) => {
  const borrowed = createJournal({ runId: "run-borrowed", owner: "owner-borrowed", sourceSha, identity: inventory().staging });
  borrowed.resources.push({ domain: "token", id: "borrowed-operator-token-id", runId: borrowed.runId, owner: borrowed.owner } as any);
  assert.throws(() => validateJournal(borrowed), /token must be run-minted/);

  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-minted-token-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-minted-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  await writeFile(inventoryPath, JSON.stringify(inventory()));
  const remote = { accountId, databases: [], workers: [], routes: [], secretNames: [], deployments: [], versions: [] };
  const owned = createJournal({ runId: "run-minted", owner: "owner-minted", sourceSha, identity: inventory().staging });
  owned.phase = "quarantined";
  const revision = createIdentityRevision(remote);
  (owned as any).preflight = { protectedRevision: revision, targetRevision: revision, operatorTokenPresent: true };
  (owned as any).lease = { active: true, runId: owned.runId, owner: owned.owner, revision };
  (owned as any).acceptance = { status: "not-run", cleanupComplete: false };
  const deletion = await generateEffectiveConfig({ root: testRoot, runId: owned.runId, inventory: inventory(), databaseId, sourceSha, deleteDurableObject: true });
  owned.mutations.push({
    kind: "durable-object-delete", domain: "durable-object", id: "durable-owned", status: "applied",
    tag: deletion.deletionTag, configDigest: deletion.configDigest,
    beforeDeploymentIds: ["deployment-before"], afterDeploymentIds: ["deployment-after"],
  } as any);
  for (const [domain, id] of [
    ["route", "route-owned"], ["hostname", "hostname-owned"], ["credential", "credential-owned"],
    ["secret", "secret-owned"], ["worker", workerName], ["durable-object", "durable-owned"], ["d1", databaseId],
  ] as const) owned.resources.push({ domain, id, runId: owned.runId, owner: owned.owner });
  owned.resources.push({ domain: "token", id: "run-minted-token-id", provenance: "run-minted", runId: owned.runId, owner: owned.owner } as any);
  await writeFile(journalPath, JSON.stringify(owned));

  let mintedActive = true;
  const revoked: string[] = [];
  const adapter = {
    whoami: async () => ({ accountId }), d1List: async () => [], deploymentsList: async () => [],
    versionsList: async () => [], secretList: async () => [], d1Execute: async () => [{ success: true, results: [] }],
  };
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "borrowed-operator-token-id" }),
    inspectId: async (id: string) => id === "run-minted-token-id" && mintedActive ? { exists: true, active: true, id } : { exists: false, active: false, id },
    listWorkerScripts: async () => [], listWorkerRoutes: async () => [], listWorkerDomains: async () => [],
    inspectWorkersDev: async () => ({ exists: false, enabled: false }),
    revoke: async (id: string) => { revoked.push(id); mintedActive = false; },
  };
  const result = await runLiveOperation({
    operation: "teardown", environment: "staging", root: testRoot, inventoryPath, journalPath,
    runId: owned.runId, owner: owned.owner, processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token" },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter, tokenClientFactory: () => tokenClient,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  });
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.absenceCount, 8);
  assert.deepEqual(revoked, ["run-minted-token-id"]);
  assert.equal((await tokenClient.inspect()).active, true);
});

test("verification fails an inactive origin after one read without scheduling a retry", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-inactive-origin-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-inactive-origin-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  await writeFile(inventoryPath, JSON.stringify(stagingInventory));

  const journal = createJournal({ runId: "run-inactive-origin", owner: "owner-inactive-origin", sourceSha, identity: stagingInventory.staging });
  journal.phase = "alias-live";
  journal.preflight = { protectedRevision: createIdentityRevision({ accountId, databases: [], workers: [], routes: [], deployments: [], versions: [] }), targetRevision: "synthetic", operatorTokenPresent: true };
  journal.config = { activeDigest: "f".repeat(64) };
  journal.resources.push({ domain: "route", id: "workers-dev-inactive", runId: journal.runId, owner: journal.owner, status: "owned" });
  await saveJournal(journalPath, journal);

  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => [{ uuid: databaseId, name: stagingInventory.staging.databaseName }],
    deploymentsList: async () => [{ id: "deployment-inactive", script_name: workerName }],
    versionsList: async () => [],
    secretList: async () => [],
  };
  const exposure = statefulExposureTokenClient([{ enabled: false }]);
  let scheduledTimers = 0;

  await assert.rejects(runLiveOperation({
    root: testRoot,
    operation: "verify",
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: journal.runId,
    owner: journal.owner,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic" },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => exposure.tokenClient,
    setTimer: () => { scheduledTimers += 1; return scheduledTimers; },
    clearTimer: () => {},
  }), /authenticated workers\.dev exposure is inactive/);

  assert.equal(exposure.reads(), 1);
  assert.equal(scheduledTimers, 0);
});

test("apply failure after D1 identity assignment records an incident, quarantines, and rethrows", async (t) => {
  const fixture = await failedApplyFixture(t);
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error) => error === fixture.applyFailure);

  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.identity.databaseId, databaseId);
  assert.deepEqual(journal.incident, {
    failedPhase: "resources-ready",
    owner: "owner-incident",
    nextAction: "reconcile-and-forward-fix-or-teardown",
    wholeStackRollback: false,
  });
  assert.equal(journal.phase, "quarantined");
  assert.equal(fixture.quarantineInspections(), 2);
  assert.deepEqual(journal.mutations.find((item: any) => item.kind === "workers-dev-disable"), {
    kind: "workers-dev-disable",
    domain: "route",
    id: journal.resources.find((item: any) => item.domain === "route").id,
    status: "applied",
    notRequired: true,
  });
});

test("apply failure marks quarantineFailed and warns that the origin must be treated as live", async (t) => {
  const fixture = await failedApplyFixture(t, { quarantineFails: true });
  await assert.rejects(runLiveOperation({ ...fixture.common, operation: "apply" }, fixture.dependencies), (error: any) => {
    assert.equal(error.message, "apply failed and automatic origin quarantine failed; treat the origin as live");
    assert.equal(error.cause, fixture.applyFailure);
    return true;
  });

  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.identity.databaseId, databaseId);
  assert.equal(journal.incident.failedPhase, "resources-ready");
  assert.equal(journal.incident.quarantineFailed, true);
  assert.equal(journal.incident.nextAction, "treat-origin-as-live-and-reconcile");
  assert.equal(journal.incident.wholeStackRollback, false);
  assert.equal(fixture.quarantineInspections(), 1);
});

test("quarantine reconciles a lost disable response after one confirmation read", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-quarantine-reconcile-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-quarantine-reconcile-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  await writeFile(inventoryPath, JSON.stringify(stagingInventory));

  const activeConfigDigest = "d".repeat(64);
  const journal = createJournal({ runId: "run-quarantine-reconcile", owner: "owner-quarantine-reconcile", sourceSha, identity: stagingInventory.staging });
  journal.phase = "verified";
  journal.preflight = { protectedRevision: createIdentityRevision({ accountId, databases: [], workers: [], routes: [], deployments: [], versions: [] }), targetRevision: "synthetic", operatorTokenPresent: true };
  journal.config = { activeDigest: activeConfigDigest };
  journal.acceptance = { status: "passed", cleanupComplete: false };
  journal.acceptanceEvidence = createEvidenceEnvelope({
    runId: journal.runId,
    sourceSha: journal.sourceSha,
    phase: journal.phase,
    outcomes: { acceptance: true },
    counts: {},
  });
  journal.resources.push({ domain: "route", id: "workers-dev-reconcile", runId: journal.runId, owner: journal.owner, status: "owned" });
  await saveJournal(journalPath, journal);

  let deploymentId = "deployment-before";
  let deployCalls = 0;
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => [{ uuid: databaseId, name: stagingInventory.staging.databaseName }],
    deploymentsList: async () => [{ id: deploymentId, script_name: workerName }],
    versionsList: async () => [],
    secretList: async () => [],
    deploy: async () => {
      deployCalls += 1;
      deploymentId = "deployment-after";
      throw new Error("synthetic disable response loss");
    },
  };
  const exposure = statefulExposureTokenClient([{ enabled: true }, { enabled: false }]);

  const result = await runLiveOperation({
    root: testRoot,
    operation: "verify",
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: journal.runId,
    owner: journal.owner,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic" },
  }, {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => exposure.tokenClient,
    fetch: async () => Response.json({
      sourceSha,
      configDigest: activeConfigDigest,
      lifecycle: "legacy-sqlite-v1",
      bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"],
    }),
    setTimer: () => assert.fail("a proven absence must not schedule a retry"),
  });

  const saved = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(result.phase, "quarantined");
  assert.equal(exposure.reads(), 2);
  assert.equal(deployCalls, 1);
  assert.equal(saved.mutations.find((item: any) => item.kind === "workers-dev-disable")?.status, "applied");
  assert.equal(saved.phase, "quarantined");
});

test("an unconfirmable quarantine is recorded and can still be torn down", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-unconfirmed-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-unconfirmed-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  await writeFile(inventoryPath, JSON.stringify(stagingInventory));

  const activeConfigDigest = "e".repeat(64);
  const revision = createIdentityRevision({ accountId, databases: [], workers: [], routes: [], deployments: [], versions: [] });
  const journal = createJournal({ runId: "run-unconfirmed", owner: "owner-unconfirmed", sourceSha, identity: stagingInventory.staging });
  journal.phase = "verified";
  journal.preflight = { protectedRevision: revision, targetRevision: revision, operatorTokenPresent: true };
  journal.lease = { active: true, runId: journal.runId, owner: journal.owner, revision };
  journal.config = { activeDigest: activeConfigDigest };
  journal.acceptance = { status: "passed", cleanupComplete: false };
  journal.acceptanceEvidence = createEvidenceEnvelope({
    runId: journal.runId,
    sourceSha: journal.sourceSha,
    phase: journal.phase,
    outcomes: { acceptance: true },
    counts: {},
  });
  for (const [domain, id] of [
    ["route", "workers-dev-unconfirmed"], ["hostname", "hostname-unconfirmed"],
    ["credential", "credential-unconfirmed"], ["secret", "secret-unconfirmed"],
    ["worker", workerName], ["durable-object", "durable-unconfirmed"], ["d1", databaseId],
  ] as const) journal.resources.push({ domain, id, runId: journal.runId, owner: journal.owner, status: "owned" });
  journal.mutations.push({ kind: "durable-object-create", domain: "durable-object", id: "durable-unconfirmed", status: "applied" });
  await saveJournal(journalPath, journal);

  const state = { exposureEnabled: true, rateLimited: true, exposureSequence: [] as boolean[], workerPresent: true, databasePresent: true, deploymentSequence: 1 };
  const deployments = () => state.workerPresent ? [{ id: `deployment-${state.deploymentSequence}`, script_name: workerName }] : [];
  const adapterFactory = ({ configPath }: { configPath?: string }) => ({
    whoami: async () => ({ accountId }),
    d1List: async () => state.databasePresent ? [{ uuid: databaseId, name: stagingInventory.staging.databaseName }] : [],
    deploymentsList: async () => deployments(),
    versionsList: async () => [],
    secretList: async () => [],
    d1Execute: async () => [{ success: true, results: [{ count: 0 }] }],
    deploy: async () => {
      assert.ok(configPath);
      state.workerPresent = true;
      state.deploymentSequence += 1;
    },
    deleteWorker: async () => { state.workerPresent = false; },
    d1Delete: async () => { state.databasePresent = false; },
  });
  let exposureReadCount = 0;
  const exposureClient = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    // The first read is quarantine's enabledBefore check; every read after it is the absence
    // proof, and those hit a real 429 Response so the rate-limit path runs through the actual
    // client error shape rather than a fabricated error object.
    fetch: async () => {
      exposureReadCount += 1;
      if (state.rateLimited && exposureReadCount > 1) return new Response(null, { status: 429 });
      return Response.json({ success: true, result: { enabled: state.exposureSequence.shift() ?? state.exposureEnabled, previews_enabled: false } });
    },
  });
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => state.workerPresent ? [{ name: workerName }] : [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectWorkersDev: exposureClient.inspectWorkersDev,
  };
  const timers = immediateRetryTimers();
  const common = {
    root: testRoot,
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: journal.runId,
    owner: journal.owner,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic" },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory,
    tokenClientFactory: () => tokenClient,
    fetch: async () => Response.json({
      sourceSha,
      configDigest: activeConfigDigest,
      lifecycle: "legacy-sqlite-v1",
      bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"],
    }),
    now: () => new Date("2030-01-01T12:00:00.000Z"),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };

  // verify must refuse rather than report success over an origin it could not prove closed --
  // the incident is still recorded, and the run stays closeable by teardown.
  await assert.rejects(
    runLiveOperation({ ...common, operation: "verify" }, dependencies),
    /origin absence could not be confirmed/,
  );
  const afterQuarantine = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(afterQuarantine.phase, "verified");
  assert.equal(exposureReadCount, 2);
  assert.deepEqual(afterQuarantine.incident.originAbsence, {
    status: "could-not-confirm",
    checkedAt: "2030-01-01T12:00:00.000Z",
    attempts: 1,
    disableFailed: false,
  });
  assert.equal(afterQuarantine.incident.quarantineFailed, undefined);
  assert.notEqual(afterQuarantine.phase, "quarantined");
  assert.equal(afterQuarantine.mutations.find((item: any) => item.kind === "workers-dev-disable")?.status, "pending");

  state.exposureEnabled = false;
  state.rateLimited = false;
  const tornDown = await runLiveOperation({ ...common, operation: "teardown" }, dependencies);
  assert.equal(tornDown.phase, "cleanup-complete");
  assert.equal(tornDown.cleanupComplete, true);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "cleanup-complete");

  const readsBeforeAbsenceCheck = exposureReadCount;
  const timersBeforeAbsenceCheck = timers.delays.length;
  state.exposureSequence.push(true, false);
  const delayed = await runLiveOperation({ ...common, operation: "absence-check" }, dependencies);
  assert.equal(delayed.passed, true);
  assert.equal(exposureReadCount, readsBeforeAbsenceCheck + 2);
  assert.equal(timers.delays.length, timersBeforeAbsenceCheck + 1);
});

test("preview-only exposure remains an unproven quarantine absence", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-preview-private-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-preview-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const inventoryPath = path.join(privateDirectory, "inventory.json");
  const journalPath = path.join(privateDirectory, "journal.json");
  const stagingInventory = inventory();
  await writeFile(inventoryPath, JSON.stringify(stagingInventory));

  const remoteWithoutTarget = { accountId, databases: [], workers: [], routes: [], deployments: [], versions: [] };
  const activeConfigDigest = "d".repeat(64);
  const journal = createJournal({ runId: "run-preview", owner: "owner-preview", sourceSha, identity: stagingInventory.staging });
  journal.phase = "verified";
  journal.preflight = { protectedRevision: createIdentityRevision(remoteWithoutTarget), targetRevision: "synthetic", operatorTokenPresent: true };
  journal.config = { activeDigest: activeConfigDigest };
  journal.resources.push({ domain: "route", id: "workers-dev-preview", runId: journal.runId, owner: journal.owner, status: "owned" });
  await saveJournal(journalPath, journal);

  let deployCalls = 0;
  const adapter = {
    whoami: async () => ({ accountId }),
    d1List: async () => [{ uuid: databaseId, name: stagingInventory.staging.databaseName }],
    deploymentsList: async () => [{ id: "deployment-before", script_name: workerName }],
    versionsList: async () => [],
    secretList: async () => [],
    deploy: async () => { deployCalls += 1; },
  };
  const exposureClient = createApiTokenClient({
    token: "synthetic-cloud-token",
    accountApiBase: "https://api.synthetic.invalid/accounts",
    fetch: async () => Response.json({ success: true, result: { enabled: false, previews_enabled: true } }),
  });
  const tokenClient = {
    inspect: async () => ({ exists: true, active: true, id: "synthetic-token-id" }),
    listWorkerScripts: async () => [],
    listWorkerRoutes: async () => [],
    listWorkerDomains: async () => [],
    inspectWorkersDev: exposureClient.inspectWorkersDev,
  };
  const timers = immediateRetryTimers();
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }),
    adapterFactory: () => adapter,
    tokenClientFactory: () => tokenClient,
    fetch: async () => Response.json({
      sourceSha,
      configDigest: activeConfigDigest,
      lifecycle: "legacy-sqlite-v1",
      bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"],
    }),
    now: () => new Date("2030-01-01T12:00:00.000Z"),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };
  await assert.rejects(runLiveOperation({
    root: testRoot,
    operation: "verify",
    environment: "staging",
    inventoryPath,
    journalPath,
    runId: journal.runId,
    owner: journal.owner,
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic" },
  }, dependencies), /origin quarantine absence proof failed/);
  // A preview hostname that stays enabled across the whole attempt ladder is present, not
  // unknown, so this stays the hard refusal it always was -- the retry removes the stale-read
  // false negative without softening a genuinely live origin into an incident note.
  const saved = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(saved.phase, "verified");
  assert.equal(saved.incident?.originAbsence, undefined);
  assert.equal(deployCalls, 1);
});

test("mocked live boundaries complete plan through teardown in dependency order with absence proof", async (t) => {
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "woodshed-live-e2e-"));
  const testRoot = await mkdtemp(path.join(tmpdir(), "woodshed-live-root-"));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  await mkdir(path.join(testRoot, "migrations", "d1"), { recursive: true });
  for (const migration of D1_MIGRATIONS) await copyFile(path.resolve("migrations/d1", migration.filename), path.join(testRoot, "migrations", "d1", migration.filename));
  const inventoryPath = path.join(privateDirectory, "inventory.json"), journalPath = path.join(privateDirectory, "journal.json");
  const freshInventory = inventory();
  delete (freshInventory.staging as Partial<typeof freshInventory.staging>).databaseId;
  await writeFile(inventoryPath, JSON.stringify(freshInventory));

  const schemaDatabase = new DatabaseSync(":memory:");
  t.after(() => schemaDatabase.close());
  schemaDatabase.exec("PRAGMA foreign_keys=ON");
  for (const migration of D1_MIGRATIONS) {
    const contents = await readFile(path.resolve("migrations/d1", migration.filename), "utf8");
    schemaDatabase.exec(contents);
  }
  const schemaObjects = schemaDatabase.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name").all();
  const state = {
    databases: [] as Array<{ uuid: string; name: string }>, deployments: [] as any[], versions: [] as any[],
    secrets: new Set<string>(), ledger: [] as string[], active: false, fixtureRows: 0, credentialActive: false,
    tokenActive: true, tokenId: "synthetic-token-id", durableDeleted: false, calls: [] as string[], revokedTokenIds: [] as string[], deploymentSequence: 0,
  };
  const assignedDatabaseId = databaseId;
  let activeDigest = "";
  let lastRemoteAction = "none";
  const read = <T>(value: T) => { lastRemoteAction = "read"; return value; };
  const assertIdentityRead = (mutation: string) => {
    assert.equal(lastRemoteAction, "identity-read", `${mutation} must be immediately preceded by a guarded identity read`);
    lastRemoteAction = mutation;
  };
  const adapterFactory = ({ configPath }: { configPath?: string }) => ({
    whoami: async () => read({ accountId }),
    d1List: async () => read(state.databases),
    deploymentsList: async () => read(state.deployments),
    versionsList: async () => read(state.versions),
    secretList: async () => read([...state.secrets].map((name) => ({ name }))),
    d1Create: async (name: string) => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.resources.some((item: any) => item.domain === "d1"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "d1-create" && item.status === "pending"));
      assertIdentityRead("d1-create");
      state.calls.push("d1-create"); state.databases = [{ uuid: assignedDatabaseId, name }];
    },
    d1TimeTravelInfo: async () => read({ bookmark: "bookmark-synthetic" }),
    d1Execute: async (_name: string, options: { command?: string; file?: string }) => {
      if (options.file?.endsWith("synthetic-fixtures.sql")) { assertIdentityRead("fixture-seed"); state.fixtureRows = 8; state.credentialActive = true; return [{ success: true, results: [] }]; }
      if (options.file?.endsWith("revoke-organizer.sql")) { assertIdentityRead("credential-revoke"); state.credentialActive = false; state.calls.push("credential"); return [{ success: true, results: [] }]; }
      const command = options.command ?? "";
      if (command.includes("name='d1_migrations'")) return read([{ success: true, results: state.ledger.length ? [{ name: "d1_migrations" }] : [] }]);
      if (command.includes("FROM d1_migrations")) return read([{ success: true, results: state.ledger.map((name, id) => ({ id, name })) }]);
      if (command.includes("count(*) AS count FROM sqlite_schema")) return read([{ success: true, results: [{ count: Math.max(1, state.ledger.length) }] }]);
      if (command.includes("SELECT token_hash,participation_id FROM participation_recovery")) return read([{ success: true, results: [] }]);
      if (command.includes("SELECT type,name,sql FROM sqlite_schema")) return read([{ success: true, results: schemaObjects }]);
      if (command === "PRAGMA foreign_keys") return read([{ success: true, results: [{ foreign_keys: 1 }] }]);
      if (command === "PRAGMA foreign_key_check") return read([{ success: true, results: [] }]);
      if (command.includes("participant_sessions") && command.includes("revoked_at IS NULL")) return read([{ success: true, results: [{ count: state.credentialActive ? 1 : 0 }] }]);
      if (command.includes("UNION ALL")) return read([{ success: true, results: state.fixtureRows ? [{ count: 1 }, { count: 1 }, { count: 2 }, { count: 2 }, { count: 1 }, { count: 1 }] : [{ count: 0 }] }]);
      return read([{ success: true, results: [] }]);
    },
    d1MigrationsApply: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.equal(journal.migrations.at(-1).status, "pending");
      assertIdentityRead("migration-apply");
      state.calls.push(`migration-${state.ledger.length + 1}`); state.ledger.push(D1_MIGRATIONS[state.ledger.length]!.filename);
    },
    deploy: async () => {
      const config = JSON.parse(await readFile(configPath!, "utf8"));
      const staging = config.env.staging;
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      if (staging.migrations.some((item: any) => Array.isArray(item.deleted_classes))) assert.ok(journal.mutations.some((item: any) => item.kind === "durable-object-delete" && item.status === "pending"));
      else if (staging.workers_dev) assert.ok(journal.mutations.some((item: any) => item.kind === "workers-dev-enable" && item.status === "pending"));
      else if (!journal.mutations.some((item: any) => item.kind === "workers-dev-disable" && item.status === "pending")) {
        assert.ok(journal.mutations.some((item: any) => item.kind === "worker-deploy" && item.status === "pending"));
        assert.ok(journal.mutations.some((item: any) => item.kind === "durable-object-create" && item.status === "pending"));
      }
      assertIdentityRead("worker-deploy");
      state.active = staging.workers_dev === true;
      if (state.active) activeDigest = staging.vars.WOODSHED_CONFIG_DIGEST;
      state.durableDeleted = staging.migrations.some((item: any) => Array.isArray(item.deleted_classes));
      const id = `deployment-synthetic-${++state.deploymentSequence}`;
      state.deployments = [{ id, script_name: workerName, workers_dev: state.active }];
      state.versions = [{ id: `version-synthetic-${state.deploymentSequence}`, script_name: workerName }];
      state.calls.push(state.durableDeleted ? "durable-object" : state.active ? "route-enable" : "worker");
      const bindings = ["APP_ORIGIN", "DB", ...(state.secrets.has("LIVE_COMMAND_SECRET") ? ["LIVE_COMMAND_SECRET"] : []), ...(state.durableDeleted ? [] : ["LIVE_COORDINATOR"])];
      return { deploymentId: id, sourceSha, configDigest: staging.vars.WOODSHED_CONFIG_DIGEST, bindings, lifecycle: "legacy-sqlite-v1" };
    },
    secretPut: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "secret-put" && item.status === "pending"));
      assertIdentityRead("secret-put");
      state.secrets.add("LIVE_COMMAND_SECRET"); state.calls.push("secret-put");
    },
    secretDelete: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-secret" && item.status === "pending"));
      assertIdentityRead("secret-delete");
      state.secrets.clear(); state.calls.push("secret");
    },
    deleteWorker: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-worker" && item.status === "pending"));
      assertIdentityRead("worker-delete");
      state.deployments = []; state.versions = []; state.active = false; state.calls.push("worker-delete");
    },
    d1Delete: async () => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-d1" && item.status === "pending"));
      assertIdentityRead("d1-delete");
      state.databases = []; state.calls.push("d1");
    },
  });
  const tokenClient = {
    inspect: async () => state.tokenActive ? { exists: true, active: true, id: state.tokenId } : { exists: false, active: false },
    inspectId: async (id: string) => state.tokenActive && id === state.tokenId ? { exists: true, active: true, id } : { exists: false, active: false },
    listWorkerScripts: async () => read(state.deployments.length > 0 ? [{ name: workerName }] : []),
    listWorkerRoutes: async () => read([]),
    listWorkerDomains: async () => { lastRemoteAction = "identity-read"; return []; },
    inspectWorkersDev: async () => read({ exists: state.deployments.length > 0, enabled: state.active }),
    inspectAccountSubdomain: async () => "synthetic",
    revoke: async (id: string) => {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.ok(journal.mutations.some((item: any) => item.kind === "teardown-token" && item.status === "pending"));
      state.revokedTokenIds.push(id); state.tokenActive = false; state.calls.push("token");
    },
  };
  const markerFetch = async (url: string) => state.active
    ? Response.json({ sourceSha, configDigest: activeDigest, lifecycle: "legacy-sqlite-v1", bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"] })
    : new Response(null, { status: 404 });
  const common = {
    root: testRoot, environment: "staging", inventoryPath, journalPath, runId: "run-live", owner: "owner-live",
    processEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-cloud-token", LIVE_COMMAND_SECRET: "s".repeat(32), WOODSHED_STAGING_ORGANIZER_TOKEN: "organizer-synthetic" },
  };
  const dependencies = {
    sourceState: () => ({ actualSourceSha: sourceSha, worktreeClean: true }), adapterFactory,
    tokenClientFactory: () => tokenClient, fetch: markerFetch, now: () => new Date("2030-01-01T12:00:00.000Z"),
    acceptance: async ({ journal, plan, persistJournal, seedFixtures, buildLiveCommand }: any) => {
      await seedFixtures(plan);
      const signed = await buildLiveCommand({ commandCredential: "c".repeat(64), authorityEpoch: 1, plan });
      assert.match(signed.authentication, /^[a-f0-9]{64}$/);
      assert.equal(signed.authorityEpoch, 1);
      assert.equal(signed.eventId, plan.eventId);
      journal.phase = "verified";
      journal.acceptance = { status: "passed", cleanupComplete: false, fixturePlan: plan };
      await persistJournal(journal);
      const evidence = createEvidenceEnvelope({ runId: journal.runId, sourceSha: journal.sourceSha, phase: journal.phase, outcomes: { acceptance: true, cleanupComplete: false, disposableResidueExpected: true, productionAuthority: false }, counts: { fixtureRows: plan.rows.length } });
      journal.acceptanceEvidence = evidence;
      await persistJournal(journal);
      return evidence;
    },
  };
  await runLiveOperation({ ...common, operation: "plan" }, dependencies);
  await assert.rejects(runLiveOperation({ ...common, operation: "plan" }, dependencies), /journal path already exists/);
  const plannedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(plannedJournal.preflight.operatorTokenPresent, true);
  assert.equal(plannedJournal.resources.some((item: any) => item.domain === "token"), false);
  state.tokenId = "replacement-operator-token-id";
  const applied = await runLiveOperation({ ...common, operation: "apply" }, dependencies);
  assert.equal(applied.phase, "alias-live");
  const appliedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.deepEqual({ ...appliedJournal.schema, digest: undefined }, {
    digest: undefined,
    foreignKeysEnabled: true,
    foreignKeyViolations: 0,
    integrity: "unsupported-on-d1",
  });
  await runLiveOperation({ ...common, operation: "verify" }, dependencies);
  const tornDown = await runLiveOperation({ ...common, operation: "teardown" }, dependencies);
  assert.equal(tornDown.cleanupComplete, true);
  assert.equal((await runLiveOperation({ ...common, operation: "teardown", processEnvironment: {} }, dependencies)).cleanupComplete, true);
  const delayed = await runLiveOperation({ ...common, operation: "absence-check" }, dependencies);
  assert.equal(delayed.passed, true);
  assert.equal(delayed.absenceCount, 7);
  assert.deepEqual(state.calls.slice(-5), ["credential", "secret", "durable-object", "worker-delete", "d1"]);
  assert.equal(state.databases.length, 0);
  assert.equal(state.deployments.length, 0);
  assert.equal(state.tokenActive, true);
  assert.deepEqual(state.revokedTokenIds, []);
  const finalJournal = await readFile(journalPath, "utf8");
  assert.match(finalJournal, /woodshed-staging-delete-[a-f0-9]{16}/);
  assert.doesNotMatch(finalJournal, /organizer-synthetic|synthetic-cloud-token|ssssssssssssssssssssssssssssssss/);
  const evidence = await readFile(`${journalPath}.evidence.json`, "utf8");
  assert.doesNotMatch(evidence, new RegExp(`${accountId}|${databaseId}|${workerName}|${origin}`));
});

test("the active-origin assertion stays a single read and never retries", async () => {
  // Retrying an absence proof removes a false negative. Retrying this assertion would do
  // the opposite: assertActiveOrigin proves the origin IS live before acceptance runs, so a
  // retry would paper over a genuinely dead origin until it happened to answer. Pin the
  // asymmetry in source, because a future edit "fixing" this the same way would be silent.
  const source = await readFile(new URL("../../../tools/cloudflare/live-driver.mjs", import.meta.url), "utf8");
  const assertion = source.slice(source.indexOf("const assertActiveOrigin"));
  const body = assertion.slice(0, assertion.indexOf("\n  };"));
  assert.match(body, /await workersDevEnabled\(/);
  assert.doesNotMatch(body, /confirmWorkersDevAbsence|confirmAbsence/);
});

test("an unowned environment-suffixed Worker blocks cleanup completion and is never deleted", async () => {
  // wrangler's secret family once resolved --name plus --env into "<name>-staging", creating a
  // Worker the journal never owned. Argument composition prevents that now. The account-wide
  // revision guard catches one created DURING a run, but an orphan left by a PREVIOUS run sits
  // in the preflight baseline and trips nothing -- so teardown would report cleanup complete
  // right past it. The journal is authority to delete only what it owns, so this refuses and
  // reports rather than sweeping an unowned resource.
  const inventory = { staging: { accountId } } as any;
  const journal = { identity: { workerName } } as any;

  await assert.rejects(
    assertNoEnvironmentSuffixedWorker(inventory, journal, { listWorkerScripts: async () => [{ name: `${workerName}-staging` }] }),
    (error: any) => error?.message === "unowned environment-suffixed Worker blocks cleanup completion",
  );

  await assertNoEnvironmentSuffixedWorker(inventory, journal, { listWorkerScripts: async () => [{ name: workerName }, { name: "unrelated" }] });
});

test("teardown proves the near-miss refusal runs before it records cleanup complete", async () => {
  const source = await readFile(new URL("../../../tools/cloudflare/live-driver.mjs", import.meta.url), "utf8");
  const guard = source.indexOf("await assertNoEnvironmentSuffixedWorker(");
  const completion = source.indexOf('journal.phase = "cleanup-complete"', guard);
  assert.ok(guard > 0, "teardown must call the near-miss refusal");
  assert.ok(completion > guard, "the refusal must run before cleanup-complete is recorded");
});

test("teardown reconciles a pending Worker deploy before the first probe or removal", async (t) => {
  const fixture = await pendingDeployTeardownFixture(t);

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  const beforeRemoval = fixture.journalAtFirstMutation();
  assert.ok(beforeRemoval, "teardown must capture the journal before its first removal");
  assert.equal(beforeRemoval.phase, "schema-expanded");
  assert.deepEqual(
    beforeRemoval.mutations.find((item: any) => item.kind === "worker-deploy"),
    {
      kind: "worker-deploy",
      status: "applied",
      sourceSha,
      deploymentId: "deployment-lost-response",
      reconciledBy: "teardown",
    },
  );
  assert.equal(beforeRemoval.mutations.find((item: any) => item.kind === "durable-object-create")?.status, "applied");
  const beforeWorkersDev = fixture.journalAtFirstWorkersDevRead();
  assert.equal(beforeWorkersDev.mutations.find((item: any) => item.kind === "worker-deploy")?.status, "applied");
  const firstWorkersDevRead = fixture.readEvents.indexOf("workers-dev");
  assert.ok(firstWorkersDevRead > 0);
  assert.equal(fixture.readEvents.slice(0, firstWorkersDevRead).every((event) => ["deployments", "versions"].includes(event)), true);
  const completed = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(completed.phase, "cleanup-complete");

  const mutationsAfterFirstRun = fixture.mutationCalls.length;
  const replay = await runLiveOperation({ ...fixture.common, operation: "teardown", processEnvironment: {} }, fixture.dependencies);
  assert.equal(replay.cleanupComplete, true);
  assert.equal(fixture.mutationCalls.length, mutationsAfterFirstRun);
});

test("pending Worker deploy reconciliation propagates deployment-list failures", async (t) => {
  const fixture = await pendingDeployTeardownFixture(t);
  const journalBefore = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const reconciliationError = new Error("synthetic reconciliation deployment-list failure");
  const baseAdapter = fixture.dependencies.adapterFactory();
  let deploymentsListCalls = 0;
  const dependencies = {
    ...fixture.dependencies,
    adapterFactory: () => ({
      ...baseAdapter,
      deploymentsList: async (name: string) => {
        deploymentsListCalls += 1;
        if (deploymentsListCalls === 3) throw reconciliationError;
        return baseAdapter.deploymentsList();
      },
    }),
  };

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, dependencies),
    (error: unknown) => error === reconciliationError,
  );

  assert.equal(deploymentsListCalls, 3);
  assert.deepEqual(fixture.mutationCalls, []);
  assert.equal(fixture.workersDevReads(), 0);
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.deepEqual(journal, journalBefore);
  assert.equal(journal.mutations.find((item: any) => item.kind === "worker-deploy")?.status, "pending");
});

for (const scenario of [
  {
    name: "a missing deployment baseline",
    fixture: { recordDeploymentBaseline: false },
  },
  {
    name: "no remote deployment identity advance",
    fixture: {
      deploymentBaseline: ["deployment-lost-response", "version-lost-response"],
    },
  },
  {
    name: "an ambiguous remote deployment identity advance",
    fixture: {
      deploymentIds: ["deployment-lost-response-1", "deployment-lost-response-2"],
      versionIds: ["version-lost-response-1", "version-lost-response-2"],
    },
  },
  {
    name: "a mismatched intent source SHA",
    fixture: { intentSourceSha: "c".repeat(40) },
  },
] as const) {
  test(`pending Worker deploy reconciliation refuses ${scenario.name}`, async (t) => {
    const fixture = await pendingDeployTeardownFixture(t, scenario.fixture);

    await assert.rejects(
      runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies),
      (error: any) => error?.message === "remote Worker predates this run's deployment; refusing to remove it",
    );

    assert.deepEqual(fixture.mutationCalls, []);
    assert.equal(fixture.workersDevReads(), 0);
    const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(journal.mutations.find((item: any) => item.kind === "worker-deploy")?.status, "pending");
    assert.notEqual(journal.phase, "cleanup-complete");
  });
}

test("teardown skips pending deploy reconciliation and the route probe when the Worker is absent", async (t) => {
  const fixture = await pendingDeployTeardownFixture(t, { deploymentIds: [], versionIds: [] });

  const result = await runLiveOperation({ ...fixture.common, operation: "teardown" }, fixture.dependencies);

  assert.equal(result.cleanupComplete, true);
  assert.equal(fixture.mutationCalls.includes("deploy"), false);
  assert.equal(fixture.workersDevReads(), 0, "a route is absent with its Worker, so teardown must not probe workers.dev");
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.phase, "cleanup-complete");
  assert.equal(journal.mutations.find((item: any) => item.kind === "worker-deploy")?.status, "pending");
});

test("early-phase teardown refuses to delete a same-named Worker this run never deployed", async (t) => {
  // The widened teardown entry accepts phases reached before the Worker is deployed. A Worker is
  // matched by name alone, and inspectResource can only stamp the journal's own identity onto
  // whatever is remotely present, so recovery's ownership check compares the journal against
  // itself. Without this guard a run that crashed at resources-ready would delete a Worker a
  // LATER run created at the same name -- in a shared account, someone else's live Worker.
  const fixture = await postWriteTeardownFixture(t, "resources-ready");
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(journal.phase, "resources-ready");
  assert.equal(journal.mutations.some((item: any) => item.kind === "worker-deploy" && item.status === "applied"), false);

  // A Worker exists at the run's name -- created by some LATER run, not this one.
  let deleted = 0;
  const base = fixture.dependencies.adapterFactory();
  const baseTokenClient = fixture.dependencies.tokenClientFactory();
  const dependencies = {
    ...fixture.dependencies,
    adapterFactory: () => ({
      ...base,
      deploymentsList: async () => [{ id: "deployment-from-another-run", script_name: workerName }],
      versionsList: async () => [],
      deleteWorker: async () => { deleted += 1; },
    }),
    tokenClientFactory: () => ({
      ...baseTokenClient,
      listWorkerScripts: async () => [{ name: workerName }],
    }),
  };

  await assert.rejects(
    runLiveOperation({ ...fixture.common, operation: "teardown" }, dependencies),
    /remote Worker predates this run's deployment; refusing to remove it/,
  );
  assert.equal(deleted, 0);
  assert.notEqual(JSON.parse(await readFile(fixture.journalPath, "utf8")).phase, "cleanup-complete");
});
