<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# focus

## Purpose

Agent focus tracking domain logic (issue #15). Computes stable scope hashes from path lists, normalizes and deduplicates paths, and reads the focus projection for the briefing's `recent_progress` dimension. Focus rows track which agents are working on which code areas — deduped by `(principal, scope_hash)` to suppress heartbeat noise and surface distinct work areas.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | `loadRecentFocus()` — read most-recent focus row per `(principal, scope_hash)` from the database; sorted by `started_at` desc, capped at limit (default 20); tolerates missing `focus` table (early schema) and malformed JSON |
| `scope-hash.ts` | `computeScopeHash()` — stable SHA-256 hash of normalized+deduped+sorted paths; `canonicalScopePaths()` — return the canonical form (sorted, deduped, normalized) for persistence alongside the hash |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- **Scope normalization**: all paths are normalized via `normalizePathPattern()` (from `src/domain/conflicts/path-match.js`) before hashing. This ensures `foo/bar`, `foo/bar/`, and `foo//bar` all hash identically.
- **Deduplication**: use a `Set` to eliminate duplicates; then sort lexicographically for stability.
- **Hash stability**: `computeScopeHash()` is pure and deterministic — identical path sets always produce the same hash, regardless of input order.
- **Empty scope**: empty or undefined paths hash to the SHA-256 of `'[]'`; callers rely on this constant to collapse "no-scope" focus events.
- **Projection read**: `loadRecentFocus()` returns the most-recent row per unique `(principal, scope_hash)` pair — prevents displaying a single agent's heartbeat noise as multiple distinct work items. The briefing consumer sorts by `started_at` desc.
- **Graceful schema tolerance**: `loadRecentFocus()` catches "no such table: focus" errors and returns `[]` (early schema may not have the table yet).

### Testing Requirements

- Unit tests in `tests/unit/domain/focus/` cover:
  - `computeScopeHash()` path normalization and deduplication (e.g., `['foo/bar', 'foo/bar']` and `['foo/bar/']` hash identically)
  - `canonicalScopePaths()` sorted output
  - empty/undefined path handling
  - idempotency (hashing the output of `canonicalScopePaths()` yields the same hash)
- Integration tests exercise `loadRecentFocus()` with real in-memory SQLite and verify deduplication logic.
- Test with malformed `scope_paths_json` to ensure graceful parsing failure (catch + return empty array).

### Common Patterns

- **Hash derivation**: SHA-256 of the canonical JSON form — `createHash('sha256').update(JSON.stringify(normalized)).digest('hex')`.
- **Path normalization**: delegate to `normalizePathPattern()` from `conflicts/path-match.js`; this is the single source of truth for path matching rules.
- **Result types**: pure functions, no error handling needed (or catch malformed JSON gracefully).

## Dependencies

### Internal

- `src/domain/conflicts/path-match.js` — `normalizePathPattern()` for consistent path canonicalization

### External

- `node:crypto` — SHA-256 hash computation

<!-- MANUAL: -->
