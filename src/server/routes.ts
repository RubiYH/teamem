import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { TeamemTools } from './tools/index.js';
import { createToolRegistry, TOOL_NAMES } from './tool-registry.js';
import {
  createRequireMemberMiddleware,
  createRequireCreatorMiddleware,
  SCOPE_REJECT_KEYS,
  type AuthedMember
} from './auth.js';
import { createRateLimitMiddleware } from './rate-limit.js';
import {
  createSpace,
  joinSpace,
  leaveSpace,
  kickMember,
  disbandSpace,
  restoreSpace,
  rotateRoomCode,
  getSpaceById,
  wipeSpace,
  unwipeSpace
} from './spaces.js';

type Variables = { member: AuthedMember };

const MCP_PROTOCOL_VERSION = '2025-11-25';

// Methods that MAY proceed without authentication. Anything not in this set
// requires JWT. Adding a new method without explicit consideration CANNOT
// silently bypass auth — this is the security invariant.
const UNAUTH_MCP_METHODS = new Set(['initialize', 'notifications/initialized']);

export function createRouter(
  tools: TeamemTools,
  db?: Database,
  jwtSecret?: string,
  trustedOrigins?: string[]
) {
  const app = new Hono<{ Variables: Variables }>();
  const registry = createToolRegistry(tools);

  const requireMember =
    db && jwtSecret ? createRequireMemberMiddleware(jwtSecret, db) : null;
  const requireCreator =
    db && jwtSecret ? createRequireCreatorMiddleware(jwtSecret, db) : null;
  const rateLimit = createRateLimitMiddleware();

  // --- /spaces routes ---
  if (db && jwtSecret) {
    // POST /spaces — create a new space (no auth, rate-limited)
    app.post('/spaces', rateLimit, async (c) => {
      let body: { member_name?: string; label?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      if (!body.member_name)
        return c.json({ error: 'member_name_required' }, 400);

      try {
        const result = await createSpace(
          db,
          { label: body.label, member_name: body.member_name },
          jwtSecret
        );
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof Error && err.message === 'room_code_collision') {
          return c.json({ error: 'room_code_collision' }, 500);
        }
        throw err;
      }
    });

    // POST /spaces/join — join with room code (no auth, rate-limited)
    app.post('/spaces/join', rateLimit, async (c) => {
      let body: { room_code?: string; member_name?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      if (!body.room_code || !body.member_name)
        return c.json({ error: 'room_code_and_member_name_required' }, 400);

      const result = await joinSpace(
        db,
        { room_code: body.room_code, member_name: body.member_name },
        jwtSecret
      );
      // Plan §2 req 1 + AC4: invalid_code → 404, code_expired → 410.
      if (result === 'invalid_code')
        return c.json({ error: 'invalid_code' }, 404);
      if (result === 'code_expired')
        return c.json({ error: 'code_expired' }, 410);
      // Codex F27: tombstoned space → same 410 the JWT middleware returns
      // for authenticated requests against a disbanded space. A leaked
      // room code must not admit anyone during the grace window.
      if (result === 'space_disbanded')
        return c.json({ error: 'space_disbanded' }, 410);
      if (result === 'name_taken') return c.json({ error: 'name_taken' }, 409);
      return c.json(result, 200);
    });

    // POST /spaces/leave — requireMember
    app.post('/spaces/leave', requireMember!, async (c) => {
      const member = c.get('member');
      const result = leaveSpace(db, { member_id: member.member_id });
      if (result === 'creator_must_disband')
        return c.json({ error: 'creator_must_disband' }, 409);
      return c.json({ ok: true });
    });

    // POST /spaces/kick — requireCreator
    app.post('/spaces/kick', requireCreator!, async (c) => {
      let body: { member_name?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      if (!body.member_name)
        return c.json({ error: 'member_name_required' }, 400);

      const member = c.get('member');
      const result = kickMember(db, {
        requester_member_id: member.member_id,
        target_member_name: body.member_name
      });
      if (result === 'not_creator')
        return c.json({ error: 'not_creator' }, 403);
      // Plan §2 req 1 + AC9: cannot_self_kick → 409.
      if (result === 'cannot_self_kick')
        return c.json({ error: 'cannot_self_kick' }, 409);
      if (result === 'target_not_found')
        return c.json({ error: 'target_not_found' }, 404);
      return c.json({ ok: true });
    });

    // POST /spaces/disband — requireCreator
    app.post('/spaces/disband', requireCreator!, async (c) => {
      let body: { label_confirmation?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }

      // Server-side label-confirmation guard (plan §2 req 1 + PM3).
      if (
        typeof body.label_confirmation !== 'string' ||
        body.label_confirmation.length === 0
      ) {
        return c.json({ error: 'label_required' }, 400);
      }
      const member = c.get('member');
      const space = getSpaceById(db, member.space_id);
      if (!space || body.label_confirmation !== space.label) {
        return c.json({ error: 'label_mismatch' }, 400);
      }

      const result = disbandSpace(db, {
        requester_member_id: member.member_id
      });
      if (result === 'not_creator')
        return c.json({ error: 'not_creator' }, 403);
      return c.json({ ok: true });
    });

    // POST /spaces/restore — requireCreator. Note: a soft-disbanded space
    // currently auth-rejects everyone with 410 because the middleware filters
    // on `disbanded_at IS NULL`. We allow restore by piercing that filter:
    // requireCreator runs the standard JOIN which would 410, so this route
    // bypasses requireMember and verifies the JWT manually plus enforces
    // is_creator against `members` directly. Keeps the 7-day grace useful.
    app.post('/spaces/restore', async (c) => {
      const authHeader =
        c.req.header('Authorization') ?? c.req.header('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'missing_authorization' }, 401);
      }
      const token = authHeader.slice('Bearer '.length).trim();
      const { verifyJwt } = await import('./jwt.js');
      const claims = await verifyJwt(token, jwtSecret);
      if (!claims) return c.json({ error: 'invalid_signature' }, 401);
      const space_id = String(claims.space_id);
      const principal = String(claims.sub);

      const memberRow = db
        .prepare(
          `SELECT id, is_creator FROM members WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL`
        )
        .get(space_id, principal) as { id: string; is_creator: number } | null;
      if (!memberRow) return c.json({ error: 'member_left' }, 401);
      if (memberRow.is_creator !== 1)
        return c.json({ error: 'not_creator' }, 403);

      const result = restoreSpace(db, { requester_member_id: memberRow.id });
      if (result === 'not_creator')
        return c.json({ error: 'not_creator' }, 403);
      if (result === 'not_disbanded')
        return c.json({ error: 'not_disbanded' }, 409);
      if (result === 'expired') return c.json({ error: 'grace_expired' }, 410);
      return c.json({ ok: true });
    });

    // POST /spaces/wipe — requireCreator. Soft-wipe (default) tombstones every
    // projection row and writes a `space_wiped` event. With `hard: true`, plus
    // a typed-label confirmation matching the space label, deletes events +
    // projection rows irreversibly. Unwipe is only valid for soft-wipe.
    app.post('/spaces/wipe', requireCreator!, async (c) => {
      let body: { hard?: unknown; label_confirmation?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }

      const member = c.get('member');
      const hard = body.hard === true;

      // Hard wipe is irreversible — require typed-label confirmation that
      // matches the server-side space label, mirroring disband (PM3).
      if (hard) {
        if (
          typeof body.label_confirmation !== 'string' ||
          body.label_confirmation.length === 0
        ) {
          return c.json({ error: 'label_required' }, 400);
        }
        const space = getSpaceById(db, member.space_id);
        if (!space || body.label_confirmation !== space.label) {
          return c.json({ error: 'label_mismatch' }, 400);
        }
      }

      const result = wipeSpace(db, {
        requester_member_id: member.member_id,
        hard
      });
      if (result === 'not_creator')
        return c.json({ error: 'not_creator' }, 403);
      if (result === 'space_disbanded')
        return c.json({ error: 'space_disbanded' }, 410);
      return c.json(result);
    });

    // POST /spaces/unwipe — requireCreator. Reverses the most recent soft-wipe.
    // Returns 409 not_wiped if there's nothing to reverse (never wiped, or
    // last operation was a hard-wipe that left no events).
    app.post('/spaces/unwipe', requireCreator!, async (c) => {
      const member = c.get('member');
      const result = unwipeSpace(db, {
        requester_member_id: member.member_id
      });
      if (result === 'not_creator')
        return c.json({ error: 'not_creator' }, 403);
      if (result === 'space_disbanded')
        return c.json({ error: 'space_disbanded' }, 410);
      if (result === 'not_wiped') return c.json({ error: 'not_wiped' }, 409);
      return c.json(result);
    });

    // POST /spaces/rotate-code — requireMember
    app.post('/spaces/rotate-code', requireMember!, async (c) => {
      const member = c.get('member');
      const result = await rotateRoomCode(db, {
        requester_member_id: member.member_id
      });
      if (result === 'not_member') return c.json({ error: 'not_member' }, 401);
      return c.json(result);
    });
  }

  // --- /mcp routes (MCP Streamable HTTP transport, spec 2025-11-25) ---

  // In-memory session registry: sessionId → { principal, spaceId, lastActiveAt }
  const MAX_SESSIONS = 10000;
  const SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 min
  const mcpSessions = new Map<
    string,
    { principal: string; spaceId: string; lastActiveAt: number }
  >();

  // Periodic sweep: evict sessions idle for >30 min. Runs every 5 min.
  const sessionSweepInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [sid, sess] of mcpSessions) {
        if (now - sess.lastActiveAt > SESSION_IDLE_TTL_MS) {
          mcpSessions.delete(sid);
        }
      }
    },
    5 * 60 * 1000
  );
  // Allow the interval to be GC'd / not block process exit
  if (typeof sessionSweepInterval.unref === 'function') {
    sessionSweepInterval.unref();
  }

  function validateOrigin(
    req: { headers: { get(name: string): string | null } },
    trustedOriginsOverride?: string[]
  ): boolean {
    const origin = req.headers.get('Origin') ?? req.headers.get('origin');
    if (!origin) return true; // no Origin = direct API call, allow
    const list = trustedOriginsOverride ?? trustedOrigins;
    if (list && list.length > 0) {
      return list.some((o) => o === origin);
    }
    // Default-deny for non-localhost when no allowlist set
    try {
      const url = new URL(origin);
      return (
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '::1'
      );
    } catch {
      return false;
    }
  }

  // POST /mcp — handles initialize, notifications/initialized, tools/list, tools/call
  app.post('/mcp', async (c) => {
    // Origin validation (spec §Security Warning)
    if (!validateOrigin(c.req.raw)) {
      return c.json({ error: 'forbidden_origin' }, 403);
    }

    let body: {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const { method, id, params } = body;
    const clientProtocolVersion = c.req.header('MCP-Protocol-Version');

    if (method === 'initialize') {
      // Cap total sessions; reject with 503 on overflow
      if (mcpSessions.size >= MAX_SESSIONS) {
        return c.json({ error: 'session_limit_exceeded' }, 503);
      }
      // Issue a new session ID
      const sessionId = randomUUID();
      mcpSessions.set(sessionId, {
        principal: '',
        spaceId: '',
        lastActiveAt: Date.now()
      });

      const responseHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'MCP-Session-Id': sessionId
      };
      if (clientProtocolVersion) {
        responseHeaders['MCP-Protocol-Version'] = clientProtocolVersion;
      }

      const responseBody = {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: { name: 'teamem-bridge', version: '1.5.0' }
        }
      };

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: responseHeaders
      });
    }

    if (method === 'notifications/initialized') {
      // Validate session if provided
      const sessionId = c.req.header('MCP-Session-Id');
      if (sessionId && !mcpSessions.has(sessionId)) {
        return c.json({ error: 'session_not_found' }, 404);
      }
      // 202 Accepted — no body required for notifications
      return new Response(null, { status: 202 });
    }

    // Auth gate: default-deny for all methods not in UNAUTH_MCP_METHODS.
    // Runs ABOVE tool-registry lookup to prevent info-leak of tool existence (AC15).
    if (!UNAUTH_MCP_METHODS.has(method ?? '')) {
      const isProd = !!(db && jwtSecret);
      if (!isProd) {
        if (process.env.TEAMEM_ALLOW_NO_AUTH !== '1') {
          return c.json(
            {
              error: 'auth_unavailable',
              detail:
                'Server has db but no jwtSecret. Set TEAMEM_JWT_SECRET or TEAMEM_ALLOW_NO_AUTH=1.'
            },
            503
          );
        }
        // Dev mode: skip JWT auth, body scrub still applies below.
      } else {
        const inner = createRequireMemberMiddleware(jwtSecret!, db!);
        let memberPassed = false;
        const innerResp = await inner(c, async () => {
          memberPassed = true;
        });
        if (!memberPassed) {
          return innerResp as Response;
        }
      }
    }

    if (method === 'tools/list') {
      // Session validation — same shape as tools/call.
      const sessionId = c.req.header('MCP-Session-Id');
      if (sessionId && !mcpSessions.has(sessionId)) {
        return c.json({ error: 'session_not_found' }, 404);
      }

      // MCP clients request tools/list right after initialize to discover the
      // tool surface. Return the registered names with permissive inputSchema —
      // strict per-tool validation lives at the tool-handler layer.
      const tools = TOOL_NAMES.map((toolName) => ({
        name: toolName,
        description: '',
        inputSchema: { type: 'object', additionalProperties: true }
      }));

      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: { tools }
      });
    }

    if (method === 'tools/call') {
      // Session validation
      const sessionId = c.req.header('MCP-Session-Id');
      if (sessionId && !mcpSessions.has(sessionId)) {
        return c.json({ error: 'session_not_found' }, 404);
      }

      const toolName = (params?.name as string | undefined) ?? '';
      const toolArgs =
        (params?.arguments as Record<string, unknown> | undefined) ?? {};

      // Body scrub: reject caller-supplied server-injected scope keys (belt-and-suspenders,
      // mirrors v1 fail-fast policy; also guards dev-mode branch where JWT injection doesn't run).
      for (const key of SCOPE_REJECT_KEYS) {
        if (key in toolArgs) {
          return c.json(
            {
              jsonrpc: '2.0',
              id: id ?? null,
              error: {
                code: -32602,
                message: `${key} is server-injected; do not supply`
              }
            },
            400
          );
        }
      }

      const name = toolName as keyof typeof registry;
      const handler = registry[name];
      if (!handler || typeof handler !== 'function') {
        return c.json(
          {
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: -32601, message: `Tool not found: ${toolName}` }
          },
          404
        );
      }

      const toolBody: Record<string, unknown> = { ...toolArgs };

      // JWT injection: set space_id/principal from verified JWT; default actor/delegation.
      if (db && jwtSecret) {
        const m = c.get('member') as AuthedMember | undefined;
        if (m) {
          toolBody.space_id = m.space_id;
          toolBody.principal = m.principal;
          if (typeof toolBody.actor !== 'string' || toolBody.actor === '') {
            toolBody.actor = m.principal;
          }
          if (
            typeof toolBody.delegation !== 'string' ||
            toolBody.delegation === ''
          ) {
            toolBody.delegation = `${m.principal}->${m.principal}`;
          }
          // Update session with principal/spaceId for fanout use; bump TTL
          if (sessionId) {
            mcpSessions.set(sessionId, {
              principal: m.principal,
              spaceId: m.space_id,
              lastActiveAt: Date.now()
            });
          }
        }
      }

      let result:
        | { ok: true; data: unknown }
        | { ok: false; error: { code: string; [k: string]: unknown } };
      try {
        result = (await Promise.resolve(
          (handler as (input: unknown) => unknown)(toolBody)
        )) as
          | { ok: true; data: unknown }
          | { ok: false; error: { code: string; [k: string]: unknown } };
      } catch {
        return c.json(
          {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32602,
              message: 'Invalid tool arguments',
              data: {
                code: 'invalid_tool_arguments',
                message: 'Tool handler rejected the request'
              }
            }
          },
          400
        );
      }

      const httpStatus =
        result &&
        typeof result === 'object' &&
        result.ok === false &&
        (result.error?.code === 'scope_conflict' ||
          result.error?.code === 'scope_conflict_self_widening' ||
          result.error?.code === 'idempotency_collision')
          ? 409
          : 200;

      const rpcResponse = {
        jsonrpc: '2.0',
        id: id ?? null,
        result
      };

      const respHeaders: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (clientProtocolVersion) {
        respHeaders['MCP-Protocol-Version'] = clientProtocolVersion;
      }

      return new Response(JSON.stringify(rpcResponse), {
        status: httpStatus,
        headers: respHeaders
      });
    }

    // Unknown method — auth gate already ran above for non-allowlisted methods.
    return c.json(
      {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32601, message: `Method not found: ${method ?? ''}` }
      },
      404
    );
  });

  // DELETE /mcp — terminate MCP session (auth required)
  app.delete('/mcp', async (c) => {
    const sessionId = c.req.header('MCP-Session-Id');
    if (!sessionId) {
      return c.json({ error: 'session_id_required' }, 400);
    }
    if (!mcpSessions.has(sessionId)) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    if (!validateOrigin(c.req.raw)) {
      return c.json({ error: 'forbidden_origin' }, 403);
    }

    // Auth gate: DELETE /mcp ('session/delete') is not in UNAUTH_MCP_METHODS — auth required.
    {
      const isProd = !!(db && jwtSecret);
      if (!isProd) {
        if (process.env.TEAMEM_ALLOW_NO_AUTH !== '1') {
          return c.json(
            {
              error: 'auth_unavailable',
              detail:
                'Server has db but no jwtSecret. Set TEAMEM_JWT_SECRET or TEAMEM_ALLOW_NO_AUTH=1.'
            },
            503
          );
        }
        // Dev mode: skip JWT auth.
      } else {
        const inner = createRequireMemberMiddleware(jwtSecret!, db!);
        let memberPassed = false;
        const innerResp = await inner(c, async () => {
          memberPassed = true;
        });
        if (!memberPassed) {
          return innerResp as Response;
        }
        // Principal-match: the verified JWT principal must own this session (existing per-session authorization).
        const m = c.get('member') as AuthedMember | undefined;
        const sess = mcpSessions.get(sessionId);
        if (m && sess && sess.principal && m.principal !== sess.principal) {
          return c.json({ error: 'forbidden' }, 403);
        }
      }
    }

    mcpSessions.delete(sessionId);
    return new Response(null, { status: 204 });
  });

  // --- /tools routes ---
  app.post('/tools/:name', async (c) => {
    const name = c.req.param('name') as keyof typeof registry;
    const handler = registry[name];

    if (!handler || typeof handler !== 'function') {
      return c.json({ error: 'tool_not_found', tool: name }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // AC22: reject top-level `repo_id` — clients must rely on JWT-extracted
    // space_id. Note `payload.repo_id` (nested inside publish_event payload)
    // is allowed as optional event metadata per plan §2 req 6.
    //
    // ADR-0008 §5 carve-out: repo-scoped lifecycle tools accept `repo_id` at
    // the top level because a single space spans multiple repos and the
    // principal can hold claims in each. Without this whitelist, gate-claim
    // and post-commit/post-checkout hooks cannot reach the server.
    const REPO_SCOPED_TOOLS = new Set<string>([
      'teamem.claim_scope',
      'teamem.release_scope_via_git',
      'teamem.pause_claims_for_branch',
      'teamem.resume_claims_for_branch',
      'teamem.list_claims',
      'teamem.force_release'
    ]);
    if (
      Object.prototype.hasOwnProperty.call(body, 'repo_id') &&
      !REPO_SCOPED_TOOLS.has(name as string)
    ) {
      return c.json({ error: 'repo_id_unsupported' }, 400);
    }

    // AC22 expansion: reject top-level `space_id` and `principal` in the
    // body. Both are derived exclusively from the verified JWT — silently
    // overriding stale client values would mask integration bugs. Same
    // fail-fast policy as `repo_id`.
    if (db && jwtSecret) {
      if (
        Object.prototype.hasOwnProperty.call(body, 'space_id') ||
        Object.prototype.hasOwnProperty.call(body, 'principal')
      ) {
        return c.json({ error: 'scope_in_body_unsupported' }, 400);
      }

      const member = c.get('member');
      // Inject auth-scope space_id and principal into the tool input so
      // callers don't need to pass them explicitly (Phase 2: tool surface
      // migration).
      if (member) {
        body.space_id = member.space_id;
        body.principal = member.principal;
        // Default actor/delegation to principal-as-actor when not provided.
        // The events table requires both as NOT NULL, but MCP-driven agents
        // rarely supply them. CLI users still set explicit values via
        // --actor / --delegation flags, which take precedence here.
        if (typeof body.actor !== 'string' || body.actor === '') {
          body.actor = member.principal;
        }
        if (typeof body.delegation !== 'string' || body.delegation === '') {
          body.delegation = `${member.principal}->${member.principal}`;
        }
      }
    }

    let result:
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; [k: string]: unknown } };
    try {
      result = (await (handler as (input: unknown) => unknown)(body)) as
        | { ok: true; data: unknown }
        | { ok: false; error: { code: string; [k: string]: unknown } };
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_tool_arguments',
            message: 'Tool handler rejected the request'
          }
        },
        400
      );
    }

    // Phase 2b — map the TOCTOU gate's structured 409 to HTTP 409. The
    // body shape (code, conflicting_claim_id, conflicting_principal,
    // colliding_paths, message) is the wire contract; do not unwrap
    // `details`. All other ok:false cases retain their existing 200
    // mapping (the bridge surfaces the typed error to consumers).
    if (
      result &&
      typeof result === 'object' &&
      result.ok === false &&
      (result.error?.code === 'scope_conflict' ||
        result.error?.code === 'scope_conflict_self_widening' ||
        result.error?.code === 'idempotency_collision' ||
        result.error?.code === 'space_rules_conflict')
    ) {
      return c.json(result, 409);
    }

    return c.json(result);
  });

  return app;
}
