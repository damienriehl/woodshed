import assert from "node:assert/strict";
import test from "node:test";

import { CoordinationError, CoordinationService } from "../../../packages/application/src/coordination-service.ts";
import { MemoryProviderAdapter, type ProviderPort } from "../../../packages/providers/src/index.ts";

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
  assert.equal(service.rankPoll(command("rank-1",0),poll.id)[0]?.slotId,"before");
  service.closePoll(command("close",3),poll.id);
  assert.throws(()=>service.respondToPoll(command("late",4),{pollId:poll.id,personId:"performer_a",responses:{after:"available"}}),/poll-closed/);
  service.reopenPoll(command("reopen",4),poll.id);
  service.respondToPoll(command("edit",5),{pollId:poll.id,personId:"performer_a",responses:{before:"unavailable",after:"available"}});
  assert.equal(service.rankPoll(command("rank-2",0),poll.id)[0]?.slotId,"after");
});

test("poll reads and response values are scoped and validated",()=>{
  const service=new CoordinationService();
  const poll=service.createPoll(command("poll-scope",0),{timeZone:"UTC",slots:[{id:"one",startsAt:"2026-08-20T18:00:00.000Z",endsAt:"2026-08-20T20:00:00.000Z"}],requiredPersonIds:[]});
  assert.throws(()=>service.rankPoll({...command("rank-wrong",0),eventId:"event_other"},poll.id),/denied/);
  assert.throws(()=>service.respondToPoll(command("invalid-availability",poll.revision),{pollId:poll.id,personId:"organizer_1",responses:{one:"sometimes" as "available"}}),/conflict/);
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

test("recording outcomes prevalidates every assignment before mutating",()=>{
  const service=new CoordinationService();
  const arrangement=service.createArrangement(command("atomic-arrangement",0),{songId:"song_alpha",key:"C",notes:"",rightsState:"cleared",parts:[{id:"lead",name:"Lead",required:true}]});
  const assignment=service.volunteer(command("atomic-volunteer",0),{decisionId:arrangement.id,partId:"lead",performerId:"performer_a",level:"committed"});
  const poll=service.createPoll(command("atomic-poll",0),{timeZone:"UTC",slots:[{id:"one",startsAt:"2026-08-20T18:00:00.000Z",endsAt:"2026-08-20T20:00:00.000Z"}],requiredPersonIds:[]});
  const session=service.publishSession(command("atomic-session",poll.revision),{pollId:poll.id,slotId:"one",agenda:[]});
  assert.throws(()=>service.recordOutcome(command("atomic-outcome",session.revision),session.id,{attendance:["performer_a"],readinessUpdates:[{assignmentId:assignment.id,state:"performance-ready"},{assignmentId:"missing",state:"learning"}]}),/not-found/);
  assert.equal(service.assignment(assignment.id).readiness,"interested");
  assert.equal(service.cancelSession(command("atomic-cancel",session.revision),session.id,"Still unchanged").revision,2);
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
  await service.disconnectProvider(command("disconnect",1),"calendar_1");
  assert.throws(()=>service.receiveProviderCallback("calendar_1","callback_2",{}),CoordinationError);
});

test("provider connection identifiers cannot be claimed by another tenant or owner",()=>{
  const service=new CoordinationService();
  service.connectProvider(command("connect-shared",0),{connectionId:"shared_connection",kind:"calendar",scopes:["free-busy:read"],retention:"delete-on-disconnect"});
  assert.throws(()=>service.connectProvider({communityId:"community_other",eventId:"event_other",actorId:"organizer_2",roles:["organizer"],operationId:"claim-shared",expectedRevision:0},{connectionId:"shared_connection",kind:"notification",scopes:["notifications:send"],retention:"delete-on-disconnect"}),/conflict/);
  assert.throws(()=>service.connectProvider({...command("owner-shared",0),actorId:"organizer_2"},{connectionId:"shared_connection",kind:"notification",scopes:["notifications:send"],retention:"delete-on-disconnect"}),/conflict/);
});

test("provider disconnect only marks local revocation after remote revocation succeeds",async()=>{
  const provider:ProviderPort={send:async()=>{},revoke:async()=>{throw new Error("offline");}};
  const service=new CoordinationService({provider});
  service.connectProvider(command("connect-failing",0),{connectionId:"failing",kind:"calendar",scopes:["free-busy:read"],retention:"delete-on-disconnect"});
  await assert.rejects(service.disconnectProvider(command("disconnect-failing",1),"failing"),/provider-failed/);
  assert.equal(service.receiveProviderCallback("failing","still-active",{}),"accepted");
});

test("notifications require an explicit send scope",async()=>{
  const service=new CoordinationService();
  service.connectProvider(command("connect",0),{connectionId:"calendar_only",kind:"calendar",scopes:["free-busy:read"],retention:"delete-on-disconnect"});
  await assert.rejects(service.sendNotification(command("send",0),{deliveryId:"delivery_denied",connectionId:"calendar_only",category:"rehearsal-update",recipientRef:"person_ref"}),/scope-denied/);
});

const coverageArrangement = { songId: "song_coverage", key: "C", notes: "", rightsState: "cleared" as const, parts: [{ id: "lead", name: "Lead", required: true }] };
const coverageSlot = { id: "slot_a", startsAt: "2030-01-02T12:00:00Z", endsAt: "2030-01-02T13:00:00Z" };

for (const [label, input] of [
  ["empty song", { ...coverageArrangement, songId: "" }],
  ["empty key", { ...coverageArrangement, key: "" }],
  ["no parts", { ...coverageArrangement, parts: [] }],
  ["duplicate parts", { ...coverageArrangement, parts: [coverageArrangement.parts[0]!, coverageArrangement.parts[0]!] }],
] as const) {
  test(`invalid arrangement ${label} leaves the operation retryable`, () => {
    const service = new CoordinationService();
    assert.throws(() => service.createArrangement(command("retry-invalid", 0), input), /invalid-arrangement/);
    assert.equal(service.createArrangement(command("retry-invalid", 0), coverageArrangement).revision, 1);
  });
}

test("arrangement creation checks roles, command identity, initial revision, and duplicate song", () => {
  const service = new CoordinationService();
  for (const field of ["communityId", "eventId", "actorId", "operationId"] as const) {
    assert.throws(() => service.createArrangement({ ...command("invalid-identity", 0), [field]: "" }, coverageArrangement), /denied/);
  }
  assert.throws(() => service.createArrangement(performerCommand("performer_a", "performer-create", 0), coverageArrangement), /denied/);
  assert.throws(() => service.createArrangement(command("wrong-revision", 1), coverageArrangement), /invalid-arrangement/);
  const created = service.createArrangement(command("valid-create", 0), coverageArrangement);
  assert.throws(() => service.createArrangement(command("duplicate-song", 0), coverageArrangement), /conflict/);
  assert.throws(() => service.arrangement(created.id, 99), /not-found/);
  assert.throws(() => service.assignment("missing"), /not-found/);
});

test("declined and withdrawn assignments stay on their original arrangement revision", () => {
  const service = new CoordinationService();
  const arrangement = service.createArrangement(command("create", 0), coverageArrangement);
  const volunteer = service.volunteer(command("volunteer", 0), { decisionId: arrangement.id, partId: "lead", performerId: "performer_a", level: "committed" });
  const offered = service.offer(command("offer", volunteer.revision), { decisionId: arrangement.id, partId: "lead", performerId: "performer_a" });
  const declined = service.respondToOffer(command("decline", offered.revision), { assignmentId: offered.id, response: "declined" });
  service.reviseArrangement(command("revise", 1), arrangement.id, { key: "D", affectedPartIds: ["lead"] });
  assert.equal(service.assignment(declined.id).decisionRevision, 1);
  assert.equal(service.assignment(declined.id).state, "declined");
  const other = service.volunteer(command("volunteer-other", 0), { decisionId: arrangement.id, partId: "lead", performerId: "performer_b", level: "committed" });
  const withdrawal = service.withdraw(command("withdraw", other.revision), other.id);
  assert.equal(withdrawal.promotedAssignmentId, null);
  assert.equal(withdrawal.assignment.state, "withdrawn");
  service.reviseArrangement(command("revise-again", 2), arrangement.id, { notes: "updated", affectedPartIds: ["lead"] });
  assert.equal(service.assignment(other.id).decisionRevision, 2);
});

test("assignment stale revisions, invalid parts and repeated offers fail without changing assignment", () => {
  const service = new CoordinationService();
  const arrangement = service.createArrangement(command("create", 0), coverageArrangement);
  assert.throws(() => service.volunteer(command("bad-part", 0), { decisionId: arrangement.id, partId: "absent", performerId: "performer_a", level: "committed" }), /invalid-assignment/);
  assert.throws(() => service.volunteer(command("bad-person", 0), { decisionId: arrangement.id, partId: "lead", performerId: "", level: "committed" }), /invalid-assignment/);
  const input = { decisionId: arrangement.id, partId: "lead", performerId: "performer_a", level: "committed" as const };
  const volunteer = service.volunteer(command("volunteer", 0), input);
  assert.deepEqual(service.volunteer(command("volunteer-again", 0), input), volunteer);
  assert.throws(() => service.respondToOffer(command("premature", 1), { assignmentId: volunteer.id, response: "accepted" }), /conflict/);
  assert.throws(() => service.offer(command("stale-offer", 0), input), /conflict/);
  const offer = service.offer(command("offer", 1), input);
  assert.throws(() => service.offer(command("repeat-offer", 2), input), /conflict/);
  assert.throws(() => service.setReadiness(command("stale-ready", 1), { assignmentId: offer.id, state: "performance-ready" }), /conflict/);
  assert.throws(() => service.withdraw(command("stale-withdraw", 1), offer.id), /conflict/);
  assert.equal(service.assignment(offer.id).revision, 2);
  assert.equal(service.assignment(offer.id).readiness, "interested");
});

for (const [label, patch, expected] of [
  ["no slots", { slots: [] }, /invalid-poll/],
  ["invalid time zone", { timeZone: "Synthetic/Invalid" }, /invalid-time-zone/],
  ["empty slot id", { slots: [{ ...coverageSlot, id: "" }] }, /invalid-slot/],
  ["invalid start", { slots: [{ ...coverageSlot, startsAt: "invalid" }] }, /invalid-slot/],
  ["invalid end", { slots: [{ ...coverageSlot, endsAt: "invalid" }] }, /invalid-slot/],
  ["zero duration", { slots: [{ ...coverageSlot, endsAt: coverageSlot.startsAt }] }, /invalid-slot/],
  ["negative duration", { slots: [{ ...coverageSlot, endsAt: "2030-01-02T11:00:00Z" }] }, /invalid-slot/],
] as const) {
  test(`poll creation rejects ${label} through calendar validation`, () => {
    const service = new CoordinationService();
    assert.throws(() => service.createPoll(command("poll-invalid", 0), Object.assign({ timeZone: "UTC", slots: [coverageSlot], requiredPersonIds: [] }, patch)), expected);
    assert.equal(service.createPoll(command("poll-invalid", 0), { timeZone: "UTC", slots: [coverageSlot], requiredPersonIds: [] }).revision, 1);
  });
}

test("poll ranking resolves empty responses and score ties by instant then slot id", () => {
  const service = new CoordinationService();
  const poll = service.createPoll(command("poll-ties", 0), { timeZone: "UTC", slots: [{ ...coverageSlot, id: "z" }, { ...coverageSlot, id: "later", startsAt: "2030-01-02T12:30:00Z" }, { ...coverageSlot, id: "a" }], requiredPersonIds: ["performer_a"] });
  assert.deepEqual(service.rankPoll(command("rank-empty", 0), poll.id).map(row => [row.slotId, row.score, row.requiredUnavailable]), [["a", 0, 0], ["z", 0, 0], ["later", 0, 0]]);
  service.respondToPoll(command("answer", 1), { pollId: poll.id, personId: "performer_a", responses: { z: "if-needed" } });
  service.respondToPoll(command("optional", 2), { pollId: poll.id, personId: "performer_b", responses: { a: "unavailable", later: "available" } });
  assert.deepEqual(service.rankPoll(command("rank-answered", 0), poll.id).map(row => [row.slotId, row.score]), [["z", 4], ["later", 2], ["a", 0]]);
});

test("session updates and outcomes persist through the real SQLite repository", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFile } = await import("node:fs/promises");
  const { SqliteCoordinationRepository } = await import("../../../packages/storage-sqlite/src/coordination-repository.ts");
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(await readFile(new URL("../../../migrations/sqlite/006_coordination_repository.sql", import.meta.url), "utf8"));
  const repository = new SqliteCoordinationRepository(database);
  const service = new CoordinationService({ repository });
  const arrangement = service.createArrangement(command("persistent-arrangement", 0), coverageArrangement);
  const assignment = service.volunteer(command("persistent-volunteer", 0), { decisionId: arrangement.id, partId: "lead", performerId: "performer_a", level: "committed" });
  const poll = service.createPoll(command("persistent-poll", 0), { timeZone: "UTC", slots: [coverageSlot], requiredPersonIds: ["performer_a"] });
  const session = service.publishSession(command("persistent-session", poll.revision), { pollId: poll.id, slotId: coverageSlot.id, agenda: [coverageArrangement.songId] });
  const input = { attendance: ["performer_a"], readinessUpdates: [{ assignmentId: assignment.id, state: "performance-ready" as const }] };
  const outcome = service.recordOutcome(command("persistent-outcome", session.revision), session.id, input);
  const restarted = new CoordinationService({ repository });
  assert.equal(restarted.assignment(assignment.id).readiness, "performance-ready");
  assert.deepEqual(restarted.recordOutcome(command("persistent-outcome", session.revision), session.id, input), outcome);
  assert.equal((database.prepare("SELECT count(*) AS n FROM coordination_audit_events WHERE capability='session:outcome'").get() as { n: number }).n, 1);
  assert.throws(() => restarted.recordOutcome(command("duplicate-updates", outcome.revision), session.id, { attendance: [], readinessUpdates: [input.readinessUpdates[0]!, input.readinessUpdates[0]!] }), /conflict/);
  assert.equal(restarted.assignment(assignment.id).revision, 2);
  const cancelled = restarted.cancelSession(command("persistent-cancel", outcome.revision), session.id, "Synthetic cancellation");
  assert.equal(cancelled.revision, outcome.revision + 1);
  assert.throws(() => restarted.updateSession(command("edit-cancelled", cancelled.revision), session.id, { agenda: [] }), /conflict/);
});

