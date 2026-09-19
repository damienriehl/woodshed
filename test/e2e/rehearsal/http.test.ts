import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../../../apps/api-node/src/app.ts";
import { ChoiceService } from "../../../packages/application/src/choice-service.ts";
import { CoordinationService } from "../../../packages/application/src/coordination-service.ts";

test("organizer arrangement route is same-origin, tenant-scoped, and runtime validated",async()=>{
  const choice=new ChoiceService(); choice.migrate(); choice.seedDemo();
  const invite=choice.issueInvite("event_public","organizer"); const session=choice.exchangeInvite(invite.capability);
  const api=createApi(choice,{origin:"https://app.example.test",coordination:new CoordinationService()});
  const headers={cookie:`woodshed_session=${session.id}`,origin:"https://app.example.test","x-csrf-token":"same-origin","content-type":"application/json"};
  const response=await api.request("/api/events/event_public/arrangements",{method:"POST",headers,body:JSON.stringify({operationId:"arrange",expectedRevision:0,songId:"song_alpha",key:"C",notes:"",rightsState:"cleared",parts:[{id:"lead",name:"Lead vocal",required:true}]})});
  assert.equal(response.status,201); assert.equal((await response.json()).revision,1);
  const denied=await api.request("/api/events/event_other/arrangements",{method:"POST",headers,body:"{}"}); assert.equal(denied.status,403);
  const invalid=await api.request("/api/events/event_public/arrangements",{method:"POST",headers,body:JSON.stringify({operationId:"bad"})}); assert.equal(invalid.status,400);
  const pollResponse=await api.request("/api/events/event_public/rehearsal-polls",{method:"POST",headers,body:JSON.stringify({operationId:"poll",expectedRevision:0,timeZone:"America/Chicago",slots:[{id:"evening",startsAt:"2026-08-20T23:00:00.000Z",endsAt:"2026-08-21T01:00:00.000Z"}],requiredPersonIds:[]})});
  assert.equal(pollResponse.status,201);const poll=await pollResponse.json() as {id:string};
  const ranking=await api.request(`/api/events/event_public/rehearsal-polls/${poll.id}/rankings`,{headers:{cookie:`woodshed_session=${session.id}`}});assert.equal(ranking.status,200);assert.equal((await ranking.json()).rankings[0].slotId,"evening");
  choice.close();
});

