import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { stableCandidateOrder } from "../../domain/src/candidate-order.ts";
import { recommendSetlist } from "../../recommendation/src/index.ts";
import { sha256 } from "../../contracts/src/snapshot.ts";

export class ChoiceError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}

export type Session = { id: string; participationId: string; communityId: string; eventId: string; role: string; assurance: "invite" | "open-public" };
export type IssuedSession = Session & { recoveryCapability: string };
type Options = { now?: () => Date; random?: (bytes: number) => Buffer; maxOpenParticipantsPerEvent?: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const migrations = () => fileURLToPath(new URL("../../../migrations/sqlite/", import.meta.url));

export class ChoiceService {
  readonly database: DatabaseSync;
  private readonly now: () => Date;
  private readonly random: (bytes: number) => Buffer;
  private readonly maxOpenParticipantsPerEvent:number;

  constructor(filename = ":memory:", options: Options = {}) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
    this.maxOpenParticipantsPerEvent=options.maxOpenParticipantsPerEvent??10_000;
  }
  close() { this.database.close(); }
  migrate() {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT");
    for (const name of readdirSync(migrations()).filter((n) => n.endsWith(".sql")).sort()) {
      const sql=readFileSync(path.join(migrations(),name),"utf8"), checksum=sha256(sql);const existing=this.database.prepare("SELECT checksum FROM schema_migrations WHERE name=?").get(name) as {checksum:string}|undefined;
      if(existing){if(existing.checksum!==checksum)throw new ChoiceError("migration-checksum-mismatch");continue;}
      this.database.exec("BEGIN IMMEDIATE");try{this.database.exec(sql);this.database.prepare("INSERT INTO schema_migrations(name,checksum,applied_at) VALUES (?,?,?)").run(name,checksum,new Date(0).toISOString());this.database.exec("COMMIT");}catch(error){this.database.exec("ROLLBACK");throw error;}
    }
  }
  seedDemo(options: { publicParticipationPolicy?: "invite" | "open" } = {}) {
    const existing = this.database.prepare("SELECT id FROM communities WHERE id='community_demo'").get();
    if (existing) {
      if (options.publicParticipationPolicy) {
        const changed=this.database.prepare("UPDATE events SET participation_policy=? WHERE id='event_public' AND community_id='community_demo'").run(options.publicParticipationPolicy);
        if(changed.changes!==1)throw new ChoiceError("invalid-demo-dataset");
      }
      return;
    }
    const communityCount = Number((this.database.prepare("SELECT count(*) AS count FROM communities").get() as { count: number }).count);
    if (communityCount !== 0) throw new ChoiceError("demo-seed-requires-empty-database");
    this.database.exec("BEGIN IMMEDIATE");
    try { this.database.exec(`
      INSERT INTO communities(id,name) VALUES ('community_demo','River City Music Circle'),('community_other','Other Community');
      INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES
        ('event_public','community_demo','Summer Singalong','voting','public','invite'),
        ('event_unlisted','community_demo','Band Workshop','published','unlisted','invite'),
        ('event_private','community_demo','Private Rehearsal','draft','private','invite'),
        ('event_other','community_other','Other Event','voting','private','open');
      INSERT INTO canonical_songs(id,community_id,title) VALUES ('song_alpha','community_demo','North Star'),('song_bravo','community_demo','Open Road'),('song_charlie','community_demo','Quiet River');
      INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES ('event_public','song_alpha','2026-01-01T00:00:00Z'),('event_public','song_bravo','2026-01-01T00:00:00Z');
      INSERT INTO event_song_decisions(id,community_id,event_id,song_id,revision,snapshot_json,created_at) VALUES ('decision_alpha','community_demo','event_public','song_alpha',1,'{"title":"North Star"}','2026-01-01T00:00:00Z'),('decision_bravo','community_demo','event_public','song_bravo',1,'{"title":"Open Road"}','2026-01-01T00:00:00Z');
    `);
      if (options.publicParticipationPolicy === "open") this.database.prepare("UPDATE events SET participation_policy='open' WHERE id='event_public'").run();
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  discoverEvents() { return this.database.prepare("SELECT id,name,state,visibility,participation_policy AS participationPolicy FROM events WHERE visibility='public' AND state <> 'draft' ORDER BY name").all(); }
  private assertVotingOpen(eventId:string){const event=this.database.prepare("SELECT state FROM events WHERE id=?").get(eventId) as {state:string}|undefined;if(!event)throw new ChoiceError("not-found");if(!["voting","live"].includes(event.state))throw new ChoiceError("voting-closed");}
  eventEntry(eventId: string, capability: string | null) {
    const event = this.database.prepare("SELECT visibility,participation_policy FROM events WHERE id=?").get(eventId) as { visibility: string; participation_policy: string } | undefined;
    if (!event) return { outcome: "not-found" };
    if (event.visibility === "private") return { outcome: "private" };
    if (event.visibility === "unlisted" && !capability) return { outcome: "invalid-link" };
    if (event.participation_policy === "open") return { outcome: "eligible-open" };
    return { outcome: capability ? "eligible-invite" : "discoverable-ineligible" };
  }
  issueInvite(eventId: string, role: string, expiresAt = new Date(this.now().getTime() + 86_400_000)) {
    const id = `invite_${this.random(12).toString("hex")}`; const capability = this.random(32).toString("base64url");
    this.database.prepare("INSERT INTO invite_capabilities(id,event_id,token_hash,role,expires_at) VALUES (?,?,?,?,?)").run(id,eventId,hash(capability),role,expiresAt.toISOString());
    return { id, capability, expiresAt: expiresAt.toISOString() };
  }
  debugCapabilityStored(capability: string) { return Boolean(this.database.prepare("SELECT 1 FROM invite_capabilities WHERE token_hash=?").get(capability)); }
  revokeInvite(id: string) { this.database.prepare("UPDATE invite_capabilities SET revoked_at=? WHERE id=?").run(this.now().toISOString(),id); }
  exchangeInvite(capability: string): IssuedSession {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const invite = this.database.prepare("SELECT i.*,e.community_id FROM invite_capabilities i JOIN events e ON e.id=i.event_id WHERE token_hash=?").get(hash(capability)) as Record<string, string | null> | undefined;
      if (!invite || invite.revoked_at || invite.exchanged_at) throw new ChoiceError("invalid-capability");
      if (Date.parse(String(invite.expires_at)) < this.now().getTime()) throw new ChoiceError("expired-capability");
      const session = this.createSession(String(invite.event_id), String(invite.community_id), String(invite.role), "invite");
      this.database.prepare("UPDATE invite_capabilities SET exchanged_at=? WHERE id=? AND exchanged_at IS NULL").run(this.now().toISOString(), String(invite.id));
      this.database.exec("COMMIT"); return session;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  openPublicSession(eventId: string, operationId: string, replaySessionId?: string): Session|IssuedSession {
    const event = this.database.prepare("SELECT community_id,participation_policy FROM events WHERE id=?").get(eventId) as {community_id:string;participation_policy:string}|undefined;
    if (!event) throw new ChoiceError("not-found");
    this.assertVotingOpen(eventId);
    if (!operationId||operationId.length>128) throw new ChoiceError("invalid-request");
    // Synthetic preview permits this seam even when demo policy is invite; HTTP route enforces open policy.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const operationHash=hash(operationId),receipt=this.database.prepare("SELECT operation_id,participation_id,created_at FROM open_join_receipts WHERE event_id=? AND operation_id IN (?,?) ORDER BY operation_id=? DESC LIMIT 1").get(eventId,operationHash,operationId,operationHash) as {operation_id:string;participation_id:string;created_at:string}|undefined;
      if(receipt){
        if(receipt.operation_id!==operationHash)this.database.prepare("UPDATE open_join_receipts SET operation_id=? WHERE event_id=? AND operation_id=?").run(operationHash,eventId,receipt.operation_id);
        let session:Session|IssuedSession|undefined;if(replaySessionId)try{const replay=this.assertEvent(replaySessionId,eventId);if(replay.participationId===receipt.participation_id)session=replay;}catch(error){if(!(error instanceof ChoiceError))throw error;}if(!session){const receiptAge=this.now().getTime()-Date.parse(receipt.created_at);if(!Number.isFinite(receiptAge)||receiptAge<0||receiptAge>10*60_000)throw new ChoiceError("unauthorized");const participation=this.database.prepare("SELECT p.community_id,p.event_id,p.revoked_at FROM guest_participations p WHERE p.id=?").get(receipt.participation_id) as {community_id:string;event_id:string;revoked_at:string|null}|undefined;if(!participation||participation.revoked_at||participation.event_id!==eventId)throw new ChoiceError("unauthorized");const replacement=this.createSessionForParticipation(receipt.participation_id,eventId,participation.community_id,"participant","open-public"),recoveryCapability=this.random(32).toString("base64url"),expiresAt=new Date(this.now().getTime()+30*86_400_000).toISOString();this.database.prepare("INSERT INTO participation_recovery(token_hash,participation_id,community_id,event_id,role,assurance,expires_at,revoked_at) VALUES (?,?,?,?,?,'open-public',?,NULL) ON CONFLICT(participation_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,revoked_at=NULL").run(hash(recoveryCapability),receipt.participation_id,participation.community_id,eventId,"participant",expiresAt);session={...replacement,recoveryCapability};}
        this.database.exec("COMMIT");
        return session;
      }
      const count=Number((this.database.prepare("SELECT count(*) count FROM guest_participations WHERE event_id=? AND revoked_at IS NULL").get(eventId) as {count:number}).count);if(count>=this.maxOpenParticipantsPerEvent)throw new ChoiceError("open-participation-capacity");
      const session=this.createSession(eventId,event.community_id,"participant","open-public");
      this.database.prepare("INSERT INTO open_join_receipts(event_id,operation_id,participation_id,created_at) VALUES (?,?,?,?)").run(eventId,operationHash,session.participationId,this.now().toISOString());
      this.database.exec("COMMIT");
      return session;
    }catch(error){this.database.exec("ROLLBACK");throw error;}
  }
  private createSession(eventId:string, communityId:string, role:string, assurance:Session["assurance"]): IssuedSession {
    const participationId=`participation_${this.random(12).toString("hex")}`, id=this.random(32).toString("base64url"),recoveryCapability=this.random(32).toString("base64url");
    this.database.prepare("INSERT INTO guest_participations(id,community_id,event_id) VALUES (?,?,?)").run(participationId,communityId,eventId);
    const session=this.createSessionForParticipation(participationId,eventId,communityId,role,assurance,id);
    this.database.prepare("INSERT INTO participation_recovery(token_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (?,?,?,?,?,?,?)").run(hash(recoveryCapability),participationId,communityId,eventId,role,assurance,new Date(this.now().getTime()+30*86_400_000).toISOString());
    return {...session,recoveryCapability};
  }
  private createSessionForParticipation(participationId:string,eventId:string,communityId:string,role:string,assurance:Session["assurance"],id=this.random(32).toString("base64url")):Session{
    this.database.prepare("INSERT INTO participant_sessions(id_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (?,?,?,?,?,?,?)").run(hash(id),participationId,communityId,eventId,role,assurance,new Date(this.now().getTime()+86_400_000).toISOString());
    return {id,participationId,communityId,eventId,role,assurance};
  }
  recoverSession(eventId:string,recoveryCapability:string,expectedAssurance?:Session["assurance"]):Session{this.assertVotingOpen(eventId);const recovery=this.database.prepare("SELECT r.participation_id,r.community_id,r.event_id,r.role,r.assurance,r.expires_at,r.revoked_at,p.revoked_at participation_revoked_at,e.participation_policy FROM participation_recovery r JOIN guest_participations p ON p.id=r.participation_id JOIN events e ON e.id=r.event_id WHERE r.token_hash=?").get(hash(recoveryCapability)) as Record<string,string|null>|undefined;if(!recovery||recovery.revoked_at||recovery.participation_revoked_at||recovery.event_id!==eventId||(expectedAssurance&&recovery.assurance!==expectedAssurance)||(recovery.assurance==="open-public"&&recovery.participation_policy!=="open")||Date.parse(String(recovery.expires_at))<this.now().getTime())throw new ChoiceError("unauthorized");return this.createSessionForParticipation(String(recovery.participation_id),String(recovery.event_id),String(recovery.community_id),String(recovery.role),recovery.assurance as Session["assurance"]);}
  recoverPublicSession(eventId:string,recoveryCapability:string):Session{return this.recoverSession(eventId,recoveryCapability,"open-public");}
  session(id:string): Session {
    const row=this.database.prepare("SELECT participation_id,community_id,event_id,role,assurance,expires_at,revoked_at FROM participant_sessions WHERE id_hash=?").get(hash(id)) as Record<string,string|null>|undefined;
    if(!row||row.revoked_at||Date.parse(String(row.expires_at))<this.now().getTime()) throw new ChoiceError("unauthorized");
    return {id,participationId:String(row.participation_id),communityId:String(row.community_id),eventId:String(row.event_id),role:String(row.role),assurance:row.assurance as Session["assurance"]};
  }
  assertEvent(sessionId:string,eventId:string){const session=this.session(sessionId);if(session.eventId!==eventId)throw new ChoiceError("denied");return session;}
  eventContext(session:Session){const event=this.database.prepare("SELECT id,name,state,visibility,participation_policy AS participationPolicy FROM events WHERE id=? AND community_id=?").get(session.eventId,session.communityId);if(!event)throw new ChoiceError("not-found");return event;}
  getBallot(sessionId:string){
    const s=this.session(sessionId);this.assertVotingOpen(s.eventId);const prior=this.database.prepare("SELECT candidate_order_json,rankings_json,current_revision FROM participant_ballots WHERE participation_id=?").get(s.participationId) as {candidate_order_json:string;rankings_json:string;current_revision:number}|undefined;
    const ids=(this.database.prepare("SELECT song_id FROM event_eligible_songs WHERE event_id=? ORDER BY added_at,song_id").all(s.eventId) as {song_id:string}[]).map(r=>r.song_id);
    const priorOrder=prior?JSON.parse(prior.current_revision>0?prior.rankings_json:prior.candidate_order_json) as string[]:[];
    const order=stableCandidateOrder(s.participationId,ids,priorOrder);
    const serializedOrder=JSON.stringify(order);
    if(prior && prior.candidate_order_json!==serializedOrder)this.database.prepare("UPDATE participant_ballots SET candidate_order_json=? WHERE participation_id=?").run(serializedOrder,s.participationId);
    else if(!prior)this.database.prepare("INSERT INTO participant_ballots(participation_id,event_id,current_revision,state,candidate_order_json) VALUES (?,?,0,'open',?)").run(s.participationId,s.eventId,serializedOrder);
    const titles=new Map((this.database.prepare("SELECT id,title FROM canonical_songs WHERE id IN (SELECT song_id FROM event_eligible_songs WHERE event_id=?)").all(s.eventId) as {id:string;title:string}[]).map(r=>[r.id,r.title]));
    return {method:"ranked-choice" as const,revision:prior?.current_revision??0,candidates:order.map(id=>({id,title:titles.get(id)??id}))};
  }
  replaceBallot(sessionId:string,expectedRevision:number,rankings:string[],operationId:string){
    const s=this.session(sessionId);this.assertVotingOpen(s.eventId);const receipt=this.database.prepare("SELECT request_hash,result_json FROM choice_receipts WHERE community_id=? AND operation_id=?").get(s.communityId,operationId) as {request_hash:string;result_json:string}|undefined;
    const requestHash=hash(JSON.stringify({participationId:s.participationId,expectedRevision,rankings})); if(receipt){if(receipt.request_hash!==requestHash)throw new ChoiceError("replay-mismatch");return JSON.parse(receipt.result_json);}
    const ballot=this.getBallot(sessionId), state=this.database.prepare("SELECT state FROM participant_ballots WHERE participation_id=?").get(s.participationId) as {state:string};
    if(!["open","reopened"].includes(state.state))throw new ChoiceError("voting-closed"); if(ballot.revision!==expectedRevision)throw new ChoiceError("conflict");
    const eligible=new Set(ballot.candidates.map(c=>c.id));if(new Set(rankings).size!==rankings.length||rankings.some(id=>!eligible.has(id)))throw new ChoiceError("invalid-ballot");
    const result={method:"ranked-choice",revision:expectedRevision+1,rankings}; this.database.exec("BEGIN IMMEDIATE");try{
      const changed=this.database.prepare("UPDATE participant_ballots SET current_revision=?,rankings_json=? WHERE participation_id=? AND current_revision=?").run(result.revision,JSON.stringify(rankings),s.participationId,expectedRevision);if(changed.changes!==1)throw new ChoiceError("conflict");
      this.database.prepare("INSERT INTO choice_receipts(community_id,operation_id,request_hash,result_json,created_at) VALUES (?,?,?,?,?)").run(s.communityId,operationId,requestHash,JSON.stringify(result),this.now().toISOString());this.database.exec("COMMIT");return result;
    }catch(error){this.database.exec("ROLLBACK");throw error;}
  }
  addEligibleSong(eventId:string,songId:string){const row=this.database.prepare("SELECT e.community_id,s.title FROM events e JOIN canonical_songs s ON s.community_id=e.community_id WHERE e.id=? AND s.id=?").get(eventId,songId) as {community_id:string;title:string}|undefined;if(!row)throw new ChoiceError("denied");this.database.exec("BEGIN IMMEDIATE");try{this.database.prepare("INSERT OR IGNORE INTO event_eligible_songs(event_id,song_id,added_at) VALUES (?,?,?)").run(eventId,songId,this.now().toISOString());this.database.prepare("INSERT OR IGNORE INTO event_song_decisions(id,community_id,event_id,song_id,revision,snapshot_json,created_at) VALUES (?,?,?,?,1,?,?)").run(`decision_${hash(`${eventId}:${songId}`).slice(0,24)}`,row.community_id,eventId,songId,JSON.stringify({title:row.title}),this.now().toISOString());this.database.exec("COMMIT");}catch(error){this.database.exec("ROLLBACK");throw error;}}
  setVotingState(eventId:string,state:"closed"|"reopened"){this.database.prepare("UPDATE participant_ballots SET state=? WHERE event_id=?").run(state,eventId);}
  removeParticipant(id:string){const now=this.now().toISOString();this.database.exec("BEGIN IMMEDIATE");try{this.database.prepare("UPDATE guest_participations SET revoked_at=? WHERE id=?").run(now,id);this.database.prepare("UPDATE participation_recovery SET revoked_at=? WHERE participation_id=?").run(now,id);this.database.exec("COMMIT")}catch(error){this.database.exec("ROLLBACK");throw error;}}
  aggregate(eventId:string){
    const ballots=this.database.prepare("SELECT b.rankings_json FROM participant_ballots b JOIN guest_participations p ON p.id=b.participation_id WHERE b.event_id=? AND p.revoked_at IS NULL AND b.current_revision>0").all(eventId) as {rankings_json:string}[];
    if(ballots.length<3)return {cohortSize:ballots.length,redacted:true,totals:null};
    const totals:Record<string,number>={};for(const b of ballots)for(const [index,id] of (JSON.parse(b.rankings_json) as string[]).entries())totals[id]=(totals[id]??0)+Math.max(1,10-index);
    return {cohortSize:ballots.length,redacted:false,totals};
  }
  configureEvent(eventId:string,input:{proposalPolicy:"immediate"|"editorial"}){this.database.prepare("UPDATE event_choice_config SET proposal_policy=? WHERE event_id=?").run(input.proposalPolicy,eventId);}
  propose(sessionId:string,title:string,operationId:string){
    const s=this.session(sessionId),requestHash=hash(JSON.stringify({title}));this.database.exec("BEGIN IMMEDIATE");try{const old=this.database.prepare("SELECT request_hash,result_json FROM proposal_receipts WHERE participation_id=? AND operation_id=?").get(s.participationId,operationId) as {request_hash:string;result_json:string}|undefined;if(old){if(old.request_hash!==requestHash)throw new ChoiceError("replay-mismatch");this.database.exec("COMMIT");return JSON.parse(old.result_json);}const count=Number((this.database.prepare("SELECT count(*) n FROM choice_proposals WHERE participation_id=?").get(s.participationId) as {n:number}).n);if(count>=3)throw new ChoiceError("quota-exceeded");const config=this.database.prepare("SELECT proposal_policy FROM event_choice_config WHERE event_id=?").get(s.eventId) as {proposal_policy:string};const result={id:`proposal_${hash(`${s.participationId}:${operationId}`).slice(0,24)}`,title,state:config.proposal_policy==="immediate"?"eligible":"submitted"};this.database.prepare("INSERT INTO choice_proposals(id,event_id,participation_id,title,state,created_at) VALUES (?,?,?,?,?,?)").run(result.id,s.eventId,s.participationId,title,result.state,this.now().toISOString());this.database.prepare("INSERT INTO proposal_receipts(participation_id,operation_id,request_hash,result_json) VALUES (?,?,?,?)").run(s.participationId,operationId,requestHash,JSON.stringify(result));this.database.exec("COMMIT");return result;}catch(error){this.database.exec("ROLLBACK");throw error;}
  }
  interpretImportedBallot(input:{method?:string;choices:string[]}){return {method:input.method??"flat",choices:input.choices};}
  claimParticipation(sessionId:string,accountId:string,proofReference:string){const s=this.session(sessionId);const existing=this.database.prepare("SELECT account_id FROM participation_claims WHERE participation_id=?").get(s.participationId) as {account_id:string}|undefined;if(existing){if(existing.account_id!==accountId)throw new ChoiceError("claim-conflict");return {participationId:s.participationId,accountId};}try{this.database.prepare("INSERT INTO participation_claims(participation_id,account_id,proof_reference,claimed_at) VALUES (?,?,?,?)").run(s.participationId,accountId,proofReference,this.now().toISOString());return {participationId:s.participationId,accountId};}catch{throw new ChoiceError("claim-conflict");}}
  createEvent(input:{id:string;communityId:string;name:string;visibility:"public"|"unlisted"|"private";participationPolicy:"invite"|"open";proposalPolicy:"immediate"|"editorial"}){this.database.prepare("INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES (?,?,?,'draft',?,?)").run(input.id,input.communityId,input.name,input.visibility,input.participationPolicy);this.configureEvent(input.id,{proposalPolicy:input.proposalPolicy});return { ...input,state:"draft" as const};}
  draft(eventId:string,overrideOrder?:string[],reason?:string){
    const songs=this.database.prepare("SELECT s.id songId,s.title FROM canonical_songs s JOIN event_eligible_songs e ON e.song_id=s.id WHERE e.event_id=?").all(eventId) as {songId:string;title:string}[];const aggregate=this.aggregate(eventId);
    return recommendSetlist({algorithmVersion:"draft-setlist/v1",seed:`${eventId}:v1`,weights:{demand:.7,feasibility:.3},songs:songs.map(song=>({...song,demand:aggregate.totals?.[song.songId]??0,feasibility:null})),overrideOrder,overrideReason:reason});
  }
}
