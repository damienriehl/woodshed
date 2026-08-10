import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.equal(draft.status, 403);
  const organizerInvite=service.issueInvite("event_public","organizer");const organizerExchange=await app.request(`/api/session/exchange?capability=${encodeURIComponent(organizerInvite.capability)}`);const organizerCookie=(organizerExchange.headers.get("set-cookie")??"").split(";")[0]??"";const organizerDraft=await app.request("/api/events/event_public/draft",{headers:{cookie:organizerCookie}});assert.equal(organizerDraft.status,200);assert.equal(JSON.stringify(await organizerDraft.json()).includes("rankings"),false);
  const idor = await app.request("/api/events/event_other/ballot", { headers: { cookie } });
  assert.equal(idor.status, 401);
  const wrongEventCookie=cookie.replace(/^woodshed_session_[^=]+/,`woodshed_session_${createHash("sha256").update("event_other").digest("hex").slice(0,16)}`);
  const wrongEvent=await app.request("/api/events/event_other/ballot",{headers:{cookie:wrongEventCookie}});assert.equal(wrongEvent.status,403);
  service.close();
});

test("loopback HTTP preview joins an open event with a context-appropriate cookie", async () => {
  const service = new ChoiceService(":memory:"); service.migrate(); service.seedDemo({ publicParticipationPolicy: "open" });
  const app = createApi(service, { origin: "http://127.0.0.1:5173" });
  const denied = await app.request("/api/events/event_public/join-open", { method: "POST" });
  assert.equal(denied.status, 403);
  const joined = await app.request("/api/events/event_public/join-open", { method: "POST", headers: { origin: "http://127.0.0.1:5173", "x-csrf-token": "same-origin", "content-type": "application/json" }, body: JSON.stringify({operationId:"join_preview"}) });
  assert.equal(joined.status, 200);
  assert.doesNotMatch(joined.headers.get("set-cookie") ?? "", /; Secure/);
  const cookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.equal((await app.request("/api/events/event_public/ballot", { headers: { cookie } })).status, 200);
  const loggedOut=await app.request("/api/logout",{method:"POST",headers:{cookie,origin:"http://127.0.0.1:5173","x-csrf-token":"same-origin","content-type":"application/json"},body:"{}"});assert.equal(loggedOut.status,204);assert.match(loggedOut.headers.get("set-cookie")??"",/Max-Age=0/);
  service.close();
});

test("public join rejects oversized bodies and operation identifiers before persistence",async()=>{const origin="http://127.0.0.1:5173",service=new ChoiceService(":memory:");service.migrate();service.seedDemo({publicParticipationPolicy:"open"});const app=createApi(service,{origin}),headers={origin,"x-csrf-token":"same-origin","content-type":"application/json"};const oversized=await app.request("/api/events/event_public/join-open",{method:"POST",headers,body:JSON.stringify({operationId:`join_${"x".repeat(2048)}`})});assert.equal(oversized.status,413);const long=await app.request("/api/events/event_public/join-open",{method:"POST",headers,body:JSON.stringify({operationId:`join_${"x".repeat(129)}`})});assert.equal(long.status,400);assert.equal(Number((service.database.prepare("SELECT count(*) count FROM open_join_receipts").get() as {count:number}).count),0);service.close();});

