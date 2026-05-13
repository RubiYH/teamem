CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  principal TEXT NOT NULL,
  actor TEXT NOT NULL,
  delegation TEXT NOT NULL,
  event_type TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refs_json TEXT,
  confidence REAL,
  schema_version TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_repo_timestamp ON events(repo_id, timestamp);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(event_id)
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  actor TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  intent TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  released_at TEXT
);

CREATE TABLE IF NOT EXISTS contracts (
  contract_key TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_event_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  updated_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blockers (
  blocker_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_principal TEXT,
  summary TEXT,
  updated_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursors (
  actor TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor, repo_id)
);
