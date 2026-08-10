import type { D1Database } from "@cloudflare/workers-types";

import { D1Kernel } from "./index.ts";

export class RuntimeError extends Error {
  readonly code:string;
  constructor(code: string, message = code) { super(message);this.code=code; }
}

export type RuntimeSession = {
  participationId: string;
  communityId: string;
  eventId: string;
  role: string;
};

export type IssuedRuntimeSession = RuntimeSession & {
  token: string;
  assurance: "open-public";
};

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export async function webSha256(value: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }

export class D1ChoiceRuntime {
  private readonly database:D1Database;
  private readonly now:()=>Date;
  private readonly beforeBallotMutation:()=>Promise<void>;
  constructor(database: D1Database, now: () => Date = () => new Date(), beforeBallotMutation:()=>Promise<void>=async()=>{}) {this.database=database;this.now=now;this.beforeBallotMutation=beforeBallotMutation;}

  async discoverEvents() {
    const rows = await this.database.prepare("SELECT id,name,state,visibility,participation_policy AS participationPolicy FROM events WHERE visibility='public' AND state <> 'draft' ORDER BY name").all();
    return rows.results;
  }

  async eventContext(session: RuntimeSession) {
    const event = await this.database.prepare("SELECT id,name,state,visibility,participation_policy AS participationPolicy FROM events WHERE id=? AND community_id=?").bind(session.eventId, session.communityId).first();
    if (!event) throw new RuntimeError("not-found");
    return event;
  }

  async joinOpen(eventId: string, operationId: string, replayToken?: string): Promise<IssuedRuntimeSession> {
    if (!operationId) throw new RuntimeError("invalid-request");
    const event = await this.database.prepare("SELECT community_id,participation_policy,state,visibility FROM events WHERE id=?").bind(eventId).first<{ community_id: string; participation_policy: string; state: string; visibility: string }>();
    if (!event) throw new RuntimeError("not-found");
    if (event.visibility !== "public" || event.participation_policy !== "open" || event.state === "draft") throw new RuntimeError("denied");
    const receipt = await this.database.prepare("SELECT participation_id FROM open_join_receipts WHERE event_id=? AND operation_id=?").bind(eventId, operationId).first<{ participation_id: string }>();
    if (receipt) {
      if (!replayToken) throw new RuntimeError("replay-session-required");
      try {
        const replay = await this.session(replayToken);
        if (replay.eventId !== eventId || replay.participationId !== receipt.participation_id) throw new RuntimeError("replay-session-required");
        return { ...replay, token: replayToken, assurance: "open-public" };
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        if (error.code === "replay-session-required") throw error;
        throw new RuntimeError("replay-session-required");
      }
    }
    const active = await this.database.prepare("SELECT count(*) AS count FROM guest_participations WHERE event_id=? AND revoked_at IS NULL").bind(eventId).first<{ count: number }>();
    if (Number(active?.count ?? 0) >= 10_000) throw new RuntimeError("open-participation-capacity");
    const participationId = `participation_${randomHex(12)}`;
    const rawToken = randomHex(32);
    const now = this.now();
    try {
      await this.database.batch([
        this.database.prepare("INSERT INTO guest_participations(id,community_id,event_id) SELECT ?,?,? WHERE (SELECT count(*) FROM guest_participations WHERE event_id=? AND revoked_at IS NULL) < 10000").bind(participationId, event.community_id, eventId, eventId),
        this.database.prepare("INSERT INTO participant_sessions(id_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (?,?,?,?,?,'open-public',?)").bind(await webSha256(rawToken), participationId, event.community_id, eventId, "participant", new Date(now.getTime() + 86_400_000).toISOString()),
        this.database.prepare("INSERT INTO open_join_receipts(event_id,operation_id,participation_id,created_at) VALUES (?,?,?,?)").bind(eventId, operationId, participationId, now.toISOString()),
      ]);
    } catch (error) {
      const concurrent = await this.database.prepare("SELECT participation_id FROM open_join_receipts WHERE event_id=? AND operation_id=?").bind(eventId, operationId).first();
      if (concurrent) throw new RuntimeError("replay-session-required");
      const atCapacity = await this.database.prepare("SELECT count(*) AS count FROM guest_participations WHERE event_id=? AND revoked_at IS NULL").bind(eventId).first<{ count: number }>();
      if (Number(atCapacity?.count ?? 0) >= 10_000) throw new RuntimeError("open-participation-capacity");
      throw error;
    }
    return { participationId, communityId: event.community_id, eventId, role: "participant", token: rawToken, assurance: "open-public" };
  }

