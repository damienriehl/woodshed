CREATE TABLE live_event_revisions(event_id TEXT PRIMARY KEY REFERENCES events(id),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)) STRICT;
CREATE TABLE live_audit_events(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),operation_id TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),entry_id TEXT NOT NULL,occurred_at TEXT NOT NULL,UNIQUE(event_id,revision),UNIQUE(event_id,operation_id)) STRICT;
CREATE TRIGGER live_audit_events_immutable_update BEFORE UPDATE ON live_audit_events BEGIN SELECT RAISE(ABORT,'live-audit-immutable'); END;
CREATE TRIGGER live_audit_events_immutable_delete BEFORE DELETE ON live_audit_events BEGIN SELECT RAISE(ABORT,'live-audit-immutable'); END;
