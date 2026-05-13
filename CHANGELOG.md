# Changelog

## 2026-05-05 — `on_commit` `expires_at` reverts to PRD §150 literal

ADR-0008 §3 originally documented an intentional drift: `on_commit` claims
carried a `lease_seconds`-derived `expires_at` as a "safety-net TTL". The
adversarial review surfaced this as a real UX trap (paused claims silently
TTL-expiring across multi-day branch switches), and the user approved the
revert on 2026-05-05.

### Behavior change

- `on_commit` claims now have `expires_at = NULL` (matching `manual_only`).
- Server rejects `lease_seconds` on `on_commit` and `manual_only` with
  `INVALID_PAYLOAD`. `lease_seconds` is now a `ttl`-only field.
- The plugin's `gate-claim.sh` no longer sends `lease_seconds` in the
  `claim_scope` payload.
- The `TEAMEM_LEASE_SECONDS` environment variable is removed.
- `gate-claim.sh` cache eviction sorts NULL `expires_at` to `Infinity` so
  active `on_commit` entries are kept (sticky), `ttl` entries evict first.

### Required migration for running deployments

Existing `on_commit` rows with non-null `expires_at` from before this revert
are not auto-migrated. Operators with running v2 deployments should run a
one-time SQL update once the new server is deployed:

```sql
UPDATE claims SET expires_at = NULL WHERE auto_release_mode = 'on_commit';
```

Fresh deployments are unaffected. The migration is idempotent — running it
twice is safe.

### Trust model implication

With no time-based safety net for `on_commit`, abandoned claims persist until
a peer force-releases them. This is the explicit tradeoff in PRD §150 and
captured in ADR-0008's "Amendment 2026-05-05" section. Surface stale claims
by asking an agent to inspect the space via `teamem.list_claims`; recover by
asking the agent to force-release the stale claim via `teamem.force_release`
after human confirmation when the claim is active or recently edited.
