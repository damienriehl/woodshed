import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import { transitionQueueEntry, type QueueEntryState } from "../../domain/src/live.ts";
import { RuntimeError, record, webSha256 } from "./choice-runtime.ts";

type Lease = { eventId: string; deviceInstallationId: string; epoch: number; revoked: boolean };
type LiveAction = "suggest" | "plan" | "queue" | "make-current" | "perform" | "skip" | "defer" | "restore";
const targets: Record<LiveAction, QueueEntryState> = { suggest:"suggested",plan:"planned",queue:"queued","make-current":"current",perform:"performed",skip:"skipped",defer:"deferred",restore:"restored" };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
async function hmac(value: unknown, secret: string) { const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(canonical(value)))); }
export async function deriveDeviceCredential(master:string,communityId:string,eventId:string,deviceInstallationId:string){return hmac(`${communityId}\0${eventId}\0${deviceInstallationId}`,master);}
function constantEqual(left:string,right:string){if(left.length!==right.length)return false;let difference=0;for(let index=0;index<left.length;index++)difference|=left.charCodeAt(index)^right.charCodeAt(index);return difference===0;}

export class D1LiveRuntime {
  private readonly database:D1Database;private readonly secret:string;private readonly now:()=>Date;
  constructor(database:D1Database,secret:string,now:()=>Date=()=>new Date()){this.database=database;this.secret=secret;this.now=now;}

  async execute(value:unknown,lease:Lease){
    const command=record(value);
    for(const key of ["communityId","eventId","actorId","deviceInstallationId","operationId","entryId"] as const)if(typeof command[key]!=="string"||command[key].length===0)throw new RuntimeError("invalid-command");
    if(command.schemaVersion!==1||!Number.isSafeInteger(command.authorityEpoch)||(command.authorityEpoch as number)<1||!Number.isSafeInteger(command.baseRevision)||(command.baseRevision as number)<0)throw new RuntimeError("invalid-command");
    if(typeof command.action!=="string"||!(command.action in targets)||!command.payload||typeof command.payload!=="object"||Array.isArray(command.payload)||typeof command.authentication!=="string")throw new RuntimeError("invalid-command");
    const eventId=command.eventId as string,communityId=command.communityId as string,operationId=command.operationId as string;
    const unsigned={...command};delete unsigned.authentication;
    const credential=await deriveDeviceCredential(this.secret,command.communityId as string,command.eventId as string,command.deviceInstallationId as string);
    if(!constantEqual(await hmac(unsigned,credential),command.authentication))throw new RuntimeError("authentication-failed");
    const now=this.now(),issued=Date.parse(String(command.issuedAt)),expires=Date.parse(String(command.expiresAt));
    if(!Number.isFinite(issued)||!Number.isFinite(expires)||expires<now.getTime()||issued>now.getTime()+30_000||expires<=issued)throw new RuntimeError("expired");
    const event=await this.database.prepare("SELECT community_id,state FROM events WHERE id=?").bind(eventId).first<{community_id:string;state:string}>();
    if(!event||event.community_id!==communityId)throw new RuntimeError("scope-mismatch");
    if(event.state!=="live")throw new RuntimeError("event-closed");
    if(lease.eventId!==eventId||lease.revoked||lease.deviceInstallationId!==command.deviceInstallationId||lease.epoch!==command.authorityEpoch)throw new RuntimeError("superseded-authority");
    const commandHash=await webSha256(canonical(command));
    const prior=await this.database.prepare("SELECT command_hash,result_json FROM live_operation_receipts WHERE event_id=? AND operation_id=?").bind(eventId,operationId).first<{command_hash:string;result_json:string}>();
    if(prior){if(prior.command_hash!==commandHash)throw new RuntimeError("replay-mismatch");return JSON.parse(prior.result_json);}
    const revisionRow=await this.database.prepare("SELECT revision FROM live_event_revisions WHERE event_id=?").bind(eventId).first<{revision:number}>();
    const revision=Number(revisionRow?.revision??0),entryId=command.entryId as string;
    const existing=await this.database.prepare("SELECT * FROM live_queue_entries WHERE id=?").bind(entryId).first<Record<string,string|number>>();
    if(existing&&(existing.event_id!==eventId||existing.community_id!==communityId))throw new RuntimeError("scope-mismatch");
    let state=targets[command.action as LiveAction],status:"applied"|"suggested"="applied";
    if(command.baseRevision!==revision){if(command.action==="queue"&&!existing){state="suggested";status="suggested";}else throw new RuntimeError("stale-revision");}
    if(existing)try{transitionQueueEntry(existing.state as QueueEntryState,state);}catch{throw new RuntimeError("invalid-transition");}
    const payload=command.payload as Record<string,unknown>,songId=typeof payload.songId==="string"?payload.songId:String(existing?.song_id??"");if(!songId)throw new RuntimeError("invalid-payload");
    const nextRevision=revision+1,at=now.toISOString(),auditId=`audit_${(await webSha256(`${eventId}:${operationId}`)).slice(0,24)}`;
    const entry={id:entryId,communityId,eventId,songId,state,revision:Number(existing?.revision??0)+1,audienceVisible:state!=="planned"&&state!=="deferred",createdAt:String(existing?.created_at??at),updatedAt:at};
    const result={status,entry,revision:nextRevision,auditId};
    const statements:D1PreparedStatement[]=[
      this.database.prepare("INSERT OR IGNORE INTO live_event_revisions(event_id,revision) VALUES (?,0)").bind(eventId),
      this.database.prepare("UPDATE live_event_revisions SET revision=? WHERE event_id=? AND revision=?").bind(nextRevision,eventId,revision),
      this.database.prepare("INSERT INTO live_queue_entries(id,community_id,event_id,song_id,state,revision,audience_visible,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET song_id=excluded.song_id,state=excluded.state,revision=excluded.revision,audience_visible=excluded.audience_visible,updated_at=excluded.updated_at").bind(entry.id,communityId,eventId,songId,state,entry.revision,entry.audienceVisible?1:0,entry.createdAt,entry.updatedAt),
    ];
    if(state==="performed")statements.push(this.database.prepare("INSERT INTO performance_history(id,event_id,entry_id,song_id,performed_at,authority_epoch,revision) VALUES (?,?,?,?,?,?,?)").bind(`performance_${operationId}`,eventId,entryId,songId,at,command.authorityEpoch,nextRevision));
    statements.push(this.database.prepare("INSERT INTO live_audit_events(id,event_id,operation_id,action,revision,entry_id,occurred_at) VALUES (?,?,?,?,?,?,?)").bind(auditId,eventId,operationId,command.action,nextRevision,entryId,at));
    statements.push(this.database.prepare("INSERT INTO live_operation_receipts(event_id,operation_id,command_hash,result_json,audit_event_id,created_at) VALUES (?,?,?,?,?,?)").bind(eventId,operationId,commandHash,JSON.stringify(result),auditId,at));
    try{await this.database.batch(statements);}catch(error){throw new RuntimeError("conflict",error instanceof Error?error.message:"conflict");}
    return result;
  }

