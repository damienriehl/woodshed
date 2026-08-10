import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ChoiceService, ChoiceError } from "../../../packages/application/src/choice-service.ts";

function service() { const value = new ChoiceService(":memory:", { now: () => new Date("2026-01-02T12:00:00Z") }); value.migrate(); value.seedDemo(); return value; }

test("open join receipt requires the matching replay session", () => {
  const directory=mkdtempSync(path.join(tmpdir(),"woodshed-open-join-")),filename=path.join(directory,"choice.sqlite");
  const first=new ChoiceService(filename),second=new ChoiceService(filename);
  try{first.migrate();first.seedDemo({publicParticipationPolicy:"open"});const original=first.openPublicSession("event_public","join_shared");assert.throws(()=>second.openPublicSession("event_public","join_shared"),(error:unknown)=>error instanceof ChoiceError&&error.code==="replay-session-required");const replay=second.openPublicSession("event_public","join_shared",original.id);assert.equal(replay.id,original.id);assert.equal(Number((first.database.prepare("SELECT count(*) count FROM guest_participations WHERE event_id='event_public'").get() as {count:number}).count),1);assert.equal(Number((first.database.prepare("SELECT count(*) count FROM participant_sessions WHERE participation_id=?").get(original.participationId) as {count:number}).count),1);}finally{second.close();first.close();rmSync(directory,{recursive:true});}
});

test("open join receipt rejects a different or expired replay session",()=>{const app=new ChoiceService(":memory:");app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const victim=app.openPublicSession("event_public","join_victim"),other=app.openPublicSession("event_public","join_other");assert.throws(()=>app.openPublicSession("event_public","join_victim",other.id),(error:unknown)=>error instanceof ChoiceError&&error.code==="replay-session-required");app.database.prepare("UPDATE participant_sessions SET expires_at='2000-01-01T00:00:00Z' WHERE participation_id=?").run(victim.participationId);assert.throws(()=>app.openPublicSession("event_public","join_victim",victim.id),(error:unknown)=>error instanceof ChoiceError&&error.code==="replay-session-required");app.close();});

test("open participation is bounded per event",()=>{const app=new ChoiceService(":memory:",{maxOpenParticipantsPerEvent:1});app.migrate();app.seedDemo({publicParticipationPolicy:"open"});app.openPublicSession("event_public","join_one");assert.throws(()=>app.openPublicSession("event_public","join_two"),(error:unknown)=>error instanceof ChoiceError&&error.code==="open-participation-capacity");app.close();});

test("discovery keeps visibility separate from eligibility", () => {
  const app = service();
  assert.equal(app.discoverEvents().every((event) => event.visibility === "public"), true);
  assert.equal(app.eventEntry("event_public", null).outcome, "discoverable-ineligible");
  assert.equal(app.eventEntry("event_unlisted", null).outcome, "invalid-link");
  assert.equal(app.eventEntry("event_private", null).outcome, "private");
  app.close();
});

test("development bootstrap is idempotent and can expose an open synthetic event", () => {
  const app = new ChoiceService(":memory:", { now: () => new Date("2026-01-02T12:00:00Z") });
  app.migrate();
  app.seedDemo();
  assert.equal(app.eventEntry("event_public", null).outcome, "discoverable-ineligible");
  app.seedDemo({ publicParticipationPolicy: "open" });
  app.seedDemo({ publicParticipationPolicy: "open" });
  assert.equal(app.eventEntry("event_public", null).outcome, "eligible-open");
  assert.deepEqual(app.discoverEvents().map((event) => event.id), ["event_public"]);
  app.close();
});

test("invite capability is hashed, single-exchange, expirable and revocable", () => {
  const app = service();
  const issued = app.issueInvite("event_public", "participant");
  assert.equal(app.debugCapabilityStored(issued.capability), false);
  const session = app.exchangeInvite(issued.capability);
  assert.equal(session.assurance, "invite");
  assert.throws(() => app.exchangeInvite(issued.capability), (error: unknown) => error instanceof ChoiceError && error.code === "invalid-capability");
  const revoked = app.issueInvite("event_public", "participant"); app.revokeInvite(revoked.id);
  assert.throws(() => app.exchangeInvite(revoked.capability), (error: unknown) => error instanceof ChoiceError && error.code === "invalid-capability");
  const expired = app.issueInvite("event_public", "participant", new Date("2026-01-01T00:00:00Z"));
  assert.throws(() => app.exchangeInvite(expired.capability), (error: unknown) => error instanceof ChoiceError && error.code === "expired-capability");
  app.close();
});

