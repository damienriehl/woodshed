export interface LiveCliArguments {
  operation: "preflight" | "plan" | "apply" | "verify" | "teardown" | "status" | "absence-check";
  environment: "staging";
  inventoryPath?: string;
  journalPath?: string;
  runId?: string;
  owner?: string;
}

export function parseLiveArguments(argv: string[]): LiveCliArguments;
export function generateEffectiveConfig(options: Record<string, any>): Promise<{ configPath: string; migrationsDirectory: string; configDigest: string; lifecycleTag: string; deletionTag?: string }>;
export function collectRemoteInventory(options: Record<string, any>): Promise<Record<string, any>>;
export function createIdentityRevision(remote: Record<string, any>): string;
export function executeJournaledMutation(options: {
  journal: any;
  expectedRevision: string;
  inspectRevision: () => Promise<string>;
  resource: { domain: string; id: string };
  kind: string;
  persistJournal: (journal: any) => Promise<unknown>;
  inspect: () => Promise<any>;
  mutate: () => Promise<any>;
  owns: (state: any) => boolean;
  reconcileExisting?: (context: { intent: any; state: any }) => Promise<boolean> | boolean;
  intentMetadata?: Record<string, unknown>;
  finalize?: (context: { journal: any; intent: any; owned: any; result: { reconciled: boolean; state: any } }) => Promise<void> | void;
}): Promise<{ reconciled: boolean; state: any }>;
export function inspectSourceState(root: string): { actualSourceSha: string; worktreeClean: boolean };
export function createApiTokenClient(options: Record<string, any>): { inspect(): Promise<Record<string, any>>; inspectId(id: string): Promise<Record<string, any>>; revoke(id: string): Promise<true>; listWorkerScripts(accountId: string): Promise<Array<{ name: string }>>; listWorkerRoutes(accountId: string): Promise<Array<{ pattern: string; script: string | null }>>; listWorkerDomains(accountId: string): Promise<Array<{ hostname: string; script: string | null; environment: string | null }>>; inspectWorkersDev(accountId: string, workerName: string): Promise<{ exists: boolean; enabled: boolean }>; inspectAccountSubdomain(accountId: string): Promise<string> };
export function runLiveOperation(input: Record<string, any>, overrides?: Record<string, any>): Promise<Record<string, any>>;
export function publicOperationResult(result: Record<string, any>): Record<string, any>;
export const LIVE_OPERATIONS: readonly string[];
