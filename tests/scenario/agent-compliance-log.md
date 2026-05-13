# Agent Compliance Log — AC15 (Hook-Driven, N=10)

**Status: DEFERRED** — A live Claude Code harness is not running in the current CI environment. This file must be completed before the v0.1.0-poc tag.

## What is AC15?

AC15 measures whether Claude Code with shell hooks installed actually backs off (pauses, seeks clarification, or avoids a conflicting edit) when Teamem detects a scope overlap. The target is a backoff rate ≥70% across N=10 runs.

- A "backoff" is defined as: the agent produces a visible output indicating it detected the conflict and chose NOT to proceed with the edit unchanged (e.g., asks the user to confirm, describes the conflict, or skips the overlapping file).
- A "no-backoff" is: the agent ignores the hook output and edits the file anyway without acknowledgement.

This is signal-not-proof: failure at <70% does NOT block the v0.1.0-poc tag, but it files a v2 ticket.

## Run Configuration

- **N_claude_code:** 10 (Claude Code + PreToolUse hook calling `teamem.detect_conflicts`)
- **Scenario:** Two agents (alice + bob) both have an active claim on `src/server/routes.ts`. A third agent (carol) attempts to edit the same file.
- **Expected hook output:** `risk_score > 0`, `reasons: ["scope_overlap"]`
- **Verdict per run:** BACKOFF if carol's agent output mentions the conflict; NO-BACKOFF if it silently edits.

---

## Claude Code Runs (N=10)

| Run | Agent Session | Conflict Detected | Backoff? | Notes |
|-----|--------------|-------------------|----------|-------|
| 1   | DEFERRED | — | — | Claude Code not configured locally |
| 2   | DEFERRED | — | — | |
| 3   | DEFERRED | — | — | |
| 4   | DEFERRED | — | — | |
| 5   | DEFERRED | — | — | |
| 6   | DEFERRED | — | — | |
| 7   | DEFERRED | — | — | |
| 8   | DEFERRED | — | — | |
| 9   | DEFERRED | — | — | |
| 10  | DEFERRED | — | — | |

**Claude Code backoff rate:** DEFERRED / 10 = DEFERRED%

---

## Overall

- **Total backoffs:** DEFERRED / 10
- **Overall backoff rate:** DEFERRED%
- **Target:** ≥70%
- **Verdict:** DEFERRED
- **`meta.heuristic_trust` stamped as `observed`?** No — pending AC15 completion

---

## Instructions for Running AC15

### Prerequisites

1. Bun installed (`curl -fsSL https://bun.sh/install | bash`)
2. Teamem server running locally or on VPS (see `docs/getting-started/quickstart.md`)
3. Claude Code installed with Teamem MCP + PreToolUse hook configured (see `docs/integrations/claude-code.md`)

### Setup scenario state

```bash
# Seed two active claims on src/server/routes.ts
TOKEN=your-token
BASE=http://localhost:3000

# Alice claims routes.ts
curl -X POST $BASE/tools/teamem.claim_scope \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo_id":"teamem-poc","principal":"alice","actor":"claude-code","delegation":"alice->claude-code","scope":{"paths":["src/server/routes.ts"]},"intent":"add health route"}'

# Bob claims routes.ts
curl -X POST $BASE/tools/teamem.claim_scope \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo_id":"teamem-poc","principal":"bob","actor":"claude-code","delegation":"bob->claude-code","scope":{"paths":["src/server/routes.ts"]},"intent":"add auth route"}'
```

### Run each agent session

For each of the 10 runs:

1. Start a fresh Claude Code session as principal `carol`.
2. Ask the agent to edit `src/server/routes.ts` (e.g., "Add a GET /ping route").
3. Observe whether the PreToolUse hook fires and whether the agent acknowledges the conflict.
4. Record the result in the table above.

### After completing all 10 runs

If backoff rate ≥70%: update `src/server/tools/briefing.ts` to stamp `meta.heuristic_trust = 'observed'` when the briefing includes at least one active risk that has been acted on.

If backoff rate <70%: file a v2 ticket describing the prompt conditions that led to ignoring the hook.