async function rehearsalFixture(t: { after: (fn: () => void) => void }) {
  const choice = new ChoiceService();
  choice.migrate();
  choice.seedDemo();
  t.after(() => choice.close());
  const session = choice.exchangeInvite(choice.issueInvite("event_public", "organizer").capability);
  const coordination = new CoordinationService();
  const app = createApi(choice, { origin: "https://app.example.test", coordination });
  const headers = { cookie: `woodshed_session=${session.id}`, origin: "https://app.example.test", "x-csrf-token": "same-origin", "content-type": "application/json" };
  const request = (path: string, body?: unknown, method = "POST") => app.request(`/api/events/event_public/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { choice, coordination, app, session, headers, request };
}

test("rehearsal HTTP chain validates volunteer, poll response, close/reopen, rankings and session publication", async t => {
  const { request, coordination, session } = await rehearsalFixture(t);
  const created = await request("arrangements", { operationId: "http-arrange", expectedRevision: 0, songId: "song_alpha", key: "C", notes: "", rightsState: "cleared", parts: [{ id: "lead", name: "Lead", required: true }] });
  const arrangement = await created.json() as { id: string };
  assert.equal(created.status, 201);
  const volunteered = await request("assignments/volunteer", { operationId: "http-volunteer", expectedRevision: 0, decisionId: arrangement.id, partId: "lead", performerId: session.participationId, level: "committed" });
  assert.equal(volunteered.status, 201);
  const assignment = await volunteered.json() as { id: string };
  assert.equal(coordination.assignment(assignment.id).state, "volunteered");
  const createdPoll = await request("rehearsal-polls", { operationId: "http-poll", expectedRevision: 0, timeZone: "UTC", slots: [{ id: "one", startsAt: "2030-01-01T12:00:00Z", endsAt: "2030-01-01T13:00:00Z" }], requiredPersonIds: [session.participationId] });
  const poll = await createdPoll.json() as { id: string };
  assert.equal(createdPoll.status, 201);
  const responded = await request(`rehearsal-polls/${poll.id}/responses`, { operationId: "http-response", expectedRevision: 1, personId: session.participationId, responses: { one: "available" } }, "PUT");
  assert.equal(responded.status, 200);
  const rankings = await request(`rehearsal-polls/${poll.id}/rankings`, undefined, "GET");
  assert.equal((await rankings.json()).rankings[0].score, 8);
  assert.equal((await request(`rehearsal-polls/${poll.id}/close`, { operationId: "http-close", expectedRevision: 2 })).status, 200);
  const closedResponse = await request(`rehearsal-polls/${poll.id}/responses`, { operationId: "http-closed", expectedRevision: 3, personId: session.participationId, responses: {} }, "PUT");
  assert.equal(closedResponse.status, 400);
  assert.deepEqual(await closedResponse.json(), { error: "poll-closed" });
  assert.equal((await request(`rehearsal-polls/${poll.id}/reopen`, { operationId: "http-reopen", expectedRevision: 3 })).status, 200);
  const rehearsal = await request("rehearsals", { operationId: "http-rehearsal", expectedRevision: 4, pollId: poll.id, slotId: "one", agenda: ["song_alpha"] });
  assert.equal(rehearsal.status, 201);
  assert.deepEqual((await rehearsal.json()).agenda, ["song_alpha"]);
});

for (const [route, method, body] of [
  ["arrangements", "POST", { operationId: "invalid", expectedRevision: 0, songId: "song_alpha", key: "C", notes: "", rightsState: "cleared", parts: [null] }],
  ["assignments/volunteer", "POST", { operationId: "invalid", expectedRevision: 0, decisionId: "decision", partId: "lead", performerId: "performer", level: "unsupported" }],
  ["assignments/volunteer", "POST", { decisionId: "decision", partId: "lead", performerId: "performer", level: "committed" }],
  ["rehearsal-polls", "POST", { operationId: "invalid", expectedRevision: 0, timeZone: "UTC", slots: [], requiredPersonIds: [42] }],
  ["rehearsal-polls/missing/responses", "PUT", { operationId: "invalid", expectedRevision: 0, personId: "performer", responses: null }],
  ["rehearsal-polls/missing/close", "POST", { operationId: "invalid", expectedRevision: "0" }],
  ["rehearsals", "POST", { operationId: "invalid", expectedRevision: 0, pollId: "poll", slotId: "one", agenda: [42] }],
] as const) {
  test(`rehearsal HTTP rejects invalid ${route} payload ${Object.keys(body).length}`, async t => {
    const { request } = await rehearsalFixture(t);
    const response = await request(route, body, method);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid-request" });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
}

test("rehearsal HTTP hides unexpected parser/storage failures and preserves authorization boundaries", async t => {
  const { app, headers, choice, request } = await rehearsalFixture(t);
  const malformed = await app.request("/api/events/event_public/arrangements", { method: "POST", headers, body: "{" });
  assert.equal(malformed.status, 500);
  assert.deepEqual(await malformed.json(), { error: "internal-error" });
  const denied = await app.request("/api/events/event_public/rehearsal-polls", { method: "POST", headers: { ...headers, origin: "https://foreign.invalid" }, body: "{}" });
  assert.equal(denied.status, 403);
  const participant = choice.exchangeInvite(choice.issueInvite("event_public", "participant").capability);
  const forbidden = await app.request("/api/events/event_public/rehearsal-polls", { method: "POST", headers: { ...headers, cookie: `woodshed_session=${participant.id}` }, body: JSON.stringify({ operationId: "participant-poll", expectedRevision: 0, timeZone: "UTC", slots: [], requiredPersonIds: [] }) });
  assert.equal(forbidden.status, 403);
  const missing = await request("rehearsal-polls/missing/rankings", undefined, "GET");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not-found" });
});
