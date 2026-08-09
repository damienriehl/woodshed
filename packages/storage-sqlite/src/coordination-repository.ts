import type { DatabaseSync } from "node:sqlite";
import { emptyCoordinationSnapshot, type CoordinationMutation, type CoordinationRepository, type CoordinationSnapshot } from "../../application/src/coordination-repository.ts";

export class SqliteCoordinationRepository implements CoordinationRepository {
  private readonly database:DatabaseSync;
  constructor(database:DatabaseSync){this.database=database;}
  load(){const row=this.database.prepare("SELECT revision,snapshot_json FROM coordination_state WHERE singleton=1").get() as {revision:number;snapshot_json:string}|undefined;return row?{...(JSON.parse(row.snapshot_json) as CoordinationSnapshot),storageRevision:row.revision}:emptyCoordinationSnapshot();}
  receipt(scope:string,operationId:string){const row=this.database.prepare("SELECT payload_hash,result_json FROM coordination_receipts WHERE scope=? AND operation_id=?").get(scope,operationId) as {payload_hash:string;result_json:string}|undefined;return row?{payloadHash:row.payload_hash,result:JSON.parse(row.result_json)}:undefined;}
  commit(snapshot:CoordinationSnapshot,mutation:CoordinationMutation){
    this.database.exec("BEGIN IMMEDIATE");
    try{
      const nextRevision=snapshot.storageRevision+1;
      const state=snapshot.storageRevision===0?this.database.prepare("INSERT OR IGNORE INTO coordination_state(singleton,revision,snapshot_json,updated_at) VALUES(1,?,?,?)").run(nextRevision,JSON.stringify(snapshot),new Date().toISOString()):this.database.prepare("UPDATE coordination_state SET revision=?,snapshot_json=?,updated_at=? WHERE singleton=1 AND revision=?").run(nextRevision,JSON.stringify(snapshot),new Date().toISOString(),snapshot.storageRevision);
      if(state.changes!==1)throw new Error("coordination storage conflict");
      this.database.prepare("INSERT INTO coordination_audit_events(community_id,event_id,actor_id,capability,operation_id,payload_hash,occurred_at) VALUES(?,?,?,?,?,?,?)").run(mutation.communityId,mutation.eventId,mutation.actorId,mutation.capability,mutation.operationId,mutation.payloadHash,new Date().toISOString());
      this.database.prepare("INSERT INTO coordination_receipts(scope,operation_id,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(mutation.scope,mutation.operationId,mutation.payloadHash,JSON.stringify(mutation.result),new Date().toISOString());
      this.database.exec("COMMIT");snapshot.storageRevision=nextRevision;
    }catch(error){this.database.exec("ROLLBACK");throw error;}
  }
}
