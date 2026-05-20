import type { MiddlewareHandler } from 'hono';
import type { Database } from 'bun:sqlite';
import { verifyJwt } from './jwt.js';
import { applyCloudFreeTrialSuspensionIfExpired } from './spaces.js';

// ── JWT-based auth (Phase 0+) ────────────────────────────────────────────────

export const SCOPE_REJECT_KEYS = [
  'space_id',
  'principal',
  'repo_id',
  'actor',
  'delegation'
] as const;

// Per-IP rate-limit for auth_check log lines (AC16): 1 line / IP / 60 s.
// Bounded with opportunistic sweep + hard cap to prevent unbounded growth under
// IP rotation (e.g., IPv6 /64 randomization or botnet flood).
const _authCheckLogWindow = 60_000;
const _AUTH_CHECK_BUCKET_CAP = 50_000;
const _authCheckLastEmit = new Map<string, number>();
function _maybeLogAuthCheck(line: string, peerIp: string): void {
  const now = Date.now();
  const last = _authCheckLastEmit.get(peerIp) ?? 0;
  if (now - last >= _authCheckLogWindow) {
    if (_authCheckLastEmit.size >= _AUTH_CHECK_BUCKET_CAP) {
      // Sweep entries older than one window — best-effort eviction.
      for (const [k, t] of _authCheckLastEmit) {
        if (now - t > _authCheckLogWindow) _authCheckLastEmit.delete(k);
      }
      // If still at cap (every entry within window), drop the oldest by insertion order.
      if (_authCheckLastEmit.size >= _AUTH_CHECK_BUCKET_CAP) {
        const oldestKey = _authCheckLastEmit.keys().next().value;
        if (oldestKey !== undefined) _authCheckLastEmit.delete(oldestKey);
      }
    }
    console.log(line);
    _authCheckLastEmit.set(peerIp, now);
  }
}

// Exported for tests only — clears per-IP rate-limit state.
export function resetAuthCheckLogBuckets(): void {
  _authCheckLastEmit.clear();
}

export type AuthedMember = {
  space_id: string;
  principal: string;
  is_creator: boolean;
  member_id: string;
};

type MemberLookupRow = { id: string; is_creator: number };

type RequireMemberOptions = {
  allowSuspended?: boolean;
};

/**
 * Single-JOIN auth middleware (plan §2 req 2). Verifies the bearer JWT
 * (HS256, exp), then performs one B-tree probe to confirm the space is
 * still live and the member has not left/been kicked. On success sets
 * `c.set('member', AuthedMember)` and calls next().
 */
