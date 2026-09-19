import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

import { createJournal, saveJournal, loadJournal } from "../../../tools/cloudflare/journal.mjs";
import { createSyntheticFixturePlan, seedSyntheticFixtures } from "../../../tools/cloudflare/staging-fixtures.mjs";
import { runDeployedAcceptance } from "../../../tools/cloudflare/staging-smoke.mjs";
import { D1_MIGRATIONS } from "../../../tools/cloudflare/migrations.mjs";

const identity = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111", databaseName: "woodshed-staging-run-a", workerName: "woodshed-staging-run-a", origin: "https://woodshed-staging.invalid" };

const response = (status: number, body: unknown = {}, headers?: HeadersInit) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });

test("fixture ownership is durable before writes and response loss reconciles without replay", async () => {
  const journal = createJournal({ runId: "run-a", owner: "owner-a", sourceSha: "a".repeat(40), identity });
  journal.phase = "alias-live";
  const plan = await createSyntheticFixturePlan({ runId: journal.runId, organizerToken: "organizer-token-not-for-evidence", preFixtureBookmark: "bookmark-a" });
  const calls: string[] = [];
  let exists = false;
  const result = await seedSyntheticFixtures({
    journal, plan,
    persistJournal: async () => { calls.push("persist"); assert.equal(journal.acceptance!.fixturePlan!.eventId, plan.eventId); },
    inspect: async () => { calls.push("inspect"); return { complete: exists, count: exists ? plan.rows.length : 0 }; },
    seed: async () => { calls.push("seed"); exists = true; throw new Error("response lost"); },
  });
  assert.deepEqual(calls, ["persist", "inspect", "seed", "inspect", "persist"]);
  assert.equal(result.reconciled, true);
  assert.equal(journal.mutations.find((item) => item.kind === "synthetic-fixture-batch")?.status, "applied");
  assert.equal(journal.phase, "alias-live");
  assert.equal(journal.acceptance!.fixturePlan!.tokenHash.length, 64);
  assert.doesNotMatch(JSON.stringify(journal), /organizer-token-not-for-evidence/);
});

