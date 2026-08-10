ALTER TABLE participation_recovery RENAME TO participation_recovery_single;
CREATE TABLE participation_recovery (token_hash TEXT PRIMARY KEY,participation_id TEXT NOT NULL REFERENCES guest_participations(id),community_id TEXT NOT NULL REFERENCES communities(id),event_id TEXT NOT NULL REFERENCES events(id),role TEXT NOT NULL,assurance TEXT NOT NULL CHECK(assurance IN ('invite','open-public')),expires_at TEXT NOT NULL,revoked_at TEXT) STRICT;
INSERT INTO participation_recovery SELECT * FROM participation_recovery_single;
DROP TABLE participation_recovery_single;
CREATE INDEX participation_recovery_participation ON participation_recovery(participation_id);
