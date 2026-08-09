CREATE TABLE event_song_decision_versions (
  id TEXT NOT NULL,
  community_id TEXT NOT NULL REFERENCES communities(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  song_id TEXT NOT NULL REFERENCES canonical_songs(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(id, revision)
) STRICT;
CREATE TABLE performance_assignments (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  decision_id TEXT NOT NULL,
  decision_revision INTEGER NOT NULL,
  part_id TEXT NOT NULL,
  performer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('volunteered','offered','accepted','assigned','declined','withdrawn','substituted')),
  readiness TEXT NOT NULL CHECK(readiness IN ('interested','learning','rehearsal-ready','performance-ready')),
  revision INTEGER NOT NULL,
  FOREIGN KEY(decision_id,decision_revision) REFERENCES event_song_decision_versions(id,revision)
) STRICT;
CREATE TABLE rehearsal_polls (id TEXT PRIMARY KEY,community_id TEXT NOT NULL REFERENCES communities(id),event_id TEXT NOT NULL REFERENCES events(id),revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','closed')),time_zone TEXT NOT NULL,slots_json TEXT NOT NULL CHECK(json_valid(slots_json))) STRICT;
CREATE TABLE provider_connections (id TEXT PRIMARY KEY,community_id TEXT NOT NULL REFERENCES communities(id),kind TEXT NOT NULL,scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),retention TEXT NOT NULL,revision INTEGER NOT NULL,revoked_at TEXT) STRICT;
CREATE TABLE provider_delivery_records (id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES provider_connections(id),request_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','sent','revoked')),attempts INTEGER NOT NULL) STRICT;
CREATE TRIGGER event_song_decision_versions_immutable_update BEFORE UPDATE ON event_song_decision_versions BEGIN SELECT RAISE(ABORT,'decision-version-immutable'); END;
CREATE TRIGGER event_song_decision_versions_immutable_delete BEFORE DELETE ON event_song_decision_versions BEGIN SELECT RAISE(ABORT,'decision-version-immutable'); END;
