import assert from "node:assert/strict";
import test from "node:test";
import {
  MigrationLedger, evaluateHealth, verifyBackupPolicy, verifyRestore,
  type BackupEvidence,
} from "../../../packages/archive/src/operations.ts";
import { ExtensionHost } from "../../../packages/extensions/src/index.ts";
import { ProviderRegistry } from "../../../packages/providers/src/registry.ts";
import { healthResponse, probeOperatorHealth, requiredMigrationManifest, type OperatorHealthAdapter } from "../../../apps/operator/src/index.ts";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { systemHealthAdapter } from "../../../apps/operator/src/index.ts";

test("migration ledger is checksummed, supports mixed versions and blocks unsafe contract", () => {
  const ledger=new MigrationLedger({minimumReadable:1,current:2});
  ledger.apply({id:"001_expand",phase:"expand",checksum:"a".repeat(64),destructive:false});
  ledger.apply({id:"002_backfill",phase:"backfill",checksum:"b".repeat(64),destructive:false});
  assert.equal(ledger.dryRun({binaryVersion:1,archiveVersion:1}).safe,true);
  assert.throws(()=>ledger.apply({id:"003_contract",phase:"contract",checksum:"c".repeat(64),destructive:true}),/blocked/i);
  assert.throws(()=>ledger.apply({id:"001_expand",phase:"expand",checksum:"d".repeat(64),destructive:false}),/checksum/i);
});

test("health gates stale backups, restore drills and missing rollback evidence", () => {
  const now=new Date("2026-08-09T12:00:00Z");
  const evidence:BackupEvidence={backupArtifactId:"backup-7",restoreProofId:"restore-4",lastBackupAt:"2026-08-09T11:00:00Z",lastRestoreDrillAt:"2026-08-01T12:00:00Z",rollbackEvidenceAt:"2026-08-08T12:00:00Z",offsite:true,encrypted:true,cleanDestinationVerified:true};
  assert.equal(evaluateHealth(evidence,{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true},now).status,"healthy");
  assert.throws(()=>verifyBackupPolicy({...evidence,lastBackupAt:"2026-08-01T12:00:00Z"},{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true},now),/backup age/i);
  assert.throws(()=>verifyBackupPolicy({...evidence,backupArtifactId:""},{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true},now),/artifact evidence/i);
  assert.throws(()=>verifyRestore({...evidence,cleanDestinationVerified:false}),/clean destination/i);
  assert.throws(()=>verifyRestore({...evidence,restoreProofId:""}),/clean destination/i);
});

test("health rejects malformed and future recovery timestamps",()=>{
  const now=new Date("2026-08-09T12:00:00Z"),policy={maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true};
  const evidence={backupArtifactId:"backup-7",restoreProofId:"restore-4",lastBackupAt:"2026-08-09T11:00:00Z",lastRestoreDrillAt:"2026-08-01T12:00:00Z",rollbackEvidenceAt:"2026-08-08T12:00:00Z",offsite:true,encrypted:true,cleanDestinationVerified:true};
  assert.throws(()=>verifyBackupPolicy({...evidence,lastBackupAt:"not-a-date"},policy,now),/timestamp invalid/);
  assert.throws(()=>verifyBackupPolicy({...evidence,lastRestoreDrillAt:"2026-08-10T12:00:00Z"},policy,now),/timestamp invalid/);
  assert.throws(()=>verifyBackupPolicy({...evidence,rollbackEvidenceAt:"2026-08-10T12:00:00Z"},policy,now),/rollback evidence invalid/);
});

test("extensions cannot bypass authorization, rights or privacy and private content defaults off", async () => {
  const host=new ExtensionHost();
  assert.equal(host.privateContentEnabled,false);
  await assert.rejects(host.invoke({id:"ext_one",permissions:["theme:read"]},"community:write",{}),/denied/i);
  await assert.rejects(host.invoke({id:"ext_one",permissions:["content:read"]},"content:read",{rightsApproved:false}),/rights/i);
});

test("provider disconnect revokes credentials and deletes derived data", async () => {
  const registry=new ProviderRegistry();
  registry.connect({id:"connection_one",scopes:["freebusy"],derivedData:["cache_one"]});
  const result=await registry.disconnect("connection_one");
  assert.deepEqual(result,{revoked:true,deletedDerivedData:1});
  assert.equal(registry.get("connection_one"),undefined);
});

test("all destinations declare safe defaults and expose the same health contract", async () => {
  const [compose,worker,oneClick]=await Promise.all([
    readFile(new URL("../../../deploy/docker/compose.yaml",import.meta.url),"utf8"),
    readFile(new URL("../../../deploy/cloudflare/wrangler.jsonc",import.meta.url),"utf8"),
    readFile(new URL("../../../deploy/one-click/manifest.json",import.meta.url),"utf8"),
  ]);
  assert.match(compose,/127\.0\.0\.1/); assert.match(compose,/read_only: true/);
  assert.match(worker,/WOODSHED_PRIVATE_CONTENT.*disabled/);
  assert.equal(JSON.parse(oneClick).productionReady,false);
  const backup:BackupEvidence={backupArtifactId:"backup-7",restoreProofId:"restore-4",lastBackupAt:"2026-08-09T11:00:00Z",lastRestoreDrillAt:"2026-08-01T12:00:00Z",rollbackEvidenceAt:"2026-08-08T12:00:00Z",offsite:true,encrypted:true,cleanDestinationVerified:true};
  for(const destination of ["node-sqlite","cloudflare","one-click"] as const)
    assert.equal(healthResponse({destination,version:"1",service:true,database:true,migrations:true,keyCustody:true,backup},{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true},new Date("2026-08-09T12:00:00Z")).status,"healthy");
});

