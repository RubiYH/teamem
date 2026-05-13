BEGIN;

CREATE TABLE IF NOT EXISTS finding_acknowledgements (
  space_id          TEXT NOT NULL REFERENCES spaces(id),
  finding_id        TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK (version >= 1),
  principal         TEXT NOT NULL,
  acknowledged_at   TEXT NOT NULL,
  source_event_id   TEXT NOT NULL,
  note              TEXT,
  PRIMARY KEY (space_id, finding_id, version, principal)
);

CREATE INDEX IF NOT EXISTS idx_finding_acknowledgements_lookup
  ON finding_acknowledgements(space_id, principal, finding_id, version);

COMMIT;
