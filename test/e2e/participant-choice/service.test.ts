import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ChoiceService, ChoiceError } from "../../../packages/application/src/choice-service.ts";

function service() { const value = new ChoiceService(":memory:", { now: () => new Date("2026-01-02T12:00:00Z") }); value.migrate(); value.seedDemo(); return value; }

test("open join receipt recovers the same participant without a response cookie", () => {
  const directory=mkdtempSync(path.join(tmpdir(),"woodshed-open-join-")),filename=path.join(directory,"choice.sqlite");
  const first=new ChoiceService(filename),second=new ChoiceService(filename);
  try{first.migrate();first.seedDemo({publicParticipationPolicy:"open"});const original=first.openPublicSession("event_public","join_shared"),recovered=second.openPublicSession("event_public","join_shared");assert.equal(recovered.participationId,original.participationId);assert.notEqual(recovered.id,original.id);assert.equal(typeof (recovered as {recoveryCapability?:string}).recoveryCapability,"string");const replay=second.openPublicSession("event_public","join_shared",original.id);assert.equal(replay.id,original.id);assert.equal(Number((first.database.prepare("SELECT count(*) count FROM guest_participations WHERE event_id='event_public'").get() as {count:number}).count),1);assert.equal(Number((first.database.prepare("SELECT count(*) count FROM participant_sessions WHERE participation_id=?").get(original.participationId) as {count:number}).count),2);}finally{second.close();first.close();rmSync(directory,{recursive:true});}
});

test("out-of-order duplicate join responses keep every issued recovery credential valid",()=>{let now=new Date("2026-01-01T00:00:00Z");const app=new ChoiceService(":memory:",{now:()=>now});app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const original=app.openPublicSession("event_public","join_concurrent") as {participationId:string;recoveryCapability:string},firstRetry=app.openPublicSession("event_public","join_concurrent") as {participationId:string;recoveryCapability:string},secondRetry=app.openPublicSession("event_public","join_concurrent") as {participationId:string;recoveryCapability:string};assert.equal(firstRetry.participationId,original.participationId);assert.equal(secondRetry.participationId,original.participationId);now=new Date("2026-01-03T00:00:00Z");for(const capability of [original.recoveryCapability,firstRetry.recoveryCapability,secondRetry.recoveryCapability])assert.equal(app.recoverPublicSession("event_public",capability).participationId,original.participationId);app.close();});

test("join replay bounds recovery credentials without invalidating successful responses",()=>{let now=new Date("2026-01-01T00:00:00Z");const app=new ChoiceService(":memory:",{now:()=>now});app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const issued=[app.openPublicSession("event_public","join_recovery_cap") as {participationId:string;recoveryCapability:string}];for(let index=1;index<8;index++)issued.push(app.openPublicSession("event_public","join_recovery_cap") as {participationId:string;recoveryCapability:string});assert.throws(()=>app.openPublicSession("event_public","join_recovery_cap"),(error:unknown)=>error instanceof ChoiceError&&error.code==="recovery-capacity");assert.equal(Number((app.database.prepare("SELECT count(*) count FROM participation_recovery WHERE participation_id=?").get(issued[0]!.participationId) as {count:number}).count),8);now=new Date("2026-01-03T00:00:00Z");for(const item of issued)assert.equal(app.recoverPublicSession("event_public",item.recoveryCapability).participationId,issued[0]!.participationId);app.close();});

test("repeated recovery keeps the session table bounded",()=>{const app=new ChoiceService(":memory:");app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const issued=app.openPublicSession("event_public","join_bounded_sessions") as {participationId:string;recoveryCapability:string};for(let index=0;index<20;index++)app.recoverPublicSession("event_public",issued.recoveryCapability);assert.equal(Number((app.database.prepare("SELECT count(*) count FROM participant_sessions WHERE participation_id=?").get(issued.participationId) as {count:number}).count),8);app.close();});