test("poll and session mutations reject stale revisions, missing entities and unknown slots", () => {
  const service = new CoordinationService();
  assert.throws(() => service.rankPoll(command("missing-poll", 0), "missing"), /not-found/);
  assert.throws(() => service.updateSession(command("missing-session", 0), "missing", { agenda: [] }), /not-found/);
  assert.throws(() => service.createPoll(command("nonzero", 1), { timeZone: "UTC", slots: [coverageSlot], requiredPersonIds: [] }), /invalid-poll/);
  const poll = service.createPoll(command("poll", 0), { timeZone: "UTC", slots: [coverageSlot], requiredPersonIds: [] });
  assert.throws(() => service.respondToPoll(command("bad-slot", 1), { pollId: poll.id, personId: "performer_a", responses: { missing: "available" } }), /conflict/);
  assert.throws(() => service.respondToPoll(command("stale-answer", 0), { pollId: poll.id, personId: "performer_a", responses: {} }), /conflict/);
  assert.throws(() => service.closePoll(command("stale-close", 0), poll.id), /conflict/);
  assert.throws(() => service.publishSession(command("unknown-slot", 1), { pollId: poll.id, slotId: "missing", agenda: [] }), /conflict/);
  assert.throws(() => service.publishSession(command("stale-publish", 0), { pollId: poll.id, slotId: coverageSlot.id, agenda: [] }), /conflict/);
  const session = service.publishSession(command("publish", 1), { pollId: poll.id, slotId: coverageSlot.id, agenda: [] });
  assert.throws(() => service.recordOutcome(command("stale-outcome", 0), session.id, { attendance: [], readinessUpdates: [] }), /conflict/);
  assert.throws(() => service.cancelSession(command("empty-reason", 1), session.id, ""), /conflict/);
  assert.throws(() => service.cancelSession(command("stale-cancel", 0), session.id, "reason"), /conflict/);
  assert.equal(service.updateSession(command("update", 1), session.id, { agenda: ["song_alpha"] }).revision, 2);
});

