import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { createApi as CreateApiType } from "../../api-node/src/app.ts";
const { createApi } = createRequire(`${process.cwd()}/package.json`)("../api-node/src/app.ts") as { createApi: typeof CreateApiType };
import type { ChoiceService as ChoiceServiceType } from "../../../packages/application/src/choice-service.ts";
const { ChoiceService } = createRequire(`${process.cwd()}/package.json`)("../../packages/application/src/choice-service.ts") as { ChoiceService: typeof ChoiceServiceType };
import { ApiError, createWoodshedApi } from "./api.ts";

describe("browser API client", () => {
  it("sends same-origin credentials and CSRF proof on mutations", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({ method: "ranked-choice", revision: 1, rankings: ["song_alpha"] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await createWoodshedApi(fetcher).saveBallot("event_public", { expectedRevision: 0, rankings: ["song_alpha"], operationId: "operation_web" });
    expect(requests[0]?.input).toBe("/api/events/event_public/ballot");
    expect(requests[0]?.init).toMatchObject({ method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": "same-origin" } });
  });

  it("preserves safe server error codes without leaking response text", async () => {
    const api = createWoodshedApi(async () => new Response(JSON.stringify({ error: "voting-closed", detail: "private detail" }), { status: 409 }));
    await expect(api.ballot("event_public")).rejects.toEqual(new ApiError(409, "voting-closed"));
  });

  it("rejects malformed successful JSON instead of inventing a successful result",async()=>{const api=createWoodshedApi(async()=>new Response("{",{status:200,headers:{"content-type":"application/json"}}));await expect(api.saveBallot("event_public",{expectedRevision:1,rankings:["song_alpha"],operationId:"operation_malformed"})).rejects.toThrow();});

  it("preserves HTTP status when an error response has no JSON body",async()=>{const api=createWoodshedApi(async()=>new Response(null,{status:401}));await expect(api.ballot("event_public")).rejects.toEqual(new ApiError(401,"request-failed"));});

  it("bounds requests and aborts a fetch that never settles", async () => {
    let signal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      signal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
    };
    await expect(createWoodshedApi(fetcher, { timeoutMs: 5 }).discover()).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });

  it("retains a join operation id across an ambiguous retry and sends CSRF proof on logout", async () => {
    const requests: RequestInit[] = [];
    let attempts = 0;
    const api = createWoodshedApi(async (_input, init) => {
      requests.push(init ?? {});
      attempts += 1;
      if (attempts === 1) throw new Error("response lost");
      return new Response(JSON.stringify({ assurance: "open-public" }), { status: 200 });
    });
    await expect(api.joinOpen("event_public")).rejects.toThrow("response lost");
    await api.joinOpen("event_public");
    expect(JSON.parse(String(requests[0]?.body)).operationId).toBe(JSON.parse(String(requests[1]?.body)).operationId);
    await api.logout();
    expect(requests[2]).toMatchObject({ method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "same-origin" } });
  });

  it("retains a join operation id across a 500 response", async () => {
    const operationIds:string[]=[];let attempts=0;const api=createWoodshedApi(async(_input,init)=>{operationIds.push(JSON.parse(String(init?.body)).operationId);attempts+=1;return attempts===1?new Response(JSON.stringify({error:"internal-error"}),{status:500}):new Response(JSON.stringify({assurance:"open-public"}),{status:200});});
    await expect(api.joinOpen("event_public")).rejects.toEqual(new ApiError(500,"internal-error"));await api.joinOpen("event_public");expect(operationIds[1]).toBe(operationIds[0]);
  });

  it("keeps the timeout active while the response body is stalled", async () => {
    const body=new ReadableStream({start(){}});const api=createWoodshedApi(async()=>new Response(body,{status:200,headers:{"content-type":"application/json"}}),{timeoutMs:5});
    await expect(api.discover()).rejects.toThrow("request-timeout");
  });

  it("cleans up the timeout after a completed response body",async()=>{
    let requestSignal:AbortSignal|undefined,abortEvents=0;const api=createWoodshedApi(async(_input,init)=>{requestSignal=init?.signal as AbortSignal;requestSignal.addEventListener("abort",()=>{abortEvents+=1});return new Response(JSON.stringify({events:[]}),{status:200,headers:{"content-type":"application/json"}});},{timeoutMs:5});
    await expect(api.discover()).resolves.toEqual({events:[]});await new Promise(resolve=>setTimeout(resolve,15));expect(requestSignal?.aborted).toBe(false);expect(abortEvents).toBe(0);
  });

  it("clears a retained join operation after a definitive HTTP failure", async () => {
    const operationIds:string[]=[];let attempts=0;const api=createWoodshedApi(async(_input,init)=>{operationIds.push(JSON.parse(String(init?.body)).operationId);attempts+=1;return attempts===1?new Response(JSON.stringify({error:"denied"}),{status:403}):new Response(JSON.stringify({assurance:"open-public"}),{status:200});});
    await expect(api.joinOpen("event_public")).rejects.toEqual(new ApiError(403,"denied"));await api.joinOpen("event_public");expect(operationIds[1]).not.toBe(operationIds[0]);
  });

  it("composes a caller abort signal with the request timeout", async () => {
    const caller=new AbortController();let received:AbortSignal|undefined;const api=createWoodshedApi(async(_input,init)=>{received=init?.signal as AbortSignal;return await new Promise<Response>((_resolve,reject)=>received?.addEventListener("abort",()=>reject(received?.reason),{once:true}));},{timeoutMs:10_000,signal:caller.signal});const request=api.discover();caller.abort(new Error("caller-cancelled"));await expect(request).rejects.toThrow("caller-cancelled");expect(received?.aborted).toBe(true);
  });

  it("bounds ambiguous join retries across arbitrary event ids", async () => {
    const operationIds:string[]=[];const api=createWoodshedApi(async(_input,init)=>{operationIds.push(JSON.parse(String(init?.body)).operationId);throw new Error("offline");});for(let index=0;index<33;index+=1)await expect(api.joinOpen(`event_${index}`)).rejects.toThrow("offline");await expect(api.joinOpen("event_0")).rejects.toThrow("offline");expect(operationIds[33]).not.toBe(operationIds[0]);
  });
});


describe("browser client through the real HTTP and SQLite stack", () => {
  function fixture() {
    const service = new ChoiceService(":memory:");
    service.migrate();
    service.seedDemo({ publicParticipationPolicy: "open" });
    const origin = "https://woodshed.example";
    const server = createApi(service, { origin });
    const cookies = new Map<string, string>();
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", origin);
      headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
      // jsdom AbortSignal is a separate realm from Node’s native Request.
      const response = await server.request(String(input), { ...init, headers, signal: undefined });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0]!;
        const split = pair.indexOf("=");
        const key = pair.slice(0, split);
        if (/Max-Age=0/i.test(cookie)) cookies.delete(key);
        else cookies.set(key, pair.slice(split + 1));
      }
      return response;
    };
    return { service, api: createWoodshedApi(fetcher), cookies };
  }

  it("discovers, joins, writes, reloads, and revokes an actual participant session", async () => {
    const { service, api, cookies } = fixture();
    try {
      expect((await api.discover()).events.map(event => event.id)).toEqual(["event_public"]);
      expect((await api.activeEvents()).events).toEqual([]);
      await expect(api.ballot("event_public")).rejects.toEqual(new ApiError(401, "unauthorized"));
      await expect(api.joinOpen("event_public")).resolves.toEqual({ assurance: "open-public" });
      expect((await api.eventContext("event_public")).event.id).toBe("event_public");
      expect((await api.activeEvents()).events.map(event => event.id)).toEqual(["event_public"]);
      const ballot = await api.ballot("event_public");
      const rankings = ballot.candidates.map(candidate => candidate.id).reverse();
      const saved = await api.saveBallot("event_public", { rankings, expectedRevision: ballot.revision, operationId: "ballot_browser_real" });
      expect(saved.revision).toBe(1);
      expect((await api.ballot("event_public")).candidates.map(candidate => candidate.id)).toEqual(rankings);
      const proposal = await api.propose("event_public", { title: "Real browser song", operationId: "proposal_browser_real" });
      expect(proposal.state).toBe("eligible");
      expect(service.database.prepare("SELECT title FROM choice_proposals WHERE id=?").get(proposal.id)).toMatchObject({ title: "Real browser song" });
      expect(cookies.size).toBe(2);
      await expect(api.logout()).resolves.toBeUndefined();
      expect(cookies.size).toBe(0);
      await expect(api.recover("event_public")).rejects.toEqual(new ApiError(401, "unauthorized"));
      await expect(api.ballot("event_public")).rejects.toEqual(new ApiError(401, "unauthorized"));
    } finally { service.close(); }
  });

  it("preserves real conflict errors and never overwrites a newer persisted ballot", async () => {
    const { service, api } = fixture();
    try {
      await api.joinOpen("event_public");
      const ballot = await api.ballot("event_public");
      const rankings = ballot.candidates.map(candidate => candidate.id);
      await api.saveBallot("event_public", { rankings, expectedRevision: 0, operationId: "ballot_first_write" });
      await expect(api.saveBallot("event_public", { rankings: [...rankings].reverse(), expectedRevision: 0, operationId: "ballot_stale_write" })).rejects.toEqual(new ApiError(409, "conflict"));
      expect(await api.ballot("event_public")).toMatchObject({ revision: 1, candidates: ballot.candidates });
      service.database.prepare("UPDATE events SET state='completed' WHERE id='event_public'").run();
      await expect(api.ballot("event_public")).rejects.toEqual(new ApiError(409, "voting-closed"));
    } finally { service.close(); }
  });

  it("recovers an expired session through its durable recovery cookie without duplicating identity", async () => {
    const { service, api } = fixture();
    try {
      await api.joinOpen("event_public");
      await api.ballot("event_public");
      service.database.prepare("UPDATE participant_sessions SET expires_at='2000-01-01T00:00:00Z'").run();
      await expect(api.ballot("event_public")).rejects.toEqual(new ApiError(401, "unauthorized"));
      await expect(api.recover("event_public")).resolves.toEqual({ assurance: "open-public" });
      expect((await api.ballot("event_public")).revision).toBe(0);
      expect(service.database.prepare("SELECT count(*) AS count FROM guest_participations").get()).toMatchObject({ count: 1 });
    } finally { service.close(); }
  });

  it("keeps a completed discovery empty when no published public event exists", async () => {
    const { service, api } = fixture();
    try {
      service.database.prepare("UPDATE events SET visibility='private'").run();
      await expect(api.discover()).resolves.toEqual({ events: [] });
      await expect(api.activeEvents()).resolves.toEqual({ events: [] });
    } finally { service.close(); }
  });

});