test("SQLite rejects a ballot when voting closes between preflight and transaction",()=>{const directory=mkdtempSync(path.join(tmpdir(),"woodshed-ballot-race-")),filename=path.join(directory,"choice.sqlite"),closer=new ChoiceService(filename);let app:ChoiceService|undefined;try{closer.migrate();closer.seedDemo({publicParticipationPolicy:"open"});app=new ChoiceService(filename,{beforeBallotMutation:()=>closer.database.prepare("UPDATE events SET state='completed' WHERE id='event_public'").run()});const session=app.openPublicSession("event_public","join_ballot_race"),ballot=app.getBallot(session.id);assert.throws(()=>app!.replaceBallot(session.id,0,ballot.candidates.map(candidate=>candidate.id),"save_ballot_race"),(error:unknown)=>error instanceof ChoiceError&&error.code==="voting-closed");assert.equal(Number((closer.database.prepare("SELECT count(*) count FROM choice_receipts WHERE operation_id='save_ballot_race'").get() as {count:number}).count),0);}finally{app?.close();closer.close();rmSync(directory,{recursive:true});}});

test("open join proof ignores a different or expired session and recovers its participant",()=>{const app=new ChoiceService(":memory:");app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const victim=app.openPublicSession("event_public","join_victim"),other=app.openPublicSession("event_public","join_other"),wrong=app.openPublicSession("event_public","join_victim",other.id);assert.equal(wrong.participationId,victim.participationId);app.database.prepare("UPDATE participant_sessions SET expires_at='2000-01-01T00:00:00Z' WHERE participation_id=?").run(victim.participationId);const recovered=app.openPublicSession("event_public","join_victim",victim.id);assert.equal(recovered.participationId,victim.participationId);app.close();});

test("open join proof is bounded and hashed at rest",()=>{const app=new ChoiceService(":memory:");app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const operationId="join_bounded_recovery_proof";app.openPublicSession("event_public",operationId);const stored=app.database.prepare("SELECT operation_id FROM open_join_receipts").get() as {operation_id:string};assert.notEqual(stored.operation_id,operationId);assert.equal(stored.operation_id.length,64);assert.throws(()=>app.openPublicSession("event_public",`join_${"x".repeat(129)}`),(error:unknown)=>error instanceof ChoiceError&&error.code==="invalid-request");app.close();});

test("sessionless join replay expires after the bounded response-retry window",()=>{let now=new Date("2026-01-01T00:00:00Z");const app=new ChoiceService(":memory:",{now:()=>now});app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const original=app.openPublicSession("event_public","join_short_lived");now=new Date("2026-01-01T00:10:01Z");assert.throws(()=>app.openPublicSession("event_public","join_short_lived"),(error:unknown)=>error instanceof ChoiceError&&error.code==="unauthorized");assert.equal(app.openPublicSession("event_public","join_short_lived",original.id).id,original.id);app.close();});

test("legacy raw join receipts migrate to hashed keys during replay",()=>{const app=new ChoiceService(":memory:");app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const operationId="join_legacy_raw",original=app.openPublicSession("event_public",operationId);app.database.prepare("UPDATE open_join_receipts SET operation_id=?").run(operationId);assert.equal(app.openPublicSession("event_public",operationId,original.id).id,original.id);const stored=app.database.prepare("SELECT operation_id FROM open_join_receipts").get() as {operation_id:string};assert.notEqual(stored.operation_id,operationId);assert.equal(stored.operation_id.length,64);assert.equal(Number((app.database.prepare("SELECT count(*) count FROM guest_participations WHERE event_id='event_public'").get() as {count:number}).count),1);app.close();});

test("legacy cookie-less replay creates missing durable recovery state",()=>{let now=new Date("2026-01-01T00:00:00Z");const app=new ChoiceService(":memory:",{now:()=>now});app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const operationId="join_legacy_recovery",original=app.openPublicSession("event_public",operationId);app.database.prepare("UPDATE open_join_receipts SET operation_id=?").run(operationId);app.database.prepare("DELETE FROM participation_recovery WHERE participation_id=?").run(original.participationId);const replay=app.openPublicSession("event_public",operationId) as {participationId:string;recoveryCapability:string};assert.equal(replay.participationId,original.participationId);assert.equal(typeof replay.recoveryCapability,"string");now=new Date("2026-01-03T00:00:00Z");assert.equal(app.recoverPublicSession("event_public",replay.recoveryCapability).participationId,original.participationId);app.close();});

