import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import worker, { type WorkerBindings } from "../../apps/api-worker/src/index.ts";
import { LiveCoordinator } from "../../apps/api-worker/src/live-do.ts";

const origin = "https://woodshed.example";
const liveSecret = "test-live-command-secret";
const sessionToken = "test-organizer-session";
const sessionHash = createHash("sha256").update(sessionToken).digest("hex");

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
  it("serves D1 discovery and authenticated ballot replacement without an injected application", async () => {
    const fixture = await runtime();
    try {
      const discovery = await fixture.fetch("/api/discovery");
      assert.equal(discovery.status, 200);
      assert.deepEqual((await discovery.json() as { events: { id: string }[] }).events.map(({ id }) => id), ["event_public"]);

      const ballot = await fixture.fetch("/api/events/event_public/ballot", { headers: fixture.authHeaders() });
      assert.equal(ballot.status, 200);
      const current = await ballot.json() as { revision: number; candidates: { id: string }[] };
      assert.equal(current.revision, 0);

      const saved = await fixture.fetch("/api/events/event_public/ballot", {
        method: "PUT",
        headers: fixture.authHeaders(true),
        body: JSON.stringify({ expectedRevision: 0, rankings: current.candidates.map(({ id }) => id), operationId: "operation_ballot_one" }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json() as { revision: number }).revision, 1);

      await fixture.DB.prepare("UPDATE ballots SET state='closed' WHERE event_id=? AND participation_id=?").bind("event_public", "participation_host").run();
      const closed = await fixture.fetch("/api/events/event_public/ballot", { method: "PUT", headers: fixture.authHeaders(true), body: JSON.stringify({ expectedRevision: 1, rankings: current.candidates.map(({ id }) => id), operationId: "operation_ballot_closed" }) });
      assert.equal(closed.status, 409);
      assert.deepEqual(await closed.json(), { error: "voting-closed" });
      await fixture.DB.prepare("UPDATE ballots SET state='reopened' WHERE event_id=? AND participation_id=?").bind("event_public", "participation_host").run();
      const reopened = await fixture.fetch("/api/events/event_public/ballot", { method: "PUT", headers: fixture.authHeaders(true), body: JSON.stringify({ expectedRevision: 1, rankings: current.candidates.map(({ id }) => id), operationId: "operation_ballot_reopened" }) });
      assert.equal(reopened.status, 200);
      assert.equal((await reopened.json() as { revision: number }).revision, 2);
      await fixture.DB.prepare("UPDATE ballots SET state='final' WHERE event_id=? AND participation_id=?").bind("event_public", "participation_host").run();
      const finalized = await fixture.fetch("/api/events/event_public/ballot", { method: "PUT", headers: fixture.authHeaders(true), body: JSON.stringify({ expectedRevision: 2, rankings: current.candidates.map(({ id }) => id), operationId: "operation_ballot_final" }) });
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

async function runtime() {
  const persist = await mkdtemp(path.join(process.cwd(), ".worker-test-"));
  const miniflare = new Miniflare({
    compatibilityDate: "2025-07-18", modules: true,
    script: "export default { fetch() { return new Response('runtime'); } }",
    d1Databases: { DB: "woodshed-worker" }, d1Persist: persist,
  });
  const DB = await miniflare.getD1Database("DB");
  for (const name of ["001_first_loop.sql", "002_participant_choice.sql", "003_rehearsal_coordination.sql", "004_live_performance.sql", "005_coordination_repository.sql", "006_worker_runtime.sql"]) {
    await DB.exec(await readFile(new URL(`../../migrations/d1/${name}`, import.meta.url), "utf8"));
  }
  await DB.batch([
    DB.prepare("INSERT INTO communities(id,name) VALUES (?,?),(?,?)").bind("community_demo", "Demo", "community_other", "Other"),
    DB.prepare("INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES (?,?,?,'live','public','invite'),(?,?,?,'live','private','invite')").bind("event_public", "community_demo", "Singalong", "event_other", "community_other", "Other"),
    DB.prepare("INSERT INTO canonical_songs(id,community_id,title) VALUES (?,?,?),(?,?,?),(?,?,?)").bind("song_alpha", "community_demo", "North Star", "song_bravo", "community_demo", "Open Road", "song_charlie", "community_demo", "Not Eligible"),
    DB.prepare("INSERT INTO canonical_songs(id,community_id,title) VALUES (?,?,?)").bind("song_other", "community_other", "Wrong Tenant"),
    DB.prepare("INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES (?,?,?),(?,?,?)").bind("event_public", "song_alpha", "2026-01-01T00:00:00Z", "event_public", "song_bravo", "2026-01-01T00:00:00Z"),
    DB.prepare("INSERT INTO guest_participations(id,community_id,event_id) VALUES (?,?,?)").bind("participation_host", "community_demo", "event_public"),
    DB.prepare("INSERT INTO participant_sessions(id_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (?,?,?,?,?,'invite',?)").bind(sessionHash, "participation_host", "community_demo", "event_public", "community-admin", "2031-01-01T00:00:00Z"),
  ]);
  const env: WorkerBindings = { DB, LIVE_COORDINATOR: authorityNamespace(), APP_ORIGIN: origin, LIVE_COMMAND_SECRET: liveSecret, CLOCK_ISO: "2030-01-01T12:01:00.000Z" };
  return {
    DB,
    fetch(pathname: string, init?: RequestInit) { return worker.fetch(new Request(`${origin}${pathname}`, init), env); },
    authHeaders(mutating = false) { return { authorization: `Bearer ${sessionToken}`, ...(mutating ? { origin, "x-csrf-token": "same-origin", "content-type": "application/json" } : {}) }; },
    async close() { await miniflare.dispose(); await rm(persist, { recursive: true, force: true }); },
  };
}