test("deployed acceptance drives participant, security, authority, live, and logout flows with sanitized evidence", async () => {
  const journal = createJournal({ runId: "run-b", owner: "owner-a", sourceSha: "b".repeat(40), identity });
  journal.phase = "worker-deployed";
  const plan = await createSyntheticFixturePlan({ runId: journal.runId, organizerToken: "organizer-secret-value", preFixtureBookmark: "bookmark-b" });
  let seeded = false;
  let loggedOut = false;
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const participantCookie = "woodshed_session_1234567890abcdef=participant-secret";
  const liveEntryId = "entry_synthetic_staging";
  const fetch = async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, init });
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    if (method !== "GET" && (headers.get("origin") !== identity.origin || headers.get("x-csrf-token") !== "same-origin")) return response(403, { error: "denied" });
    if (path === "/api/discovery") return response(200, { events: [{ id: plan.eventId }] });
    if (path.endsWith("/join-open")) return response(200, { assurance: "open-public" }, { "set-cookie": `${participantCookie}; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax` });
    const cookie = headers.get("cookie");
    const bearer = headers.get("authorization");
    if (path.endsWith("/context")) return cookie === participantCookie && !loggedOut ? response(200, { event: { id: plan.eventId } }) : response(401, { error: "unauthorized" });
    if (path.endsWith("/ballot") && method === "GET") {
      const written = requests.some(({ path: priorPath, init: priorInit }) => priorPath.endsWith("/ballot") && priorInit.method === "PUT");
      return cookie === participantCookie ? response(200, { revision: written ? 1 : 0, candidates: (written ? [...plan.songIds].reverse() : plan.songIds).map((id) => ({ id })) }) : response(401, { error: "unauthorized" });
    }
    if (path.endsWith("/ballot") && method === "PUT") return response(200, { revision: 1 });
    if (path.endsWith("/proposals")) return response(201, { state: "eligible" });
    if (path.endsWith("/authority/acquire")) return bearer === `${"Bear"}er organizer-secret-value` ? response(200, { epoch: 1, commandCredential: "device-credential-secret", deviceInstallationId: plan.deviceInstallationId }) : cookie ? response(403, { error: "denied" }) : response(401, { error: "unauthorized" });
    if (path.endsWith("/live/commands")) return bearer === `${"Bear"}er organizer-secret-value` ? response(200, { status: "applied", revision: 1, entry: { id: liveEntryId, state: "queued" } }) : response(403, { error: "denied" });
    if (path.endsWith("/live/state")) {
      const commandSent = requests.some(({ path: priorPath }) => priorPath.endsWith("/live/commands"));
      return response(200, commandSent ? { revision: 1, entries: [{ id: liveEntryId, state: "queued" }] } : { revision: 0, entries: [] });
    }
    if (path === "/api/logout") { loggedOut = true; return response(204, undefined, { "set-cookie": "woodshed_session_1234567890abcdef=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax" }); }
    return response(404, { error: "not-found" });
  };

  const evidence = await runDeployedAcceptance({
    origin: identity.origin, journal, plan, organizerToken: "organizer-secret-value", fetch,
    persistJournal: async () => {}, inspectFixtures: async () => ({ complete: seeded, count: seeded ? plan.rows.length : 0 }),
    seedFixtures: async () => { seeded = true; },
    buildLiveCommand: ({ commandCredential }) => { assert.equal(commandCredential, "device-credential-secret"); return { entryId: liveEntryId, operationId: plan.operationIds.live, authentication: "signed-command-secret" }; },
  });

  assert.equal(journal.phase, "verified");
  assert.equal(evidence.outcomes.acceptance, true);
  assert.equal(evidence.outcomes.cleanupComplete, false);
  assert.equal(evidence.counts.fixtureRows, plan.rows.length);
  assert.equal(evidence.counts.choiceRevision, 1);
  assert.equal(evidence.counts.liveRevision, 1);
  assert.equal(requests.filter(({ path }) => path.endsWith("/live/state")).length, 2);
  assert.deepEqual(evidence.outcomes.security, { wrongOrigin: true, missingCsrf: true, missingSession: true, retiredSessionReplay: true, participantOrganizer: true });
  assert.equal(requests.filter(({ path, init }) => path.endsWith("/context") && new Headers(init.headers).get("cookie") === participantCookie).length, 2);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /participant-secret|organizer-secret|device-credential|signed-command|tokenHash|candidate|body/i);
  assert.ok(requests.filter(({ init }) => init.method && init.method !== "GET").every(({ init }) => new Headers(init.headers).get("origin") === identity.origin || new Headers(init.headers).get("origin") === "https://wrong-origin.invalid"));
});