test("open-public recovery stops when an event becomes invite-only",()=>{const app=new ChoiceService(":memory:");app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const issued=app.openPublicSession("event_public","join_policy_change") as {recoveryCapability:string};app.database.prepare("UPDATE events SET participation_policy='invite' WHERE id='event_public'").run();assert.throws(()=>app.recoverSession("event_public",issued.recoveryCapability),(error:unknown)=>error instanceof ChoiceError&&error.code==="unauthorized");app.close();});

test("event lifecycle closes joins, reads, mutations, and exact replays",()=>{const app=new ChoiceService(":memory:");app.migrate();app.seedDemo({publicParticipationPolicy:"open"});const session=app.openPublicSession("event_public","join_before_close"),ballot=app.getBallot(session.id),rankings=ballot.candidates.map(candidate=>candidate.id);app.replaceBallot(session.id,0,rankings,"save_before_close");app.database.prepare("UPDATE events SET state='completed' WHERE id='event_public'").run();for(const action of [()=>app.openPublicSession("event_public","join_after_close"),()=>app.getBallot(session.id),()=>app.replaceBallot(session.id,0,rankings,"save_before_close")])assert.throws(action,(error:unknown)=>error instanceof ChoiceError&&error.code==="voting-closed");app.close();});

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

test("privileged invite sessions do not receive durable recovery",()=>{const app=service(),invite=app.issueInvite("event_public","organizer"),session=app.exchangeInvite(invite.capability);assert.equal(session.role,"organizer");assert.equal("recoveryCapability" in session,false);assert.equal(Number((app.database.prepare("SELECT count(*) count FROM participation_recovery WHERE participation_id=?").get(session.participationId) as {count:number}).count),0);app.close();});

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

const choiceCode = (code: string) => (error: unknown) => error instanceof ChoiceError && error.code === code;

test("invite recovery survives reconnect and preserves the saved ballot", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "woodshed-invite-recovery-"));
  const filename = path.join(directory, "choice.sqlite");
  let app = new ChoiceService(filename);
  try {
    app.migrate(); app.seedDemo();
    const issued = app.exchangeInvite(app.issueInvite("event_public", "participant").capability);
    assert.ok("recoveryCapability" in issued);
    const rankings = app.getBallot(issued.id).candidates.map(({ id }) => id);
    app.replaceBallot(issued.id, 0, rankings, "persisted_ballot");
    app.revokeSession(issued.id);
    app.close(); app = new ChoiceService(filename); app.migrate();
    assert.throws(() => app.session(issued.id), choiceCode("unauthorized"));
    assert.throws(() => app.recoverPublicSession("event_public", issued.recoveryCapability), choiceCode("unauthorized"));
    const recovered = app.recoverSession("event_public", issued.recoveryCapability, "invite");
    assert.equal(recovered.participationId, issued.participationId);
    assert.equal(app.getBallot(recovered.id).revision, 1);
    assert.deepEqual(app.getBallot(recovered.id).candidates.map(({ id }) => id), rankings);
    assert.equal(app.recoveryEventContext(issued.recoveryCapability).id, "event_public");
  } finally { app.close(); rmSync(directory, { recursive: true }); }
});

test("revoking any recovery credential invalidates sibling credentials and sessions only for its participant", () => {
  const app = service();
  try {
    app.seedDemo({ publicParticipationPolicy: "open" });
    const first = app.openPublicSession("event_public", "revoke_join");
    const sibling = app.openPublicSession("event_public", "revoke_join");
    const other = app.openPublicSession("event_public", "other_join");
    assert.ok("recoveryCapability" in first && "recoveryCapability" in sibling);
    app.revokeRecovery(first.recoveryCapability);
    app.revokeRecovery(first.recoveryCapability); app.revokeRecovery("unknown");
    for (const issued of [first, sibling]) {
      assert.throws(() => app.session(issued.id), choiceCode("unauthorized"));
      assert.throws(() => app.recoverSession("event_public", issued.recoveryCapability), choiceCode("unauthorized"));
      assert.throws(() => app.recoveryEventContext(issued.recoveryCapability), choiceCode("unauthorized"));
    }
    assert.equal(app.session(other.id).participationId, other.participationId);
  } finally { app.close(); }
});

