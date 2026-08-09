import assert from "node:assert/strict";
import test from "node:test";

import { CoordinationError, CoordinationService } from "../../../packages/application/src/coordination-service.ts";
import { MemoryProviderAdapter } from "../../../packages/providers/src/index.ts";

const command = (operationId:string, expectedRevision:number) => ({
  communityId:"community_demo", eventId:"event_public", actorId:"organizer_1",
  roles:["organizer"] as const, operationId, expectedRevision,
});
const performerCommand = (actorId:string,operationId:string,expectedRevision:number) => ({
  communityId:"community_demo",eventId:"event_public",actorId,
  roles:["performer"] as const,operationId,expectedRevision,
});

test("arrangement versions are immutable and invalidate only materially affected readiness",()=>{
  const service=new CoordinationService();
  const arrangement=service.createArrangement(command("arrange-1",0),{songId:"song_alpha",key:"C",notes:"Acoustic",rightsState:"cleared",parts:[{id:"lead",name:"Lead vocal",required:true},{id:"drums",name:"Drums",required:true}]});
  const volunteeredLead=service.volunteer(command("volunteer-1",0),{decisionId:arrangement.id,partId:"lead",performerId:"performer_a",level:"committed"});
  const lead=service.offer(command("offer-1",volunteeredLead.revision),{decisionId:arrangement.id,partId:"lead",performerId:"performer_a"});
  const acceptedLead=service.respondToOffer(command("accept-1",lead.revision),{assignmentId:lead.id,response:"accepted"});
  service.setReadiness(command("ready-lead",acceptedLead.revision),{assignmentId:lead.id,state:"performance-ready"});
  const drums=service.volunteer(command("volunteer-2",0),{decisionId:arrangement.id,partId:"drums",performerId:"performer_b",level:"committed"});
  service.setReadiness(command("ready-drums",drums.revision),{assignmentId:drums.id,state:"rehearsal-ready"});

  const next=service.reviseArrangement(command("arrange-2",arrangement.revision),arrangement.id,{key:"D",affectedPartIds:["lead"]});
  assert.equal(next.revision,2);
  assert.equal(service.assignment(lead.id).readiness,"learning");
  assert.equal(service.assignment(drums.id).readiness,"rehearsal-ready");
  assert.equal(service.assignment(drums.id).decisionRevision,2);
  assert.equal(service.arrangement(arrangement.id,1).key,"C");
});

test("competing volunteers remain unassigned; accepted backup promotes deterministically after withdrawal",()=>{
  const service=new CoordinationService();
  const arrangement=service.createArrangement(command("a",0),{songId:"song_alpha",key:"C",notes:"",rightsState:"cleared",parts:[{id:"lead",name:"Lead vocal",required:true}]});
  const first=service.volunteer(command("v1",0),{decisionId:arrangement.id,partId:"lead",performerId:"performer_a",level:"committed"});
  const second=service.volunteer(command("v2",0),{decisionId:arrangement.id,partId:"lead",performerId:"performer_b",level:"backup"});
  assert.equal(first.state,"volunteered"); assert.equal(second.state,"volunteered");
  const primary=service.offer(command("o1",first.revision),{decisionId:arrangement.id,partId:"lead",performerId:"performer_a"});
  const assignedPrimary=service.respondToOffer(command("r1",primary.revision),{assignmentId:primary.id,response:"accepted"});
  const backup=service.offer(command("o2",second.revision),{decisionId:arrangement.id,partId:"lead",performerId:"performer_b",backup:true});
  service.respondToOffer(command("r2",backup.revision),{assignmentId:backup.id,response:"accepted"});
  const result=service.withdraw(command("withdraw",assignedPrimary.revision),primary.id);
  assert.equal(result.promotedAssignmentId,backup.id);
  assert.equal(service.assignment(backup.id).state,"assigned");
  assert.equal(service.assignment(primary.id).state,"substituted");
});

test("performers cannot accept, withdraw, or answer a poll for another person",()=>{
  const service=new CoordinationService();
  const arrangement=service.createArrangement(command("a",0),{songId:"song_alpha",key:"C",notes:"",rightsState:"cleared",parts:[{id:"lead",name:"Lead vocal",required:true}]});
  const volunteered=service.volunteer(performerCommand("performer_a","v",0),{decisionId:arrangement.id,partId:"lead",performerId:"performer_a",level:"committed"});
  const offered=service.offer(command("o",volunteered.revision),{decisionId:arrangement.id,partId:"lead",performerId:"performer_a"});
  assert.throws(()=>service.respondToOffer(performerCommand("performer_b","accept",offered.revision),{assignmentId:offered.id,response:"accepted"}),/denied/);
  assert.throws(()=>service.withdraw(performerCommand("performer_b","withdraw",offered.revision),offered.id),/denied/);
  const poll=service.createPoll(command("poll",0),{timeZone:"UTC",slots:[{id:"one",startsAt:"2026-08-20T18:00:00.000Z",endsAt:"2026-08-20T20:00:00.000Z"}],requiredPersonIds:[]});
  assert.throws(()=>service.respondToPoll(performerCommand("performer_b","answer",poll.revision),{pollId:poll.id,personId:"performer_a",responses:{one:"available"}}),/denied/);
});