test("deployed acceptance fails closed unless the live command appears only after execution with matching revision and state", async (t) => {
  const liveEntryId = "entry_synthetic_staging";
  const cases = [
    { name: "entry already exists", before: { revision: 0, entries: [{ id: liveEntryId, state: "queued" }] }, after: { revision: 1, entries: [{ id: liveEntryId, state: "queued" }] }, result: { revision: 1, entry: { id: liveEntryId, state: "queued" } }, error: /synthetic live entry existed before command/ },
    { name: "revision differs", before: { revision: 0, entries: [] }, after: { revision: 2, entries: [{ id: liveEntryId, state: "queued" }] }, result: { revision: 1, entry: { id: liveEntryId, state: "queued" } }, error: /live state readback mismatch/ },
    { name: "entry is absent", before: { revision: 0, entries: [] }, after: { revision: 1, entries: [] }, result: { revision: 1, entry: { id: liveEntryId, state: "queued" } }, error: /live state readback mismatch/ },
    { name: "entry state differs", before: { revision: 0, entries: [] }, after: { revision: 1, entries: [{ id: liveEntryId, state: "current" }] }, result: { revision: 1, entry: { id: liveEntryId, state: "queued" } }, error: /live state readback mismatch/ },
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    const journal = createJournal({ runId: `run-live-${scenario.name.replaceAll(" ", "-")}`, owner: "owner-a", sourceSha: "d".repeat(40), identity });
    journal.phase = "worker-deployed";
    const organizerToken = "organizer-live-token";
    const plan = await createSyntheticFixturePlan({ runId: journal.runId, organizerToken, preFixtureBookmark: "bookmark-live" });
    const participantCookie = "woodshed_session_1234567890abcdef=participant-live-token";
    let seeded = false, loggedOut = false, ballotWritten = false, liveStateReads = 0;
    const fetch = async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname, headers = new Headers(init.headers), method = init.method ?? "GET";
      if (method !== "GET" && (headers.get("origin") !== identity.origin || headers.get("x-csrf-token") !== "same-origin")) return response(403, { error: "denied" });
      if (path === "/api/discovery") return response(200, { events: [{ id: plan.eventId }] });
      if (path.endsWith("/join-open")) return response(200, {}, { "set-cookie": `${participantCookie}; Path=/; HttpOnly; Secure; SameSite=Lax` });
      const cookie = headers.get("cookie"), bearer = headers.get("authorization");
      if (path.endsWith("/context")) return cookie === participantCookie && !loggedOut ? response(200) : response(401);
      if (path.endsWith("/ballot") && method === "GET") return cookie === participantCookie ? response(200, { revision: ballotWritten ? 1 : 0, candidates: (ballotWritten ? [...plan.songIds].reverse() : plan.songIds).map((id) => ({ id })) }) : response(401);
      if (path.endsWith("/ballot") && method === "PUT") { ballotWritten = true; return response(200, { revision: 1 }); }
      if (path.endsWith("/proposals")) return response(201, { state: "eligible" });
      if (path.endsWith("/authority/acquire")) return bearer === `Bearer ${organizerToken}` ? response(200, { epoch: 1, commandCredential: "credential" }) : response(403);
      if (path.endsWith("/live/commands")) return response(200, scenario.result);
      if (path.endsWith("/live/state")) return response(200, liveStateReads++ === 0 ? scenario.before : scenario.after);
      if (path === "/api/logout") { loggedOut = true; return response(204, undefined, { "set-cookie": "woodshed_session_1234567890abcdef=; Max-Age=0; Path=/" }); }
      return response(404);
    };

    await assert.rejects(runDeployedAcceptance({
      origin: identity.origin, journal, plan, organizerToken, fetch, persistJournal: async () => {},
      inspectFixtures: async () => ({ complete: seeded, count: seeded ? plan.rows.length : 0 }), seedFixtures: async () => { seeded = true; },
      buildLiveCommand: () => ({ entryId: liveEntryId, operationId: plan.operationIds.live, authentication: "signed-command-secret" }),
    }), scenario.error);
    assert.equal(journal.phase, "verified");
    assert.equal(journal.acceptance!.status, "failed");
  });
});

test("failed fixture or deployed response records verification completion without claiming quarantine or cleanup", async () => {
  const journal = createJournal({ runId: "run-c", owner: "owner-a", sourceSha: "c".repeat(40), identity });
  journal.phase = "worker-deployed";
  const plan = await createSyntheticFixturePlan({ runId: journal.runId, organizerToken: "organizer-token", preFixtureBookmark: "bookmark-c" });
  await assert.rejects(runDeployedAcceptance({
    origin: identity.origin, journal, plan, organizerToken: "organizer-token",
    persistJournal: async () => {}, inspectFixtures: async () => ({ complete: false, count: 0 }),
    seedFixtures: async () => { throw new Error("D1 unavailable"); },
    fetch: async () => assert.fail("HTTP must not run"), buildLiveCommand: () => ({}),
  }), /fixture seed failed/);
  assert.equal(journal.phase, "verified");
  assert.equal(journal.acceptance!.cleanupComplete, false);
});