test("recovery rejects unknown, expired, removed, wrong-event and closed-event credentials without issuing sessions", () => {
  const app = service();
  try {
    app.seedDemo({ publicParticipationPolicy: "open" });
    const issued = app.openPublicSession("event_public", "recovery_errors");
    assert.ok("recoveryCapability" in issued);
    assert.throws(() => app.recoverSession("event_public", "unknown"), choiceCode("unauthorized"));
    assert.throws(() => app.recoveryEventContext("unknown"), choiceCode("unauthorized"));
    assert.throws(() => app.recoverSession("event_other", issued.recoveryCapability), choiceCode("unauthorized"));
    assert.throws(() => app.recoverSession("missing", issued.recoveryCapability), choiceCode("not-found"));
    app.database.prepare("UPDATE participation_recovery SET expires_at='2000-01-01T00:00:00Z'").run();
    assert.throws(() => app.recoverSession("event_public", issued.recoveryCapability), choiceCode("unauthorized"));
    assert.throws(() => app.recoveryEventContext(issued.recoveryCapability), choiceCode("unauthorized"));
    app.database.prepare("UPDATE participation_recovery SET expires_at='2099-01-01T00:00:00Z'").run();
    app.database.prepare("UPDATE events SET state='completed' WHERE id='event_public'").run();
    assert.throws(() => app.recoverSession("event_public", issued.recoveryCapability), choiceCode("voting-closed"));
    assert.throws(() => app.recoveryEventContext(issued.recoveryCapability), choiceCode("unauthorized"));
    app.database.prepare("UPDATE events SET state='voting' WHERE id='event_public'").run();
    app.removeParticipant(issued.participationId);
    assert.throws(() => app.session(issued.id), choiceCode("unauthorized"));
    assert.throws(() => app.recoverSession("event_public", issued.recoveryCapability), choiceCode("unauthorized"));
    assert.equal((app.database.prepare("SELECT count(*) n FROM participant_sessions").get() as { n: number }).n, 1);
  } finally { app.close(); }
});

test("invalid join timestamps and revoked participants cannot replay a receipt", () => {
  const app = service();
  try {
    const issued = app.openPublicSession("event_public", "invalid_join_age");
    for (const timestamp of ["invalid", "2099-01-01T00:00:00Z"]) {
      app.database.prepare("UPDATE open_join_receipts SET created_at=?").run(timestamp);
      assert.throws(() => app.openPublicSession("event_public", "invalid_join_age"), choiceCode("unauthorized"));
    }
    app.database.prepare("UPDATE open_join_receipts SET created_at='2026-01-02T12:00:00Z'").run();
    app.removeParticipant(issued.participationId);
    assert.throws(() => app.openPublicSession("event_public", "invalid_join_age"), choiceCode("unauthorized"));
    assert.throws(() => app.openPublicSession("missing", "join"), choiceCode("not-found"));
    assert.throws(() => app.openPublicSession("event_public", ""), choiceCode("invalid-request"));
  } finally { app.close(); }
});

test("migration checksums detect changed history and clean migrations are repeatable", () => {
  const app = service();
  try {
    const before = app.database.prepare("SELECT * FROM schema_migrations ORDER BY name").all();
    app.migrate(); assert.deepEqual(app.database.prepare("SELECT * FROM schema_migrations ORDER BY name").all(), before);
    app.database.prepare("UPDATE schema_migrations SET checksum='changed' WHERE name=(SELECT min(name) FROM schema_migrations)").run();
    assert.throws(() => app.migrate(), choiceCode("migration-checksum-mismatch"));
  } finally { app.close(); }
});

