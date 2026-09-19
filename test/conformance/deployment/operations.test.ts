import assert from "node:assert/strict";
import test from "node:test";
import {
  MigrationLedger, evaluateHealth, verifyBackupPolicy, verifyRestore,
  type BackupEvidence,
} from "../../../packages/archive/src/operations.ts";
import { ExtensionHost } from "../../../packages/extensions/src/index.ts";
import { ProviderRegistry } from "../../../packages/providers/src/registry.ts";
import { healthConfigFromEnvironment, healthResponse, probeOperatorHealth, requiredMigrationManifest, type OperatorHealthAdapter } from "../../../apps/operator/src/index.ts";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
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
  const directory=await mkdtemp(join(tmpdir(),"woodshed-health-")),databasePath=join(directory,"community.sqlite"),keyPath=join(directory,"archive-material.bin"),backupEvidencePath=join(directory,"backup.json");
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

const coverageNow = new Date("2030-01-02T12:00:00Z");
const coveragePolicy = { maxBackupAgeMs: 60_000, maxRestoreDrillAgeMs: 120_000, requireOffsite: true };
function freshEvidence(): BackupEvidence {
  return { backupArtifactId: "backup_synthetic", restoreProofId: "restore_synthetic", lastBackupAt: coverageNow.toISOString(), lastRestoreDrillAt: coverageNow.toISOString(), rollbackEvidenceAt: coverageNow.toISOString(), offsite: true, encrypted: true, cleanDestinationVerified: true };
}

for (const [label, change, expected] of [
  ["unencrypted backup", { encrypted: false }, /encryption missing/],
  ["onsite-only backup", { offsite: false }, /offsite backup missing/],
  ["blank artifact", { backupArtifactId: "  " }, /artifact evidence missing/],
  ["old restore drill", { lastRestoreDrillAt: "2030-01-02T11:57:59Z" }, /restore drill age gate/],
  ["invalid restore timestamp", { lastRestoreDrillAt: "invalid" }, /restore drill timestamp invalid/],
  ["invalid rollback timestamp", { rollbackEvidenceAt: "invalid" }, /rollback evidence invalid/],
  ["missing restore proof", { restoreProofId: "  " }, /clean destination restore/],
] as const) {
  test(`operator recovery reports ${label} through health evaluation`, () => {
    const backup = { ...freshEvidence(), ...change };
    const result = healthResponse({ destination: "node-sqlite", version: "test", service: true, database: true, migrations: true, keyCustody: true, backup }, coveragePolicy, coverageNow);
    assert.equal(result.status, "degraded");
    assert.equal(result.checks.recovery, false);
    assert.match(result.recovery.join(" "), expected);
  });
}

test("recovery age thresholds are inclusive and optional offsite is honored", () => {
  const evidence = { ...freshEvidence(), lastBackupAt: new Date(coverageNow.getTime() - 60_000).toISOString(), lastRestoreDrillAt: new Date(coverageNow.getTime() - 120_000).toISOString(), offsite: false };
  assert.deepEqual(evaluateHealth(evidence, { ...coveragePolicy, requireOffsite: false }, coverageNow), { status: "healthy", checks: [] });
  assert.throws(() => verifyBackupPolicy(evidence, { ...coveragePolicy, requireOffsite: false }, new Date(coverageNow.getTime() + 1)), /backup age/);
});

test("migration replay preserves the original step and dry-run reports both incompatible versions", () => {
  const ledger = new MigrationLedger({ minimumReadable: 2, current: 3 });
  const step = { id: "002_expand", phase: "expand" as const, checksum: "a".repeat(64), destructive: false };
  ledger.apply(step);
  step.phase = "expand";
  step.destructive = true;
  ledger.apply({ ...step, destructive: false });
  const result = ledger.dryRun({ binaryVersion: 1, archiveVersion: 4 });
  assert.deepEqual(result.issues, ["unsupported binary version", "unsupported archive version"]);
  assert.equal(result.safe, false);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.destructive, false);
  assert.equal(ledger.dryRun({ binaryVersion: 3, archiveVersion: 2 }).safe, true);
  assert.throws(() => ledger.apply({ ...step, id: "bad_checksum", checksum: "A".repeat(64) }), /checksum invalid/);
  assert.throws(() => ledger.apply({ ...step, id: "contract", phase: "contract", destructive: false }), /contract step blocked/);
  assert.equal(ledger.applied.size, 1);
});

