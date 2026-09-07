export interface StagingIdentity { accountId: string; databaseId?: string; databaseName: string; workerName: string; origin: string }
export type StagingResourceDomain = "route" | "hostname" | "credential" | "secret" | "worker" | "durable-object" | "d1" | "token";
export interface StagingResource { domain: StagingResourceDomain; id: string; runId: string; owner: string; status?: "planned" | "owned"; provenance?: "run-minted" }
export interface StagingMutation {
  kind: string; status: "planned" | "pending" | "applied"; domain?: StagingResourceDomain; id?: string; operationId?: string;
  sourceSha?: string; deploymentId?: string; beforeDeploymentIds?: string[]; afterDeploymentIds?: string[];
  tag?: string; configDigest?: string; notRequired?: boolean; revocationAccepted?: boolean;
  providerAcceptance?: { id: string };
}
export interface MigrationAttestation {
  filename: string; sha256: string; sourceSha: string; status: "pending" | "applied";
  precondition?: Record<string, unknown>; postcondition?: Record<string, unknown>;
}
export interface StagingFixturePlan {
  runId: string; preFixtureBookmark: string; communityId: string; eventId: string; organizerParticipationId: string;
  songIds: string[]; deviceInstallationId: string; durableObjectIdentity: string; operationIds: Record<string, string>;
  tokenHash: string; rows: Array<{ table: string; key: string }>; parentChildTables: string[];
}
export interface StagingJournal {
  version: 1; runId: string; owner: string; sourceSha: string; phase: string; identity: StagingIdentity;
  resources: StagingResource[]; mutations: StagingMutation[]; migrations: MigrationAttestation[];
  acceptance?: { status: string; cleanupComplete: boolean; fixturePlan?: StagingFixturePlan };
  preflight?: { protectedRevision: string; targetRevision: string; operatorTokenPresent: true };
  governance?: Record<string, unknown>; lease?: { active: boolean; runId: string; owner: string; revision: string };
  recovery?: Record<string, unknown>; config?: Record<string, unknown>; schema?: Record<string, unknown>; deployment?: Record<string, unknown>;
  deploymentBaseline?: string[]; rollback?: Record<string, unknown>; acceptanceEvidence?: Record<string, unknown>;
  incident?: Record<string, unknown>; teardown?: Record<string, unknown>; retention?: Record<string, unknown>;
  absenceChecks?: Array<Record<string, unknown>>; createdAt: string; updatedAt: string;
}
export const TEARDOWN_ENTRY_PHASES: readonly string[];
export function validateJournal(value: unknown): StagingJournal;
export function createJournal(input: { runId: string; owner: string; sourceSha: string; identity: StagingIdentity; now?: string }): StagingJournal;
export function attestMigration(journal: StagingJournal, migration: { filename: string; sha256: string; sourceSha: string }): StagingJournal;
export function saveJournal(file: string, value: StagingJournal): Promise<StagingJournal>;
export function saveNewJournal(file: string, value: StagingJournal): Promise<StagingJournal>;
export function loadJournal(file: string, expected?: { runId?: string; owner?: string }): Promise<StagingJournal>;