function deployedFixture(runId = "fixture-contract") {
  const journal = createJournal({ runId, owner: "synthetic-owner", sourceSha: "a".repeat(40), identity });
  journal.phase = "worker-deployed";
  const plan = createSyntheticFixturePlan({ runId, organizerToken: "synthetic-organizer", preFixtureBookmark: "bookmark-before" });
  return { journal, plan };
}

test("synthetic plans reject invalid credentials, bookmarks and run identifiers", () => {
  const valid = { runId: "run-valid", organizerToken: "synthetic-token", preFixtureBookmark: "bookmark" };
  for (const organizerToken of [undefined, null, 10, "", "short"]) assert.throws(() => createSyntheticFixturePlan({ ...valid, organizerToken } as never), /organizer token/);
  for (const preFixtureBookmark of [undefined, null, 10, ""]) assert.throws(() => createSyntheticFixturePlan({ ...valid, preFixtureBookmark } as never), /bookmark/);
  for (const runId of [undefined, null, 10, "", "../run/one", "has space", "x".repeat(129)]) assert.throws(() => createSyntheticFixturePlan({ ...valid, runId } as never), /run ID/);
  const first = createSyntheticFixturePlan(valid);
  assert.deepEqual(createSyntheticFixturePlan(valid), first);
  assert.notEqual(createSyntheticFixturePlan({ ...valid, runId: "other-run" }).eventId, first.eventId);
  assert.equal(createSyntheticFixturePlan({ ...valid, runId: "x".repeat(128) }).rows.length, 8);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.operationIds));
  assert.equal(first.durableObjectIdentity, first.eventId);
  assert.equal(new Set(first.rows.map(({ table, key }) => `${table}:${key}`)).size, 8);
});

test("fixture preconditions reject wrong ownership and missing boundaries before any writes", async () => {
  const { journal, plan } = deployedFixture();
  let writes = 0;
  const options = { journal, plan, persistJournal: async () => { writes++; }, inspect: async () => ({ complete: false, count: 0 }), seed: async () => { writes++; } };
  await assert.rejects(seedSyntheticFixtures({ ...options, plan: { ...plan, runId: "another-run" } }), /does not belong/);
  journal.phase = "pre-write";
  await assert.rejects(seedSyntheticFixtures(options), /does not belong/);
  journal.phase = "worker-deployed";
  for (const key of ["persistJournal", "inspect", "seed"]) await assert.rejects(seedSyntheticFixtures({ ...options, [key]: undefined } as never), /boundaries/);
  assert.equal(writes, 0);
  assert.equal(journal.acceptance, undefined);
  assert.deepEqual(journal.mutations, []);
});

test("fixture reconciliation rejects partial states, failed postconditions, and incomplete response loss", async () => {
  for (const before of [{ complete: false, count: 1 }, { complete: true, count: 7 }, { complete: false, count: 8 }]) {
    const { journal, plan } = deployedFixture();
    await assert.rejects(seedSyntheticFixtures({ journal, plan, persistJournal: async () => {}, inspect: async () => before, seed: async () => assert.fail("must not seed partial state") }), /partial synthetic/);
  }
  for (const after of [{ complete: false, count: 0 }, { complete: true, count: 7 }, { complete: false, count: 8 }]) {
    const { journal, plan } = deployedFixture();
    let reads = 0;
    await assert.rejects(seedSyntheticFixtures({ journal, plan, persistJournal: async () => {}, inspect: async () => reads++ === 0 ? { complete: false, count: 0 } : after, seed: async () => {} }), /postcondition/);
    assert.equal(reads, 2);
  }
  const { journal, plan } = deployedFixture();
  const cause = new Error("write lost before completion");
  await assert.rejects(seedSyntheticFixtures({ journal, plan, persistJournal: async () => {}, inspect: async () => ({ complete: false, count: 0 }), seed: async () => { throw cause; } }), (error: unknown) => error instanceof Error && error.cause === cause && /requires quarantine/.test(error.message));
});

test("fixture journal persistence failure stops before inspection and seeding", async () => {
  const { journal, plan } = deployedFixture();
  await assert.rejects(seedSyntheticFixtures({ journal, plan, persistJournal: async () => { throw new Error("disk full"); }, inspect: async () => assert.fail("inspection after failed journal"), seed: async () => assert.fail("write after failed journal") }), /disk full/);
});

