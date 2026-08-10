export type DiscoveredEvent = {
  id: string;
  name: string;
  state: string;
  visibility: "public" | "unlisted" | "private";
  participationPolicy: "open" | "invite";
};

export type BallotCandidate = { id: string; title: string };
export type Ballot = { method: "ranked-choice"; revision: number; candidates: BallotCandidate[] };
export type SavedBallot = { method: "ranked-choice"; revision: number; rankings: string[] };
export type Proposal = { id: string; title: string; state: "submitted" | "eligible" };

export type WoodshedApi = {
  discover(): Promise<{ events: DiscoveredEvent[] }>;
  eventContext(eventId: string): Promise<{ event: DiscoveredEvent }>;
  joinOpen(eventId: string): Promise<{ assurance: "open-public" }>;
  ballot(eventId: string): Promise<Ballot>;
  saveBallot(eventId: string, input: { expectedRevision: number; rankings: string[]; operationId: string }): Promise<SavedBallot>;
  propose(eventId: string, input: { title: string; operationId: string }): Promise<Proposal>;
  logout(): Promise<void>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

async function json<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new ApiError(response.status, body.error ?? "request-failed");
  return body;
}

const mutationHeaders = { "content-type": "application/json", "x-csrf-token": "same-origin" };

export function operationId(prefix: "ballot" | "proposal" | "join") {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${suffix}`;
}

export function createWoodshedApi(fetcher: typeof fetch = fetch, options: { timeoutMs?: number; signal?: AbortSignal } = {}): WoodshedApi {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const joinRetries = new Map<string, string>();
  const request = async (path: string, init?: RequestInit) => {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("request-timeout")), timeoutMs);
    const signals=[controller.signal,options.signal,init?.signal].filter((signal):signal is AbortSignal=>Boolean(signal));const signal=signals.length===1?signals[0]:AbortSignal.any(signals);
    try { return await fetcher(path, { credentials: "same-origin", ...init, signal }); } finally { clearTimeout(timeout); }
  };
  return {
    discover: () => json(request("/api/discovery")),
    eventContext: (eventId) => json(request(`/api/events/${encodeURIComponent(eventId)}/context`)),
    joinOpen: async (eventId) => { let retained=joinRetries.get(eventId);if(!retained){if(joinRetries.size>=32)joinRetries.delete(joinRetries.keys().next().value!);retained=operationId("join");joinRetries.set(eventId,retained);}try{const result=await json<{assurance:"open-public"}>(request(`/api/events/${encodeURIComponent(eventId)}/join-open`,{method:"POST",headers:mutationHeaders,body:JSON.stringify({operationId:retained})}));joinRetries.delete(eventId);return result;}catch(error){if(error instanceof ApiError)joinRetries.delete(eventId);throw error;} },
    ballot: (eventId) => json(request(`/api/events/${encodeURIComponent(eventId)}/ballot`)),
    saveBallot: (eventId, input) => json(request(`/api/events/${encodeURIComponent(eventId)}/ballot`, { method: "PUT", headers: mutationHeaders, body: JSON.stringify(input) })),
    propose: (eventId, input) => json(request(`/api/events/${encodeURIComponent(eventId)}/proposals`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(input) })),
    logout: async () => { await json(request("/api/logout", { method: "POST", headers: mutationHeaders, body: "{}" })); },
  };
}
