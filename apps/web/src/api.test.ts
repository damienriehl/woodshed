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
});
