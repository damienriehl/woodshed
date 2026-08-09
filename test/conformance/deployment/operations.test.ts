import assert from "node:assert/strict";
import test from "node:test";
import {
  MigrationLedger, evaluateHealth, verifyBackupPolicy, verifyRestore,
  type BackupEvidence,
} from "../../../packages/archive/src/operations.ts";
import { ExtensionHost } from "../../../packages/extensions/src/index.ts";
import { ProviderRegistry } from "../../../packages/providers/src/registry.ts";
import { healthResponse } from "../../../apps/operator/src/index.ts";
import { readFile } from "node:fs/promises";

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
  const evidence:BackupEvidence={lastBackupAt:"2026-08-09T11:00:00Z",lastRestoreDrillAt:"2026-08-01T12:00:00Z",rollbackEvidenceAt:"2026-08-08T12:00:00Z",offsite:true,encrypted:true,cleanDestinationVerified:true};
  assert.equal(evaluateHealth(evidence,{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true},now).status,"healthy");
  assert.throws(()=>verifyBackupPolicy({...evidence,lastBackupAt:"2026-08-01T12:00:00Z"},{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true},now),/backup age/i);
  assert.throws(()=>verifyRestore({...evidence,cleanDestinationVerified:false}),/clean destination/i);
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
  const backup:BackupEvidence={lastBackupAt:"2026-08-09T11:00:00Z",lastRestoreDrillAt:"2026-08-01T12:00:00Z",rollbackEvidenceAt:"2026-08-08T12:00:00Z",offsite:true,encrypted:true,cleanDestinationVerified:true};
  for(const destination of ["node-sqlite","cloudflare","one-click"] as const)
    assert.equal(healthResponse({destination,version:"1",database:true,keyCustody:true,backup},{maxBackupAgeMs:7_200_000,maxRestoreDrillAgeMs:14*86_400_000,requireOffsite:true},new Date("2026-08-09T12:00:00Z")).status,"healthy");
});
