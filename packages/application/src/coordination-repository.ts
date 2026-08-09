import { sha256 } from "../../contracts/src/snapshot.ts";

export type CoordinationSnapshot = {
  storageRevision: number;
  arrangements: Record<string, unknown[]>;
  assignments: Record<string, unknown>;
  polls: Record<string, unknown>;
  sessions: Record<string, unknown>;
  connections: Record<string, unknown>;
  deliveries: Record<string, unknown>;
};

export type CoordinationReceipt = { payloadHash: string; result: unknown };
export type CoordinationMutation = {
  scope: string; operationId: string; payloadHash: string; actorId: string;
  communityId: string; eventId: string; capability: string; result: unknown;
};

export interface CoordinationRepository {
  load(): CoordinationSnapshot;
  receipt(scope: string, operationId: string): CoordinationReceipt | undefined;
  commit(snapshot: CoordinationSnapshot, mutation: CoordinationMutation): void;
}

export const emptyCoordinationSnapshot = (): CoordinationSnapshot => ({ storageRevision:0, arrangements:{}, assignments:{}, polls:{}, sessions:{}, connections:{}, deliveries:{} });
export const coordinationPayloadHash = (value: unknown) => sha256(value);

export class MemoryCoordinationRepository implements CoordinationRepository {
  private snapshot = emptyCoordinationSnapshot();
  private receipts = new Map<string, CoordinationReceipt>();
  load(){ return structuredClone(this.snapshot); }
  receipt(scope:string,operationId:string){ return structuredClone(this.receipts.get(`${scope}:${operationId}`)); }
  commit(snapshot:CoordinationSnapshot,mutation:CoordinationMutation){
    const key=`${mutation.scope}:${mutation.operationId}`;
    if(this.receipts.has(key))throw new Error("duplicate coordination receipt");
    snapshot.storageRevision++;
    this.snapshot=structuredClone(snapshot);
    this.receipts.set(key,{payloadHash:mutation.payloadHash,result:structuredClone(mutation.result)});
  }
}