test("invite redirect can load its authorized unlisted event context", async () => {
  const service = new ChoiceService(":memory:"); service.migrate(); service.seedDemo();
  const app = createApi(service, { origin: "https://woodshed.example" });
  const invite = service.issueInvite("event_unlisted", "participant");
  const exchanged = await app.request(`/api/session/exchange?capability=${encodeURIComponent(invite.capability)}`);
  assert.equal(exchanged.headers.get("location"), "/events/event_unlisted");
  const cookie = (exchanged.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const response = await app.request("/api/events/event_unlisted/context", { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { event: { id:"event_unlisted",name:"Band Workshop",state:"published",visibility:"unlisted",participationPolicy:"invite" } });
  const active = await app.request("/api/session/events", { headers: { cookie } });
  assert.deepEqual(await active.json(), { events: [{ id:"event_unlisted",name:"Band Workshop",state:"published",visibility:"unlisted",participationPolicy:"invite" }] });
  service.close();
});

test("invite recovery cookie restores an expired invite session",async()=>{let now=new Date("2026-01-01T00:00:00Z");const origin="https://woodshed.example",service=new ChoiceService(":memory:",{now:()=>now});service.migrate();service.seedDemo();service.database.prepare("UPDATE events SET state='voting' WHERE id='event_unlisted'").run();const app=createApi(service,{origin}),invite=service.issueInvite("event_unlisted","participant"),exchange=await app.request(`/api/session/exchange?capability=${encodeURIComponent(invite.capability)}`),setCookies=exchange.headers.getSetCookie?.()??[],sessionCookie=setCookies.find(value=>value.startsWith("woodshed_session_"))?.split(";")[0]??"",recoveryCookie=setCookies.find(value=>value.startsWith("woodshed_recovery_"))?.split(";")[0]??"";assert.ok(sessionCookie&&recoveryCookie);now=new Date("2026-01-03T00:00:00Z");assert.equal((await app.request("/api/events/event_unlisted/ballot",{headers:{cookie:`${sessionCookie}; ${recoveryCookie}`}})).status,401);const active=await app.request("/api/session/events",{headers:{cookie:`${sessionCookie}; ${recoveryCookie}`}});assert.deepEqual(await active.json(),{events:[{id:"event_unlisted",name:"Band Workshop",state:"voting",visibility:"unlisted",participationPolicy:"invite"}]});const recovered=await app.request("/api/events/event_unlisted/recover",{method:"POST",headers:{cookie:recoveryCookie,origin,"x-csrf-token":"same-origin","content-type":"application/json"},body:"{}"});assert.equal(recovered.status,200);assert.deepEqual(await recovered.json(),{assurance:"invite"});const replacement=(recovered.headers.get("set-cookie")??"").split(";")[0]??"";assert.equal((await app.request("/api/events/event_unlisted/ballot",{headers:{cookie:`${replacement}; ${recoveryCookie}`}})).status,200);service.close();});

test("privileged invite exchange sets no durable recovery cookie",async()=>{const origin="https://woodshed.example",service=new ChoiceService(":memory:");service.migrate();service.seedDemo();const app=createApi(service,{origin}),invite=service.issueInvite("event_public","organizer"),response=await app.request(`/api/session/exchange?capability=${encodeURIComponent(invite.capability)}`);assert.equal(response.status,303);assert.equal((response.headers.getSetCookie?.()??[]).some(value=>value.startsWith("woodshed_recovery_")),false);service.close();});

test("event-scoped cookies resume the original ballot after switching away and back", async () => {
  const service = new ChoiceService(":memory:"); service.migrate(); service.seedDemo({ publicParticipationPolicy: "open" });
  const secondEvent = { id:"event_second",communityId:"community_demo",name:"Second Event",state:"voting",visibility:"public",participationPolicy:"open",proposalPolicy:"editorial" } as const;
  service.createEvent(secondEvent);
  service.database.prepare("UPDATE events SET state='voting' WHERE id='event_second'").run();
  const app = createApi(service, { origin: "https://woodshed.example" });
  const cookies = new Map<string,string>();
  const request = async (path:string, init:RequestInit={}) => {
    const headers=new Headers(init.headers);headers.set("origin","https://woodshed.example");headers.set("x-csrf-token","same-origin");headers.set("cookie",[...cookies].map(([name,value])=>`${name}=${value}`).join("; "));
    const response=await app.request(path,{...init,headers});const set=response.headers.get("set-cookie")?.split(";",1)[0]?.split("=");if(set?.[0]&&set[1])cookies.set(set[0],set[1]);return response;
  };
  await request("/api/events/event_public/join-open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationId:"join_resume_public"})});
  const first=await (await request("/api/events/event_public/ballot")).json() as {revision:number;candidates:{id:string}[]};
  await request("/api/events/event_public/ballot",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({expectedRevision:first.revision,rankings:first.candidates.map(({id})=>id),operationId:"operation_first_event"})});
  assert.equal((await request("/api/events/event_second/join-open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationId:"join_resume_second"})})).status,200);
  const resumed=await (await request("/api/events/event_public/ballot")).json() as {revision:number};
  assert.equal(resumed.revision,first.revision+1);
  assert.equal(cookies.size,2);
  service.close();
});

test("open joins replay safely and event-scoped cookies preserve identity across event switches", async () => {
  const origin="http://127.0.0.1:5173";const service=new ChoiceService(":memory:");service.migrate();service.seedDemo({publicParticipationPolicy:"open"});service.createEvent({id:"event_second",communityId:"community_demo",name:"Second",visibility:"public",participationPolicy:"open",proposalPolicy:"editorial"});service.database.prepare("UPDATE events SET state='voting' WHERE id='event_second'").run();const app=createApi(service,{origin});
  const join=async(eventId:string,operationId:string,cookie="")=>app.request(`/api/events/${eventId}/join-open`,{method:"POST",headers:{origin,"x-csrf-token":"same-origin","content-type":"application/json",...(cookie?{cookie}:{})},body:JSON.stringify({operationId})});
  const first=await join("event_public","join_a");const cookieA=(first.headers.get("set-cookie")??"").split(";")[0]??"";const recovered=await join("event_public","join_a");assert.equal(recovered.status,200);assert.notEqual((recovered.headers.get("set-cookie")??"").split(";")[0]??"",cookieA);assert.equal((recovered.headers.getSetCookie?.()??[]).some(value=>value.startsWith("woodshed_recovery_")),true);const replay=await join("event_public","join_a",cookieA);assert.equal(replay.status,200);const replayCookie=(replay.headers.get("set-cookie")??"").split(";")[0]??"";assert.equal(replayCookie,cookieA);assert.equal((await app.request("/api/events/event_public/ballot",{headers:{cookie:replayCookie}})).status,200);assert.equal(Number((service.database.prepare("SELECT count(*) count FROM guest_participations WHERE event_id='event_public'").get() as {count:number}).count),1);
  const second=await join("event_second","join_b",cookieA);const cookieB=(second.headers.get("set-cookie")??"").split(";")[0]??"";const both=`${replayCookie}; ${cookieB}`;assert.equal((await app.request("/api/events/event_public/ballot",{headers:{cookie:both}})).status,200);assert.equal((await app.request("/api/events/event_second/ballot",{headers:{cookie:both}})).status,200);service.close();
});

test("out-of-order open joins cannot overwrite another event's session", async () => {
  const origin="http://127.0.0.1:5173";const service=new ChoiceService(":memory:");service.migrate();service.seedDemo({publicParticipationPolicy:"open"});service.createEvent({id:"event_second",communityId:"community_demo",name:"Second",visibility:"public",participationPolicy:"open",proposalPolicy:"editorial"});service.database.prepare("UPDATE events SET state='voting' WHERE id='event_second'").run();const app=createApi(service,{origin});const headers={origin,"x-csrf-token":"same-origin","content-type":"application/json"};const a=await app.request("/api/events/event_public/join-open",{method:"POST",headers,body:JSON.stringify({operationId:"late_a"})});const b=await app.request("/api/events/event_second/join-open",{method:"POST",headers,body:JSON.stringify({operationId:"early_b"})});assert.notEqual((a.headers.get("set-cookie")??"").split("=")[0],(b.headers.get("set-cookie")??"").split("=")[0]);service.close();
});

test("logout clears every event-scoped session cookie",async()=>{const origin="http://127.0.0.1:5173",service=new ChoiceService(":memory:");service.migrate();service.seedDemo({publicParticipationPolicy:"open"});service.createEvent({id:"event_second",communityId:"community_demo",name:"Second",visibility:"public",participationPolicy:"open",proposalPolicy:"editorial"});service.database.prepare("UPDATE events SET state='voting' WHERE id='event_second'").run();const app=createApi(service,{origin}),headers={origin,"x-csrf-token":"same-origin","content-type":"application/json"};const a=await app.request("/api/events/event_public/join-open",{method:"POST",headers,body:JSON.stringify({operationId:"logout_a"})}),b=await app.request("/api/events/event_second/join-open",{method:"POST",headers,body:JSON.stringify({operationId:"logout_b"})});const cookies=`${(a.headers.get("set-cookie")??"").split(";")[0]}; ${(b.headers.get("set-cookie")??"").split(";")[0]}`;const logout=await app.request("/api/logout",{method:"POST",headers:{...headers,cookie:cookies},body:"{}"});assert.equal((logout.headers.getSetCookie?.()??[]).filter(value=>value.includes("Max-Age=0")).length,2);service.close();});

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
