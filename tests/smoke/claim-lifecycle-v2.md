# Claim Lifecycle v2 — End-to-End Smoke Walkthrough

This document is the reproducible manual smoke test for the full claim lifecycle
introduced in slices #28–#36. Run this against two real clones of the same repo
before any v2 release.

**Prerequisite**: a running Teamem server and two terminal sessions — one for
Alice, one for Bob — each with their own Claude Code session and Teamem
credentials.

---

## Setup

```bash
# Clone the repo twice (simulating two teammates)
git clone https://github.com/your-org/your-repo.git alice-clone
git clone https://github.com/your-org/your-repo.git bob-clone

# Install git hooks in each clone (slice #31)
cd alice-clone && bun run teamem install-git-hooks
cd bob-clone   && bun run teamem install-git-hooks

# Start a shared Teamem space (alice creates, bob joins)
# Alice:
cd alice-clone && bun run setup   # creates space, gets SPACE_ID + JWT
# Bob:
cd bob-clone   && bun run setup   # joins space with room code from alice

# Launch Teamem-aware Claude Code in each clone
cd alice-clone && claude --teamem   # or use the Teamem-aware launcher
cd bob-clone   && claude --teamem   # or use the Teamem-aware launcher
```

Verify both clones share the same `repo_id` (same git remote URL → same
canonical repo_id). If clones have different remotes, set
`TEAMEM_PROJECT_ID=<shared-id>` in both `.env` files.

---

## Story group 1 — Acquire on Edit, claim survives Stop (slice #28)

Alice:

```text
Edit src/Form.tsx.
Show my current Teamem claims.
```

Expected: `gate-claim.sh` fires during the edit, the agent acquires an
`on_commit` claim, and the agent uses `teamem.list_claims` to show
`src/Form.tsx` under Alice's active claims.

End Alice's session and restart it, then ask:

```text
Show my current Teamem claims.
```

Expected: the claim still appears because the Stop hook is a no-op.

**Pass criteria**: `hook-trace.log` shows `decision:allow` for gate-claim, and
`decision:noop` (or `released_count:0`) for release-claims on Stop.

---

## Story group 2 — Branch isolation + same-branch conflict (slice #29)

```bash
# Alice is on feature/a holding src/api/client.ts
git -C alice-clone checkout -b feature/a
# Alice edits src/api/client.ts → claim acquired on feature/a

# Bob is on main — different branch
git -C bob-clone checkout main
# Bob edits src/api/client.ts
# Expected: NO conflict (different branches → different claim_scope)
# Bob's gate-claim returns allow; ask the agent to list all space claims

# Bob switches to feature/a
git -C bob-clone checkout feature/a
# Bob tries to edit src/api/client.ts
# Expected: scope_conflict — claim_paused_by_peer or conflict error
```

**Pass criteria**: the agent's space-wide `teamem.list_claims` output shows
Alice's claim on `feature/a` and Bob's claim on `main` simultaneously.
Conflict fires only when Bob is on the same branch.

---

## Story group 3 — Detached HEAD silent skip (slice #30)

```bash
# Alice: enter detached HEAD
git -C alice-clone checkout HEAD~1   # detached

# Alice tries to edit any file
# Expected: gate-claim exits 0 (allow), logs decision:detached_head_skip
# No claim created, no bridge call made
```

**Pass criteria**: `hook-trace.log` has `decision:detached_head_skip` (or
`decision:allow` with `reason:outside_repo`). No claim appears in
the agent's self-scoped claim listing.

---

## Story group 4 — Auto-release on commit: M / A / D / R (slices #31, #32)

Alice edits `src/Button.tsx` and creates `src/NewFile.tsx`, then asks:

```text
Show my current Teamem claims.
```

Expected: both files are held under `on_commit / active`.

```bash
git -C alice-clone add src/Button.tsx src/NewFile.tsx
git -C alice-clone commit -m "add Button and NewFile"
```

Expected: the post-commit hook calls `teamem.release_scope_via_git` for both
paths. Ask the agent to show Alice's claims again; both claims should be gone.

```bash
git -C alice-clone mv src/OldName.tsx src/NewName.tsx
git -C alice-clone commit -m "rename OldName→NewName"

git -C alice-clone rm src/Deprecated.tsx
git -C alice-clone commit -m "delete Deprecated"
```