function syntheticHealthEnvironment(): NodeJS.ProcessEnv {
  return { WOODSHED_DESTINATION: "node-sqlite", WOODSHED_HEALTH_URL: "data:text/plain,healthy", WOODSHED_DB: "/synthetic/community.sqlite", WOODSHED_MIGRATIONS_PATH: "/synthetic/migrations", WOODSHED_KEY_PATH: "/synthetic/material.bin", WOODSHED_BACKUP_EVIDENCE: "/synthetic/backup.json" };
}

test("operator configuration uses defaults and supports every destination without reading process secrets", () => {
  for (const destination of ["node-sqlite", "cloudflare", "one-click"] as const) {
    const result = healthConfigFromEnvironment({ ...syntheticHealthEnvironment(), WOODSHED_DESTINATION: destination });
    assert.ok(result);
    assert.equal(result.destination, destination);
    assert.equal(result.version, "unknown");
    assert.deepEqual(result.policy, { maxBackupAgeMs: 86_400_000, maxRestoreDrillAgeMs: 1_209_600_000, requireOffsite: true });
  }
  const custom = healthConfigFromEnvironment({ ...syntheticHealthEnvironment(), WOODSHED_VERSION: "synthetic-v2", WOODSHED_MAX_BACKUP_AGE_MS: "100", WOODSHED_MAX_RESTORE_AGE_MS: "200", WOODSHED_REQUIRE_OFFSITE: "false" });
  assert.equal(custom?.version, "synthetic-v2");
  assert.deepEqual(custom?.policy, { maxBackupAgeMs: 100, maxRestoreDrillAgeMs: 200, requireOffsite: false });
});

test("operator configuration rejects missing required values and relative storage paths", () => {
  for (const name of Object.keys(syntheticHealthEnvironment())) {
    const environment = syntheticHealthEnvironment();
    delete environment[name];
    assert.equal(healthConfigFromEnvironment(environment), undefined, name);
  }
  assert.equal(healthConfigFromEnvironment({ ...syntheticHealthEnvironment(), WOODSHED_DESTINATION: "unsupported" }), undefined);
  for (const name of ["WOODSHED_DB", "WOODSHED_MIGRATIONS_PATH", "WOODSHED_KEY_PATH", "WOODSHED_BACKUP_EVIDENCE"]) {
    assert.equal(healthConfigFromEnvironment({ ...syntheticHealthEnvironment(), [name]: "relative-path" }), undefined, name);
  }
});

for (const value of ["0", "-1", "NaN", "Infinity", "", "not-a-number"]) {
  test(`operator configuration rejects invalid recovery age ${JSON.stringify(value)}`, () => {
    for (const name of ["WOODSHED_MAX_BACKUP_AGE_MS", "WOODSHED_MAX_RESTORE_AGE_MS"]) {
      assert.equal(healthConfigFromEnvironment({ ...syntheticHealthEnvironment(), [name]: value }), undefined, name);
    }
  });
}

