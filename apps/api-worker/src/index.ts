import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";

import { D1ChoiceRuntime, RuntimeError, record, type RuntimeSession } from "../../../packages/storage-d1/src/choice-runtime.ts";
import { D1LiveRuntime,deriveDeviceCredential } from "../../../packages/storage-d1/src/live-runtime.ts";
export { LiveCoordinator } from "./live-do.ts";

export type WorkerBindings={DB:D1Database;LIVE_COORDINATOR:DurableObjectNamespace;APP_ORIGIN:string;LIVE_COMMAND_SECRET:string;CLOCK_ISO?:string};
const headers={"referrer-policy":"no-referrer","x-content-type-options":"nosniff","content-security-policy":"default-src 'self'; frame-ancestors 'none'; base-uri 'none'","cache-control":"private, no-store"};
const safe=new Set(["GET","HEAD","OPTIONS"]),organizers=new Set(["organizer","community-admin"]),participants=new Set(["participant",...organizers]);
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const errorStatus:Record<string,number>={unauthorized:401,denied:403,"not-found":404,conflict:409,"stale-revision":409,"superseded-authority":409,"authority-already-held":409,"replay-mismatch":409,"voting-closed":409,"rate-limited":429};

async function body(request:Request){try{return record(await request.json());}catch(error){if(error instanceof RuntimeError)throw error;throw new RuntimeError("invalid-command");}}
function token(request:Request){const match=/^Bearer (\S+)$/.exec(request.headers.get("authorization")??"");if(!match?.[1])throw new RuntimeError("unauthorized");return match[1];}
function mutationGuard(request:Request,env:WorkerBindings){if(!safe.has(request.method)&&(request.headers.get("origin")!==env.APP_ORIGIN||request.headers.get("x-csrf-token")!=="same-origin"))throw new RuntimeError("denied");}
function eventMatch(path:string,suffix:string){return new RegExp(`^/api/events/([^/]+)${suffix}$`).exec(path)?.[1];}
function coordinator(env:WorkerBindings,eventId:string){return env.LIVE_COORDINATOR.get(env.LIVE_COORDINATOR.idFromName(eventId));}
async function authority(env:WorkerBindings,eventId:string,path:string,request?:Request){return coordinator(env,eventId).fetch(`https://authority.invalid${path}`,request?{method:request.method,headers:{"content-type":"application/json"},body:request.method==="GET"?undefined:JSON.stringify({...await body(request),eventId})}:undefined);}
function requireOrganizer(session:RuntimeSession){if(!organizers.has(session.role))throw new RuntimeError("denied");}

export default {async fetch(request:Request,env:WorkerBindings):Promise<Response>{
  try{
    const url=new URL(request.url),choice=new D1ChoiceRuntime(env.DB,()=>new Date(env.CLOCK_ISO??Date.now()));
    if(request.method==="GET"&&url.pathname==="/api/discovery")return json({events:await choice.discoverEvents()});
    const ballotEvent=eventMatch(url.pathname,"/ballot");
    if(ballotEvent){const session=await choice.session(token(request));await choice.assertEvent(session,ballotEvent);if(!participants.has(session.role))throw new RuntimeError("denied");if(request.method==="GET")return json(await choice.ballot(session));if(request.method==="PUT"){mutationGuard(request,env);return json(await choice.replaceBallot(session,await body(request)));}}
    const liveStateEvent=eventMatch(url.pathname,"/live/state"),liveHistoryEvent=eventMatch(url.pathname,"/live/history");
    if((liveStateEvent||liveHistoryEvent)&&request.method==="GET"){const eventId=liveStateEvent??liveHistoryEvent!;const session=await choice.session(token(request));await choice.assertEvent(session,eventId);const live=new D1LiveRuntime(env.DB,env.LIVE_COMMAND_SECRET,()=>new Date(env.CLOCK_ISO??Date.now()));return json(liveStateEvent?await live.state(eventId,session.communityId):await live.history(eventId,session.communityId));}
    const commandEvent=eventMatch(url.pathname,"/live/commands");
    if(commandEvent&&request.method==="POST"){mutationGuard(request,env);const session=await choice.session(token(request));await choice.assertEvent(session,commandEvent);requireOrganizer(session);const command=await body(request);if(command.eventId!==commandEvent||command.communityId!==session.communityId||command.actorId!==session.participationId)throw new RuntimeError("denied");const leaseResponse=await authority(env,commandEvent,"/authority/current");const lease=await leaseResponse.json();if(!lease)throw new RuntimeError("superseded-authority");return json(await new D1LiveRuntime(env.DB,env.LIVE_COMMAND_SECRET,()=>new Date(env.CLOCK_ISO??Date.now())).execute(command,lease as never));}
    const authorityRoutes:[string,string,string,number][]=[["/live/authority/acquire","/authority/acquire","POST",200],["/live/authority/handoffs","/authority/handoffs","POST",201],["/live/authority/handoffs/confirm","/authority/handoffs/confirm","POST",200],["/live/authority/handoffs/cancel","/authority/handoffs/cancel","POST",200],["/live/authority/revoke-recover","/authority/revoke-recover","POST",200]];
    for(const [suffix,target,method] of authorityRoutes){const eventId=eventMatch(url.pathname,suffix);if(eventId&&request.method===method){mutationGuard(request,env);const session=await choice.session(token(request));await choice.assertEvent(session,eventId);requireOrganizer(session);const response=await authority(env,eventId,target,request),result=await response.json() as Record<string,unknown>;if(response.ok&&typeof result.deviceInstallationId==="string")result.commandCredential=await deriveDeviceCredential(env.LIVE_COMMAND_SECRET,session.communityId,eventId,result.deviceInstallationId);return json(result,response.status);}}
    return json({error:"not-found"},404);
  }catch(error){const code=error instanceof RuntimeError?error.code:typeof error==="object"&&error&&"code" in error?String(error.code):"internal-error";return json({error:code},errorStatus[code]??(code==="internal-error"?500:400));}
}};