test("demo seeding rejects foreign data and an incomplete existing demo", () => {
  const app = new ChoiceService(":memory:");
  try {
    app.migrate(); app.database.prepare("INSERT INTO communities(id,name) VALUES ('community_foreign','Existing')").run();
    assert.throws(() => app.seedDemo(), choiceCode("demo-seed-requires-empty-database"));
    app.database.prepare("DELETE FROM communities").run();
    app.database.prepare("INSERT INTO communities(id,name) VALUES ('community_demo','Incomplete')").run();
    assert.throws(() => app.seedDemo({ publicParticipationPolicy: "open" }), choiceCode("invalid-demo-dataset"));
    assert.deepEqual(app.discoverEvents(), []);
  } finally { app.close(); }
});

test("an interrupted invite exchange rolls back the participation and keeps the invite usable", () => {
  const app = service();
  try {
    const invite = app.issueInvite("event_public", "participant");
    app.database.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON participation_recovery BEGIN SELECT RAISE(ABORT, 'recovery unavailable'); END");
    assert.throws(() => app.exchangeInvite(invite.capability), /recovery unavailable/);
    assert.equal((app.database.prepare("SELECT count(*) n FROM guest_participations").get() as { n: number }).n, 0);
    assert.equal((app.database.prepare("SELECT count(*) n FROM participant_sessions").get() as { n: number }).n, 0);
    app.database.exec("DROP TRIGGER fail_recovery");
    assert.equal(app.exchangeInvite(invite.capability).assurance, "invite");
  } finally { app.close(); }
});

test("failed proposal receipt persistence rolls back the proposal and preserves quota", () => {
  const app = service();
  try {
    const session = app.openPublicSession("event_public", "proposal_rollback");
    app.database.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON proposal_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    assert.throws(() => app.propose(session.id, "Song", "failed_proposal"), /receipt unavailable/);
    assert.equal((app.database.prepare("SELECT count(*) n FROM choice_proposals").get() as { n: number }).n, 0);
    app.database.exec("DROP TRIGGER fail_receipt");
    assert.equal(app.propose(session.id, "Song", "failed_proposal").state, "eligible");
  } finally { app.close(); }
});

test("empty ballots and discovery remain scoped to newly created draft events", () => {
  const app = service();
  try {
    const event = app.createEvent({ id: "event_empty", communityId: "community_demo", name: "Empty", visibility: "public", participationPolicy: "open", proposalPolicy: "editorial" });
    assert.equal(event.state, "draft");
    assert.equal(app.discoverEvents().some(row => row.id === event.id), false);
    assert.equal(app.eventEntry("missing", null).outcome, "not-found");
    assert.equal(app.eventEntry("event_unlisted", "capability").outcome, "eligible-invite");
    app.database.prepare("UPDATE events SET state='voting' WHERE id=?").run(event.id);
    const session = app.openPublicSession(event.id, "empty_join");
    assert.deepEqual(app.getBallot(session.id), { method: "ranked-choice", revision: 0, candidates: [] });
    assert.equal(app.replaceBallot(session.id, 0, [], "empty_save").revision, 1);
    assert.equal(app.propose(session.id, "First song", "empty_proposal").state, "submitted");
    assert.throws(() => app.assertEvent(session.id, "event_public"), choiceCode("denied"));
    assert.equal(app.eventContext(session).id, event.id);
    assert.throws(() => app.eventContext({ ...session, communityId: "community_other" }), choiceCode("not-found"));
    assert.throws(() => app.addEligibleSong(event.id, "missing"), choiceCode("denied"));
  } finally { app.close(); }
});

