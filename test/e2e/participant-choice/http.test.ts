import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../../../apps/api-node/src/app.ts";
import { createWoodshedApi } from "../../../apps/web/src/api.ts";
import { ChoiceService } from "../../../packages/application/src/choice-service.ts";

test("HTTP choice-to-draft integration enforces session, origin, tenant, privacy headers", async () => {
  const service = new ChoiceService(":memory:", { now: () => new Date("2026-01-02T12:00:00Z") }); service.migrate(); service.seedDemo();
  const app = createApi(service, { origin: "https://woodshed.example" });
  const invite = service.issueInvite("event_public", "participant");
  const exchanged = await app.request(`/api/session/exchange?capability=${encodeURIComponent(invite.capability)}`);
  assert.equal(exchanged.status, 303);
  assert.equal(exchanged.headers.get("location"), "/events/event_public");
  assert.match(exchanged.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(exchanged.headers.get("referrer-policy"), "no-referrer");
  const cookie = (exchanged.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const ballotResponse = await app.request("/api/events/event_public/ballot", { headers: { cookie } });
  const ballot = await ballotResponse.json() as { revision: number; candidates: { id: string }[] };
  const denied = await app.request("/api/events/event_public/ballot", { method: "PUT", headers: { cookie, "content-type": "application/json", origin: "https://different.example" }, body: JSON.stringify({ expectedRevision: ballot.revision, rankings: [], operationId: "operation_denied" }) });
  assert.equal(denied.status, 403);
  const saved = await app.request("/api/events/event_public/ballot", { method: "PUT", headers: { cookie, "content-type": "application/json", origin: "https://woodshed.example", "x-csrf-token": "same-origin" }, body: JSON.stringify({ expectedRevision: ballot.revision, rankings: ballot.candidates.map((candidate) => candidate.id), operationId: "operation_http" }) });
  assert.equal(saved.status, 200);
  const draft = await app.request("/api/events/event_public/draft", { headers: { cookie } });
  assert.equal(draft.status, 200);
  assert.equal(JSON.stringify(await draft.json()).includes("rankings"), false);
  const idor = await app.request("/api/events/event_other/ballot", { headers: { cookie } });
  assert.equal(idor.status, 403);
  service.close();
});

test("loopback HTTP preview joins an open event with a context-appropriate cookie", async () => {
  const service = new ChoiceService(":memory:"); service.migrate(); service.seedDemo({ publicParticipationPolicy: "open" });
  const app = createApi(service, { origin: "http://127.0.0.1:5173" });
  const denied = await app.request("/api/events/event_public/join-open", { method: "POST" });
  assert.equal(denied.status, 403);
  const joined = await app.request("/api/events/event_public/join-open", { method: "POST", headers: { origin: "http://127.0.0.1:5173", "x-csrf-token": "same-origin" } });
  assert.equal(joined.status, 200);
  assert.doesNotMatch(joined.headers.get("set-cookie") ?? "", /; Secure/);
  const cookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.equal((await app.request("/api/events/event_public/ballot", { headers: { cookie } })).status, 200);
  service.close();
});

test("browser client joins, persists a ranked ballot and proposal, then reloads them through HTTP", async () => {
  const origin = "http://127.0.0.1:5173";
  const service = new ChoiceService(":memory:"); service.migrate(); service.seedDemo({ publicParticipationPolicy: "open" });
  const app = createApi(service, { origin });
  let cookie = "";
  const browserFetch: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    const response = await app.request(String(input), { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0] ?? "";
    return response;
  };
  const client = createWoodshedApi(browserFetch);
  await client.joinOpen("event_public");
  const ballot = await client.ballot("event_public");
  const rankings = ballot.candidates.map(candidate => candidate.id).reverse();
  await client.saveBallot("event_public", { expectedRevision: ballot.revision, rankings, operationId: "ballot_browser_integration" });
  await client.propose("event_public", { title: "Lantern Song", operationId: "proposal_browser_integration" });
  const reloaded = await createWoodshedApi(browserFetch).ballot("event_public");
  assert.equal(reloaded.revision, 1);
  assert.deepEqual(reloaded.candidates.map(candidate => candidate.id), rankings);
  assert.equal(Number((service.database.prepare("SELECT count(*) AS count FROM choice_proposals WHERE title='Lantern Song'").get() as { count:number }).count), 1);
  service.close();
});
