CREATE TABLE coordination_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE coordination_receipts (
  scope TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, operation_id)
) STRICT;

CREATE TABLE coordination_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (community_id, event_id, actor_id, operation_id)
) STRICT;
