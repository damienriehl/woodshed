import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import worker, { type WorkerBindings } from "../../apps/api-worker/src/index.ts";
import { LiveCoordinator } from "../../apps/api-worker/src/live-do.ts";
import { D1ChoiceRuntime } from "../../packages/storage-d1/src/choice-runtime.ts";

const origin = "https://woodshed.example";
const liveSecret = "test-live-command-secret";
const sessionToken = "test-organizer-session";
const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
const baseMigrationSql = Promise.all(["001_first_loop.sql", "002_participant_choice.sql", "003_rehearsal_coordination.sql", "004_live_performance.sql", "005_coordination_repository.sql", "006_worker_runtime.sql", "007_open_join_receipts.sql"].map(name => readFile(new URL(`../../migrations/d1/${name}`, import.meta.url), "utf8")));
const ballotLifecycleMigrationSql = readFile(new URL("../../migrations/d1/008_ballot_lifecycle_guard.sql", import.meta.url), "utf8");
const runtimeQuotaMigrationSql = readFile(new URL("../../migrations/d1/008_runtime_quota_indexes.sql", import.meta.url), "utf8");

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string) { return Promise.resolve(this.values.get(key) as T | undefined); }
  put<T>(key: string, value: T) { this.values.set(key, value); return Promise.resolve(); }
  delete(key: string) { return Promise.resolve(this.values.delete(key)); }
  transaction<T>(body: () => Promise<T>) { return body(); }
}

function authorityNamespace(): DurableObjectNamespace {
  const objects = new Map<string, LiveCoordinator>();
  return {
    idFromName(name: string) { return { toString: () => name } as never; },
    get(id: { toString(): string }) {
      const key = id.toString();
      let object = objects.get(key);
      if (!object) {
        object = new LiveCoordinator({ storage: new MemoryDurableStorage() } as never);
        objects.set(key, object);
      }
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => object!.fetch(new Request(input, init)) } as never;
    },
  } as unknown as DurableObjectNamespace;
}

async function signedCommand(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    schemaVersion: 1,
    communityId: "community_demo",
    eventId: "event_public",
    actorId: "participation_host",
    deviceInstallationId: "device_stage",
    authorityEpoch: 1,
    baseRevision: 0,
    operationId: "operation_live_one",
    issuedAt: "2030-01-01T12:00:00.000Z",
    expiresAt: "2030-01-01T12:05:00.000Z",
    action: "queue",
    entryId: "entry_song_alpha",
    payload: { songId: "song_alpha" },
    ...overrides,
  };
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
      : JSON.stringify(value);
  const credential=createHmac("sha256",liveSecret).update(JSON.stringify(`${unsigned.communityId}\0${unsigned.eventId}\0${unsigned.deviceInstallationId}`)).digest("hex");
  return { ...unsigned, authentication: createHmac("sha256", credential).update(canonical(unsigned)).digest("hex") };
}

