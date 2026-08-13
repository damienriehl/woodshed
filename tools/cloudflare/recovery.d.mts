export interface RollbackCompatibility { durableObject: string; d1Schema: string; durableObjectShape: string; bindings: string[]; secrets: string[] }
export function assertRollbackCompatible(current: RollbackCompatibility, target: RollbackCompatibility): true;
export function runQuarantinedD1Recovery(options: Record<string, any>): Promise<{ restored: true; durableObjectRestored: false; verification: Record<string, boolean> }>;
export function runStackTeardown(options: Record<string, any>): Promise<{ complete: boolean; absence: Record<string, boolean>; durableObjectStateRemovedWithNamespace: boolean }>;
export function buildFailureReport(input: { phase: string; nextAction: string; incidentOwner: string; observations?: Record<string, unknown> }, configuredSecrets?: string[]): Record<string, unknown>;
export function createJournalRetention(input: { completedAt?: string; incidentResolvedAt?: string }): { retainUntil: string; checks: string[]; disposalAuthority: string };
export const RESOURCE_ORDER: readonly string[];
