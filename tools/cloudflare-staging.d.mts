export {
  collectRemoteInventory,
  createApiTokenClient,
  createIdentityRevision,
  executeJournaledMutation,
  generateEffectiveConfig,
  parseLiveArguments,
  publicOperationResult,
  runLiveOperation,
} from "./cloudflare/live-driver.mjs";
export type { LiveCliArguments } from "./cloudflare/live-driver.mjs";
export * from "./cloudflare/staging-fixtures.mjs";
export * from "./cloudflare/staging-smoke.mjs";
export * from "./cloudflare/recovery.mjs";

export function executeStep(options: { inspect: () => Promise<any>; mutate: () => Promise<any>; owns: (state: any) => boolean }): Promise<{ reconciled: boolean; state: any }>;
export function runStagingOperation(options: Record<string, any>): Promise<any>;
export function publicErrorMessage(error: unknown, environment?: Record<string, string | undefined>): string;
