import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";

import { ChoiceError, ChoiceService, type Session } from "../../../packages/application/src/choice-service.ts";
import { CoordinationError, CoordinationService } from "../../../packages/application/src/coordination-service.ts";
import { authorize } from "../../../packages/application/src/authorization.ts";

type Variables = { sessionId: string; session: Session };
const SESSION_COOKIE = "woodshed_session";
const RECOVERY_COOKIE = "woodshed_recovery";
const eventSessionCookie = (eventId: string) => `${SESSION_COOKIE}_${createHash("sha256").update(eventId).digest("hex").slice(0,16)}`;
const eventRecoveryCookie = (eventId: string) => `${RECOVERY_COOKIE}_${createHash("sha256").update(eventId).digest("hex").slice(0,16)}`;
const sessionCookieOptions = (origin: string) => ({ httpOnly: true, sameSite: "Lax", secure: origin.startsWith("https://"), path: "/", maxAge: 86_400 } as const);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ERROR_STATUS = {
  unauthorized: 401,
  denied: 403,
  "not-found": 404,
  conflict: 409,
  "voting-closed": 409,
  "replay-session-required": 409,
  "open-participation-capacity": 429,
} as const;

export function createApi(service: ChoiceService, options: { origin: string; coordination?: CoordinationService }) {
  const app = new Hono<{ Variables: Variables }>();
  const coordination=options.coordination??new CoordinationService();
  const cookieOptions=sessionCookieOptions(options.origin);
  const recoveryCookieOptions={...cookieOptions,maxAge:30*86_400};
  app.use("*", async (context, next) => {
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (context.req.path.startsWith("/api/")) context.header("Cache-Control", "private, no-store");
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof ChoiceError || error instanceof CoordinationError) {
      const status = ERROR_STATUS[error.code as keyof typeof ERROR_STATUS] ?? 400;
      return context.json({ error: error.code }, status);
    }
    return context.json({ error: "internal-error" }, 500);
  });
  app.use("/api/*", async (context, next) => {
    if (!SAFE_METHODS.has(context.req.method) &&
        (context.req.header("origin") !== options.origin || context.req.header("x-csrf-token") !== "same-origin")) {
      throw new ChoiceError("denied");
    }
    await next();
  });
  app.get("/api/discovery", (context) => context.json({ events: service.discoverEvents() }));
  app.get("/api/session/exchange", (context) => {
    const capability = context.req.query("capability"); if (!capability) throw new ChoiceError("invalid-capability");
    const session = service.exchangeInvite(capability);
    setCookie(context, eventSessionCookie(session.eventId), session.id, cookieOptions);
    if("recoveryCapability" in session)setCookie(context,eventRecoveryCookie(session.eventId),session.recoveryCapability,recoveryCookieOptions);
    return context.redirect(`/events/${session.eventId}`, 303);
  });
  app.use("/api/events/:eventId/join-open",bodyLimit({maxSize:1024,onError:context=>context.json({error:"invalid-request"},413)}));
  app.post("/api/events/:eventId/join-open", async (context) => {
    const entry = service.eventEntry(context.req.param("eventId"), null); if (entry.outcome !== "eligible-open") throw new ChoiceError("denied");
    const eventId=context.req.param("eventId"),body=await context.req.json<{operationId?:string}>();if(typeof body.operationId!=="string"||!body.operationId||body.operationId.length>128)throw new ChoiceError("invalid-request");const cookieName=eventSessionCookie(eventId),recovery=getCookie(context,eventRecoveryCookie(eventId));const session=recovery?service.recoverPublicSession(eventId,recovery):service.openPublicSession(eventId,body.operationId,getCookie(context,cookieName));setCookie(context,cookieName,session.id,cookieOptions);if("recoveryCapability" in session&&typeof session.recoveryCapability==="string")setCookie(context,eventRecoveryCookie(eventId),session.recoveryCapability,recoveryCookieOptions);return context.json({assurance:session.assurance});
  });
  app.post("/api/events/:eventId/recover",context=>{const eventId=context.req.param("eventId"),recovery=getCookie(context,eventRecoveryCookie(eventId));if(!recovery)throw new ChoiceError("unauthorized");const session=service.recoverSession(eventId,recovery);setCookie(context,eventSessionCookie(eventId),session.id,cookieOptions);return context.json({assurance:session.assurance});});
  app.get("/api/session/events",context=>{const events=new Map<string,unknown>();for(const [name,value] of Object.entries(getCookie(context))){try{const event=name.startsWith(`${SESSION_COOKIE}_`)?service.eventContext(service.session(String(value))):name.startsWith(`${RECOVERY_COOKIE}_`)?service.recoveryEventContext(String(value)):null;if(event)events.set(String((event as {id:string}).id),event)}catch{/* Ignore expired, revoked, malformed, or policy-ineligible cookies. */}}return context.json({events:[...events.values()]});});
  app.use("/api/events/:eventId/*", async (context, next) => {
    const sessionId=getCookie(context,eventSessionCookie(context.req.param("eventId")))??getCookie(context,SESSION_COOKIE);if(!sessionId)throw new ChoiceError("unauthorized");const session=service.assertEvent(sessionId,context.req.param("eventId"));context.set("sessionId",sessionId);context.set("session",session);
    await next();
  });
  app.get("/api/events/:eventId/ballot", (context) => context.json(service.getBallot(context.get("sessionId"))));
  app.get("/api/events/:eventId/context", (context) => context.json({event:service.eventContext(context.get("session"))}));
  app.put("/api/events/:eventId/ballot", async (context) => { const body=await context.req.json<{expectedRevision:number;rankings:string[];operationId:string}>(); return context.json(service.replaceBallot(context.get("sessionId"),body.expectedRevision,body.rankings,body.operationId)); });
  app.post("/api/events/:eventId/proposals", async (context) => { const body=await context.req.json<{title:string;operationId:string}>(); return context.json(service.propose(context.get("sessionId"),body.title,body.operationId),201); });
  app.get("/api/events/:eventId/draft", (context) => {const session=context.get("session");if(!authorize({roles:[session.role],actorCommunityId:session.communityId,resourceCommunityId:session.communityId,capability:"event:moderate"}).allowed)throw new ChoiceError("denied");return context.json(service.draft(session.eventId));});
  const coordinationCommand=(sessionId:string,body:Record<string,unknown>)=>{const session=service.session(sessionId);if(typeof body.operationId!=="string"||typeof body.expectedRevision!=="number")throw new CoordinationError("invalid-request");return {communityId:session.communityId,eventId:session.eventId,actorId:session.participationId,roles:[session.role],operationId:body.operationId,expectedRevision:body.expectedRevision};};
  app.post("/api/events/:eventId/arrangements", async context => {
    const body=await context.req.json<Record<string,unknown>>();
    if(typeof body.operationId!=="string"||typeof body.expectedRevision!=="number"||typeof body.songId!=="string"||typeof body.key!=="string"||typeof body.notes!=="string"||!Array.isArray(body.parts)||!body.parts.every(part=>typeof part==="object"&&part!==null&&typeof (part as Record<string,unknown>).id==="string"&&typeof (part as Record<string,unknown>).name==="string"&&typeof (part as Record<string,unknown>).required==="boolean")||!new Set(["cleared","restricted","unknown"]).has(String(body.rightsState)))throw new CoordinationError("invalid-request");
    return context.json(coordination.createArrangement(coordinationCommand(context.get("sessionId"),body),{songId:body.songId,key:body.key,notes:body.notes,rightsState:body.rightsState as "cleared"|"restricted"|"unknown",parts:body.parts as {id:string;name:string;required:boolean}[]}),201);
  });
  app.post("/api/events/:eventId/assignments/volunteer",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.decisionId!=="string"||typeof body.partId!=="string"||typeof body.performerId!=="string"||!new Set(["interested","backup","committed"]).has(String(body.level)))throw new CoordinationError("invalid-request");return context.json(coordination.volunteer(coordinationCommand(context.get("sessionId"),body),{decisionId:body.decisionId,partId:body.partId,performerId:body.performerId,level:body.level as "interested"|"backup"|"committed"}),201);});
  app.post("/api/events/:eventId/rehearsal-polls",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.timeZone!=="string"||!Array.isArray(body.slots)||!Array.isArray(body.requiredPersonIds)||!body.requiredPersonIds.every(value=>typeof value==="string"))throw new CoordinationError("invalid-request");return context.json(coordination.createPoll(coordinationCommand(context.get("sessionId"),body),{timeZone:body.timeZone,slots:body.slots as {id:string;startsAt:string;endsAt:string}[],requiredPersonIds:body.requiredPersonIds as string[]}),201);});
  app.put("/api/events/:eventId/rehearsal-polls/:pollId/responses",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.personId!=="string"||typeof body.responses!=="object"||body.responses===null)throw new CoordinationError("invalid-request");return context.json(coordination.respondToPoll(coordinationCommand(context.get("sessionId"),body),{pollId:context.req.param("pollId"),personId:body.personId,responses:body.responses as Record<string,"available"|"if-needed"|"unavailable">}));});
  app.get("/api/events/:eventId/rehearsal-polls/:pollId/rankings",context=>context.json({rankings:coordination.rankPoll(coordinationCommand(context.get("sessionId"),{operationId:`rank:${context.req.param("pollId")}`,expectedRevision:0}),context.req.param("pollId"))}));
  app.post("/api/events/:eventId/rehearsal-polls/:pollId/close",async context=>{const body=await context.req.json<Record<string,unknown>>();return context.json(coordination.closePoll(coordinationCommand(context.get("sessionId"),body),context.req.param("pollId")));});
  app.post("/api/events/:eventId/rehearsal-polls/:pollId/reopen",async context=>{const body=await context.req.json<Record<string,unknown>>();return context.json(coordination.reopenPoll(coordinationCommand(context.get("sessionId"),body),context.req.param("pollId")));});
  app.post("/api/events/:eventId/rehearsals",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.pollId!=="string"||typeof body.slotId!=="string"||!Array.isArray(body.agenda)||!body.agenda.every(value=>typeof value==="string"))throw new CoordinationError("invalid-request");return context.json(coordination.publishSession(coordinationCommand(context.get("sessionId"),body),{pollId:body.pollId,slotId:body.slotId,agenda:body.agenda as string[]}),201);});
  app.post("/api/logout", (context) => { for(const name of Object.keys(getCookie(context)))if(name===SESSION_COOKIE||name.startsWith(`${SESSION_COOKIE}_`)||name.startsWith(`${RECOVERY_COOKIE}_`))deleteCookie(context,name,{path:"/"}); return context.body(null,204); });
  return app;
}
