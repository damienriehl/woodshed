export interface RollbackCompatibility { durableObject: string; d1Schema: string; durableObjectShape: string; bindings: string[]; secrets: string[] }
export function assertRollbackCompatible(current: RollbackCompatibility, target: RollbackCompatibility): true;
export function runQuarantinedD1Recovery(options: Record<string, any>): Promise<{ restored: true; reconciled: boolean; durableObjectRestored: false; verification: Record<string, boolean> }>;
export interface DeferredRouteInspection {
  exists: null;
  deferAbsenceUntil: "worker";
  runId: string;
  owner: string;
}
export interface ResourceInspection {
  exists: boolean | undefined;
  runId?: string;
  owner?: string;
}
export interface StackTeardownOptions {
  journal: any;
  lease: any;
  expectedRevision: string;
  inspectRevision: () => Promise<string> | string;
  listDependents: (resource: any, context: { deferredRouteProof: boolean }) => Promise<unknown[]> | unknown[];
  inspectResource: (resource: any) => Promise<ResourceInspection | DeferredRouteInspection> | ResourceInspection | DeferredRouteInspection;
  removeResource: (resource: any) => Promise<void> | void;
  verifyTokenInactive: () => Promise<boolean> | boolean;
}
export function runStackTeardown(options: StackTeardownOptions): Promise<{ complete: boolean; absence: Record<string, boolean>; protectedRevision: string; durableObjectStateRemovedWithNamespace: boolean }>;
export function buildFailureReport(input: { phase: string; nextAction: string; incidentOwner: string; observations?: Record<string, unknown> }, configuredSecrets?: string[]): Record<string, unknown>;
export function createJournalRetention(input: { completedAt?: string; incidentResolvedAt?: string }): { retainUntil: string; checks: string[]; disposalAuthority: string };
export const RESOURCE_ORDER: readonly string[];
