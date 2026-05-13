<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-09 | Updated: 2026-05-09 -->

# security

## Purpose

Security-focused tests that verify authentication, authorization, JWT handling, and rate-limiting behavior. Tests here exercise auth bypass vectors, secret rotation, credential handling, and permission boundaries.

## Key Files

| File | Description |
|------|-------------|
| `jwt-secret-rotation-flow.test.ts` | JWT secret rotation without evicting active members — old secret becomes invalid, new secret accepts new tokens |
| `room-code-rate-limit.test.ts` | Room code join attempts are rate-limited; fails after N attempts in a window |
| `code-leak-abuse-simulation.test.ts` | Simulates room code leaked to untrusted agent; rate limit + credential file isolation prevents abuse |

## For AI Agents

### Working In This Directory

- Security tests are adversarial — they attempt to find exploit vectors (auth bypass, permission violation, data leak).
- Each test documents the threat model and the guard that prevents it.
- Use in-process Hono server with real SQLite `:memory:` DB and real JWT middleware.
- Do not skip or disable security tests; they are regression detectors for critical vulnerabilities.

### Testing Requirements

- Every security test must pass; none should be skipped or disabled.
- Tests should verify both the positive path (attack is blocked) and negative path (legitimate access still works).
- Rate-limit tests must verify bucket state isolation between test cases (call `resetRateLimitBuckets()` in setup).
- JWT tests must use multiple secrets to verify that token signing/verification uses the correct secret.

### Common Patterns

- **Secret rotation**: create space with SECRET_V1, mint token, rotate to SECRET_V2, verify old token rejected, new token accepted.
- **Rate limit**: loop N+1 times sending requests, expect success for N, failure (429) for N+1.
- **Isolation**: verify that data from space A doesn't leak when querying as a member of space B.
- **Threat documentation**: add a comment explaining what the test prevents (e.g., "prevents unauthenticated toolcall via malformed header").

## Dependencies

### Internal

- `src/infra/db/sqlite-client.js`, `src/infra/db/sqlite-event-store.js` — DB setup
- `src/server/tools/index.js` — tool factory
- `src/server/routes.js`, `src/server/auth.js` — HTTP server and JWT middleware
- `src/server/rate-limit.js` — rate limiter implementation
- `tests/helpers/migrations.js`, `tests/helpers/auth.js` — database and JWT helpers

### External

- `bun:test` — test runner
- `hono` — HTTP server framework
- `node:crypto` — (used internally by JWT signing)

<!-- MANUAL: -->