describe("browser client transport edge cases", () => {
  it("encodes event identifiers as one path segment for every event operation", async () => {
    const paths: string[] = [];
    const api = createWoodshedApi(async input => { paths.push(String(input)); return new Response("{}", { status: 200 }); });
    const eventId = "event/slash ?#%";
    await api.eventContext(eventId);
    await api.joinOpen(eventId);
    await api.recover(eventId);
    await api.ballot(eventId);
    await api.saveBallot(eventId, { rankings: [], expectedRevision: 0, operationId: "ballot_path" });
    await api.propose(eventId, { title: "Song", operationId: "proposal_path" });
    expect(paths).toEqual(["context", "join-open", "recover", "ballot", "ballot", "proposals"].map(suffix => `/api/events/event%2Fslash%20%3F%23%25/${suffix}`));
  });

  it("allocates a fresh join operation after success", async () => {
    const operations: string[] = [];
    const api = createWoodshedApi(async (_input, init) => { operations.push(JSON.parse(String(init?.body)).operationId); return new Response(JSON.stringify({ assurance: "open-public" }), { status: 200 }); });
    await api.joinOpen("event_public");
    await api.joinOpen("event_public");
    expect(operations[0]).not.toBe(operations[1]);
  });

  it("preserves a caller cancellation that happens while decoding a stalled body", async () => {
    const caller = new AbortController();
    const api = createWoodshedApi(async () => new Response(new ReadableStream({ start() {} })), { signal: caller.signal });
    const result = api.discover();
    caller.abort(new Error("navigation-cancelled"));
    await expect(result).rejects.toThrow("navigation-cancelled");
  });
});