test("operator health probes the service, database migrations, key custody, and recovery evidence",async()=>{
  const backup:BackupEvidence={backupArtifactId:"backup-7",restoreProofId:"restore-4",lastBackupAt:"2026-08-09T11:00:00Z",lastRestoreDrillAt:"2026-08-01T12:00:00Z",rollbackEvidenceAt:"2026-08-08T12:00:00Z",offsite:true,encrypted:true,cleanDestinationVerified:true};
  const calls:string[]=[];
  const adapter:OperatorHealthAdapter={
    async service(url){calls.push(`service:${url}`);return true},
    database(path){calls.push(`database:${path}`);return true},
    migrations(path,migrationsPath){calls.push(`migrations:${path}:${migrationsPath}`);return true},
    keyCustody(path){calls.push(`key:${path}`);return true},
    backupEvidence(path){calls.push(`backup:${path}`);return backup},
  };
  const result=await probeOperatorHealth({destination:"node-sqlite",version:"1",serviceUrl:"http://127.0.0.1:8787/api/discovery",databasePath:"/data/community.sqlite",migrationsPath:"/app/migrations/sqlite",keyPath:"/run/secrets/archive.key",backupEvidencePath:"/data/backup-evidence.json",policy:{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true}},adapter,new Date("2026-08-09T12:00:00Z"));
  assert.equal(result.status,"healthy");
  assert.deepEqual(calls,["service:http://127.0.0.1:8787/api/discovery","database:/data/community.sqlite","migrations:/data/community.sqlite:/app/migrations/sqlite","key:/run/secrets/archive.key","backup:/data/backup-evidence.json"]);
});

test("operator health is non-ready when adapter config or any real probe is missing",async()=>{
  const adapter:OperatorHealthAdapter={service:async()=>true,database:()=>true,migrations:()=>false,keyCustody:()=>true,backupEvidence:()=>{throw new Error("missing evidence")}};
  const missing=await probeOperatorHealth(undefined,adapter);
  assert.equal(missing.status,"adapter-required");
  assert.equal(missing.exitCode,1);
  const degraded=await probeOperatorHealth({destination:"node-sqlite",version:"1",serviceUrl:"http://service",databasePath:"/db",migrationsPath:"/migrations",keyPath:"/key",backupEvidencePath:"/backup",policy:{maxBackupAgeMs:1,maxRestoreDrillAgeMs:1,requireOffsite:true}},adapter);
  assert.equal(degraded.status,"degraded");
  assert.equal(degraded.exitCode,1);
  assert.equal(degraded.checks.migrations,false);
  assert.match(degraded.recovery.join(" "),/missing evidence/i);
});

test("system health adapter requires the exact ordered SQLite migration source manifest",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"woodshed-health-")),databasePath=join(directory,"community.sqlite"),keyPath=join(directory,"archive.key"),backupEvidencePath=join(directory,"backup.json");
  const migrationsPath=fileURLToPath(new URL("../../../migrations/sqlite/",import.meta.url));
  const manifest=requiredMigrationManifest(migrationsPath);
  const database=new DatabaseSync(databasePath);
  database.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL)");
  const insert=database.prepare("INSERT INTO schema_migrations(name, checksum) VALUES (?, ?)");
  for(const migration of manifest.slice(0,-1))insert.run(migration.name,migration.checksum);
  assert.equal(systemHealthAdapter.migrations(databasePath,migrationsPath),false,"incomplete ledger must be rejected");
  insert.run(manifest.at(-1)!.name,"a".repeat(64));
  assert.equal(systemHealthAdapter.migrations(databasePath,migrationsPath),false,"fabricated checksum must be rejected");
  database.prepare("UPDATE schema_migrations SET checksum=? WHERE name=?").run(manifest.at(-1)!.checksum,manifest.at(-1)!.name);
  insert.run("999_unrecognized.sql","b".repeat(64));
  assert.equal(systemHealthAdapter.migrations(databasePath,migrationsPath),false,"extra migration must be rejected");
  database.prepare("DELETE FROM schema_migrations WHERE name=?").run("999_unrecognized.sql");
  assert.equal(systemHealthAdapter.migrations(databasePath,migrationsPath),true,"current source-derived ledger must be accepted");
  database.close();
  await writeFile(keyPath,Buffer.alloc(32,1));
  await writeFile(backupEvidencePath,JSON.stringify({backupArtifactId:"backup-7",restoreProofId:"restore-4",lastBackupAt:"2026-08-09T11:00:00Z",lastRestoreDrillAt:"2026-08-01T12:00:00Z",rollbackEvidenceAt:"2026-08-08T12:00:00Z",offsite:true,encrypted:true,cleanDestinationVerified:true}));
  assert.equal(systemHealthAdapter.database(databasePath),true);
  assert.equal(systemHealthAdapter.migrations(databasePath,migrationsPath),true);
  assert.equal(await systemHealthAdapter.keyCustody(keyPath),true);
  assert.equal((await systemHealthAdapter.backupEvidence(backupEvidencePath)).cleanDestinationVerified,true);
  await writeFile(keyPath,"short");
  assert.equal(await systemHealthAdapter.keyCustody(keyPath),false);
});
