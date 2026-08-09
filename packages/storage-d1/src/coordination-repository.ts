import type { D1Database } from "@cloudflare/workers-types";
import { emptyCoordinationSnapshot, type CoordinationMutation, type CoordinationSnapshot } from "../../application/src/coordination-repository.ts";

export class D1CoordinationRepository {
  private readonly database:D1Database;
  constructor(database:D1Database){this.database=database;}
  async load(){const row=await this.database.prepare("SELECT revision,snapshot_json FROM coordination_state WHERE singleton=1").first<{revision:number;snapshot_json:string}>();return row?{...(JSON.parse(row.snapshot_json) as CoordinationSnapshot),storageRevision:row.revision}:emptyCoordinationSnapshot();}
  async receipt(scope:string,operationId:string){const row=await this.database.prepare("SELECT payload_hash,result_json FROM coordination_receipts WHERE scope=? AND operation_id=?").bind(scope,operationId).first<{payload_hash:string;result_json:string}>();return row?{payloadHash:row.payload_hash,result:JSON.parse(row.result_json)}:undefined;}
  async commit(snapshot:CoordinationSnapshot,mutation:CoordinationMutation){
    const now=new Date().toISOString();
    const nextRevision=snapshot.storageRevision+1;
    const state=snapshot.storageRevision===0?this.database.prepare("INSERT OR IGNORE INTO coordination_state(singleton,revision,snapshot_json,updated_at,last_scope,last_operation_id) VALUES(1,?,?,?,?,?)").bind(nextRevision,JSON.stringify(snapshot),now,mutation.scope,mutation.operationId):this.database.prepare("UPDATE coordination_state SET revision=?,snapshot_json=?,updated_at=?,last_scope=?,last_operation_id=? WHERE singleton=1 AND revision=?").bind(nextRevision,JSON.stringify(snapshot),now,mutation.scope,mutation.operationId,snapshot.storageRevision);
    const results=await this.database.batch([
      state,
      this.database.prepare("INSERT INTO coordination_audit_events(community_id,event_id,actor_id,capability,operation_id,payload_hash,occurred_at) SELECT ?,?,?,?,?,?,? FROM coordination_state WHERE singleton=1 AND last_scope=? AND last_operation_id=?").bind(mutation.communityId,mutation.eventId,mutation.actorId,mutation.capability,mutation.operationId,mutation.payloadHash,now,mutation.scope,mutation.operationId),
      this.database.prepare("INSERT INTO coordination_receipts(scope,operation_id,payload_hash,result_json,created_at) SELECT ?,?,?,?,? FROM coordination_state WHERE singleton=1 AND last_scope=? AND last_operation_id=?").bind(mutation.scope,mutation.operationId,mutation.payloadHash,JSON.stringify(mutation.result),now,mutation.scope,mutation.operationId)
    ]);if(results.some(result=>result.meta.changes!==1))throw new Error("coordination storage conflict");snapshot.storageRevision=nextRevision;
  }
}
