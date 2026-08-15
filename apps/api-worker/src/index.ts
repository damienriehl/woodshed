import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";

import { authorize } from "../../../packages/application/src/authorization.ts";
import { D1ChoiceRuntime, RuntimeError, record, webSha256, type RuntimeSession } from "../../../packages/storage-d1/src/choice-runtime.ts";
import { D1LiveRuntime,deriveDeviceCredential } from "../../../packages/storage-d1/src/live-runtime.ts";
export { LiveCoordinator } from "./live-do.ts";

export type WorkerBindings={DB:D1Database;LIVE_COORDINATOR:DurableObjectNamespace;APP_ORIGIN:string;LIVE_COMMAND_SECRET:string;CLOCK_ISO?:string};
const headers={"referrer-policy":"no-referrer","x-content-type-options":"nosniff","content-security-policy":"default-src 'self'; frame-ancestors 'none'; base-uri 'none'","cache-control":"private, no-store"};
const safe=new Set(["GET","HEAD","OPTIONS"]),organizers=new Set(["organizer","community-admin"]),participants=new Set(["participant",...organizers]);
const json=(body:unknown,status=200,extraHeaders?:HeadersInit)=>Response.json(body,{status,headers:extraHeaders?{...headers,...Object.fromEntries(new Headers(extraHeaders))}:headers});
const errorStatus:Record<string,number>={unauthorized:401,denied:403,"not-found":404,conflict:409,"stale-revision":409,"superseded-authority":409,"authority-already-held":409,"replay-mismatch":409,"replay-session-required":409,"voting-closed":409,"rate-limited":429,"open-participation-capacity":429};

async function body(request:Request){try{return record(await request.json());}catch(error){if(error instanceof RuntimeError)throw error;throw new RuntimeError("invalid-command");}}
function bearerToken(request:Request){return /^Bearer (\S+)$/.exec(request.headers.get("authorization")??"")?.[1];}
function cookies(request:Request){const result:Record<string,string>={};for(const part of (request.headers.get("cookie")??"").split(";")){const separator=part.indexOf("=");if(separator<1)continue;const name=part.slice(0,separator).trim(),value=part.slice(separator+1).trim();if(!name||!value)continue;try{result[name]=decodeURIComponent(value);}catch{continue;}}return result;}
async function eventCookie(eventId:string){return `woodshed_session_${(await webSha256(eventId)).slice(0,16)}`;}
async function token(request:Request,eventId:string){const value=bearerToken(request)??cookies(request)[await eventCookie(eventId)];if(!value)throw new RuntimeError("unauthorized");return value;}
function setSessionCookie(cookieName:string,value:string,env:WorkerBindings){const secure=env.APP_ORIGIN.startsWith("https://")?"; Secure":"";return `${cookieName}=${encodeURIComponent(value)}; Max-Age=86400; Path=/; HttpOnly${secure}; SameSite=Lax`;}
function mutationGuard(request:Request,env:WorkerBindings){if(!safe.has(request.method)&&(request.headers.get("origin")!==env.APP_ORIGIN||request.headers.get("x-csrf-token")!=="same-origin"))throw new RuntimeError("denied");}
function eventMatch(path:string,suffix:string){return new RegExp(`^/api/events/([^/]+)${suffix}$`).exec(path)?.[1];}
function coordinator(env:WorkerBindings,eventId:string){return env.LIVE_COORDINATOR.get(env.LIVE_COORDINATOR.idFromName(eventId));}
async function authority(env:WorkerBindings,eventId:string,path:string,request?:Request){return coordinator(env,eventId).fetch(`https://authority.invalid${path}`,request?{method:request.method,headers:{"content-type":"application/json"},body:request.method==="GET"?undefined:JSON.stringify({...await body(request),eventId})}:undefined);}
function requireOrganizer(session:RuntimeSession){if(!organizers.has(session.role))throw new RuntimeError("denied");}

