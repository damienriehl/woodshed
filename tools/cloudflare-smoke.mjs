import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { parseConfigFileTextToJson } from "typescript";
import { D1_MIGRATIONS, verifyMigrationDirectory } from "./cloudflare/migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "woodshed-cloudflare-smoke-"));
const cleanupOnExit = () => rmSync(temporary, { recursive: true, force: true });
process.once("exit", cleanupOnExit);
const bundle = path.join(temporary, "worker.mjs");
const wranglerPath = path.join(root, "deploy/cloudflare/wrangler.jsonc");
const origin = "https://smoke.woodshed.invalid";
const clock = "2030-01-01T12:01:00.000Z";
const organizerToken = "synthetic-organizer-session";

let miniflare;
try {
  const wranglerResult = parseConfigFileTextToJson(wranglerPath, await readFile(wranglerPath, "utf8"));
  assert.equal(wranglerResult.error, undefined, "Wrangler configuration must be valid JSONC");
  const wrangler = wranglerResult.config;
  const databaseBinding = wrangler.d1_databases?.[0];
  const durableObjectBinding = wrangler.durable_objects?.bindings?.[0];
  assert.equal(databaseBinding?.binding, "DB");
  assert.equal(durableObjectBinding?.name, "LIVE_COORDINATOR");
  assert.equal(durableObjectBinding?.class_name, "LiveCoordinator");
  assert.equal(databaseBinding?.migrations_dir, "../../migrations/d1");
  assert.ok(wrangler.migrations?.some((migration) => migration.new_sqlite_classes?.includes(durableObjectBinding.class_name)), "Wrangler must declare the configured Durable Object class in a SQLite migration");
  assert.equal(typeof wrangler.main, "string");
  assert.equal(typeof wrangler.compatibility_date, "string");
  assert.ok(Array.isArray(wrangler.compatibility_flags));

  await build({
    entryPoints: [path.resolve(path.dirname(wranglerPath), wrangler.main)],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*"],
    sourcemap: false,
    logLevel: "silent",
  });

  miniflare = new Miniflare({
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
    modules: true,
    scriptPath: bundle,
    modulesRoot: temporary,
    d1Databases: { [databaseBinding.binding]: "woodshed-smoke" },
    durableObjects: { [durableObjectBinding.name]: { className: durableObjectBinding.class_name, useSQLite: true } },
    bindings: {
      APP_ORIGIN: origin,
      CLOCK_ISO: clock,
      LIVE_COMMAND_SECRET: "synthetic-live-command-secret-32-bytes-minimum",
    },
  });

  const database = await miniflare.getD1Database("DB");
  const migrationsDirectory = path.join(root, "migrations/d1");
  await verifyMigrationDirectory(migrationsDirectory);
  const migrations = D1_MIGRATIONS.map(({ filename }) => filename);
  for (const migration of migrations) {
    const sql = (await readFile(path.join(migrationsDirectory, migration), "utf8")).replace(/\s*\r?\n\s*/g, " ");
    await database.exec(sql);
  }

  await database.batch([
    database.prepare("INSERT INTO communities(id,name) VALUES (?,?)").bind("community_smoke", "Synthetic Smoke Community"),
    database.prepare("INSERT INTO events(id,community_id,name,state,visibility,participation_policy) VALUES (?,?,?,'live','public','open')").bind("event_smoke", "community_smoke", "Synthetic Smoke Event"),
    database.prepare("INSERT INTO canonical_songs(id,community_id,title) VALUES (?,?,?),(?,?,?)").bind("song_one", "community_smoke", "Synthetic First Song", "song_two", "community_smoke", "Synthetic Second Song"),
    database.prepare("INSERT INTO event_eligible_songs(event_id,song_id,added_at) VALUES (?,?,?),(?,?,?)").bind("event_smoke", "song_one", clock, "event_smoke", "song_two", clock),
    database.prepare("INSERT INTO guest_participations(id,community_id,event_id) VALUES (?,?,?)").bind("participation_organizer", "community_smoke", "event_smoke"),
    database.prepare("INSERT INTO participant_sessions(id_hash,participation_id,community_id,event_id,role,assurance,expires_at) VALUES (?,?,?,?,?,'invite',?)").bind(createHash("sha256").update(organizerToken).digest("hex"), "participation_organizer", "community_smoke", "event_smoke", "community-admin", "2031-01-01T00:00:00.000Z"),
  ]);

  assert.equal((await database.prepare("SELECT proposal_policy FROM event_choice_config WHERE event_id=?").bind("event_smoke").first())?.proposal_policy, "immediate");
  const activePlan = await database.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM guest_participations WHERE event_id=? AND revoked_at IS NULL").bind("event_smoke").all();
  assert.match(activePlan.results.map((row) => row.detail).join("\n"), /guest_participations_active_event_idx/);

  const mutationHeaders = { origin, "x-csrf-token": "same-origin", "content-type": "application/json" };
  const joined = await fetchWorker("/api/events/event_smoke/join-open", { method: "POST", headers: mutationHeaders, body: JSON.stringify({ operationId: "smoke_join" }) });
  assert.equal(joined.status, 200);
  const cookie = joined.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  assert.equal((await fetchWorker("/api/events/event_smoke/context", { headers: { cookie } })).status, 200);
  const ballot = await (await fetchWorker("/api/events/event_smoke/ballot", { headers: { cookie } })).json();
  assert.equal(ballot.revision, 0);
  const rankings = ballot.candidates.map(({ id }) => id).reverse();
  const saved = await fetchWorker("/api/events/event_smoke/ballot", { method: "PUT", headers: { ...mutationHeaders, cookie }, body: JSON.stringify({ expectedRevision: 0, rankings, operationId: "smoke_ballot" }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  const persistedBallot = await (await fetchWorker("/api/events/event_smoke/ballot", { headers: { cookie } })).json();
  assert.equal(persistedBallot.revision, 1);
  assert.deepEqual(persistedBallot.candidates.map(({ id }) => id), rankings);

  const proposal = await fetchWorker("/api/events/event_smoke/proposals", { method: "POST", headers: { ...mutationHeaders, cookie }, body: JSON.stringify({ title: "Synthetic Proposed Song", operationId: "smoke_proposal" }) });
  assert.equal(proposal.status, 201);
  assert.equal((await proposal.json()).state, "eligible");

  const authority = await fetchWorker("/api/events/event_smoke/live/authority/acquire", { method: "POST", headers: { ...mutationHeaders, authorization: `Bearer ${organizerToken}` }, body: JSON.stringify({ deviceInstallationId: "device_smoke" }) });
  assert.equal(authority.status, 200);
  const authorityBody = await authority.json();
  assert.equal(authorityBody.epoch, 1);
  assert.equal(typeof authorityBody.commandCredential, "string");

  const logout = await fetchWorker("/api/logout", { method: "POST", headers: { ...mutationHeaders, cookie } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);

  process.stdout.write(`Cloudflare smoke passed: ${migrations.length} migrations, bundled Worker, D1, Durable Object, participant loop.\n`);

  async function fetchWorker(pathname, init) {
    return miniflare.dispatchFetch(`${origin}${pathname}`, init);
  }
} finally {
  try {
    await miniflare?.dispose();
  } finally {
    process.removeListener("exit", cleanupOnExit);
    await rm(temporary, { recursive: true, force: true });
  }
}
