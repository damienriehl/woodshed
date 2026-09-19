import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Miniflare } from "miniflare";

import { firstLoopCommand, SYNTHETIC_FIRST_LOOP_IDS as IDS, registerFirstLoopStorageConformance } from "../../packages/conformance/src/first-loop-suite.ts";
import { KernelError } from "../../packages/conformance/src/adapter.ts";
import { D1Kernel } from "../../packages/storage-d1/src/index.ts";

const COMPATIBILITY_DATE = "2025-07-18";

async function createHarness() {
  const persist = await mkdtemp(path.join(os.tmpdir(), "woodshed-d1-"));
  const migrations = await Promise.all(["001_first_loop.sql", "002_participant_choice.sql"].map(async (name) => ({
    name,
    sql: await readFile(new URL(`../../migrations/d1/${name}`, import.meta.url), "utf8"),
  })));
  let miniflare: Miniflare | undefined;

  async function open() {
    miniflare = new Miniflare({
      compatibilityDate: COMPATIBILITY_DATE,
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "woodshed-conformance" },
      d1Persist: persist,
    });
    return new D1Kernel(await miniflare.getD1Database("DB"), migrations, async () => {
      await miniflare?.dispose();
      miniflare = undefined;
    });
  }

  return {
    open,
    async reopen(kernel: { close(): Promise<void> | void }) { await kernel.close(); return open(); },
    async cleanup() { await miniflare?.dispose(); await rm(persist, { recursive: true, force: true }); },
  };
}

registerFirstLoopStorageConformance("Miniflare D1", createHarness);

async function withD1(run: (kernel: D1Kernel) => Promise<void>, initialize = true) {
  const harness = await createHarness();
  try {
    const kernel = await harness.open();
    if (initialize) {
      await kernel.migrate();
      await kernel.seedSyntheticFirstLoop(IDS);
    }
    await run(kernel);
  } finally {
    await harness.cleanup();
  }
}

function hasCode(code: KernelError["code"]) {
  return (error: unknown) => error instanceof KernelError && error.code === code;
}

async function assertMutationCounts(kernel: D1Kernel, expected: number) {
  for (const table of ["ballot_versions", "audit_events", "idempotency_receipts"] as const) {
    assert.equal(await kernel.count(table), expected, table);
  }
}

test("Miniflare D1: malformed envelopes, absent event scope and confused identity cannot write", async () => {
  await withD1(async kernel => {
    const now = new Date("2030-01-01T12:01:00Z");
    for (const envelope of [null, firstLoopCommand({ expectedRevision: -1 }), firstLoopCommand({ scope: "community", eventId: undefined })]) {
      await assert.rejects(kernel.replaceBallot(envelope, [IDS.songA], now), hasCode("invalid-command"));
      await assertMutationCounts(kernel, 0);
    }
    await assert.rejects(kernel.replaceBallot(firstLoopCommand({ aggregateId: "ballot_unrelated_target" }), [IDS.songA], now), hasCode("denied"));
    await assertMutationCounts(kernel, 0);
    await assert.rejects(kernel.count("communities; DROP TABLE communities" as never), hasCode("invalid-command"));
    assert.equal(await kernel.count("communities"), 2);
  });
});

test("Miniflare D1: inclusive time boundaries persist empty ballots then replacement and replay", async () => {
  await withD1(async kernel => {
    assert.equal(await kernel.latestBallotCreatedAt(), undefined);
    const first = firstLoopCommand();
    await assert.rejects(kernel.replaceBallot(first, [], new Date(Date.parse(first.issuedAt) - 1)), hasCode("not-yet-valid"));
    assert.deepEqual(await kernel.replaceBallot(first, [], new Date(first.issuedAt)), { method: "ranked-choice", revision: 1, rankings: [] });
    const second = firstLoopCommand({ operationId: "operation_boundary_second", expectedRevision: 1 });
    const result = await kernel.replaceBallot(second, [IDS.songB, IDS.songA], new Date(second.expiresAt));
    assert.deepEqual(result, { method: "ranked-choice", revision: 2, rankings: [IDS.songB, IDS.songA] });
    // Object insertion order must not change the replay payload digest.
    const reordered = Object.fromEntries(Object.entries(second).reverse());
    assert.deepEqual(await kernel.replaceBallot(reordered, [IDS.songB, IDS.songA], new Date(second.expiresAt)), result);
    await assert.rejects(kernel.replaceBallot(second, result.rankings, new Date(Date.parse(second.expiresAt) + 1)), hasCode("expired"));
    assert.equal(await kernel.latestBallotCreatedAt(), second.expiresAt);
    await assertMutationCounts(kernel, 2);
    const versions = await kernel.database.prepare("SELECT revision, rankings_json FROM ballot_versions ORDER BY revision").all();
    assert.deepEqual(versions.results, [{ revision: 1, rankings_json: "[]" }, { revision: 2, rankings_json: JSON.stringify(result.rankings) }]);
    assert.deepEqual(await kernel.invariantViolations(), []);
  });
});

