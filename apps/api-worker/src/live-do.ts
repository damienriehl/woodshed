import { DurableObjectAuthorityCoordinator, type DurableAuthorityState } from "../../../packages/application/src/live-coordinator.ts";
import type { DurableObjectState } from "@cloudflare/workers-types";

export class LiveCoordinator {
  private readonly authority:DurableObjectAuthorityCoordinator;
  constructor(state:DurableObjectState){
    const adapter:DurableAuthorityState={
      get:<T>(key:string)=>state.storage.get<T>(key),
      put:<T>(key:string,value:T)=>state.storage.put(key,value),
      transaction:<T>(body:()=>Promise<T>)=>state.storage.transaction(()=>body()),
    };
    this.authority=new DurableObjectAuthorityCoordinator(adapter);
  }
  async fetch(request:Request){
    const url=new URL(request.url);
    if(request.method==="GET"&&url.pathname==="/health")return Response.json({status:"healthy",coordinator:"durable-object"});
    if(request.method==="POST"&&url.pathname==="/authority/acquire"){
      const body=await request.json() as {eventId?:string;deviceInstallationId?:string};
      if(!body.eventId||!body.deviceInstallationId)return Response.json({error:"invalid-command"},{status:400});
      return Response.json(await this.authority.acquire(body.eventId,body.deviceInstallationId));
    }
    return Response.json({error:"not-found"},{status:404});
  }
}
