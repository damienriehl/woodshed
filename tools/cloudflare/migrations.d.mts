export interface D1Migration { readonly filename: string; readonly sha256: string }
export const D1_MIGRATIONS: readonly D1Migration[];
export function verifyMigrationDirectory(directory: string, manifest?: readonly D1Migration[]): Promise<readonly D1Migration[]>;
