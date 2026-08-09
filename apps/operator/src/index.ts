import { evaluateHealth, type BackupEvidence, type RecoveryPolicy } from "../../../packages/archive/src/operations.ts";
export type OperatorStatus={destination:"node-sqlite"|"cloudflare"|"one-click";version:string;database:boolean;keyCustody:boolean;backup:BackupEvidence};
export function healthResponse(status:OperatorStatus,policy:RecoveryPolicy,now=new Date()){
  const recovery=evaluateHealth(status.backup,policy,now),checks={database:status.database,keyCustody:status.keyCustody,recovery:recovery.status==="healthy"};
  return{status:Object.values(checks).every(Boolean)?"healthy" as const:"degraded" as const,destination:status.destination,version:status.version,checks,recovery:recovery.checks};
}