test("operator probes real SQLite, migration files, synthetic custody bytes, and recovery evidence end to end", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "woodshed-health-chain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrationsPath = join(directory, "migrations");
  await mkdir(migrationsPath);
  await mkdir(join(migrationsPath, "ignored.sql"));
  await writeFile(join(migrationsPath, "002_second.sql"), "SELECT 2;");
  await writeFile(join(migrationsPath, "001_first.sql"), "SELECT 1;");
  await writeFile(join(migrationsPath, "README.txt"), "synthetic migration fixture");
  const config = healthConfigFromEnvironment({ ...syntheticHealthEnvironment(), WOODSHED_DB: join(directory, "community.sqlite"), WOODSHED_MIGRATIONS_PATH: migrationsPath, WOODSHED_KEY_PATH: join(directory, "material.bin"), WOODSHED_BACKUP_EVIDENCE: join(directory, "backup.json") })!;
  const manifest = requiredMigrationManifest(migrationsPath);
  assert.deepEqual(manifest.map(entry => entry.name), ["001_first.sql", "002_second.sql"]);
  const database = new DatabaseSync(config.databasePath);
  try {
    database.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL)");
    for (const entry of manifest) database.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(entry.name, entry.checksum);
  } finally { database.close(); }
  await writeFile(config.keyPath, Buffer.alloc(32, 7));
  await writeFile(config.backupEvidencePath, JSON.stringify(freshEvidence()));
  const healthy = await probeOperatorHealth(config, systemHealthAdapter, coverageNow);
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.exitCode, 0);
  assert.deepEqual(healthy.checks, { service: true, database: true, migrations: true, keyCustody: true, recovery: true });
  await writeFile(join(migrationsPath, "002_second.sql"), "SELECT 3;");
  await writeFile(config.backupEvidencePath, "{invalid json");
  await rm(config.keyPath);
  const degraded = await probeOperatorHealth(config, systemHealthAdapter, coverageNow);
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.exitCode, 1);
  assert.deepEqual(degraded.checks, { service: true, database: true, migrations: false, keyCustody: false, recovery: false });
  assert.ok(degraded.recovery.length >= 2);
});

test("operator adapters fail closed on missing databases, directories and malformed service URLs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "woodshed-health-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = join(directory, "missing");
  assert.equal(systemHealthAdapter.database(missing), false);
  assert.equal(systemHealthAdapter.migrations(missing, directory), false);
  assert.equal(systemHealthAdapter.migrations(missing, missing), false);
  assert.equal(await systemHealthAdapter.keyCustody(missing), false);
  assert.equal(await systemHealthAdapter.service("not a URL"), false);
  await assert.rejects(async () => systemHealthAdapter.backupEvidence(missing));
});

test("operator aggregates thrown probe errors and non-Error recovery failures", async () => {
  const adapter: OperatorHealthAdapter = {
    service() { throw new Error("service failure"); },
    database() { throw new Error("database failure"); },
    async migrations() { throw new Error("migration failure"); },
    async keyCustody() { throw new Error("custody failure"); },
    backupEvidence() { throw "synthetic unavailable"; },
  };
  const result = await probeOperatorHealth(healthConfigFromEnvironment(syntheticHealthEnvironment()), adapter, coverageNow);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.checks, { service: false, database: false, migrations: false, keyCustody: false, recovery: false });
  assert.deepEqual(result.recovery, ["backup evidence unavailable", "backup artifact evidence missing"]);
});

test("extension permissions admit public and rights-approved work but never private content", async () => {
  const host = new ExtensionHost();
  const extension = { id: "synthetic-extension", permissions: ["theme:read", "content:read", "private:read"] };
  assert.deepEqual(await host.invoke(extension, "theme:read", {}), { extensionId: extension.id, capability: "theme:read", status: "accepted" });
  await assert.rejects(host.invoke(extension, "content:read", {}), /rights approval required/);
  assert.equal((await host.invoke(extension, "content:read", { rightsApproved: true })).status, "accepted");
  for (const privacyApproved of [undefined, false, true]) {
    await assert.rejects(host.invoke(extension, "private:read", { rightsApproved: true, privacyApproved }), /private content disabled/);
  }
  assert.equal(host.privateContentEnabled, false);
  await assert.rejects(host.invoke({ id: extension.id, permissions: [] }, "theme:read", { rightsApproved: true, privacyApproved: true }), /capability denied/);
});