test("aggregate privacy threshold and recommendation use only active submitted ballots", () => {
  const app = service();
  try {
    const sessions = [0, 1, 2].map(index => app.openPublicSession("event_public", `aggregate_${index}`));
    for (const session of sessions) app.replaceBallot(session.id, 0, ["song_bravo", "song_alpha"], `save_${session.participationId}`);
    assert.deepEqual(app.aggregate("event_public"), { cohortSize: 3, redacted: false, totals: { song_bravo: 30, song_alpha: 27 } });
    const draft = app.draft("event_public");
    assert.deepEqual(draft.items.map(item => item.songId), ["song_bravo", "song_alpha"]);
    assert.equal(draft.items[0]?.factors.demand.value, 30);
    assert.deepEqual(app.draft("event_public", ["song_alpha", "song_bravo"], "Opening tune").explanation.override, { order: ["song_alpha", "song_bravo"], reason: "Opening tune" });
    app.removeParticipant(sessions[0]!.participationId);
    assert.deepEqual(app.aggregate("event_public"), { cohortSize: 2, redacted: true, totals: null });
    assert.ok(app.draft("event_public").items.every(item => item.factors.demand.value === 0));
    assert.deepEqual(app.draft("event_other").items, []);
  } finally { app.close(); }
});

test("ballot validation and receipt failure leave saved rankings and revision intact", () => {
  const app = service();
  try {
    const session = app.openPublicSession("event_public", "ballot_rollback");
    for (const rankings of [["song_alpha", "song_alpha"], ["song_charlie"]])
      assert.throws(() => app.replaceBallot(session.id, 0, rankings, "invalid_save"), choiceCode("invalid-ballot"));
    app.database.exec("CREATE TRIGGER fail_ballot_receipt BEFORE INSERT ON choice_receipts BEGIN SELECT RAISE(ABORT, 'ballot receipt unavailable'); END");
    assert.throws(() => app.replaceBallot(session.id, 0, ["song_alpha"], "retry_save"), /ballot receipt unavailable/);
    assert.equal(app.getBallot(session.id).revision, 0);
    app.database.exec("DROP TRIGGER fail_ballot_receipt");
    assert.equal(app.replaceBallot(session.id, 0, ["song_alpha"], "retry_save").revision, 1);
    assert.throws(() => app.replaceBallot(session.id, 0, ["song_bravo"], "retry_save"), choiceCode("replay-mismatch"));
  } finally { app.close(); }
});

test("failed participant and recovery revocations are atomic and retryable", () => {
  const app = service();
  try {
    const issued = app.exchangeInvite(app.issueInvite("event_public", "participant").capability);
    assert.ok("recoveryCapability" in issued);
    app.database.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE ON participation_recovery BEGIN SELECT RAISE(ABORT, 'revoke unavailable'); END");
    assert.throws(() => app.removeParticipant(issued.participationId), /revoke unavailable/);
    assert.equal(app.session(issued.id).participationId, issued.participationId);
    assert.throws(() => app.revokeRecovery(issued.recoveryCapability), /revoke unavailable/);
    assert.equal(app.recoverSession("event_public", issued.recoveryCapability).participationId, issued.participationId);
    app.database.exec("DROP TRIGGER fail_revoke");
    app.revokeRecovery(issued.recoveryCapability);
    assert.throws(() => app.session(issued.id), choiceCode("unauthorized"));
  } finally { app.close(); }
});

test("eligible song insertion rolls back when decision persistence fails and deduplicates retry", () => {
  const app = service();
  try {
    const session = app.openPublicSession("event_public", "eligible_retry");
    app.database.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON event_song_decisions BEGIN SELECT RAISE(ABORT, 'decision unavailable'); END");
    assert.throws(() => app.addEligibleSong("event_public", "song_charlie"), /decision unavailable/);
    assert.equal(app.getBallot(session.id).candidates.length, 2);
    app.database.exec("DROP TRIGGER fail_decision");
    app.addEligibleSong("event_public", "song_charlie"); app.addEligibleSong("event_public", "song_charlie");
    assert.equal(app.getBallot(session.id).candidates.length, 3);
    assert.equal((app.database.prepare("SELECT count(*) n FROM event_song_decisions WHERE event_id='event_public' AND song_id='song_charlie'").get() as { n: number }).n, 1);
  } finally { app.close(); }
});