test("notification delivery replays across service reconstruction without duplicate provider effects", async () => {
  const { MemoryCoordinationRepository } = await import("../../../packages/application/src/coordination-repository.ts");
  const repository = new MemoryCoordinationRepository();
  const provider = new MemoryProviderAdapter();
  const service = new CoordinationService({ repository, provider });
  service.connectProvider(command("connect-notify", 0), { connectionId: "notify", kind: "notification", scopes: ["notifications:send"], retention: "delete-on-disconnect" });
  const input = { deliveryId: "delivery", connectionId: "notify", category: "rehearsal", recipientRef: "synthetic_person" };
  const sent = await service.sendNotification(command("send-once", 0), input);
  const restored = new CoordinationService({ repository, provider });
  assert.deepEqual(await restored.sendNotification(command("send-once", 0), input), sent);
  assert.deepEqual(await restored.sendNotification(command("send-new-operation", 0), input), sent);
  assert.equal(provider.sent.length, 1);
  await assert.rejects(restored.sendNotification(command("send-once", 0), { ...input, category: "changed" }), /replay-mismatch/);
  await assert.rejects(restored.sendNotification(command("delivery-collision", 0), { ...input, recipientRef: "different_person" }), /replay-mismatch/);
  const revoked = await restored.disconnectProvider(command("disconnect-notify", 1), "notify");
  assert.deepEqual(await restored.disconnectProvider(command("disconnect-notify", 1), "notify"), revoked);
  assert.deepEqual(provider.revoked, ["notify"]);
  await assert.rejects(restored.sendNotification(command("send-after-revoke", 0), { ...input, deliveryId: "new" }), /provider-revoked/);
});

test("provider callbacks validate sizes, empty ids and replay payload identity before recording receipts", () => {
  const service = new CoordinationService();
  assert.throws(() => service.receiveProviderCallback("absent", "id", {}), /provider-revoked/);
  service.connectProvider(command("connect", 0), { connectionId: "callback", kind: "calendar", scopes: ["free-busy:read"], retention: "delete-on-disconnect" });
  assert.throws(() => service.receiveProviderCallback("callback", "", {}), /invalid-callback/);
  assert.throws(() => service.receiveProviderCallback("callback", "retry", undefined), /invalid-callback/);
  assert.throws(() => service.receiveProviderCallback("callback", "retry", "x".repeat(16_383)), /invalid-callback/);
  assert.equal(service.receiveProviderCallback("callback", "retry", "x".repeat(16_382)), "accepted");
  assert.throws(() => service.receiveProviderCallback("callback", "retry", "changed"), /replay-mismatch/);
  assert.equal(service.receiveProviderCallback("callback", "retry", "x".repeat(16_382)), "duplicate");
});
