export function redactEvidence<T>(value: T, configuredSecrets?: string[]): T;
export function createEvidenceEnvelope(input: { runId: string; sourceSha: string; phase: string; outcomes?: Record<string, unknown>; counts?: Record<string, number>; ids?: Record<string, string> }): Record<string, unknown>;
export function createFinalEvidencePacket(input: Record<string, any>): Record<string, any>;
export function saveEvidencePacket(file: string, packet: Record<string, any>): Promise<Record<string, any>>;