export default {async fetch(request:Request,env:WorkerBindings):Promise<Response>{
  try{
    const url=new URL(request.url),choice=new D1ChoiceRuntime(env.DB,()=>new Date(env.CLOCK_ISO??Date.now()));
    if(request.method==="GET"&&url.pathname==="/api/discovery")return json({events:await choice.discoverEvents()});
    const joinEvent=eventMatch(url.pathname,"/join-open");
    if(joinEvent&&request.method==="POST"){mutationGuard(request,env);const value=await body(request);if(typeof value.operationId!=="string"||!value.operationId)throw new RuntimeError("invalid-request");const cookieName=await eventCookie(joinEvent),session=await choice.joinOpen(joinEvent,value.operationId,cookies(request)[cookieName]);return json({assurance:session.assurance},200,{"set-cookie":setSessionCookie(cookieName,session.token,env)});}
    const contextEvent=eventMatch(url.pathname,"/context");
    if(contextEvent&&request.method==="GET"){const session=await choice.session(await token(request,contextEvent));await choice.assertEvent(session,contextEvent);return json({event:await choice.eventContext(session)});}
    const proposalEvent=eventMatch(url.pathname,"/proposals");
    if(proposalEvent&&request.method==="POST"){mutationGuard(request,env);const session=await choice.session(await token(request,proposalEvent));await choice.assertEvent(session,proposalEvent);if(!authorize({roles:[session.role],actorCommunityId:session.communityId,resourceCommunityId:session.communityId,capability:"proposal:create"}).allowed)throw new RuntimeError("denied");return json(await choice.propose(session,await body(request)),201);}
    if(url.pathname==="/api/logout"&&request.method==="POST"){mutationGuard(request,env);const responseHeaders=new Headers(headers);for(const [name,value] of Object.entries(cookies(request)))if(name==="woodshed_session"||/^woodshed_session_[0-9a-f]{16}$/.test(name)){await choice.revokeSession(value);responseHeaders.append("set-cookie",`${name}=; Max-Age=0; Path=/; HttpOnly${env.APP_ORIGIN.startsWith("https://")?"; Secure":""}; SameSite=Lax`);}return new Response(null,{status:204,headers:responseHeaders});}
    const ballotEvent=eventMatch(url.pathname,"/ballot");
    if(ballotEvent){const session=await choice.session(await token(request,ballotEvent));await choice.assertEvent(session,ballotEvent);if(!participants.has(session.role))throw new RuntimeError("denied");if(request.method==="GET")return json(await choice.ballot(session));if(request.method==="PUT"){mutationGuard(request,env);return json(await choice.replaceBallot(session,await body(request)));}}
    const liveStateEvent=eventMatch(url.pathname,"/live/state"),liveHistoryEvent=eventMatch(url.pathname,"/live/history");
    if((liveStateEvent||liveHistoryEvent)&&request.method==="GET"){const eventId=liveStateEvent??liveHistoryEvent!;const session=await choice.session(await token(request,eventId));await choice.assertEvent(session,eventId);const live=new D1LiveRuntime(env.DB,env.LIVE_COMMAND_SECRET,()=>new Date(env.CLOCK_ISO??Date.now()));return json(liveStateEvent?await live.state(eventId,session.communityId):await live.history(eventId,session.communityId));}
    const commandEvent=eventMatch(url.pathname,"/live/commands");
    if(commandEvent&&request.method==="POST"){mutationGuard(request,env);const session=await choice.session(await token(request,commandEvent));await choice.assertEvent(session,commandEvent);requireOrganizer(session);const command=await body(request);if(command.eventId!==commandEvent||command.communityId!==session.communityId||command.actorId!==session.participationId)throw new RuntimeError("denied");const leaseResponse=await authority(env,commandEvent,"/authority/current");const lease=await leaseResponse.json();if(!lease)throw new RuntimeError("superseded-authority");return json(await new D1LiveRuntime(env.DB,env.LIVE_COMMAND_SECRET,()=>new Date(env.CLOCK_ISO??Date.now())).execute(command,lease as never));}
    const authorityRoutes:[string,string,string,number][]=[["/live/authority/acquire","/authority/acquire","POST",200],["/live/authority/handoffs","/authority/handoffs","POST",201],["/live/authority/handoffs/confirm","/authority/handoffs/confirm","POST",200],["/live/authority/handoffs/cancel","/authority/handoffs/cancel","POST",200],["/live/authority/revoke-recover","/authority/revoke-recover","POST",200]];
    for(const [suffix,target,method] of authorityRoutes){const eventId=eventMatch(url.pathname,suffix);if(eventId&&request.method===method){mutationGuard(request,env);const session=await choice.session(await token(request,eventId));await choice.assertEvent(session,eventId);requireOrganizer(session);const response=await authority(env,eventId,target,request),result=await response.json() as Record<string,unknown>;if(response.ok&&typeof result.deviceInstallationId==="string")result.commandCredential=await deriveDeviceCredential(env.LIVE_COMMAND_SECRET,session.communityId,eventId,result.deviceInstallationId);return json(result,response.status);}}
    return json({error:"not-found"},404);
  }catch(error){const code=error instanceof RuntimeError?error.code:typeof error==="object"&&error&&"code" in error?String(error.code):"internal-error";return json({error:code},errorStatus[code]??(code==="internal-error"?500:400));}
}};