  async state(eventId:string,communityId:string){
    const event=await this.database.prepare("SELECT 1 FROM events WHERE id=? AND community_id=?").bind(eventId,communityId).first();if(!event)throw new RuntimeError("denied");
    const revision=await this.database.prepare("SELECT revision FROM live_event_revisions WHERE event_id=?").bind(eventId).first<{revision:number}>();
    const entries=await this.database.prepare("SELECT id,community_id AS communityId,event_id AS eventId,song_id AS songId,state,revision,audience_visible AS audienceVisible,created_at AS createdAt,updated_at AS updatedAt FROM live_queue_entries WHERE event_id=? AND community_id=? ORDER BY updated_at,id").bind(eventId,communityId).all();
    return {revision:Number(revision?.revision??0),entries:entries.results.map(row=>({...row,audienceVisible:Boolean(row.audienceVisible)}))};
  }
  async history(eventId:string,communityId:string){
    const event=await this.database.prepare("SELECT 1 FROM events WHERE id=? AND community_id=?").bind(eventId,communityId).first();if(!event)throw new RuntimeError("denied");
    const rows=await this.database.prepare("SELECT h.id,h.event_id AS eventId,h.entry_id AS entryId,h.song_id AS songId,h.performed_at AS performedAt,h.authority_epoch AS authorityEpoch,h.revision FROM performance_history h JOIN live_queue_entries q ON q.id=h.entry_id WHERE h.event_id=? AND q.community_id=? ORDER BY h.revision").bind(eventId,communityId).all();return {performances:rows.results};
  }
}
