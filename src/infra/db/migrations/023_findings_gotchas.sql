-- Migration 023: persistent gotchas on the findings substrate (Space Memory v1 issue 04).
--
-- Upgrades findings from TTL-only notes into a mixed substrate:
--   - classic findings remain TTL-backed (`lifecycle='ttl'`, expires_at set)
--   - gotchas are durable (`kind='gotcha'`, `lifecycle='persistent'`, expires_at NULL)
--
-- SQLite cannot relax a NOT NULL constraint in place, so we rebuild the table
-- with nullable `expires_at` plus explicit metadata needed by the PRD:
-- kind, lifecycle, status, version identity, and structured path storage.

CREATE TABLE IF NOT EXISTS findings_v2 (
  finding_id        TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL,
  principal         TEXT NOT NULL,
  summary           TEXT NOT NULL,
  body              TEXT,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  severity          TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'urgent')),
  paths_json        TEXT NOT NULL DEFAULT '[]',
  refs_json         TEXT,
  recipient_principals_json TEXT NOT NULL DEFAULT '[]',
  kind              TEXT NOT NULL DEFAULT 'finding' CHECK (kind IN ('finding', 'gotcha')),
  lifecycle         TEXT NOT NULL DEFAULT 'ttl' CHECK (lifecycle IN ('ttl', 'persistent')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'archived')),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        TEXT NOT NULL,
  expires_at        TEXT,
  source_event_id   TEXT NOT NULL,
  tombstoned_at     TEXT
);

INSERT INTO findings_v2 (
  finding_id,
  space_id,
  principal,
  summary,
  body,
  tags_json,
  severity,
  paths_json,
  refs_json,
  recipient_principals_json,
  kind,
  lifecycle,
  status,
  version,
  created_at,
  expires_at,
  source_event_id,
  tombstoned_at
)
SELECT
  finding_id,
  space_id,
  principal,
  summary,
  body,
  tags_json,
  severity,
  CASE
    WHEN refs_json IS NOT NULL
      AND json_valid(refs_json)
      AND json_type(refs_json, '$.paths') = 'array'
    THEN json_extract(refs_json, '$.paths')
    ELSE '[]'
  END,
  refs_json,
  '[]',
  'finding',
  'ttl',
  'active',
  1,
  created_at,
  expires_at,
  source_event_id,
  tombstoned_at
FROM findings;

DROP TABLE findings;
ALTER TABLE findings_v2 RENAME TO findings;

CREATE INDEX IF NOT EXISTS idx_findings_active
  ON findings(space_id, tombstoned_at, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_findings_space_principal
  ON findings(space_id, principal, created_at);
