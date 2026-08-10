import { describe, expect, it } from "vitest";
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