describe("Cloudflare Worker runtime", () => {
  it("exposes only the non-sensitive frozen release marker when staging bindings are present", async () => {
    const sourceSha = "a".repeat(40), configDigest = "b".repeat(64);
    const response = await worker.fetch(new Request(`${origin}/api/staging-release`), {
      DB: {} as D1Database, LIVE_COORDINATOR: authorityNamespace(), APP_ORIGIN: origin,
      LIVE_COMMAND_SECRET: liveSecret, WOODSHED_SOURCE_SHA: sourceSha, WOODSHED_CONFIG_DIGEST: configDigest,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sourceSha, configDigest, lifecycle: "legacy-sqlite-v1", bindings: ["APP_ORIGIN", "DB", "LIVE_COMMAND_SECRET", "LIVE_COORDINATOR"] });

    const absent = await worker.fetch(new Request(`${origin}/api/staging-release`), {
      DB: {} as D1Database, LIVE_COORDINATOR: authorityNamespace(), APP_ORIGIN: origin, LIVE_COMMAND_SECRET: liveSecret,
    });
    assert.equal(absent.status, 404);

    for (const markers of [
      { WOODSHED_SOURCE_SHA: "invalid", WOODSHED_CONFIG_DIGEST: configDigest },
      { WOODSHED_SOURCE_SHA: sourceSha, WOODSHED_CONFIG_DIGEST: "invalid" },
    ]) {
      const malformed = await worker.fetch(new Request(`${origin}/api/staging-release`), {
        DB: {} as D1Database, LIVE_COORDINATOR: authorityNamespace(), APP_ORIGIN: origin, LIVE_COMMAND_SECRET: liveSecret, ...markers,
      });
      assert.equal(malformed.status, 404);
    }
  });

  it("completes the accountless participant first loop with event-scoped sessions", async () => {
    const fixture = await runtime();
    try {
      const joined = await fixture.fetch("/api/events/event_public/join-open", {
        method: "POST",
        headers: fixture.mutationHeaders(),
        body: JSON.stringify({ operationId: "join_worker_first_loop" }),
      });
      assert.equal(joined.status, 200);
      assert.deepEqual(await joined.json(), { assurance: "open-public" });
      const cookie = joined.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      assert.match(cookie, /^woodshed_session_[0-9a-f]{16}=/);
      assert.match(joined.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Lax/);

      const context = await fixture.fetch("/api/events/event_public/context", { headers: { cookie } });
      assert.equal(context.status, 200);
      assert.deepEqual(await context.json(), { event: { id: "event_public", name: "Singalong", state: "live", visibility: "public", participationPolicy: "open" } });
      assert.equal((await fixture.fetch("/api/events/event_other/context", { headers: { cookie } })).status, 401);
      assert.equal((await fixture.fetch("/api/events/event_public/context", { headers: { cookie: "woodshed_session_bad=%E0%A4%A" } })).status, 401);
      assert.equal((await fixture.fetch("/api/events/event_public/ballot", { headers: { cookie } })).status, 200);

      const proposed = await fixture.fetch("/api/events/event_public/proposals", {
        method: "POST",
        headers: fixture.mutationHeaders(cookie),
        body: JSON.stringify({ title: "Lantern Song", operationId: "proposal_worker_one" }),
      });
      assert.equal(proposed.status, 201);
      const participation = await fixture.DB.prepare("SELECT participation_id FROM open_join_receipts WHERE event_id=? AND operation_id=?").bind("event_public", "join_worker_first_loop").first<{ participation_id: string }>();
      const proposal = await proposed.json();
      assert.deepEqual(proposal, {
        id: `proposal_${createHash("sha256").update(`${participation!.participation_id}:proposal_worker_one`).digest("hex").slice(0, 24)}`,
        title: "Lantern Song",
        state: "submitted",
      });
      assert.deepEqual(await (await fixture.fetch("/api/events/event_public/proposals", {
        method: "POST", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ title: "Lantern Song", operationId: "proposal_worker_one" }),
      })).json(), proposal);
      const mismatch = await fixture.fetch("/api/events/event_public/proposals", {
        method: "POST", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ title: "Changed Song", operationId: "proposal_worker_one" }),
      });
      assert.equal(mismatch.status, 409);
      assert.deepEqual(await mismatch.json(), { error: "replay-mismatch" });
      assert.equal((await fixture.fetch("/api/events/event_public/proposals", { method: "POST", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ title: "Second Song", operationId: "proposal_worker_two" }) })).status, 201);
      const quotaRace = await Promise.all([["proposal_worker_three", "Third Song"], ["proposal_worker_four", "Fourth Song"]].map(([operationId, title]) => fixture.fetch("/api/events/event_public/proposals", { method: "POST", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ title, operationId }) })));
      assert.deepEqual(quotaRace.map(response => response.status).sort(), [201, 400]);
      const overQuota = quotaRace.find(response => response.status === 400)!;
      assert.deepEqual(await overQuota.json(), { error: "quota-exceeded" });
      assert.equal((await fixture.DB.prepare("SELECT count(*) AS count FROM choice_proposals WHERE event_id=? AND participation_id=(SELECT participation_id FROM open_join_receipts WHERE event_id=? AND operation_id=?)").bind("event_public", "event_public", "join_worker_first_loop").first<{ count: number }>())?.count, 3);

      assert.equal((await fixture.fetch("/api/events/event_public/join-open", {
        method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: "join_worker_first_loop" }),
      })).status, 409);
      const replay = await fixture.fetch("/api/events/event_public/join-open", {
        method: "POST", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ operationId: "join_worker_first_loop" }),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get("set-cookie")?.split(";", 1)[0], cookie);

      const otherJoin = await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: "join_worker_other" }) });
      const otherCookie = otherJoin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      assert.equal((await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(otherCookie), body: JSON.stringify({ operationId: "join_worker_first_loop" }) })).status, 409);

      const expiredJoin = await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: "join_worker_expired" }) });
      const expiredCookie = expiredJoin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const expiredParticipation = await fixture.DB.prepare("SELECT participation_id FROM open_join_receipts WHERE event_id=? AND operation_id=?").bind("event_public", "join_worker_expired").first<{ participation_id: string }>();
      await fixture.DB.prepare("UPDATE participant_sessions SET expires_at=? WHERE participation_id=?").bind("2029-01-01T00:00:00Z", expiredParticipation!.participation_id).run();
      assert.equal((await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(expiredCookie), body: JSON.stringify({ operationId: "join_worker_expired" }) })).status, 409);

      const revokedJoin = await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: "join_worker_revoked" }) });
      const revokedCookie = revokedJoin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const revokedParticipation = await fixture.DB.prepare("SELECT participation_id FROM open_join_receipts WHERE event_id=? AND operation_id=?").bind("event_public", "join_worker_revoked").first<{ participation_id: string }>();
      await fixture.DB.prepare("UPDATE participant_sessions SET revoked_at=? WHERE participation_id=?").bind("2030-01-01T00:00:00Z", revokedParticipation!.participation_id).run();
      assert.equal((await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(revokedCookie), body: JSON.stringify({ operationId: "join_worker_revoked" }) })).status, 409);

      const logout = await fixture.fetch("/api/logout", { method: "POST", headers: fixture.mutationHeaders(`${cookie}; woodshed_session_deadbeefdeadbeef=another`) });
      assert.equal(logout.status, 204);
      assert.equal(logout.headers.getSetCookie().filter(value => /Max-Age=0/.test(value)).length, 2);
      assert.equal((await fixture.fetch("/api/events/event_public/context", { headers: { cookie } })).status, 401);

      const bearerLogout = await fixture.fetch("/api/logout", { method: "POST", headers: fixture.authHeaders(true) });
      assert.equal(bearerLogout.status, 204);
      assert.equal((await fixture.fetch("/api/events/event_public/context", { headers: fixture.authHeaders() })).status, 401);

      await fixture.DB.prepare("UPDATE guest_participations SET revoked_at=? WHERE id=?").bind("2030-01-01T12:02:00.000Z", participation!.participation_id).run();
      assert.equal((await fixture.fetch("/api/events/event_public/context", { headers: { cookie } })).status, 401);
    } finally { await fixture.close(); }
  });

  it("denies accountless joins for private and unlisted open events without persistence", async () => {
    const fixture = await runtime();
    try {
      for (const eventId of ["event_private_open", "event_unlisted_open"]) {
        const response = await fixture.fetch(`/api/events/${eventId}/join-open`, { method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: `join_${eventId}` }) });
        assert.equal(response.status, 403);
      }
      for (const table of ["guest_participations", "participant_sessions", "open_join_receipts"]) {
        const query = `SELECT count(*) AS count FROM ${table} WHERE event_id IN ('event_private_open','event_unlisted_open')`;
        assert.equal((await fixture.DB.prepare(query).first<{ count: number }>())?.count, 0);
      }
    } finally { await fixture.close(); }
  });

  it("returns 500 when replay session lookup fails operationally", async () => {
    const fixture = await runtime();
    try {
      const joined = await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: "join_operational_failure" }) });
      const cookie = joined.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const response = await fixture.fetchWithDatabase(sessionLookupFailure(fixture.DB), "/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ operationId: "join_operational_failure" }) });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "internal-error" });
    } finally { await fixture.close(); }
  });

  it("omits Secure from accountless session cookies at a local HTTP origin", async () => {
    const fixture = await runtime(`http://${"local" + "host"}:8787`);
    try {
      const joined = await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: "join_local_http" }) });
      assert.equal(joined.status, 200);
      assert.doesNotMatch(joined.headers.get("set-cookie") ?? "", /; Secure/);
    } finally { await fixture.close(); }
  });

  it("atomically bounds concurrent open joins at the per-event capacity", async () => {
    const fixture = await runtime();
    try {
      await fixture.DB.exec("WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<9998) INSERT INTO guest_participations(id,community_id,event_id) SELECT 'participation_fill_' || value,'community_demo','event_public' FROM sequence");
      const attempts = await Promise.all(["capacity_a", "capacity_b"].map(operationId => fixture.fetch("/api/events/event_public/join-open", {
        method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId }),
      })));
      assert.deepEqual(attempts.map(response => response.status).sort(), [200, 429]);
      assert.equal((await fixture.DB.prepare("SELECT count(*) AS count FROM guest_participations WHERE event_id='event_public' AND revoked_at IS NULL").first<{ count: number }>())?.count, 10_000);
      assert.equal((await fixture.DB.prepare("SELECT count(*) AS count FROM open_join_receipts WHERE operation_id IN ('capacity_a','capacity_b')").first<{ count: number }>())?.count, 1);
      assert.equal((await fixture.DB.prepare("SELECT count(*) AS count FROM participant_sessions s JOIN open_join_receipts r ON r.participation_id=s.participation_id WHERE r.operation_id IN ('capacity_a','capacity_b')").first<{ count: number }>())?.count, 1);
      assert.equal((await fixture.DB.prepare("SELECT count(*) AS count FROM participant_sessions s LEFT JOIN guest_participations p ON p.id=s.participation_id WHERE p.id IS NULL").first<{ count: number }>())?.count, 0);
    } finally { await fixture.close(); }
  });

  it("uses the forward quota indexes for both runtime count predicates", async () => {
    const fixture = await runtime();
    try {
      const activePlan = await fixture.DB.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM guest_participations WHERE event_id=? AND revoked_at IS NULL").bind("event_public").all<{ detail: string }>();
      assert.match(activePlan.results.map(row => row.detail).join("\n"), /guest_participations_active_event_idx/);
      const proposalPlan = await fixture.DB.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM choice_proposals WHERE event_id=? AND participation_id=?").bind("event_public", "participation_host").all<{ detail: string }>();
      assert.match(proposalPlan.results.map(row => row.detail).join("\n"), /choice_proposals_event_participation_idx/);
    } finally { await fixture.close(); }
  });

  it("serves D1 discovery and authenticated ballot replacement without an injected application", async () => {
    const fixture = await runtime();
    try {
      assert.equal((await fixture.DB.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='open_join_receipts'").first<{count:number}>())?.count,1);
      const discovery = await fixture.fetch("/api/discovery");
      assert.equal(discovery.status, 200);
      assert.deepEqual((await discovery.json() as { events: { id: string }[] }).events.map(({ id }) => id), ["event_public"]);

      const joined = await fixture.fetch("/api/events/event_public/join-open", { method: "POST", headers: fixture.mutationHeaders(), body: JSON.stringify({ operationId: "join_ballot_roundtrip" }) });
      const cookie = joined.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const ballot = await fixture.fetch("/api/events/event_public/ballot", { headers: { cookie } });
      assert.equal(ballot.status, 200);
      const current = await ballot.json() as { revision: number; candidates: { id: string }[] };
      assert.equal(current.revision, 0);

      const rankings = current.candidates.map(({ id }) => id).reverse();
      const saved = await fixture.fetch("/api/events/event_public/ballot", {
        method: "PUT",
        headers: fixture.mutationHeaders(cookie),
        body: JSON.stringify({ expectedRevision: 0, rankings, operationId: "operation_ballot_one" }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json() as { revision: number }).revision, 1);
      assert.deepEqual((await (await fixture.fetch("/api/events/event_public/ballot", { headers: { cookie } })).json() as { candidates: { id: string }[] }).candidates.map(({ id }) => id), rankings);
      await fixture.DB.prepare("INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES (?,?,?)").bind("event_public", "song_charlie", "2030-01-01T12:02:00Z").run();
      assert.deepEqual((await (await fixture.fetch("/api/events/event_public/ballot", { headers: { cookie } })).json() as { candidates: { id: string }[] }).candidates.map(({ id }) => id), [...rankings, "song_charlie"]);

      await fixture.DB.prepare("UPDATE events SET state='completed' WHERE id='event_public'").run();
      assert.equal((await fixture.fetch("/api/events/event_public/ballot", { headers: {cookie} })).status,409);
      const replayAfterClose=await fixture.fetch("/api/events/event_public/ballot",{method:"PUT",headers:fixture.mutationHeaders(cookie),body:JSON.stringify({expectedRevision:0,rankings,operationId:"operation_ballot_one"})});
      assert.equal(replayAfterClose.status,409);
      assert.deepEqual(await replayAfterClose.json(),{error:"voting-closed"});
      await fixture.DB.prepare("UPDATE events SET state='voting' WHERE id='event_public'").run();

      const joinedParticipation = await fixture.DB.prepare("SELECT participation_id FROM open_join_receipts WHERE event_id=? AND operation_id=?").bind("event_public", "join_ballot_roundtrip").first<{ participation_id: string }>();
      await fixture.DB.prepare("UPDATE ballots SET state='closed' WHERE event_id=? AND participation_id=?").bind("event_public", joinedParticipation!.participation_id).run();
      const closed = await fixture.fetch("/api/events/event_public/ballot", { method: "PUT", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ expectedRevision: 1, rankings, operationId: "operation_ballot_closed" }) });
      assert.equal(closed.status, 409);
      assert.deepEqual(await closed.json(), { error: "voting-closed" });
      await fixture.DB.prepare("UPDATE ballots SET state='reopened' WHERE event_id=? AND participation_id=?").bind("event_public", joinedParticipation!.participation_id).run();
      const reopened = await fixture.fetch("/api/events/event_public/ballot", { method: "PUT", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ expectedRevision: 1, rankings, operationId: "operation_ballot_reopened" }) });
      assert.equal(reopened.status, 200);
      assert.equal((await reopened.json() as { revision: number }).revision, 2);
      await fixture.DB.prepare("UPDATE ballots SET state='final' WHERE event_id=? AND participation_id=?").bind("event_public", joinedParticipation!.participation_id).run();
      const finalized = await fixture.fetch("/api/events/event_public/ballot", { method: "PUT", headers: fixture.mutationHeaders(cookie), body: JSON.stringify({ expectedRevision: 2, rankings, operationId: "operation_ballot_final" }) });
      assert.equal(finalized.status, 409);

      const crossTenant = await fixture.fetch("/api/events/event_other/ballot", { headers: fixture.authHeaders() });
      assert.equal(crossTenant.status, 403);
    } finally { await fixture.close(); }
  });

  it("proves sessions through the participation and event scope and rejects either revocation or a non-finite expiry", async () => {
    const fixture = await runtime();
    try {
      await fixture.DB.prepare("UPDATE guest_participations SET revoked_at=? WHERE id=?").bind("2030-01-01T00:00:00Z", "participation_host").run();
      assert.equal((await fixture.fetch("/api/events/event_public/ballot", { headers: fixture.authHeaders() })).status, 401);
      await fixture.DB.prepare("UPDATE guest_participations SET revoked_at=NULL WHERE id=?").bind("participation_host").run();
      await fixture.DB.prepare("UPDATE participant_sessions SET revoked_at=? WHERE id_hash=?").bind("2030-01-01T00:00:00Z", sessionHash).run();
      assert.equal((await fixture.fetch("/api/events/event_public/ballot", { headers: fixture.authHeaders() })).status, 401);
      await fixture.DB.prepare("UPDATE participant_sessions SET revoked_at=NULL,expires_at='not-a-date' WHERE id_hash=?").bind(sessionHash).run();
      assert.equal((await fixture.fetch("/api/events/event_public/ballot", { headers: fixture.authHeaders() })).status, 401);
    } finally { await fixture.close(); }
  });

  it("rejects a ballot when voting closes after the preflight check but before the atomic write",async()=>{const fixture=await runtime();try{const choice=new D1ChoiceRuntime(fixture.DB,()=>new Date("2030-01-01T12:01:00.000Z"),async()=>{await fixture.DB.prepare("UPDATE events SET state='completed' WHERE id='event_public'").run();}),session=await choice.session(sessionToken);await assert.rejects(()=>choice.replaceBallot(session,{expectedRevision:0,rankings:["song_alpha","song_bravo"],operationId:"operation_close_race"}),(error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="voting-closed");assert.equal((await fixture.DB.prepare("SELECT count(*) count FROM ballot_versions WHERE operation_id='operation_close_race'").first<{count:number}>())?.count,0);assert.equal((await fixture.DB.prepare("SELECT count(*) count FROM idempotency_receipts WHERE operation_id='operation_close_race'").first<{count:number}>())?.count,0);}finally{await fixture.close();}});

  it("persists authenticated live commands, history, state, and confirmed authority handoff", async () => {
    const fixture = await runtime();
    try {
      const acquired = await fixture.fetch("/api/events/event_public/live/authority/acquire", {
        method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ deviceInstallationId: "device_stage" }),
      });
      assert.equal(acquired.status, 200);
      const acquiredAuthority=await acquired.json() as { epoch: number;commandCredential:string };
      assert.equal(acquiredAuthority.epoch, 1);
      assert.equal(acquiredAuthority.commandCredential.length,64);

      const command = await signedCommand();
      const [queued, concurrentRetry] = await Promise.all([
        fixture.fetch("/api/events/event_public/live/commands", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(command) }),
        fixture.fetch("/api/events/event_public/live/commands", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(command) }),
      ]);
      assert.equal(queued.status, 200);
      assert.equal(concurrentRetry.status, 200);
      const queuedBody = await queued.json() as { entry: { state: string } };
      assert.equal(queuedBody.entry.state, "queued");
      assert.deepEqual(await concurrentRetry.json(), queuedBody);

      const ineligible = await fixture.fetch("/api/events/event_public/live/commands", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(await signedCommand({ operationId: "operation_ineligible", baseRevision: 1, entryId: "entry_bad_song", payload: { songId: "song_other" } })) });
      assert.equal(ineligible.status, 400);
      assert.deepEqual(await ineligible.json(), { error: "invalid-payload" });
      const notEventEligible = await fixture.fetch("/api/events/event_public/live/commands", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(await signedCommand({ operationId: "operation_not_event_eligible", baseRevision: 1, entryId: "entry_unlisted_song", payload: { songId: "song_charlie" } })) });
      assert.equal(notEventEligible.status, 400);
      assert.deepEqual(await notEventEligible.json(), { error: "invalid-payload" });

      const offline = await fixture.fetch("/api/events/event_public/live/commands", {
        method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(await signedCommand({ operationId: "operation_offline", entryId: "entry_song_bravo", payload: { songId: "song_bravo" } })),
      });
      assert.equal(offline.status, 200);
      assert.deepEqual(await offline.json().then((value: unknown) => { const result=value as {status:string;entry:{state:string}};return [result.status,result.entry.state]; }), ["suggested", "suggested"]);

      const handoff = await fixture.fetch("/api/events/event_public/live/authority/handoffs", {
        method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ fromDeviceInstallationId: "device_stage", toDeviceInstallationId: "device_backup" }),
      });
      assert.equal(handoff.status, 201);
      const { token } = await handoff.json() as { token: string };
      const cancelled = await fixture.fetch("/api/events/event_public/live/authority/handoffs/cancel", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ token, deviceInstallationId: "device_stage" }) });
      assert.equal(cancelled.status, 200);
      const replacementHandoff = await fixture.fetch("/api/events/event_public/live/authority/handoffs", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ fromDeviceInstallationId: "device_stage", toDeviceInstallationId: "device_backup" }) });
      const replacementToken = (await replacementHandoff.json() as { token: string }).token;
      const confirmed = await fixture.fetch("/api/events/event_public/live/authority/handoffs/confirm", {
        method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ token: replacementToken, deviceInstallationId: "device_backup" }),
      });
      assert.equal(confirmed.status, 200);
      assert.equal((await confirmed.json() as { epoch: number }).epoch, 2);

      const state = await fixture.fetch("/api/events/event_public/live/state", { headers: fixture.authHeaders() });
      assert.equal(state.status, 200);
      const liveState=await state.json() as { revision: number; entries: {state:string}[] };
      assert.equal(liveState.revision,2);
      assert.deepEqual(liveState.entries.map(({state})=>state).sort(),["queued","suggested"]);
      const history = await fixture.fetch("/api/events/event_public/live/history", { headers: fixture.authHeaders() });
      assert.deepEqual((await history.json() as { performances: unknown[] }).performances, []);

      const oldWriter = await fixture.fetch("/api/events/event_public/live/commands", {
        method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(await signedCommand({ operationId: "operation_old_writer", baseRevision: 1 })),
      });
      assert.equal(oldWriter.status, 409);
      assert.deepEqual(await oldWriter.json(), { error: "superseded-authority" });

      const pendingAtRecovery = await fixture.fetch("/api/events/event_public/live/authority/handoffs", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ fromDeviceInstallationId: "device_backup", toDeviceInstallationId: "device_abandoned" }) });
      const abandonedToken = (await pendingAtRecovery.json() as { token: string }).token;
      const recovery = await fixture.fetch("/api/events/event_public/live/authority/revoke-recover", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ lostDeviceInstallationId: "device_backup", recoveryDeviceInstallationId: "device_recovery" }) });
      assert.equal(recovery.status, 200);
      assert.equal((await recovery.json() as { epoch: number }).epoch, 3);
      const stalePending = await fixture.fetch("/api/events/event_public/live/authority/handoffs/confirm", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ token: abandonedToken, deviceInstallationId: "device_abandoned" }) });
      assert.equal(stalePending.status, 403);
    } finally { await fixture.close(); }
  });

  it("bounds new live operations at 1000 per event while preserving exact replay", async () => {
    const fixture = await runtime();
    try {
      await fixture.fetch("/api/events/event_public/live/authority/acquire", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify({ deviceInstallationId: "device_stage" }) });
      const original = await signedCommand();
      const first = await fixture.fetch("/api/events/event_public/live/commands", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(original) });
      const firstBody = await first.json();
      await fixture.DB.exec("WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<999) INSERT INTO live_operation_receipts(event_id,operation_id,command_hash,result_json,audit_event_id,created_at) SELECT 'event_public','operation_fill_' || value,'hash_' || value,'{}','audit_fill_' || value,'2030-01-01T12:00:00.000Z' FROM sequence");
      const replay = await fixture.fetch("/api/events/event_public/live/commands", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(original) });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), firstBody);
      const limited = await fixture.fetch("/api/events/event_public/live/commands", { method: "POST", headers: fixture.authHeaders(true), body: JSON.stringify(await signedCommand({ operationId: "operation_over_limit", baseRevision: 1, entryId: "entry_song_bravo", payload: { songId: "song_bravo" } })) });
      assert.equal(limited.status, 429);
      assert.deepEqual(await limited.json(), { error: "rate-limited" });
    } finally { await fixture.close(); }
  });
});

