export function redactEvidence<T>(value: T, configuredSecrets?: string[]): T;
export function createEvidenceEnvelope(input: { runId: string; sourceSha: string; phase: string; outcomes?: Record<string, unknown>; counts?: Record<string, number>; ids?: Record<string, string> }): Record<string, unknown>;
export type RouteAbsenceProofMethod = "provider-read" | "owning-worker-deletion";
export interface FinalEvidencePacketInput extends Record<string, any> {
  routeAbsenceProofMethods?: Record<string, RouteAbsenceProofMethod>;
}
export interface FinalAbsenceProof {
  count: number;
  absent: true;
  proofMethod?: RouteAbsenceProofMethod;
}
export interface FinalEvidencePacket extends Record<string, any> {
  absence: Record<string, FinalAbsenceProof> & { route: FinalAbsenceProof };
}
export function createFinalEvidencePacket(input: FinalEvidencePacketInput): FinalEvidencePacket;
export function saveEvidencePacket(file: string, packet: FinalEvidencePacket): Promise<FinalEvidencePacket>;
