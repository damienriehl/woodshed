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

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export async function webSha256(value: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }

export class D1ChoiceRuntime {
  private readonly database:D1Database;
  private readonly now:()=>Date;
  constructor(database: D1Database, now: () => Date = () => new Date()) {this.database=database;this.now=now;}

  async discoverEvents() {
    const rows = await this.database.prepare("SELECT id,name,state,visibility,participation_policy AS participationPolicy FROM events WHERE visibility='public' AND state <> 'draft' ORDER BY name").all();
    return rows.results;
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
    const current = await this.database.prepare("SELECT current_revision FROM ballots WHERE community_id=? AND event_id=? AND participation_id=?").bind(session.communityId, session.eventId, session.participationId).first<{ current_revision: number }>();
    return { method: "ranked-choice" as const, revision: Number(current?.current_revision ?? 0), candidates: scored.map(({ id, title }) => ({ id, title })) };
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
    return new D1Kernel(this.database, []).replaceBallot(envelope, body.rankings as string[], now);
  }

  private async assertVotingOpen(session:RuntimeSession){const event=await this.database.prepare("SELECT state FROM events WHERE id=? AND community_id=?").bind(session.eventId,session.communityId).first<{state:string}>();if(!event)throw new RuntimeError("denied");if(!["voting","live"].includes(event.state))throw new RuntimeError("voting-closed");}
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeError("invalid-command");
  return value as Record<string, unknown>;
}