test("routine session expiry recovers the same open-event participation", () => {
  let now=new Date("2026-01-02T12:00:00Z");const app=new ChoiceService(":memory:",{now:()=>now});app.migrate();app.seedDemo({publicParticipationPolicy:"open"});
  const first=app.openPublicSession("event_public","join_before_expiry"),ballot=app.getBallot(first.id),rankings=ballot.candidates.map(({id})=>id);
  app.replaceBallot(first.id,ballot.revision,rankings,"operation_before_expiry");now=new Date("2026-01-04T12:00:00Z");
  assert.throws(()=>app.getBallot(first.id),(error:unknown)=>error instanceof ChoiceError&&error.code==="unauthorized");
  assert.ok("recoveryCapability" in first);const recovered=app.recoverPublicSession("event_public",first.recoveryCapability);
  assert.equal(recovered.participationId,first.participationId);assert.equal(app.getBallot(recovered.id).revision,1);app.close();
});

test("ballot CAS, replay, append, close/reopen, removal and secrecy", () => {
  const app = service();
  const session = app.openPublicSession("event_public","join_ballot");
  const ballot = app.getBallot(session.id);
  const rankings = ballot.candidates.map((candidate) => candidate.id).reverse();
  const operationId = "operation_first";
  const saved = app.replaceBallot(session.id, ballot.revision, rankings, operationId);
  assert.equal(saved.revision, 1);
  assert.deepEqual(app.replaceBallot(session.id, 0, rankings, operationId), saved);
  assert.throws(() => app.replaceBallot(session.id, 0, rankings, "operation_stale"), (error: unknown) => error instanceof ChoiceError && error.code === "conflict");
  assert.deepEqual(app.getBallot(session.id).candidates.map((candidate) => candidate.id), rankings);
  app.addEligibleSong("event_public", "song_charlie");
  assert.deepEqual(app.getBallot(session.id).candidates.slice(0, -1).map((candidate) => candidate.id), rankings);
  app.setVotingState("event_public", "closed");
  assert.throws(() => app.replaceBallot(session.id, 1, [], "operation_late"), (error: unknown) => error instanceof ChoiceError && error.code === "voting-closed");
  app.setVotingState("event_public", "reopened");
  assert.equal(app.replaceBallot(session.id, 1, [], "operation_reopen").revision, 2);
  assert.equal(JSON.stringify(app.aggregate("event_public")).includes("rankings"), false);
  app.removeParticipant(session.participationId);
  assert.equal(app.aggregate("event_public").cohortSize, 0);
  app.close();
});

test("proposal policy supports immediate/editorial, quotas, and replay", () => {
  const app = service();
  const session = app.openPublicSession("event_public","join_proposal");
  const first = app.propose(session.id, "New Tune", "proposal_operation_one");
  assert.equal(first.state, "eligible");
  assert.deepEqual(app.propose(session.id, "New Tune", "proposal_operation_one"), first);
  assert.throws(()=>app.propose(session.id,"Changed Tune","proposal_operation_one"),(error:unknown)=>error instanceof ChoiceError&&error.code==="replay-mismatch");
  app.configureEvent("event_public", { proposalPolicy: "editorial" });
  assert.equal(app.propose(session.id, "Another Tune", "proposal_operation_two").state, "submitted");
  app.propose(session.id, "Third Tune", "proposal_operation_three");
  assert.throws(() => app.propose(session.id, "Fourth Tune", "proposal_operation_four"), (error: unknown) => error instanceof ChoiceError && error.code === "quota-exceeded");
  app.close();
});

test("legacy flat ballots remain flat while new ballots are ranked", () => {
  const app = service();
  assert.equal(app.interpretImportedBallot({ method: "flat", choices: ["song_alpha"] }).method, "flat");
  assert.equal(app.interpretImportedBallot({ choices: ["song_alpha"] }).method, "flat");
  assert.equal(app.getBallot(app.openPublicSession("event_public","join_ranked").id).method, "ranked-choice");
  app.close();
});

test("account claim stays attached to the original guest participation", () => {
  const app=service(),session=app.openPublicSession("event_public","join_claim");
  const first=app.claimParticipation(session.id,"account_alpha","proof_alpha");
  assert.deepEqual(app.claimParticipation(session.id,"account_alpha","proof_alpha"),first);
  assert.equal(first.participationId,session.participationId);
  assert.throws(()=>app.claimParticipation(session.id,"account_bravo","proof_bravo"),(error:unknown)=>error instanceof ChoiceError&&error.code==="claim-conflict");
  app.close();
});