test("provider registry validates scopes, snapshots input and disconnects only its owned connection", async () => {
  const registry = new ProviderRegistry();
  assert.equal(registry.get("missing"), undefined);
  assert.deepEqual(await registry.disconnect("missing"), { revoked: false, deletedDerivedData: 0 });
  assert.throws(() => registry.connect({ id: "invalid", scopes: [], derivedData: [] }), /scopes required/);
  assert.equal(registry.get("invalid"), undefined);
  const connection = { id: "synthetic-one", scopes: ["freebusy"], derivedData: ["cache-one", "cache-two"] };
  registry.connect(connection);
  connection.scopes.push("changed");
  connection.derivedData.length = 0;
  registry.connect({ id: "synthetic-two", scopes: ["freebusy"], derivedData: [] });
  assert.deepEqual(registry.get("synthetic-one"), { id: "synthetic-one", scopes: ["freebusy"], derivedData: ["cache-one", "cache-two"] });
  assert.deepEqual(await registry.disconnect("synthetic-one"), { revoked: true, deletedDerivedData: 2 });
  assert.equal(registry.get("synthetic-one"), undefined);
  assert.equal(registry.get("synthetic-two")?.id, "synthetic-two");
  assert.deepEqual(await registry.disconnect("synthetic-one"), { revoked: false, deletedDerivedData: 0 });
  assert.deepEqual(await registry.disconnect("synthetic-two"), { revoked: true, deletedDerivedData: 0 });
});

import { spawnSync } from "node:child_process";

function operatorCli(args: string[], environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../apps/operator/src/cli.ts", import.meta.url)), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...environment, ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) } });
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

test("operator CLI distinguishes unsupported commands from supported operations requiring adapters", () => {
  for (const args of [[], ["unsupported"]]) {
    const result = operatorCli(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: woodshed-operator/);
  }
  for (const command of ["archive:export", "archive:import:dry-run", "backup:verify", "restore:verify", "upgrade:dry-run"]) {
    const result = operatorCli([command]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { command, status: "adapter-required" });
  }
  const health = operatorCli(["health"]);
  assert.equal(health.status, 1);
  assert.equal(JSON.parse(health.stdout).status, "adapter-required");
});

test("operator CLI health consumes synthetic files and a real SQLite migration ledger", async t => {
  const root = await mkdtemp(join(tmpdir(), "woodshed-operator-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrations = join(root, "migrations");
  await mkdir(migrations);
  await writeFile(join(migrations, "001.sql"), "SELECT 1;");
  const environment = { ...syntheticHealthEnvironment(), WOODSHED_DB: join(root, "database.sqlite"), WOODSHED_MIGRATIONS_PATH: migrations, WOODSHED_KEY_PATH: join(root, "material.bin"), WOODSHED_BACKUP_EVIDENCE: join(root, "evidence.json") };
  const database = new DatabaseSync(environment.WOODSHED_DB);
  try {
    database.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL)");
    const entry = requiredMigrationManifest(migrations)[0]!;
    database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(entry.name, entry.checksum);
  } finally { database.close(); }
  const current = new Date(Date.now() - 1_000).toISOString();
  await writeFile(environment.WOODSHED_KEY_PATH, Buffer.alloc(32, 8));
  await writeFile(environment.WOODSHED_BACKUP_EVIDENCE, JSON.stringify({ ...freshEvidence(), lastBackupAt: current, lastRestoreDrillAt: current, rollbackEvidenceAt: current }));
  const healthy = operatorCli(["health"], environment);
  assert.equal(healthy.status, 0);
  assert.equal(JSON.parse(healthy.stdout).status, "healthy");
  await rm(environment.WOODSHED_BACKUP_EVIDENCE);
  const degraded = operatorCli(["health"], environment);
  assert.equal(degraded.status, 1);
  assert.equal(JSON.parse(degraded.stdout).checks.recovery, false);
});
