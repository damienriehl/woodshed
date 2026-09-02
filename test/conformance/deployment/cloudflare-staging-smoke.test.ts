import assert from "node:assert/strict";
import test from "node:test";

import { createJournal } from "../../../tools/cloudflare/journal.mjs";
import { createSyntheticFixturePlan, seedSyntheticFixtures } from "../../../tools/cloudflare/staging-fixtures.mjs";
import { runDeployedAcceptance } from "../../../tools/cloudflare/staging-smoke.mjs";

const identity = { accountId: "a".repeat(32), databaseId: "11111111-1111-4111-8111-111111111111", databaseName: "woodshed-staging-run-a", workerName: "woodshed-staging-run-a", origin: "https://woodshed-staging.invalid" };

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
  const response = (status: number, body: unknown = {}, headers?: HeadersInit) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
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
    const response = (status: number, value: unknown = {}, headers?: HeadersInit) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
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
