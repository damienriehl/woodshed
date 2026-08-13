export function executeStep<T>(input: { inspect: () => Promise<{ exists: boolean; id?: string }>; mutate: () => Promise<T>; owns: (state: { exists: boolean; id?: string }) => boolean }): Promise<{ reconciled: boolean; state: T | { exists: boolean; id?: string } }>;
export { createSyntheticFixturePlan, seedSyntheticFixtures } from "./cloudflare/staging-fixtures.mjs";
export { runDeployedAcceptance } from "./cloudflare/staging-smoke.mjs";
export function runStagingOperation(options: Record<string, any>): Promise<any>;
export { assertRollbackCompatible, buildFailureReport, createJournalRetention, runQuarantinedD1Recovery, runStackTeardown } from "./cloudflare/recovery.mjs";