async function runtime(appOrigin = origin) {
  const persist = await mkdtemp(path.join(process.cwd(), ".worker-test-"));
  const miniflare = new Miniflare({
    compatibilityDate: "2025-07-18", modules: true,
    script: "export default { fetch() { return new Response('runtime'); } }",
    d1Databases: { DB: "woodshed-worker" }, d1Persist: persist,
  });
  const DB = await miniflare.getD1Database("DB");
  for (const sql of await baseMigrationSql) await DB.exec(sql);
  await DB.exec(await ballotLifecycleMigrationSql);
  await DB.batch([
    DB.prepare("INSERT INTO communities(id,name) VALUES (?,?),(?,?)").bind("community_demo", "Demo", "community_other", "Other"),
    DB.prepare("INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES (?,?,?,'live','public','open'),(?,?,?,'live','private','invite'),(?,?,?,'live','private','open'),(?,?,?,'live','unlisted','open')").bind("event_public", "community_demo", "Singalong", "event_other", "community_other", "Other", "event_private_open", "community_demo", "Private Open", "event_unlisted_open", "community_demo", "Unlisted Open"),
    DB.prepare("INSERT INTO canonical_songs(id,community_id,title) VALUES (?,?,?),(?,?,?),(?,?,?)").bind("song_alpha", "community_demo", "North Star", "song_bravo", "community_demo", "Open Road", "song_charlie", "community_demo", "Not Eligible"),
    DB.prepare("INSERT INTO canonical_songs(id,community_id,title) VALUES (?,?,?)").bind("song_other", "community_other", "Wrong Tenant"),
    DB.prepare("INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES (?,?,?),(?,?,?)").bind("event_public", "song_alpha", "2026-01-01T00:00:00Z", "event_public", "song_bravo", "2026-01-01T00:00:00Z"),
    DB.prepare("INSERT INTO guest_participations(id,community_id,event_id) VALUES (?,?,?)").bind("participation_host", "community_demo", "event_public"),
    DB.prepare("INSERT INTO participant_sessions(id_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (?,?,?,?,?,'invite',?)").bind(sessionHash, "participation_host", "community_demo", "event_public", "community-admin", "2031-01-01T00:00:00Z"),
  ]);
  await DB.exec(await runtimeQuotaMigrationSql);
  await DB.prepare("UPDATE event_choice_config SET proposal_policy='editorial' WHERE event_id=?").bind("event_public").run();
  const env: WorkerBindings = { DB, LIVE_COORDINATOR: authorityNamespace(), APP_ORIGIN: appOrigin, LIVE_COMMAND_SECRET: liveSecret, CLOCK_ISO: "2030-01-01T12:01:00.000Z" };
  return {
    DB,
    fetch(pathname: string, init?: RequestInit) { return worker.fetch(new Request(`${appOrigin}${pathname}`, init), env); },
    fetchWithDatabase(database: D1Database, pathname: string, init?: RequestInit) { return worker.fetch(new Request(`${appOrigin}${pathname}`, init), { ...env, DB: database }); },
    authHeaders(mutating = false) { return { authorization: `Bearer ${sessionToken}`, ...(mutating ? { origin, "x-csrf-token": "same-origin", "content-type": "application/json" } : {}) }; },
    mutationHeaders(cookie = "") { return { origin: appOrigin, "x-csrf-token": "same-origin", "content-type": "application/json", ...(cookie ? { cookie } : {}) }; },
    async close() { await miniflare.dispose(); await rm(persist, { recursive: true, force: true }); },
  };
}

function sessionLookupFailure(database: D1Database): D1Database {
  const failFirst = <T extends object>(statement: T): T => new Proxy(statement, {
    get(target, property) {
      if (property === "first") return () => Promise.reject(new Error("injected D1 lookup failure"));
      if (property === "bind") return (...values: unknown[]) => failFirst((Reflect.get(target, property, target) as (...args: unknown[]) => T).apply(target, values));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (query: string) => {
        const statement = target.prepare(query);
        if (!query.startsWith("SELECT s.participation_id")) return statement;
        return failFirst(statement);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
