import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
// @ts-expect-error JavaScript staging contract intentionally ships without a separate type surface.
import { describeInventoryFields, validateStagingInventory } from "../../../tools/cloudflare/inventory.mjs";

const sourceSha = "a".repeat(40);

function validInventory() {
  return {
    expectedSourceSha: sourceSha,
    environment: "staging",
    staging: {
      accountId: "1".repeat(32),
      databaseId: "11111111-2222-4333-8444-555555555555",
      databaseName: "woodshed-staging-synthetic-db",
      origin: "https://woodshed-staging-synthetic.workers.dev",
      workerName: "woodshed-staging-synthetic",
    },
    forbidden: {
      accountIds: ["2".repeat(32)],
      databaseIds: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
      origins: ["https://woodshed.invalid"],
      workerNames: ["woodshed-production"],
    },
  };
}

test("validates a synthetic, explicit staging inventory without exposing values", () => {
  const inventory = validInventory();
  const result = validateStagingInventory(inventory, {
    actualSourceSha: sourceSha,
    worktreeClean: true,
  });

  assert.equal(result.environment, "staging");
  assert.equal(result.staging.workerName, "woodshed-staging-synthetic");
  const description = describeInventoryFields(result);
  assert.deepEqual(description, {
    environment: "configured",
    expectedSourceSha: "configured",
    staging: ["accountId", "databaseId", "databaseName", "origin", "workerName"],
    forbidden: ["accountIds", "databaseIds", "origins", "workerNames"],
  });
  assert.doesNotMatch(JSON.stringify(description), /11111111|woodshed-staging-synthetic|a{40}/);
});

test("fails closed for missing, placeholder, unsafe, default, or production targets", () => {
  const cases: Array<[string, (inventory: ReturnType<typeof validInventory>) => void, RegExp]> = [
    ["missing account", (value) => delete (value.staging as Partial<typeof value.staging>).accountId, /accountId.*required/i],
    ["missing database name", (value) => delete (value.staging as Partial<typeof value.staging>).databaseName, /databaseName.*required/i],
    ["missing origin", (value) => delete (value.staging as Partial<typeof value.staging>).origin, /origin.*required/i],
    ["placeholder", (value) => { value.staging.databaseId = "replace-during-install"; }, /placeholder/i],
    ["unsafe worker", (value) => { value.staging.workerName = "woodshed-production"; }, /staging/i],
    ["default environment", (value) => { value.environment = "default"; }, /environment.*staging/i],
    ["forbidden target", (value) => { value.staging.accountId = value.forbidden.accountIds[0]!; }, /forbidden/i],
    ["hootenanny target", (value) => { value.staging.workerName = "hootenanny-staging"; }, /hootenanny/i],
  ];

  for (const [name, mutate, expected] of cases) {
    const inventory = validInventory();
    mutate(inventory);
    assert.throws(
      () => validateStagingInventory(inventory, { actualSourceSha: sourceSha, worktreeClean: true }),
      expected,
      name,
    );
  }
});

test("accepts an approved fresh D1 name before Cloudflare assigns its UUID", () => {
  const inventory = validInventory();
  delete (inventory.staging as Partial<typeof inventory.staging>).databaseId;
  const result = validateStagingInventory(inventory, { actualSourceSha: sourceSha, worktreeClean: true });
  assert.equal(result.staging.databaseName, "woodshed-staging-synthetic-db");
  assert.equal(result.staging.databaseId, undefined);
});

test("requires complete forbidden sets and compares normalized identifiers", () => {
  for (const field of ["accountIds", "databaseIds", "origins", "workerNames"] as const) {
    const inventory = validInventory();
    inventory.forbidden[field] = [];
    assert.throws(() => validateStagingInventory(inventory, { actualSourceSha: sourceSha, worktreeClean: true }), /non-empty array/i);
  }
  const inventory = validInventory();
  inventory.staging.accountId = "A".repeat(32);
  inventory.forbidden.accountIds = ["a".repeat(32)];
  assert.throws(() => validateStagingInventory(inventory, { actualSourceSha: sourceSha, worktreeClean: true }), /account is forbidden/i);
});

test("rejects unknown fields, a dirty tree, and a mismatched full source SHA", () => {
  const withUnknown = { ...validInventory(), token: "must-not-be-accepted" };
  assert.throws(
    () => validateStagingInventory(withUnknown, { actualSourceSha: sourceSha, worktreeClean: true }),
    /unknown field.*token/i,
  );
  assert.throws(
    () => validateStagingInventory(validInventory(), { actualSourceSha: sourceSha, worktreeClean: false }),
    /clean worktree/i,
  );
  assert.throws(
    () => validateStagingInventory(validInventory(), { actualSourceSha: "b".repeat(40), worktreeClean: true }),
    /source sha.*match/i,
  );
  assert.throws(
    () => validateStagingInventory(validInventory(), { actualSourceSha: "short", worktreeClean: true }),
    /full source sha/i,
  );
});

test("repository scripts pin the local Wrangler binary to the staging environment", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.devDependencies.wrangler, "4.28.1");
  assert.equal(
    packageJson.scripts["cloudflare:staging:version"],
    "wrangler --config deploy/cloudflare/wrangler.jsonc --env staging --version",
  );
  assert.doesNotMatch(packageJson.scripts["cloudflare:staging:version"], /npx|--env default|--env production/);

  const wrangler = await readFile(new URL("../../../deploy/cloudflare/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wrangler, /"env"\s*:\s*\{\s*"staging"/s);
  assert.doesNotMatch(wrangler, /replace-during-install/);
});
