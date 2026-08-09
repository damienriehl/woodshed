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
