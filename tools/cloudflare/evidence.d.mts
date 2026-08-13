export function redactEvidence<T>(value: T, configuredSecrets?: string[]): T;
export function createEvidenceEnvelope(input: { runId: string; sourceSha: string; phase: string; outcomes?: Record<string, unknown>; counts?: Record<string, number>; ids?: Record<string, string> }): Record<string, unknown>;
