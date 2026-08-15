export interface StagingIdentity { accountId: string; databaseId?: string; databaseName: string; workerName: string; origin: string }
export interface StagingJournal { version: 1; runId: string; owner: string; sourceSha: string; phase: string; identity: StagingIdentity; resources: unknown[]; mutations: unknown[]; migrations: Array<{ filename: string; sha256: string; sourceSha: string; status: string }>; acceptance?: { status: string; cleanupComplete: boolean; fixturePlan?: Record<string, any> }; createdAt: string; updatedAt: string }
export function validateJournal(value: unknown): StagingJournal;
export function createJournal(input: { runId: string; owner: string; sourceSha: string; identity: StagingIdentity; now?: string }): StagingJournal;
export function attestMigration(journal: StagingJournal, migration: { filename: string; sha256: string; sourceSha: string }): StagingJournal;
export function saveJournal(file: string, value: StagingJournal): Promise<StagingJournal>;
export function loadJournal(file: string, expected?: { runId?: string; owner?: string }): Promise<StagingJournal>;
