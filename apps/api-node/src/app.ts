import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { ChoiceError, ChoiceService } from "../../../packages/application/src/choice-service.ts";

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

export function createApi(service: ChoiceService, options: { origin: string }) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (context, next) => {
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (context.req.path.startsWith("/api/")) context.header("Cache-Control", "private, no-store");
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof ChoiceError) {
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
  app.post("/api/logout", (context) => { deleteCookie(context,SESSION_COOKIE,{path:"/"}); return context.body(null,204); });
  return app;
}
