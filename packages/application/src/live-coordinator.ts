import { randomUUID } from "node:crypto";
export type AuthorityLease={eventId:string;deviceInstallationId:string;epoch:number;confirmedAt:string;revoked:boolean};
type Handoff={token:string;from:string;to:string;epoch:number};
export interface AuthorityCoordinator { acquire(eventId:string,deviceInstallationId:string):AuthorityLease;current(eventId:string):AuthorityLease|null;requestHandoff(eventId:string,from:string,to:string):Handoff;confirmHandoff(eventId:string,token:string,device:string):AuthorityLease;cancelHandoff(eventId:string,token:string,device:string):void;revokeAndRecover(eventId:string,lostDevice:string,recoveryDevice:string):AuthorityLease; }
export class MemoryAuthorityCoordinator implements AuthorityCoordinator {
  private leases=new Map<string,AuthorityLease>();private pending=new Map<string,Handoff>();
  acquire(eventId:string,deviceInstallationId:string){const old=this.leases.get(eventId);if(old&&!old.revoked)throw new Error("authority-already-held");const lease={eventId,deviceInstallationId,epoch:(old?.epoch??0)+1,confirmedAt:new Date().toISOString(),revoked:false};this.leases.set(eventId,lease);return {...lease};}
  current(eventId:string){const value=this.leases.get(eventId);return value&&!value.revoked?{...value}:null;}
  requestHandoff(eventId:string,from:string,to:string){const lease=this.leases.get(eventId);if(!lease||lease.revoked||lease.deviceInstallationId!==from||from===to)throw new Error("handoff-denied");const handoff={token:randomUUID(),from,to,epoch:lease.epoch};this.pending.set(eventId,handoff);return {...handoff};}
  confirmHandoff(eventId:string,token:string,device:string){const handoff=this.pending.get(eventId),lease=this.leases.get(eventId);if(!handoff||handoff.token!==token||handoff.to!==device||lease?.epoch!==handoff.epoch)throw new Error("handoff-denied");const next={eventId,deviceInstallationId:device,epoch:lease.epoch+1,confirmedAt:new Date().toISOString(),revoked:false};this.leases.set(eventId,next);this.pending.delete(eventId);return {...next};}
  cancelHandoff(eventId:string,token:string,device:string){const handoff=this.pending.get(eventId);if(!handoff||handoff.token!==token||handoff.from!==device)throw new Error("handoff-denied");this.pending.delete(eventId);}
  revokeAndRecover(eventId:string,lostDevice:string,recoveryDevice:string){const lease=this.leases.get(eventId);if(!lease||lease.deviceInstallationId!==lostDevice)throw new Error("recovery-denied");const next={eventId,deviceInstallationId:recoveryDevice,epoch:lease.epoch+1,confirmedAt:new Date().toISOString(),revoked:false};this.leases.set(eventId,next);this.pending.delete(eventId);return {...next};}
  snapshot(){return {leases:[...this.leases],pending:[...this.pending]};}
  static restore(snapshot:ReturnType<MemoryAuthorityCoordinator["snapshot"]>){const value=new MemoryAuthorityCoordinator();value.leases=new Map(snapshot.leases);value.pending=new Map(snapshot.pending);return value;}
}

export interface DurableAuthorityState { get<T>(key:string):Promise<T|undefined>;put<T>(key:string,value:T):Promise<void>;transaction<T>(body:()=>Promise<T>):Promise<T>; }
export class DurableObjectAuthorityCoordinator {
  private readonly state:DurableAuthorityState;constructor(state:DurableAuthorityState){this.state=state;}
  async acquire(eventId:string,deviceInstallationId:string){return this.state.transaction(async()=>{const old=await this.state.get<AuthorityLease>(eventId);if(old&&!old.revoked)throw new Error("authority-already-held");const next={eventId,deviceInstallationId,epoch:(old?.epoch??0)+1,confirmedAt:new Date().toISOString(),revoked:false};await this.state.put(eventId,next);return next;});}
}
