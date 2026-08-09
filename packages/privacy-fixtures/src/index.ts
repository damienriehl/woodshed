import { parseNeutralSnapshot, sha256, type NeutralSnapshot, type SnapshotRecord } from "../../contracts/src/snapshot.ts";
export function deriveSyntheticFixture(value:unknown):NeutralSnapshot{
  const s=parseNeutralSnapshot(value), counters=new Map<string,number>(), ids=new Map<string,string>();
  for(const r of s.records){const n=(counters.get(r.type)??0)+1;counters.set(r.type,n);ids.set(r.sourceId,`synthetic_${r.type}_${n}`);}
  const records:SnapshotRecord[]=s.records.map(r=>({type:r.type,sourceId:ids.get(r.sourceId)!,parentSourceId:r.parentSourceId?ids.get(r.parentSourceId)??null:null,tombstone:r.tombstone,attributes:syntheticAttributes(r,ids)}));
  const recordHashes=Object.fromEntries(records.map(record=>[record.sourceId,sha256(record)]));
  return {...s,snapshotId:"snapshot_synthetic_001",sourceIdentity:"source_synthetic",destinationCommunityId:"community_synthetic",records,recordHashes};
}
function syntheticAttributes(r:SnapshotRecord,ids:ReadonlyMap<string,string>):Record<string,unknown>{
  if(r.type==="household"&&Array.isArray(r.attributes.memberSourceIds))return {memberSourceIds:(r.attributes.memberSourceIds as unknown[]).map(v=>typeof v==="string"?ids.get(v)??"synthetic_missing_member":"synthetic_missing_member")};
  return {};
}