Expected: the claim for the renamed or deleted path is released.

**Pass criteria**: every claim for a committed/renamed/deleted path disappears
from the agent's self-scoped claim listing immediately after the commit.

---

## Story group 5 — Branch switch → pause → peer denial → resume (slice #33)

```bash
git -C alice-clone checkout feature/a
```

Alice edits `src/Form.tsx` so the edit gate acquires an `on_commit` claim, then
switches away:

```bash
git -C alice-clone checkout main
```

Ask Alice's agent to show her claims. Expected: `src/Form.tsx` appears under
`on_commit / paused` with `paused_reason: branch_switch`.

Bob tries to edit `src/Form.tsx` on `feature/a`. Expected:
`claim_paused_by_peer` denial because Alice has a paused claim.

Alice returns:

```bash
git -C alice-clone checkout feature/a
```

Expected: post-checkout resumes the claim. Ask Alice's agent to show her claims;
`src/Form.tsx` should be active again.

**Pass criteria**: pause shows `paused_reason: branch_switch`; after resume,
`status` returns to `active` and `paused_at` is null.

---

## Story group 6 — Agent-requested TTL and manual-only claims (slice #34)

Ask Alice's agent:

```text
Claim docs/spec.md for 30 minutes, then show my current Teamem claims.
```

Expected: the agent calls `teamem.claim_scope` with `auto_release_mode: "ttl"`
and `lease_seconds: 1800`, then uses `teamem.list_claims`; the claim appears
under `ttl / active` with an expiry around 30 minutes in the future.

Ask Alice's agent:

```text
Claim README.md as a manual-only Teamem claim, then show my current claims.
```

Expected: the agent calls `teamem.claim_scope` with
`auto_release_mode: "manual_only"`; the claim appears under
`manual_only / active` with no expiry.

```bash
git -C alice-clone add README.md && git commit -m "update readme"
```

Ask Alice's agent to show claims again. Expected: `README.md` is still held
because `manual_only` survives commit.

Ask Alice's agent:

```text
Release my README.md Teamem claim, then show my current claims.
```

Expected: the agent calls `teamem.release_scope`; `README.md` is gone.

**Pass criteria**: TTL claim shows `expires_at` as a future timestamp; manual
claim shows `expires_at: null`; manual claim is NOT released by post-commit hook.

---

## Story group 7 — Force-release with online + offline notification (slice #35)

Alice holds `src/Form.tsx` (`on_commit / active`) on
`github.com/team/repo / feature/alice`.

Bob asks his agent:

```text
Force-release Alice's stale src/Form.tsx Teamem claim on feature/alice.
```

Expected: the agent asks for human confirmation if the claim is active or
recently edited, then calls `teamem.force_release` with `target_principal`,
`repo_id`, `branch`, and `path`.

Alice online with Channels enabled: expected live channel notice about
`force_release`.

Alice offline, or online without a visible live-delivery surface: on Alice's
next Teamem-launched SessionStart/session, expected unread notification delivery
for the `force_release` event.

Ask either agent to show all space claims. Expected: `src/Form.tsx` no longer
appears under Alice's claims.

**Pass criteria**: `teamem.fetch_unread_notifications` returns the
`force_release` event for Alice as the durable fallback; channel-enabled sessions
may additionally receive a live notice.

---

## Story group 8 — teamem.list_claims accuracy at every step (slice #36)

Ask the agent to show self-scoped claims and space-wide claims at each
transition in story groups 1–7 above and verify:

| Step | Self-scoped claims | Space-wide claims |
|------|-----------------|----------------------|
| After acquire | shows claim under mode/active | same |
| After Stop | claim still present (no-op) | same |
| After branch switch | claim under mode/paused | same |
| After resume | claim back under mode/active | same |
| After commit | claim gone | same |
| After force-release | claim gone | same |
| Empty state | "No active claims." | "No active claims." |

**Pass criteria for scope="space"**: when Alice and Bob both hold claims, the
listing groups output as `principal → mode → status` with all rows present.

---

## Final verification

After all story groups complete, ask the agent:

```text
Show all Teamem claims in this space.
```

Expected: "No active claims."

Then run:

```bash
cd /path/to/teamem-poc
bun test
bun run typecheck
bun run lint
# All should pass
```
