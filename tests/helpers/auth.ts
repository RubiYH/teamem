import { signJwt } from '../../src/server/jwt.js';

export const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';

export async function mintTestJwt(opts: {
  space_id: string;
  member_name: string;
  exp?: number;
}): Promise<string> {
  const jwt = await signJwt(
    { sub: opts.member_name, space_id: opts.space_id },
    TEST_JWT_SECRET
  );
  if (opts.exp !== undefined) {
    // Rebuild with custom exp by signing a raw payload
    const { sign } = await import('hono/jwt');
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        iss: 'teamem-server',
        sub: opts.member_name,
        space_id: opts.space_id,
        jti: 'test-jti',
        iat: now,
        exp: opts.exp
      },
      TEST_JWT_SECRET,
      'HS256'
    );
  }
  return jwt;
}
