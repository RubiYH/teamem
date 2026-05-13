-- Migration 004: composite PK on contracts (multi-tenant safety).
--
-- Why: migration 003 renamed `contracts.repo_id → space_id` but left the
-- existing `PRIMARY KEY(contract_key)` in place. Under the multi-space model
-- shipped in v0.2.0, two distinct spaces that record `contract_changed` events
-- with the same caller-supplied `contract_key` collide globally — the later
-- write overwrites the earlier one, breaking tenant isolation.
--
-- Fix: rebuild the contracts table with a composite primary key
-- `(space_id, contract_key)` so each (space, key) pair owns its own row.
-- Putting `space_id` first matches the dominant access pattern: list contracts
-- for the current space.
--
-- SQLite ALTER TABLE cannot change a primary key, so we do the standard
-- rename → create-new → copy → drop dance, all inside a single transaction.

BEGIN TRANSACTION;

ALTER TABLE contracts RENAME TO contracts_old;

CREATE TABLE contracts (
  space_id              TEXT NOT NULL,
  contract_key          TEXT NOT NULL,
  state_json            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  updated_by_event_id   TEXT NOT NULL,
  PRIMARY KEY (space_id, contract_key)
);

INSERT INTO contracts (space_id, contract_key, state_json, updated_at, updated_by_event_id)
SELECT space_id, contract_key, state_json, updated_at, updated_by_event_id
FROM contracts_old;

DROP TABLE contracts_old;

-- Index for the secondary access pattern (look up a contract by key across spaces),
-- though this should be rare under the multi-tenant model.
CREATE INDEX IF NOT EXISTS idx_contracts_key ON contracts(contract_key);

COMMIT;
