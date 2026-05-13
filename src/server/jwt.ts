import { sign, verify } from 'hono/jwt';
import { randomBytes } from 'node:crypto';

export interface JwtClaims {
  iss: string;
  sub: string;
  space_id: string;
  jti: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export const JWT_ISSUER = 'teamem-server';
export const JWT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const EXAMPLE_JWT_SECRETS = new Set(['replace-with-openssl-rand-hex-32']);

export function requireJwtSecret(
  env: Record<string, string | undefined>
): string {
  const secret = env.TEAMEM_JWT_SECRET;
  if (!secret || secret.length < 32 || EXAMPLE_JWT_SECRETS.has(secret)) {
    throw new Error(
      'TEAMEM_JWT_SECRET must be set to a generated secret of at least 32 characters. Server cannot start without it.'
    );
  }
  return secret;
}

export async function signJwt(
  payload: { sub: string; space_id: string },
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    iss: JWT_ISSUER,
    sub: payload.sub,
    space_id: payload.space_id,
    jti: randomBytes(16).toString('hex'),
    iat: now,
    exp: now + JWT_TTL_SECONDS
  };
  return sign(claims as Record<string, unknown>, secret, 'HS256');
}

export async function verifyJwt(
  token: string,
  secret: string
): Promise<JwtClaims | null> {
  try {
    const raw = (await verify(token, secret, 'HS256')) as Record<
      string,
      unknown
    >;
    // Required-claim validation (plan §2 req 7). Reject tokens missing iss/sub/space_id
    // even if the signature is valid. The auth middleware maps null to
    // 'invalid_signature' so existing tests stay green.
    if (raw.iss !== JWT_ISSUER) return null;
    if (typeof raw.sub !== 'string' || raw.sub.length === 0) return null;
    if (typeof raw.space_id !== 'string' || raw.space_id.length === 0)
      return null;
    return raw as unknown as JwtClaims;
  } catch {
    return null;
  }
}