  async session(token: string): Promise<RuntimeSession> {
    const row = await this.database.prepare("SELECT s.participation_id,s.community_id,s.event_id,s.role,s.expires_at,s.revoked_at AS session_revoked_at,p.revoked_at AS participation_revoked_at FROM participant_sessions s JOIN guest_participations p ON p.id=s.participation_id AND p.community_id=s.community_id AND p.event_id=s.event_id JOIN events e ON e.id=s.event_id AND e.community_id=s.community_id WHERE s.id_hash=?").bind(await webSha256(token)).first<Record<string, string | null>>();
    const expiresAt = Date.parse(String(row?.expires_at));
    if (!row || row.session_revoked_at || row.participation_revoked_at || !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) throw new RuntimeError("unauthorized");
    return { participationId: String(row.participation_id), communityId: String(row.community_id), eventId: String(row.event_id), role: String(row.role) };
  }

  async assertEvent(session: RuntimeSession, eventId: string) {
    if (session.eventId !== eventId) throw new RuntimeError("denied");
    const event = await this.database.prepare("SELECT community_id FROM events WHERE id=?").bind(eventId).first<{ community_id: string }>();
    if (!event || event.community_id !== session.communityId) throw new RuntimeError("denied");
  }

  async ballot(session: RuntimeSession) {
    await this.assertVotingOpen(session);
    const songs = await this.database.prepare("SELECT s.id,s.title FROM canonical_songs s JOIN event_eligible_songs e ON e.song_id=s.id WHERE e.event_id=? AND s.community_id=? ORDER BY s.id").bind(session.eventId, session.communityId).all<{ id: string; title: string }>();
    const scored = await Promise.all(songs.results.map(async (song) => ({ ...song, score: await webSha256(`${session.participationId}\0${song.id}`) })));
    scored.sort((a, b) => a.score.localeCompare(b.score) || a.id.localeCompare(b.id));
    const current = await this.database.prepare("SELECT id,current_revision FROM ballots WHERE community_id=? AND event_id=? AND participation_id=?").bind(session.communityId, session.eventId, session.participationId).first<{ id: string; current_revision: number }>();
    const revision = Number(current?.current_revision ?? 0);
    let ordered = scored;
    if (current && revision > 0) {
      const version = await this.database.prepare("SELECT rankings_json FROM ballot_versions WHERE ballot_id=? AND revision=?").bind(current.id, revision).first<{ rankings_json: string }>();
      const persisted = version ? JSON.parse(version.rankings_json) as unknown : [];
      const savedIds = Array.isArray(persisted) ? persisted.filter((id): id is string => typeof id === "string") : [];
      const byId = new Map(scored.map(song => [song.id, song]));
      const retained = savedIds.flatMap(id => { const song=byId.get(id);if(!song)return [];byId.delete(id);return [song]; });
      ordered = [...retained, ...scored.filter(song => byId.has(song.id))];
    }
    return { method: "ranked-choice" as const, revision, candidates: ordered.map(({ id, title }) => ({ id, title })) };
  }

