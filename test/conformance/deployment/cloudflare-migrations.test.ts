import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { D1_MIGRATIONS, verifyMigrationDirectory } from "../../../tools/cloudflare/migrations.mjs";

const expected = [
  "001_first_loop.sql", "002_participant_choice.sql", "003_rehearsal_coordination.sql",
  "004_live_performance.sql", "005_coordination_repository.sql", "006_worker_runtime.sql",
  "007_open_join_receipts.sql", "007_participation_recovery.sql",
  "008_ballot_lifecycle_guard.sql", "008_runtime_quota_indexes.sql",
  "009_multiple_recovery_credentials.sql",
];

test("the content-addressed D1 manifest contains the exact ordered chain", async () => {
  assert.deepEqual(D1_MIGRATIONS.map(({ filename }) => filename), expected);
  assert.equal(new Set(D1_MIGRATIONS.map(({ filename }) => filename)).size, 11);
  for (const migration of D1_MIGRATIONS) assert.match(migration.sha256, /^[a-f0-9]{64}$/);
  await verifyMigrationDirectory(path.resolve("migrations/d1"));
});

test("migration verification rejects missing, added, reordered, changed, and duplicate entries", async () => {
  const source = path.resolve("migrations/d1");
  async function fixture(names = expected) {
    const directory = await mkdtemp(path.join(tmpdir(), "woodshed-migrations-"));
    for (const name of names) await writeFile(path.join(directory, name), await readFile(path.join(source, name)));
    return directory;
  }
  const missing = await fixture(expected.slice(1));
  await assert.rejects(verifyMigrationDirectory(missing), /manifest mismatch/);
  const added = await fixture();
  await writeFile(path.join(added, "010_unknown.sql"), "select 1;");
  await assert.rejects(verifyMigrationDirectory(added), /manifest mismatch/);
  const changed = await fixture();
  await writeFile(path.join(changed, expected[0]!), "select 1;");
  await assert.rejects(verifyMigrationDirectory(changed), /digest mismatch/);
  await assert.rejects(verifyMigrationDirectory(source, [...D1_MIGRATIONS].reverse()), /manifest mismatch/);
  await assert.rejects(verifyMigrationDirectory(source, [...D1_MIGRATIONS, D1_MIGRATIONS[0]!]), /duplicate/);
});
