#!/usr/bin/env node
export { createSyntheticFixturePlan, seedSyntheticFixtures } from "./cloudflare/staging-fixtures.mjs";
export { runDeployedAcceptance } from "./cloudflare/staging-smoke.mjs";
export { assertRollbackCompatible, buildFailureReport, createJournalRetention, runQuarantinedD1Recovery, runStackTeardown } from "./cloudflare/recovery.mjs";
export { collectRemoteInventory, createApiTokenClient, createIdentityRevision, executeJournaledMutation, generateEffectiveConfig, parseLiveArguments, publicOperationResult, runLiveOperation } from "./cloudflare/live-driver.mjs";
import { pathToFileURL } from "node:url";
import { redactEvidence } from "./cloudflare/evidence.mjs";
import { loadJournal } from "./cloudflare/journal.mjs";
import { LIVE_OPERATIONS, parseLiveArguments, publicOperationResult, runLiveOperation } from "./cloudflare/live-driver.mjs";

const OPERATIONS = new Set(LIVE_OPERATIONS);
const IDENTITY_FIELDS = ["accountId", "databaseId", "databaseName", "workerName", "origin"];

function sameIdentity(expected, actual) {
  return expected && actual && IDENTITY_FIELDS.every((key) => expected[key] === actual[key]);
}

export async function executeStep({ inspect, mutate, owns }) {
  const before = await inspect();
  if (before?.exists) {
    if (!owns(before)) throw new Error("existing resource is not owned by this run");
    return { reconciled: true, state: before };
  }
  try { return { reconciled: false, state: await mutate() }; }
  catch (error) {
    const after = await inspect();
    if (after?.exists && owns(after)) return { reconciled: true, state: after };
    throw new Error("mutation outcome is uncertain; no retry authorized", { cause: error });
  }
}

export async function runStagingOperation(options) {
  const { operation, boundaries = {} } = options;
  if (!OPERATIONS.has(operation)) throw new Error("unknown staging operation");
  if (operation === "teardown" || operation === "status") {
    if (!options.journalPath) throw new Error("journal path is required");
    const journal = await loadJournal(options.journalPath, { runId: options.runId, owner: options.owner });
    if (operation === "status") return journal;
    if (!options.lease?.active || options.lease.runId !== journal.runId || options.lease.owner !== journal.owner) throw new Error("active ownership lease is required");
    const remote = await boundaries.inspect?.(journal.identity);
    if (!sameIdentity(journal.identity, remote)) throw new Error("remote identity changed");
    return boundaries.mutate?.({ operation, journal });
  }
  if (!options.inventory || typeof options.inventory !== "object") throw new Error("validated inventory is required");
  if (operation === "preflight" || operation === "plan") return { operation, mutationCount: 0 };
  if (!options.lease?.active || options.lease.runId !== options.runId || options.lease.owner !== options.owner) throw new Error("active ownership lease is required");
  if (!sameIdentity(options.expectedIdentity, options.remoteIdentity)) throw new Error("remote identity changed");
  return boundaries.mutate?.({ operation });
}

export function publicErrorMessage(error, environment = process.env) {
  const configuredSecrets = [environment.CLOUDFLARE_API_TOKEN, environment.LIVE_COMMAND_SECRET, environment.WOODSHED_STAGING_ORGANIZER_TOKEN];
  return redactEvidence({ message: error instanceof Error ? error.message : "staging operation failed" }, configuredSecrets).message;
}

async function main(argv) {
  const parsed = parseLiveArguments(argv);
  const result = await runLiveOperation({ ...parsed, processEnvironment: process.env });
  process.stdout.write(`${JSON.stringify(publicOperationResult(result))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${publicErrorMessage(error)}\n`);
  process.exitCode = 1;
});
