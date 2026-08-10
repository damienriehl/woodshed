import { parseNeutralSnapshot, type NeutralSnapshot } from "../../contracts/src/snapshot.ts";
export * from "./envelope.ts";
type Staged={snapshot:NeutralSnapshot;stagedAt:Date;keyMaterial?:Buffer};
export class InMemorySnapshotStore {
  readonly staged=new Map<string,Staged>(); readonly communities=new Map<string,{watermark:string;snapshotId:string;records:NeutralSnapshot["records"]}>(); failBeforeCommit=false;
  stage(snapshot:NeutralSnapshot, stagedAt=new Date()){this.staged.set(snapshot.snapshotId,{snapshot,stagedAt,keyMaterial:Buffer.alloc(32)});}
  active(id:string){return this.communities.get(id);}
  commit(snapshot:NeutralSnapshot){if(this.failBeforeCommit)throw new Error("simulated crash before commit");this.communities.set(snapshot.destinationCommunityId,{watermark:snapshot.endWatermark,snapshotId:snapshot.snapshotId,records:structuredClone(snapshot.records)});this.staged.delete(snapshot.snapshotId);}
  purgeExpired(now=new Date()){let n=0;for(const [id,item] of this.staged)if(Date.parse(item.snapshot.expiresAt)<=now.getTime()){item.keyMaterial?.fill(0);this.staged.delete(id);n++;}return n;}
}
export class SnapshotImporter {
  private readonly store:InMemorySnapshotStore;
  private readonly now:()=>Date;
  constructor(store:InMemorySnapshotStore,now=()=>new Date()){this.store=store;this.now=now;}
  async import(value:unknown,now=this.now()){const s=parseNeutralSnapshot(value);if(Date.parse(s.expiresAt)<=now.getTime())throw new Error("snapshot expired");const active=this.store.active(s.destinationCommunityId);if(active?.snapshotId===s.snapshotId)return {status:"duplicate" as const};if(active&&BigInt(s.endWatermark)<=BigInt(active.watermark))throw new Error("older snapshot rejected");this.store.stage(s,now);this.store.commit(s);return {status:"committed" as const};}
}