test("Miniflare D1: checksum mismatch preserves committed state and matching migration can replay", async () => {
  await withD1(async kernel => {
    await kernel.replaceBallot(firstLoopCommand(), [IDS.songA], new Date("2030-01-01T12:01:00Z"));
    const migration = await kernel.database.prepare("SELECT name, checksum FROM schema_migrations ORDER BY name LIMIT 1").first<{ name: string; checksum: string }>();
    assert.ok(migration);
    await kernel.database.prepare("UPDATE schema_migrations SET checksum = 'wrong' WHERE name = ?").bind(migration.name).run();
    await assert.rejects(kernel.migrate(), error => hasCode("storage-failure")(error) && /checksum mismatch/.test((error as Error).message));
    await assertMutationCounts(kernel, 1);
    assert.equal(await kernel.count("communities"), 2);
    await kernel.database.prepare("UPDATE schema_migrations SET checksum = ? WHERE name = ?").bind(migration.checksum, migration.name).run();
    await kernel.migrate();
    assert.equal(await kernel.count("schema_migrations"), 2);
    assert.deepEqual(await kernel.invariantViolations(), []);
  });
});

test("Miniflare D1: failed migration ledger insertion rolls back schema and permits a clean retry", async () => {
  await withD1(async kernel => {
    await kernel.database.exec("CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    await kernel.database.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END;");
    await assert.rejects(kernel.migrate(), error => hasCode("storage-failure")(error) && /synthetic ledger failure/.test((error as Error).message));
    assert.equal(await kernel.count("schema_migrations"), 0);
    assert.equal(await kernel.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'communities'").first(), null);
    await kernel.database.exec("DROP TRIGGER fail_migration;");
    await kernel.migrate();
    await kernel.seedSyntheticFirstLoop(IDS);
    assert.equal((await kernel.replaceBallot(firstLoopCommand(), [IDS.songA], new Date("2030-01-01T12:01:00Z"))).revision, 1);
    await assertMutationCounts(kernel, 1);
    assert.deepEqual(await kernel.invariantViolations(), []);
  }, false);
});

test("Miniflare D1: invariant scan reports the exact count when mutation receipts are missing", async () => {
  await withD1(async kernel => {
    const now = new Date("2030-01-01T12:01:00Z");
    await kernel.replaceBallot(firstLoopCommand(), [IDS.songA], now);
    await kernel.replaceBallot(firstLoopCommand({ operationId: "operation_second", expectedRevision: 1 }), [IDS.songB], now);
    await kernel.database.prepare("DELETE FROM idempotency_receipts").run();
    assert.deepEqual(await kernel.invariantViolations(), [{ invariant: "mutation-has-audit-and-receipt", count: 2 }]);
  });
});

test("Miniflare D1: lifecycle migration rejects closed-event replacement and rolls back revision", async () => {
  await withD1(async kernel => {
    const name = "008_ballot_lifecycle_guard.sql";
    const sql = await readFile(new URL(`../../migrations/d1/${name}`, import.meta.url), "utf8");
    await new D1Kernel(kernel.database, [{ name, sql }]).migrate();
    const now = new Date("2030-01-01T12:01:00Z");
    await kernel.replaceBallot(firstLoopCommand(), [IDS.songA], now);
    await kernel.database.prepare("UPDATE events SET state = 'completed' WHERE id = ?").bind(IDS.event).run();
    const next = firstLoopCommand({ operationId: "operation_closed", expectedRevision: 1 });
    await assert.rejects(kernel.replaceBallot(next, [IDS.songB], now), hasCode("voting-closed"));
    await assertMutationCounts(kernel, 1);
    assert.equal((await kernel.database.prepare("SELECT current_revision FROM ballots").first<{ current_revision: number }>())?.current_revision, 1);
    assert.deepEqual(await kernel.invariantViolations(), []);
    await kernel.database.prepare("UPDATE events SET state = 'live' WHERE id = ?").bind(IDS.event).run();
    assert.equal((await kernel.replaceBallot(next, [IDS.songB], now)).revision, 2);
    await assertMutationCounts(kernel, 2);
    assert.deepEqual(await kernel.invariantViolations(), []);
  });
});
