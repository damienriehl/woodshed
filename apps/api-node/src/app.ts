import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { ChoiceError, ChoiceService } from "../../../packages/application/src/choice-service.ts";
import { CoordinationError, CoordinationService } from "../../../packages/application/src/coordination-service.ts";

type Variables = { sessionId: string };
const SESSION_COOKIE = "woodshed_session";
const SESSION_COOKIE_OPTIONS = { httpOnly: true, sameSite: "Lax", secure: true, path: "/", maxAge: 86_400 } as const;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ERROR_STATUS = {
  unauthorized: 401,
  denied: 403,
  "not-found": 404,
  conflict: 409,
} as const;

export function createApi(service: ChoiceService, options: { origin: string; coordination?: CoordinationService }) {
  const app = new Hono<{ Variables: Variables }>();
  const coordination=options.coordination??new CoordinationService();
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
  app.get("/api/discovery", (context) => context.json({ events: service.discoverEvents() }));
  app.get("/api/session/exchange", (context) => {
    const capability = context.req.query("capability"); if (!capability) throw new ChoiceError("invalid-capability");
    const session = service.exchangeInvite(capability);
    setCookie(context, SESSION_COOKIE, session.id, SESSION_COOKIE_OPTIONS);
    return context.redirect(`/events/${session.eventId}`, 303);
  });
  app.post("/api/events/:eventId/join-open", (context) => {
    const entry = service.eventEntry(context.req.param("eventId"), null); if (entry.outcome !== "eligible-open") throw new ChoiceError("denied");
    const session = service.openPublicSession(context.req.param("eventId")); setCookie(context,SESSION_COOKIE,session.id,SESSION_COOKIE_OPTIONS); return context.json({assurance:session.assurance});
  });
  app.use("/api/events/:eventId/*", async (context, next) => {
    const sessionId=getCookie(context,SESSION_COOKIE);if(!sessionId)throw new ChoiceError("unauthorized");service.assertEvent(sessionId,context.req.param("eventId"));context.set("sessionId",sessionId);
    if (!SAFE_METHODS.has(context.req.method)) {
      if(context.req.header("origin")!==options.origin||context.req.header("x-csrf-token")!=="same-origin")throw new ChoiceError("denied");
    }
    await next();
  });
  app.get("/api/events/:eventId/ballot", (context) => context.json(service.getBallot(context.get("sessionId"))));
  app.put("/api/events/:eventId/ballot", async (context) => { const body=await context.req.json<{expectedRevision:number;rankings:string[];operationId:string}>(); return context.json(service.replaceBallot(context.get("sessionId"),body.expectedRevision,body.rankings,body.operationId)); });
  app.post("/api/events/:eventId/proposals", async (context) => { const body=await context.req.json<{title:string;operationId:string}>(); return context.json(service.propose(context.get("sessionId"),body.title,body.operationId),201); });
  app.get("/api/events/:eventId/draft", (context) => context.json(service.draft(context.req.param("eventId"))));
  const coordinationCommand=(sessionId:string,body:Record<string,unknown>)=>{const session=service.session(sessionId);if(typeof body.operationId!=="string"||typeof body.expectedRevision!=="number")throw new CoordinationError("invalid-request");return {communityId:session.communityId,eventId:session.eventId,actorId:session.participationId,roles:[session.role],operationId:body.operationId,expectedRevision:body.expectedRevision};};
  app.post("/api/events/:eventId/arrangements", async context => {
    const body=await context.req.json<Record<string,unknown>>();
    if(typeof body.operationId!=="string"||typeof body.expectedRevision!=="number"||typeof body.songId!=="string"||typeof body.key!=="string"||typeof body.notes!=="string"||!Array.isArray(body.parts)||!body.parts.every(part=>typeof part==="object"&&part!==null&&typeof (part as Record<string,unknown>).id==="string"&&typeof (part as Record<string,unknown>).name==="string"&&typeof (part as Record<string,unknown>).required==="boolean")||!new Set(["cleared","restricted","unknown"]).has(String(body.rightsState)))throw new CoordinationError("invalid-request");
    return context.json(coordination.createArrangement(coordinationCommand(context.get("sessionId"),body),{songId:body.songId,key:body.key,notes:body.notes,rightsState:body.rightsState as "cleared"|"restricted"|"unknown",parts:body.parts as {id:string;name:string;required:boolean}[]}),201);
  });
  app.post("/api/events/:eventId/assignments/volunteer",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.decisionId!=="string"||typeof body.partId!=="string"||typeof body.performerId!=="string"||!new Set(["interested","backup","committed"]).has(String(body.level)))throw new CoordinationError("invalid-request");return context.json(coordination.volunteer(coordinationCommand(context.get("sessionId"),body),{decisionId:body.decisionId,partId:body.partId,performerId:body.performerId,level:body.level as "interested"|"backup"|"committed"}),201);});
  app.post("/api/events/:eventId/rehearsal-polls",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.timeZone!=="string"||!Array.isArray(body.slots)||!Array.isArray(body.requiredPersonIds)||!body.requiredPersonIds.every(value=>typeof value==="string"))throw new CoordinationError("invalid-request");return context.json(coordination.createPoll(coordinationCommand(context.get("sessionId"),body),{timeZone:body.timeZone,slots:body.slots as {id:string;startsAt:string;endsAt:string}[],requiredPersonIds:body.requiredPersonIds as string[]}),201);});
  app.put("/api/events/:eventId/rehearsal-polls/:pollId/responses",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.personId!=="string"||typeof body.responses!=="object"||body.responses===null)throw new CoordinationError("invalid-request");return context.json(coordination.respondToPoll(coordinationCommand(context.get("sessionId"),body),{pollId:context.req.param("pollId"),personId:body.personId,responses:body.responses as Record<string,"available"|"if-needed"|"unavailable">}));});
  app.get("/api/events/:eventId/rehearsal-polls/:pollId/rankings",context=>context.json({rankings:coordination.rankPoll(context.req.param("pollId"))}));
  app.post("/api/events/:eventId/rehearsal-polls/:pollId/close",async context=>{const body=await context.req.json<Record<string,unknown>>();return context.json(coordination.closePoll(coordinationCommand(context.get("sessionId"),body),context.req.param("pollId")));});
  app.post("/api/events/:eventId/rehearsal-polls/:pollId/reopen",async context=>{const body=await context.req.json<Record<string,unknown>>();return context.json(coordination.reopenPoll(coordinationCommand(context.get("sessionId"),body),context.req.param("pollId")));});
  app.post("/api/events/:eventId/rehearsals",async context=>{const body=await context.req.json<Record<string,unknown>>();if(typeof body.pollId!=="string"||typeof body.slotId!=="string"||!Array.isArray(body.agenda)||!body.agenda.every(value=>typeof value==="string"))throw new CoordinationError("invalid-request");return context.json(coordination.publishSession(coordinationCommand(context.get("sessionId"),body),{pollId:body.pollId,slotId:body.slotId,agenda:body.agenda as string[]}),201);});
  app.post("/api/logout", (context) => { deleteCookie(context,SESSION_COOKIE,{path:"/"}); return context.body(null,204); });
  return app;
}
