import type { Context, Next } from 'hono';

// Plan §2 req 3 + AC18: 10 attempts per 1 minute per IP.
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_ATTEMPTS = 10;

// Bounded with opportunistic sweep + hard cap to prevent unbounded growth
// under IP rotation (e.g., IPv6 /64 randomization or botnet flood) — same
// pattern as the auth_check log buckets in src/server/auth.ts.
const BUCKET_CAP = 50_000;

interface BucketEntry {
  count: number;
  window_start: number;
}

const buckets = new Map<string, BucketEntry>();

function evictIfAtCap(now: number): void {
  if (buckets.size < BUCKET_CAP) return;
  // Sweep entries whose window has expired — best-effort eviction.
  for (const [k, e] of buckets) {
    if (now - e.window_start >= WINDOW_MS) buckets.delete(k);
  }
  // If still at cap (every entry within window), drop the oldest by insertion order.
  if (buckets.size >= BUCKET_CAP) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }
}

// Resolve the client IP for rate-limit bucketing.
//
// Security note: client-supplied `X-Forwarded-For` is trivially spoofable when
// the server is reachable directly. An attacker rotating the header per request
// dodges per-IP throttling. We therefore honor the header ONLY when the
// operator explicitly opts in via `TEAMEM_TRUST_PROXY=1` — set this when the
// server is deployed behind a known reverse proxy (Caddy, nginx, Fly.io, etc.)
// that strips and rewrites the header.
//
// Default (no env): use the actual socket peer address via Bun.serve's
// `requestIP(req)`, which the entrypoint plumbs into `c.env.server`. If the
// server isn't reachable (in-process `app.request()` for unit/integration
// tests), fall back to a constant 'no-ip' bucket — strict but safe.
function getClientIp(c: Context): string {
  const trustProxy = process.env.TEAMEM_TRUST_PROXY === '1';
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for')?.split(',')[0].trim();
    if (xff) return xff;
    const xri = c.req.header('x-real-ip');
    if (xri) return xri;
  }
  // Bun.serve's `server.requestIP(req)` returns `{address, port, family}` or null.
  // Hono's Bun adapter passes the server as the second arg to `app.fetch`,
  // surfacing it via `c.env.server` when entrypoint plumbs it (src/server/index.ts).
  const env = c.env as
    | { server?: { requestIP?: (req: Request) => { address: string } | null } }
    | undefined;
  const peer = env?.server?.requestIP?.(c.req.raw);
  if (peer && peer.address) return peer.address;
  return 'no-ip';
}

/**
 * Records an attempt for the request's client IP and returns `null` when the
 * request is within limits, or the Retry-After value (seconds) when the IP
 * has exceeded MAX_ATTEMPTS in the current window. Shared by the middleware
 * below and by route handlers that need an inline check on a single code
 * path (e.g. the unauthenticated MCP `initialize` branch) without throttling
 * the whole route.
 */
export function checkRateLimit(c: Context): number | null {
  const ip = getClientIp(c);
  const now = Date.now();

  let entry = buckets.get(ip);
  if (!entry || now - entry.window_start >= WINDOW_MS) {
    evictIfAtCap(now);
    entry = { count: 0, window_start: now };
  }

  entry.count += 1;
  buckets.set(ip, entry);

  if (entry.count > MAX_ATTEMPTS) {
    // Compute Retry-After from the bucket's first-attempt timestamp; floor at 1s.
    const msUntilReset = Math.max(0, entry.window_start + WINDOW_MS - now);
    return Math.max(1, Math.ceil(msUntilReset / 1000));
  }
  return null;
}

export function createRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const retryAfter = checkRateLimit(c);
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'rate_limited' }, 429);
    }

    await next();
  };
}

// Exported for tests
export function resetRateLimitBuckets() {
  buckets.clear();
}