export function createRequireMemberMiddleware(
  jwtSecret: string,
  db: Database,
  options: RequireMemberOptions = {}
): MiddlewareHandler {
  const stmt = db.prepare(
    `SELECT m.id, m.is_creator
       FROM spaces s
       JOIN members m ON m.space_id = s.id
      WHERE s.id = ?1
        AND s.disbanded_at IS NULL
        AND m.name = ?2
        AND m.left_at IS NULL
      LIMIT 1`
  );
  const spaceStmt = db.prepare(
    `SELECT disbanded_at FROM spaces WHERE id = ?1 LIMIT 1`
  );

  return async (c, next) => {
    const start = Date.now();
    const env = c.env as
      | {
          server?: { requestIP?: (req: Request) => { address: string } | null };
        }
      | undefined;
    const peerIp = env?.server?.requestIP?.(c.req.raw)?.address ?? 'no-ip';
    const log = (result: string, extra: Record<string, unknown> = {}) => {
      try {
        _maybeLogAuthCheck(
          JSON.stringify({
            event: 'auth_check',
            result,
            latency_ms: Date.now() - start,
            ...extra
          }),
          peerIp
        );
      } catch {
        /* logging must not break auth */
      }
    };

    const authHeader =
      c.req.header('Authorization') ?? c.req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      log('missing_authorization');
      return c.json({ error: 'missing_authorization' }, 401);
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      log('missing_authorization');
      return c.json({ error: 'missing_authorization' }, 401);
    }

    // Header alg check (must be HS256)
    const parts = token.split('.');
    if (parts.length !== 3) {
      log('invalid_signature');
      return c.json({ error: 'invalid_signature' }, 401);
    }
    let header: { alg?: unknown; typ?: unknown } | null = null;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    } catch {
      log('invalid_signature');
      return c.json({ error: 'invalid_signature' }, 401);
    }
    if (!header || header.alg !== 'HS256') {
      log('invalid_alg');
      return c.json({ error: 'invalid_alg' }, 401);
    }

    // Cheap exp pre-check so we can return the canonical "expired" reason
    // before hono/jwt's verify() converts it into a generic failure.
    let prePayload: {
      exp?: unknown;
      sub?: unknown;
      space_id?: unknown;
    } | null = null;
    try {
      prePayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      log('invalid_signature');
      return c.json({ error: 'invalid_signature' }, 401);
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      prePayload &&
      typeof prePayload.exp === 'number' &&
      prePayload.exp < now
    ) {
      log('token_expired');
      return c.json({ error: 'token_expired' }, 401);
    }

    // Constant-time signature/exp verification (delegated)
    const claims = await verifyJwt(token, jwtSecret);
    if (!claims) {
      log('invalid_signature');
      return c.json({ error: 'invalid_signature' }, 401);
    }

    const space_id = String(claims.space_id);
    const principal = String(claims.sub);

    // Single-JOIN lookup (plan §2 req 2)
    const row = stmt.get(space_id, principal) as MemberLookupRow | null;
    if (!row) {
      // Differentiate disbanded vs left vs not-found via a cheap second probe.
      // Disbanded space → 410; member left/kicked or unknown member → 401.
      const spaceRow = spaceStmt.get(space_id) as {
        disbanded_at: string | null;
      } | null;
      if (spaceRow && spaceRow.disbanded_at !== null) {
        log('space_disbanded', { space_id });
        return c.json({ error: 'space_disbanded' }, 410);
      }
      if (!spaceRow) {
        log('space_not_found', { space_id });
        // Enrich the error with the offending space_id + remediation hint.
        // Stale JWTs from a wiped/rebuilt DB authenticate cleanly (signature
        // is valid) but reference a space that no longer exists. Without
        // surfacing the space_id and a hint to re-onboard, the operator has
        // to dig through events/projection state to figure out the disconnect.
        return c.json(
          {
            error: 'space_not_found',
            space_id,
            principal,
            hint:
              "JWT references a space that does not exist in this server's database. " +
              'Likely causes: (1) the DB was wiped or rebuilt while your credentials cached an old JWT; ' +
              '(2) you are pointing TEAMEM_SERVER_URL at a different deployment than the one that issued the JWT. ' +
              'Re-run `bun run src/cli/setup.ts --join-space --room-code <code> --principal <name>` against the live server.'
          },
          401
        );
      }
      // Space exists & live but member missing → either left/kicked or never existed
      log('member_left', { space_id, principal });
      return c.json(
        {
          error: 'member_left',
          space_id,
          principal,
          hint:
            'Your principal is no longer a member of this space (left or kicked). ' +
            "Re-join via `/teamem-setup` with the space's room code, or ask the creator to re-add you."
        },
        401
      );
    }

    const suspension = applyCloudFreeTrialSuspensionIfExpired(db, space_id);
    if (suspension && options.allowSuspended !== true) {
      log('space_suspended', {
        space_id,
        reason: suspension.suspensionReason
      });
      return c.json(
        {
          error: 'space_suspended',
          reason: suspension.suspensionReason
        },
        410
      );
    }

    const member: AuthedMember = {
      space_id,
      principal,
      is_creator: row.is_creator === 1,
      member_id: row.id
    };
    c.set('member', member);
    log('ok', { space_id, principal });
    await next();
    return;
  };
}

/**
 * Composes `createRequireMemberMiddleware` and additionally enforces
 * `member.is_creator === true`. Reads is_creator from DB (via the inner
 * middleware's JOIN), so AC19 (DB is source of truth) holds.
 */
export function createRequireCreatorMiddleware(
  jwtSecret: string,
  db: Database
): MiddlewareHandler {
  const requireMember = createRequireMemberMiddleware(jwtSecret, db);
  return async (c, next) => {
    let memberPassed = false;
    // Capture the inner Response — when `requireMember` rejects (401/410)
    // it returns the Response from `c.json(...)`. We must propagate that
    // back to Hono; returning `undefined` here leaves the outer context
    // unfinalized and Hono throws "Context is not finalized" → 500.
    const innerResp = await requireMember(c, async () => {
      memberPassed = true;
    });
    if (!memberPassed) {
      return innerResp as Response;
    }
    const member = c.get('member') as AuthedMember | undefined;
    if (!member || member.is_creator !== true) {
      return c.json({ error: 'not_creator' }, 403);
    }
    await next();
    return;
  };
}
