export function createWranglerAdapter(options: Record<string, unknown>): any;
export function runBoundedSubprocess(file: string, args: string[], options: Record<string, any>): Promise<{ exitCode: number | null; signal?: string | null; stdout: string; stderr: string }>;
export function assertCredentialedPreflight(inventory: any, remote: any, options?: any): any;
export function persistAssignedDatabaseIdentity(options: any): Promise<string>;
export function reconcileMigrationLedger(options: any): any;
export function assertSchemaInvariants(actual: any, expected: any): true;
export function assertDeploymentIdentity(expected: any, actual: any): true;
export function runMigrationFirstDeployment(options: any): Promise<any>;
