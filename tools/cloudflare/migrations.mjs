import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const D1_MIGRATIONS = Object.freeze([
  ["001_first_loop.sql", "6c23f3ff830d1a5ec246cfac07e751e73832e1c66454749868b1621048bfdad0"],
  ["002_participant_choice.sql", "8210e7961ade6820b21ec007bf578ba0bc7e3d683ff3bd3ee002ed02b8e9963a"],
  ["003_rehearsal_coordination.sql", "ded8e0d3736956e8f879bee5d0c5b847f6628b6ce4dfb469cd4944c954113333"],
  ["004_live_performance.sql", "2e606120ac0aefebf656fcd02248938b13f0067f0e922a116f16075aecce8ddf"],
  ["005_coordination_repository.sql", "421a75b3b7005902bb6fa55ba88463497411c834246876e16a50c7618145d1d6"],
  ["006_worker_runtime.sql", "0e3a10b386c7fd87ad0a47c17b9cb769d26d8e527dba33a5f549fd43cc7cac72"],
  ["007_open_join_receipts.sql", "edbb0326da995b002f4cd9b573331b5381533969501519f1b4bbd60d1780f4cc"],
  ["007_participation_recovery.sql", "61ea9ea6f9c6280e9b6f387b9dbeb0ab8f6bc74e93f8147c1fadf00e28b31a28"],
  ["008_ballot_lifecycle_guard.sql", "735cfad0be42b6c7a2869eeb96c722d79d185bee7cf30a6ed8581e8ed1d3386d"],
  ["008_runtime_quota_indexes.sql", "ed4427361cf853cdf327d142a7be4d254dd59394de71658d2819d9aabfa7b2db"],
  ["009_multiple_recovery_credentials.sql", "a319575c1f1d6d9c5f786087a36fc859135d419a2b74ac07ecd8c9b4541d8bd0"],
].map(([filename, sha256]) => Object.freeze({ filename, sha256 })));

export async function verifyMigrationDirectory(directory, manifest = D1_MIGRATIONS) {
  const filenames = manifest.map(({ filename }) => filename);
  if (new Set(filenames).size !== filenames.length) throw new Error("duplicate migration in manifest");
  const actual = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(filenames)) throw new Error("migration manifest mismatch");
  for (const migration of manifest) {
    const content = await readFile(path.join(directory, migration.filename));
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== migration.sha256) throw new Error(`migration digest mismatch: ${migration.filename}`);
  }
  return manifest;
}