test("rehearsal poll uses instant-based DST-safe slots, required weighting, close/reopen, and editable responses",()=>{
  const service=new CoordinationService();
  const poll=service.createPoll(command("poll",0),{timeZone:"America/Chicago",slots:[
    {id:"before",startsAt:"2026-11-01T06:30:00.000Z",endsAt:"2026-11-01T07:30:00.000Z"},
    {id:"after",startsAt:"2026-11-01T08:00:00.000Z",endsAt:"2026-11-01T09:00:00.000Z"},
  ],requiredPersonIds:["performer_a"]});
  service.respondToPoll(command("p1",poll.revision),{pollId:poll.id,personId:"performer_a",responses:{before:"available",after:"unavailable"}});
  service.respondToPoll(command("p2",2),{pollId:poll.id,personId:"performer_b",responses:{before:"if-needed",after:"available"}});
  assert.equal(service.rankPoll(poll.id)[0]?.slotId,"before");
  service.closePoll(command("close",3),poll.id);
  assert.throws(()=>service.respondToPoll(command("late",4),{pollId:poll.id,personId:"performer_a",responses:{after:"available"}}),/poll-closed/);
  service.reopenPoll(command("reopen",4),poll.id);
  service.respondToPoll(command("edit",5),{pollId:poll.id,personId:"performer_a",responses:{before:"unavailable",after:"available"}});
  assert.equal(service.rankPoll(poll.id)[0]?.slotId,"after");
});

test("agenda lifecycle records attendance and targeted readiness outcomes",()=>{
  const service=new CoordinationService();
  const poll=service.createPoll(command("poll",0),{timeZone:"UTC",slots:[{id:"one",startsAt:"2026-08-20T18:00:00.000Z",endsAt:"2026-08-20T20:00:00.000Z"}],requiredPersonIds:[]});
  const session=service.publishSession(command("publish",poll.revision),{pollId:poll.id,slotId:"one",agenda:["song_alpha"]});
  const updated=service.updateSession(command("update",session.revision),session.id,{agenda:["song_alpha","song_bravo"]});
  service.recordOutcome(command("outcome",updated.revision),updated.id,{attendance:["performer_a"],readinessUpdates:[]});
  const cancelled=service.cancelSession(command("cancel",updated.revision+1),updated.id,"Venue unavailable");
  assert.equal(cancelled.state,"cancelled");
});

test("provider grants are scoped and revocable; callbacks and sends are idempotent across rate limits",async()=>{
  const adapter=new MemoryProviderAdapter({failFirstWithRateLimit:true}); const service=new CoordinationService({provider:adapter});
  service.connectProvider(command("connect",0),{connectionId:"calendar_1",kind:"notification",scopes:["notifications:send"],retention:"delete-on-disconnect"});
  assert.throws(()=>service.connectProvider(command("bad",0),{connectionId:"bad",kind:"calendar",scopes:["event-details:read"],retention:"delete-on-disconnect"}),/scope-denied/);
  assert.equal(service.receiveProviderCallback("calendar_1","callback_1",{busy:["opaque"]}),"accepted");
  assert.equal(service.receiveProviderCallback("calendar_1","callback_1",{busy:["opaque"]}),"duplicate");
  await assert.rejects(service.sendNotification(command("send",0),{deliveryId:"delivery_1",connectionId:"calendar_1",category:"rehearsal-update",recipientRef:"person_ref"}),/rate-limited/);
  assert.equal((await service.sendNotification(command("send",0),{deliveryId:"delivery_1",connectionId:"calendar_1",category:"rehearsal-update",recipientRef:"person_ref"})).state,"sent");
  assert.equal((await service.sendNotification(command("send",0),{deliveryId:"delivery_1",connectionId:"calendar_1",category:"rehearsal-update",recipientRef:"person_ref"})).state,"sent");
  assert.equal(adapter.sent.length,1);
  service.disconnectProvider(command("disconnect",1),"calendar_1");
  assert.throws(()=>service.receiveProviderCallback("calendar_1","callback_2",{}),CoordinationError);
});

test("notifications require an explicit send scope",async()=>{
  const service=new CoordinationService();
  service.connectProvider(command("connect",0),{connectionId:"calendar_only",kind:"calendar",scopes:["free-busy:read"],retention:"delete-on-disconnect"});
  await assert.rejects(service.sendNotification(command("send",0),{deliveryId:"delivery_denied",connectionId:"calendar_only",category:"rehearsal-update",recipientRef:"person_ref"}),/scope-denied/);
});