  async replaceBallot(session: RuntimeSession, value: unknown) {
    await this.assertVotingOpen(session);
    const body = record(value);
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 || !Array.isArray(body.rankings) || !body.rankings.every((item) => typeof item === "string") || typeof body.operationId !== "string" || body.operationId.length === 0) throw new RuntimeError("invalid-command");
    const state = await this.database.prepare("SELECT state FROM ballots WHERE community_id=? AND event_id=? AND participation_id=?").bind(session.communityId, session.eventId, session.participationId).first<{ state: string }>();
    if (state && !["open", "reopened"].includes(state.state)) throw new RuntimeError("voting-closed");
    const now = this.now();
    const envelope = {
      schemaVersion: 1, aggregateType: "ballot", aggregateId: `${session.participationId}:${session.eventId}`, scope: "event",
      communityId: session.communityId, eventId: session.eventId, actorId: session.participationId, capability: "ballot:replace",
      operationId: body.operationId, expectedRevision: body.expectedRevision, issuedAt: new Date(now.getTime() - 1_000).toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    };
    await this.beforeBallotMutation();
    return new D1Kernel(this.database, []).replaceBallot(envelope, body.rankings as string[], now);
  }

  private async assertVotingOpen(session:RuntimeSession){const event=await this.database.prepare("SELECT state FROM events WHERE id=? AND community_id=?").bind(session.eventId,session.communityId).first<{state:string}>();if(!event)throw new RuntimeError("denied");if(!["voting","live"].includes(event.state))throw new RuntimeError("voting-closed");}

  async propose(session: RuntimeSession, value: unknown) {
    const body = record(value);
    if (typeof body.title !== "string" || body.title.trim().length === 0 || typeof body.operationId !== "string" || body.operationId.length === 0) throw new RuntimeError("invalid-command");
    const title = body.title.trim();
    const requestHash = await webSha256(JSON.stringify({ title }));
    const receipt = await this.database.prepare("SELECT request_hash,result_json FROM proposal_receipts WHERE participation_id=? AND operation_id=?").bind(session.participationId, body.operationId).first<{ request_hash: string; result_json: string }>();
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new RuntimeError("replay-mismatch");
      return JSON.parse(receipt.result_json);
    }
    const count = await this.database.prepare("SELECT count(*) AS count FROM choice_proposals WHERE event_id=? AND participation_id=?").bind(session.eventId, session.participationId).first<{ count: number }>();
    if (Number(count?.count ?? 0) >= 3) throw new RuntimeError("quota-exceeded");
    const config = await this.database.prepare("SELECT proposal_policy FROM event_choice_config WHERE event_id=?").bind(session.eventId).first<{ proposal_policy: string }>();
    if (!config) throw new RuntimeError("not-found");
    const result = { id: `proposal_${(await webSha256(`${session.participationId}:${body.operationId}`)).slice(0, 24)}`, title, state: config.proposal_policy === "immediate" ? "eligible" : "submitted" };
    try {
      await this.database.batch([
        this.database.prepare("INSERT INTO choice_proposals(id,event_id,participation_id,title,state,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM choice_proposals WHERE event_id=? AND participation_id=?) < 3").bind(result.id, session.eventId, session.participationId, title, result.state, this.now().toISOString(), session.eventId, session.participationId),
        this.database.prepare("INSERT INTO proposal_receipts(participation_id,operation_id,request_hash,result_json) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM choice_proposals WHERE id=? AND event_id=? AND participation_id=?)").bind(session.participationId, body.operationId, requestHash, JSON.stringify(result), result.id, session.eventId, session.participationId),
      ]);
      const persisted = await this.database.prepare("SELECT 1 AS value FROM proposal_receipts WHERE participation_id=? AND operation_id=?").bind(session.participationId, body.operationId).first();
      if (!persisted) throw new RuntimeError("quota-exceeded");
    } catch (error) {
      const concurrent = await this.database.prepare("SELECT request_hash,result_json FROM proposal_receipts WHERE participation_id=? AND operation_id=?").bind(session.participationId, body.operationId).first<{ request_hash: string; result_json: string }>();
      if (concurrent) {
        if (concurrent.request_hash !== requestHash) throw new RuntimeError("replay-mismatch");
        return JSON.parse(concurrent.result_json);
      }
      throw error;
    }
    return result;
  }
}

function randomHex(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return hex(bytes.buffer as ArrayBuffer);
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeError("invalid-command");
  return value as Record<string, unknown>;
}
