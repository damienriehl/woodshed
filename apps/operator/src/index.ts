import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join } from "node:path";
import { evaluateHealth, type BackupEvidence, type RecoveryPolicy } from "../../../packages/archive/src/operations.ts";

export type OperatorStatus={destination:"node-sqlite"|"cloudflare"|"one-click";version:string;service:boolean;database:boolean;migrations:boolean;keyCustody:boolean;backup:BackupEvidence};
export type OperatorHealthConfig={destination:OperatorStatus["destination"];version:string;serviceUrl:string;databasePath:string;migrationsPath:string;keyPath:string;backupEvidencePath:string;policy:RecoveryPolicy};
export interface OperatorHealthAdapter {
  service(url:string):Promise<boolean>|boolean;
  database(path:string):Promise<boolean>|boolean;
  migrations(path:string,migrationsPath:string):Promise<boolean>|boolean;
  keyCustody(path:string):Promise<boolean>|boolean;
  backupEvidence(path:string):Promise<BackupEvidence>|BackupEvidence;
}

export function healthResponse(status:OperatorStatus,policy:RecoveryPolicy,now=new Date()){
  const recovery=evaluateHealth(status.backup,policy,now),checks={service:status.service,database:status.database,migrations:status.migrations,keyCustody:status.keyCustody,recovery:recovery.status==="healthy"};
  return{status:Object.values(checks).every(Boolean)?"healthy" as const:"degraded" as const,destination:status.destination,version:status.version,checks,recovery:recovery.checks};
}

function sqliteProbe(path:string,query:string){
  const database=new DatabaseSync(path,{readOnly:true});
  try{return database.prepare(query).all()}finally{database.close()}
}

type MigrationManifestEntry={name:string;checksum:string};

export function requiredMigrationManifest(migrationsPath:string):MigrationManifestEntry[]{
  return readdirSync(migrationsPath,{withFileTypes:true})
    .filter(entry=>entry.isFile()&&entry.name.endsWith(".sql"))
    .map(entry=>entry.name)
    .sort()
    .map(name=>({name,checksum:createHash("sha256").update(readFileSync(join(migrationsPath,name))).digest("hex")}));
}

export const systemHealthAdapter:OperatorHealthAdapter={
  async service(url){try{const response=await fetch(url,{signal:AbortSignal.timeout(3_000)});return response.ok}catch{return false}},
  database(path){try{const rows=sqliteProbe(path,"PRAGMA quick_check") as {quick_check?:string}[];return rows.length>0&&rows.every(row=>row.quick_check==="ok")}catch{return false}},
  migrations(path,migrationsPath){
    try{
      const expected=requiredMigrationManifest(migrationsPath);
      const applied=sqliteProbe(path,"SELECT name, checksum FROM schema_migrations ORDER BY name") as MigrationManifestEntry[];
      return expected.length>0&&applied.length===expected.length&&applied.every((entry,index)=>entry.name===expected[index]?.name&&entry.checksum===expected[index]?.checksum);
    }catch{return false}
  },
  async keyCustody(path){let bytes:Buffer|undefined;try{bytes=await readFile(path);return bytes.byteLength>=32}catch{return false}finally{bytes?.fill(0)}},
  async backupEvidence(path){return JSON.parse(await readFile(path,"utf8")) as BackupEvidence},
};

export function healthConfigFromEnvironment(environment:NodeJS.ProcessEnv=process.env):OperatorHealthConfig|undefined {
  const destination=environment.WOODSHED_DESTINATION,serviceUrl=environment.WOODSHED_HEALTH_URL,databasePath=environment.WOODSHED_DB,migrationsPath=environment.WOODSHED_MIGRATIONS_PATH,keyPath=environment.WOODSHED_KEY_PATH,backupEvidencePath=environment.WOODSHED_BACKUP_EVIDENCE;
  if(destination!=="node-sqlite"&&destination!=="cloudflare"&&destination!=="one-click"||!serviceUrl||!databasePath||!migrationsPath||!keyPath||!backupEvidencePath)return undefined;
  if(![databasePath,migrationsPath,keyPath,backupEvidencePath].every(isAbsolute))return undefined;
  const maxBackupAgeMs=Number(environment.WOODSHED_MAX_BACKUP_AGE_MS??86_400_000),maxRestoreDrillAgeMs=Number(environment.WOODSHED_MAX_RESTORE_AGE_MS??1_209_600_000);
  if(!Number.isFinite(maxBackupAgeMs)||maxBackupAgeMs<=0||!Number.isFinite(maxRestoreDrillAgeMs)||maxRestoreDrillAgeMs<=0)return undefined;
  return{destination,version:environment.WOODSHED_VERSION??"unknown",serviceUrl,databasePath,migrationsPath,keyPath,backupEvidencePath,policy:{maxBackupAgeMs,maxRestoreDrillAgeMs,requireOffsite:environment.WOODSHED_REQUIRE_OFFSITE!=="false"}};
}

export async function probeOperatorHealth(config:OperatorHealthConfig|undefined,adapter:OperatorHealthAdapter=systemHealthAdapter,now=new Date()){
  if(!config)return{status:"adapter-required" as const,exitCode:1,checks:{service:false,database:false,migrations:false,keyCustody:false,recovery:false},recovery:["operator health adapter configuration required"]};
  const recoveryErrors:string[]=[];
  const safe=async(probe:()=>Promise<boolean>|boolean)=>{try{return await probe()}catch{return false}};
  const service=await safe(()=>adapter.service(config.serviceUrl)),database=await safe(()=>adapter.database(config.databasePath)),migrations=await safe(()=>adapter.migrations(config.databasePath,config.migrationsPath)),keyCustody=await safe(()=>adapter.keyCustody(config.keyPath));
  let backup:BackupEvidence;
  try{backup=await adapter.backupEvidence(config.backupEvidencePath)}catch(error){recoveryErrors.push(error instanceof Error?error.message:"backup evidence unavailable");backup={backupArtifactId:"",restoreProofId:"",lastBackupAt:"invalid",lastRestoreDrillAt:"invalid",rollbackEvidenceAt:"invalid",offsite:false,encrypted:false,cleanDestinationVerified:false}}
  const result=healthResponse({destination:config.destination,version:config.version,service,database,migrations,keyCustody,backup},config.policy,now);
  result.recovery.unshift(...recoveryErrors);
  if(recoveryErrors.length)result.checks.recovery=false;
  return{...result,exitCode:result.status==="healthy"&&recoveryErrors.length===0?0:1};
}
