<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-01 | Updated: 2026-05-05 -->

# migrations

## Purpose

Forward-only SQL migrations for the Teamem SQLite database. Each migration is idempotent (`CREATE TABLE IF NOT EXISTS`) so it can be applied to fresh `:memory:` databases per test without bookkeeping.

## Key Files

| File              | Description                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `001_init.sql`    | Initial schema: `events`, `idempotency_keys`, `claims`, `contracts`, `decisions`, `blockers`, `cursors` + `idx_events_repo_timestamp` index |

## For AI Agents

### Working In This Directory

- Naming convention: `NNN_<short_name>.sql`, three-digit zero-padded ordinal.
- The migration runner (`runMigration` in `../sqlite-client.ts`) just runs `db.exec(sql)`. There is **no migration ledger / versioning** in v1 — every migration is `IF NOT EXISTS`-safe and runs every startup. Do not add `DROP` statements.
- The `idempotency_keys` table has a foreign key to `events.event_id`. SQLite does not enforce FKs unless `PRAGMA foreign_keys = ON;` is set — currently it is not, so the FK is documentation only.
- When you add a column to `events`, also update the `INSERT` statement in `../sqlite-event-store.ts:append` and the `INSERT OR REPLACE` statements in `../../projections/apply-event.ts`.

### Testing Requirements

- N/A directly — exercised by every store/projection test that calls `runMigration`.
- A new migration should be exercised by at least one test that calls it on a fresh `:memory:` DB.

### Common Patterns

- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` for forward-safety.
- TEXT columns for JSON blobs (`scope_json`, `payload_json`, `state_json`, `raw_json`).
- Composite primary key on `cursors (actor, repo_id)`.

## Dependencies

### Internal

- Read at runtime by `../sqlite-client.ts:runMigration`.

### External

- SQLite SQL dialect.

<!-- MANUAL: -->

## Update 2026-05-05 — migrations 003 through 021

The Key Files table only lists `001_init.sql`; the directory now contains `001` → `021`. Discover with `ls`. Notable additions for claim-lifecycle v2:

| File                                  | Description                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `019_branch_aware_claims.sql`         | Adds `repo_id`, `branch`, `head_sha_at_acquire`, `last_edit_at`, `paused_at`, `paused_reason`, `auto_release_mode`, `path` columns to `claims`; composite index on `(repo_id, branch, status)` |
| `020_unread_notifications.sql`        | Per-`(space_id, principal)` notification queue with index on `(space_id, principal, delivered_at)`           |
| `021_remove_ask_claimant_coord_pref.sql` | Idempotently rewrites legacy `members.coord_pref='ask-claimant'` rows to `auto-skip`; app-level validation now exposes only `auto-skip` and `auto-discuss` |

### `path` column semantic

`claims.path` holds `paths[0]` only; the full scope is in `scope_json`. **Do not write WHERE filters on `path = ?`** — they silently miss multi-path claims for `paths[1+]`. Use `EXISTS (SELECT 1 FROM json_each(json_extract(scope_json, '$.paths')) je WHERE je.value = ?)` instead. See `releaseScopeViaGit` for the canonical pattern.

### `expires_at` semantic (PRD §150 + ADR-0008 Amendment 2026-05-05)

NULL for `on_commit` and `manual_only`; only `ttl` mode sets a timestamp. Sweepers / TTL queries that filter on `expires_at` MUST tolerate NULL — `WHERE expires_at < now()` correctly excludes NULL via SQLite three-valued logic. Don't add `WHERE expires_at IS NOT NULL` defensively unless you mean "ttl-only".

### Migration runner is forward-only, no ledger

Every migration runs every startup via `runAllMigrations`; only `CREATE ... IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS` (or equivalent guarded ALTERs) are safe. No DROPs. New schema changes that aren't naturally idempotent must be guarded with a `PRAGMA user_version` check or equivalent.

### Operator migration outside migrations runner

PRD §150 amendment requires a one-time `UPDATE claims SET expires_at = NULL WHERE auto_release_mode = 'on_commit'` for pre-amendment v2 deployments. This is intentionally NOT in a migration file (existing on_commit data is operator-owned, not server-owned). It lives in `CHANGELOG.md` for operators to run by hand. New operator migrations of this kind should follow the same convention — surface in CHANGELOG, do not auto-run.
