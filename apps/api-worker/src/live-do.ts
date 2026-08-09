import type { DurableObjectState } from "@cloudflare/workers-types";

export class LiveCoordinator {
  private readonly storage:DurableObjectState["storage"];
  constructor(state:DurableObjectState){
    this.storage=state.storage;
  }
  async fetch(request:Request){
    const url=new URL(request.url);
    if(request.method==="GET"&&url.pathname==="/health")return Response.json({status:"healthy",coordinator:"durable-object"});
    if(request.method==="GET"&&url.pathname==="/authority/current")return Response.json(await this.storage.get("lease")??null);
    if(request.method==="POST"&&url.pathname==="/authority/acquire"){
      const body=await request.json() as {eventId?:string;deviceInstallationId?:string};
      if(!body.eventId||!body.deviceInstallationId)return Response.json({error:"invalid-command"},{status:400});
      return this.storage.transaction(async()=>{const old=await this.storage.get<{epoch:number;revoked:boolean}>("lease");if(old&&!old.revoked)return Response.json({error:"authority-already-held"},{status:409});const lease={eventId:body.eventId!,deviceInstallationId:body.deviceInstallationId!,epoch:(old?.epoch??0)+1,confirmedAt:new Date().toISOString(),revoked:false};await this.storage.put("lease",lease);return Response.json(lease);});
    }
    if(request.method==="POST"&&url.pathname==="/authority/handoffs"){
      const body=await request.json() as {eventId?:string;fromDeviceInstallationId?:string;toDeviceInstallationId?:string};
      return this.storage.transaction(async()=>{const lease=await this.storage.get<{eventId:string;deviceInstallationId:string;epoch:number;revoked:boolean}>("lease");if(!lease||lease.eventId!==body.eventId||lease.revoked||lease.deviceInstallationId!==body.fromDeviceInstallationId||body.fromDeviceInstallationId===body.toDeviceInstallationId||!body.toDeviceInstallationId)return Response.json({error:"handoff-denied"},{status:403});const pending={token:crypto.randomUUID(),from:body.fromDeviceInstallationId,to:body.toDeviceInstallationId,epoch:lease.epoch,eventId:lease.eventId};await this.storage.put("handoff",pending);return Response.json(pending,{status:201});});
    }
    if(request.method==="POST"&&url.pathname==="/authority/handoffs/confirm"){
      const body=await request.json() as {eventId?:string;token?:string;deviceInstallationId?:string};
      return this.storage.transaction(async()=>{const lease=await this.storage.get<{eventId:string;epoch:number}>("lease"),pending=await this.storage.get<{eventId:string;token:string;to:string;epoch:number}>("handoff");if(!lease||!pending||pending.eventId!==body.eventId||pending.token!==body.token||pending.to!==body.deviceInstallationId||pending.epoch!==lease.epoch)return Response.json({error:"handoff-denied"},{status:403});const next={eventId:lease.eventId,deviceInstallationId:pending.to,epoch:lease.epoch+1,confirmedAt:new Date().toISOString(),revoked:false};await this.storage.put("lease",next);await this.storage.delete("handoff");return Response.json(next);});
    }
    if(request.method==="POST"&&url.pathname==="/authority/handoffs/cancel"){
      const body=await request.json() as {eventId?:string;token?:string;deviceInstallationId?:string};
      return this.storage.transaction(async()=>{const lease=await this.storage.get<{eventId:string;deviceInstallationId:string;epoch:number;revoked:boolean}>("lease"),pending=await this.storage.get<{eventId:string;token:string;from:string;epoch:number}>("handoff");if(!lease||!pending||lease.revoked||lease.eventId!==body.eventId||pending.eventId!==body.eventId||pending.token!==body.token||pending.from!==body.deviceInstallationId||pending.epoch!==lease.epoch||lease.deviceInstallationId!==body.deviceInstallationId)return Response.json({error:"handoff-denied"},{status:403});await this.storage.delete("handoff");return Response.json({cancelled:true,epoch:lease.epoch});});
    }
    if(request.method==="POST"&&url.pathname==="/authority/revoke-recover"){
      const body=await request.json() as {eventId?:string;lostDeviceInstallationId?:string;recoveryDeviceInstallationId?:string};
      return this.storage.transaction(async()=>{const lease=await this.storage.get<{eventId:string;deviceInstallationId:string;epoch:number;revoked:boolean}>("lease");if(!lease||lease.eventId!==body.eventId||lease.deviceInstallationId!==body.lostDeviceInstallationId||!body.recoveryDeviceInstallationId||body.recoveryDeviceInstallationId===body.lostDeviceInstallationId)return Response.json({error:"recovery-denied"},{status:403});const next={eventId:lease.eventId,deviceInstallationId:body.recoveryDeviceInstallationId,epoch:lease.epoch+1,confirmedAt:new Date().toISOString(),revoked:false};await this.storage.put("lease",next);await this.storage.delete("handoff");return Response.json(next);});
    }
    return Response.json({error:"not-found"},{status:404});
  }
}