test("fixture ownership survives disk reload and reconciles real SQLite writes without replay", async t => {
  const directory = await mkdtemp(join(tmpdir(), "woodshed-fixture-ownership-"));
  let db: DatabaseSync | undefined;
  t.after(async () => { try { db?.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const file = join(directory, "journal.json");
  db = new DatabaseSync(join(directory, "fixtures.sqlite"));
  const { journal, plan } = deployedFixture();
  db.exec("CREATE TABLE synthetic_rows (table_name TEXT NOT NULL, row_key TEXT NOT NULL, PRIMARY KEY(table_name,row_key))");
  const inspect = async () => {
    const count = plan.rows.filter(({ table, key }) => db!.prepare("SELECT 1 FROM synthetic_rows WHERE table_name=? AND row_key=?").get(table, key)).length;
    return { complete: count === plan.rows.length, count };
  };
  let writes = 0;
  const seed = async () => {
    const persisted = await loadJournal(file);
    assert.deepEqual(persisted.acceptance!.fixturePlan!.rows, plan.rows);
    assert.deepEqual(persisted.mutations.at(-1), { kind: "synthetic-fixture-batch", operationId: plan.operationIds.join, status: "planned" });
    for (const row of plan.rows) { db!.prepare("INSERT INTO synthetic_rows VALUES (?,?)").run(row.table, row.key); writes++; }
  };
  assert.deepEqual(await seedSyntheticFixtures({ journal, plan, persistJournal: (value) => saveJournal(file, value), inspect, seed }), { reconciled: false, count: 8 });
  assert.deepEqual(await seedSyntheticFixtures({ journal: await loadJournal(file), plan, persistJournal: (value) => saveJournal(file, value), inspect, seed }), { reconciled: true, count: 8 });
  assert.equal(writes, 8);
  assert.doesNotMatch(await readFile(file, "utf8"), /synthetic-organizer/);
});


test("deployed acceptance executes the real Worker, D1, Durable Object and persisted ownership chain", async t => {
  const directory = await mkdtemp(join(tmpdir(), "woodshed-acceptance-chain-"));
  let runtime: Miniflare | undefined;
  t.after(async () => { try { await runtime?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const file = join(directory, "journal.json");
  const { journal, plan } = deployedFixture("real-acceptance-chain");
  const bundled = await build({ entryPoints: ["apps/api-worker/src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"], target: "es2022" });
  runtime = new Miniflare({
    compatibilityDate: "2025-07-18", modules: true, compatibilityFlags: ["nodejs_compat"], script: bundled.outputFiles[0]!.text,
    d1Databases: { DB: "synthetic-staging-acceptance" },
    durableObjects: { LIVE_COORDINATOR: "LiveCoordinator" },
    bindings: { APP_ORIGIN: identity.origin, LIVE_COMMAND_SECRET: "synthetic-live-secret", CLOCK_ISO: "2030-01-01T12:01:00.000Z" },
  });
  const db = await runtime.getD1Database("DB");
  for (const name of ["001_first_loop.sql", "002_participant_choice.sql", "003_rehearsal_coordination.sql", "004_live_performance.sql", "005_coordination_repository.sql", "006_worker_runtime.sql", "007_open_join_receipts.sql", "008_ballot_lifecycle_guard.sql", "008_runtime_quota_indexes.sql"]) await db.exec(await readFile(new URL(`../../../migrations/d1/${name}`, import.meta.url), "utf8"));
  const evidence = await runDeployedAcceptance({
    origin: identity.origin, journal, plan, organizerToken: "synthetic-organizer",
    persistJournal: (value) => saveJournal(file, value),
    inspectFixtures: async () => {
      const counts = await Promise.all([
        db.prepare("SELECT count(*) n FROM communities WHERE id=?").bind(plan.communityId).first<number>("n"),
        db.prepare("SELECT count(*) n FROM events WHERE id=?").bind(plan.eventId).first<number>("n"),
        db.prepare("SELECT count(*) n FROM canonical_songs WHERE id IN (?,?)").bind(...plan.songIds).first<number>("n"),
        db.prepare("SELECT count(*) n FROM event_eligible_songs WHERE event_id=?").bind(plan.eventId).first<number>("n"),
        db.prepare("SELECT count(*) n FROM guest_participations WHERE id=?").bind(plan.organizerParticipationId).first<number>("n"),
        db.prepare("SELECT count(*) n FROM participant_sessions WHERE id_hash=?").bind(plan.tokenHash).first<number>("n"),
      ]);
      const count = counts.reduce<number>((sum, n) => sum + (n ?? 0), 0);
      return { complete: count === 8, count };
    },
    seedFixtures: async () => {
      assert.deepEqual((await loadJournal(file)).acceptance!.fixturePlan!.rows, plan.rows);
      await db.batch([
        db.prepare("INSERT INTO communities(id,name) VALUES (?,?)").bind(plan.communityId, "Synthetic Circle"),
        db.prepare("INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES (?,?,?,'live','public','open')").bind(plan.eventId, plan.communityId, "Synthetic Event"),
        ...plan.songIds.map((id, index) => db.prepare("INSERT INTO canonical_songs(id,community_id,title) VALUES (?,?,?)").bind(id, plan.communityId, `Synthetic Song ${index}`)),
        ...plan.songIds.map((id) => db.prepare("INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES (?,?,?)").bind(plan.eventId, id, "2030-01-01T00:00:00Z")),
        db.prepare("INSERT INTO guest_participations(id,community_id,event_id) VALUES (?,?,?)").bind(plan.organizerParticipationId, plan.communityId, plan.eventId),
        db.prepare("INSERT INTO participant_sessions(id_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (?,?,?,?,'community-admin','invite',?)").bind(plan.tokenHash, plan.organizerParticipationId, plan.communityId, plan.eventId, "2031-01-01T00:00:00Z"),
      ]);
    },
    fetch: async (url, init) => {
      const response = await runtime!.dispatchFetch(url, init as never);
      return new Response(response.status === 204 ? null : await response.text(), { status: response.status, headers: [...response.headers] });
    },
    buildLiveCommand: ({ commandCredential, authorityEpoch }) => {
      const command = { schemaVersion: 1, communityId: plan.communityId, eventId: plan.eventId, actorId: plan.organizerParticipationId, deviceInstallationId: plan.deviceInstallationId, authorityEpoch, baseRevision: 0, operationId: plan.operationIds.live, issuedAt: "2030-01-01T12:00:00.000Z", expiresAt: "2030-01-01T12:05:00.000Z", action: "queue", entryId: "entry_synthetic_acceptance", payload: { songId: plan.songIds[0] } };
      const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
      return { ...command, authentication: createHmac("sha256", commandCredential).update(canonical(command)).digest("hex") };
    },
  });
  assert.equal(evidence.outcomes.acceptance, true);
  assert.deepEqual(evidence.counts, { fixtureRows: 8, choiceRevision: 1, liveRevision: 1, liveEntries: 1 });
  const persisted = await loadJournal(file);
  assert.equal(persisted.phase, "verified");
  assert.equal(persisted.acceptance!.status, "passed");
  assert.equal(await db.prepare("SELECT count(*) n FROM live_queue_entries WHERE event_id=?").bind(plan.eventId).first<number>("n"), 1);
  assert.equal(await db.prepare("SELECT count(*) n FROM open_join_receipts WHERE event_id=?").bind(plan.eventId).first<number>("n"), 1);
  assert.doesNotMatch(await readFile(file, "utf8"), /synthetic-organizer|synthetic-live-secret/);
});

test("acceptance validates deployment, HTTPS origin and required boundaries before persistence", async () => {
  const { journal, plan } = deployedFixture();
  const options = { origin: identity.origin, journal, plan, organizerToken: "synthetic-organizer", fetch: async () => assert.fail("unexpected request"), persistJournal: async () => assert.fail("unexpected persistence"), inspectFixtures: async () => ({ complete: true, count: 8 }), seedFixtures: async () => {}, buildLiveCommand: () => ({}) };
  journal.phase = "pre-write";
  await assert.rejects(runDeployedAcceptance(options), /immutable deployed Worker/);
  journal.phase = "worker-deployed";
  await assert.rejects(runDeployedAcceptance({ ...options, origin: "https://other.invalid" }), /HTTPS origin/);
  const insecure = "http://woodshed-staging.invalid";
  journal.identity.origin = insecure;
  await assert.rejects(runDeployedAcceptance({ ...options, origin: insecure }), /HTTPS origin/);
  journal.identity.origin = identity.origin;
  for (const key of ["organizerToken", "fetch", "buildLiveCommand"]) await assert.rejects(runDeployedAcceptance({ ...options, [key]: undefined } as never), /boundaries/);
  assert.equal(journal.acceptance, undefined);
});

type AcceptanceFault = { stage: string; value?: unknown; status?: number; cookie?: string; malformed?: boolean; command?: unknown; error: RegExp };
const acceptanceFaults: AcceptanceFault[] = [
  { stage: "discovery", status: 503, error: /discovery returned unexpected status 503/ },
  { stage: "discovery", malformed: true, error: /discovery returned malformed JSON/ },
  { stage: "discovery", value: null, error: /absent from discovery/ },
  { stage: "discovery", value: { events: [] }, error: /absent from discovery/ },
  { stage: "join", status: 409, error: /join returned unexpected status 409/ },
  ...["", "woodshed_session_wrong=secret; Path=/; HttpOnly; Secure; SameSite=Lax", "woodshed_session_1234567890abcdef=secret; HttpOnly; Secure; SameSite=Lax", "woodshed_session_1234567890abcdef=secret; Path=/; Secure; SameSite=Lax", "woodshed_session_1234567890abcdef=secret; Path=/; HttpOnly; SameSite=Lax", "woodshed_session_1234567890abcdef=secret; Path=/; HttpOnly; Secure; SameSite=Strict"].map(cookie => ({ stage: "join", cookie, error: /join cookie contract/ })),
  { stage: "ballot", value: { revision: 0.5, candidates: [] }, error: /ballot response contract/ },
  { stage: "ballot", value: { revision: 0 }, error: /ballot response contract/ },
  { stage: "readback", value: { revision: 2, candidates: [] }, error: /ballot readback mismatch/ },
  { stage: "readback", value: { revision: 1, candidates: [] }, error: /ballot readback mismatch/ },
  { stage: "proposal", value: { state: "submitted" }, error: /proposal policy contract/ },
  { stage: "authority", value: { epoch: 1.5, commandCredential: "credential" }, error: /authority response contract/ },
  { stage: "authority", value: { epoch: 1, commandCredential: "" }, error: /authority response contract/ },
  { stage: "authority", value: { epoch: 1, commandCredential: 10 }, error: /authority response contract/ },
  ...[null, "string", {}, { entryId: "" }].map(command => ({ stage: "command", command, error: /live command contract/ })),
  { stage: "before", value: { revision: 0.5, entries: [] }, error: /initial live state contract/ },
  { stage: "before", value: { revision: 0 }, error: /initial live state contract/ },
  { stage: "logout", cookie: "", error: /logout did not clear/ },
  ...["wrong-origin", "csrf", "missing-session", "participant-authority", "after-logout"].map(stage => ({ stage, status: 200, error: /deployed security matrix/ })),
  { stage: "live-result", value: { revision: 0.5, entry: { id: "entry", state: "queued" } }, error: /live response contract/ },
  { stage: "live-result", value: { revision: 1 }, error: /live response contract/ },
  { stage: "live-result", value: { revision: 1, entry: { id: "entry", state: 1 } }, error: /live response contract/ },
  { stage: "after", value: { revision: 1.5, entries: [] }, error: /live response contract/ },
  { stage: "after", value: { revision: 1 }, error: /live response contract/ },
  { stage: "live-result", value: { revision: 1, entry: { id: "different-entry", state: "queued" } }, error: /live state readback mismatch/ },
];

for (const [index, fault] of acceptanceFaults.entries()) test(`acceptance records contract fault ${index + 1} at ${fault.stage}`, async () => {
  const { journal, plan } = deployedFixture(`acceptance-fault-${index}`);
  const participantCookie = "woodshed_session_1234567890abcdef=synthetic-participant";
  let written = false, liveWritten = false, loggedOut = false;
  const persisted: unknown[] = [];
  const response = (stage: string, status: number, value: unknown = {}, cookie?: string) => {
    if (stage === fault.stage) {
      status = fault.status ?? status;
      if (Object.hasOwn(fault, "value")) value = fault.value;
      cookie = fault.cookie ?? cookie;
    }
    return new Response(status === 204 ? null : stage === fault.stage && fault.malformed ? "invalid json" : JSON.stringify(value), { status, headers: { "content-type": "application/json", ...(cookie !== undefined ? { "set-cookie": cookie } : {}) } });
  };
  await assert.rejects(runDeployedAcceptance({
    origin: identity.origin, journal, plan, organizerToken: "synthetic-organizer",
    persistJournal: async (value) => { persisted.push(structuredClone(value)); },
    inspectFixtures: async () => ({ complete: true, count: 8 }), seedFixtures: async () => assert.fail("already seeded"),
    buildLiveCommand: () => fault.stage === "command" ? fault.command : { entryId: "entry" },
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname, headers = new Headers(init.headers), method = init.method ?? "GET";
      if (headers.get("origin") === "https://wrong-origin.invalid") return response("wrong-origin", 403);
      if (method === "POST" && !headers.has("x-csrf-token")) return response("csrf", 403);
      if (path === "/api/discovery") return response("discovery", 200, { events: [{ id: plan.eventId }] });
      if (path.endsWith("/join-open")) return response("join", 200, {}, `${participantCookie}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      if (path.endsWith("/context")) return response(loggedOut ? "after-logout" : "context", loggedOut ? 401 : 200);
      if (path.endsWith("/ballot")) {
        if (!headers.has("cookie")) return response("missing-session", 401);
        if (method === "PUT") { written = true; return response("ballot-write", 200, { revision: 1 }); }
        return response(written ? "readback" : "ballot", 200, { revision: written ? 1 : 0, candidates: (written ? [...plan.songIds].reverse() : plan.songIds).map(id => ({ id })) });
      }
      if (path.endsWith("/proposals")) return response("proposal", 201, { state: "eligible" });
      if (path.endsWith("/authority/acquire")) return headers.has("cookie") ? response("participant-authority", 403) : response("authority", 200, { epoch: 1, commandCredential: "credential" });
      if (path.endsWith("/live/commands")) { liveWritten = true; return response("live-result", 200, { revision: 1, entry: { id: "entry", state: "queued" } }); }
      if (path.endsWith("/live/state")) return response(liveWritten ? "after" : "before", 200, { revision: liveWritten ? 1 : 0, entries: liveWritten ? [{ id: "entry", state: "queued" }] : [] });
      if (path === "/api/logout") { loggedOut = true; return response("logout", 204, undefined, "woodshed_session_1234567890abcdef=; Max-Age=0; Path=/"); }
      assert.fail(`unexpected route ${path}`);
    },
  }), fault.error);
  assert.equal(journal.phase, "verified");
  assert.equal(journal.acceptance!.status, "failed");
  assert.equal(journal.acceptance!.cleanupComplete, false);
  assert.deepEqual(persisted.at(-1), journal);
});


test("offline Cloudflare smoke CLI validates configured bundle, migrations and SQLite Durable Object", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../tools/cloudflare-smoke.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) },
  });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Cloudflare smoke passed: ${D1_MIGRATIONS.length} migrations, bundled Worker, D1, Durable Object, participant loop.`);
});
