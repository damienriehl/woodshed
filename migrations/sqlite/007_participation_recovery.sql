CREATE TABLE participation_recovery (
  token_hash TEXT PRIMARY KEY,
  participation_id TEXT NOT NULL UNIQUE REFERENCES guest_participations(id),
  community_id TEXT NOT NULL REFERENCES communities(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  role TEXT NOT NULL,
  assurance TEXT NOT NULL CHECK(assurance IN ('invite','open-public')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
