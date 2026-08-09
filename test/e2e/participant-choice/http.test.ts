import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../../../apps/api-node/src/app.ts";
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
