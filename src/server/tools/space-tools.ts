import type { ToolContext } from './context.js';
import type { ToolResponse } from '../types.js';

export function spaceLeave(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
  }
): ToolResponse<{ ok: true }> {
  const member = ctx.db
    .prepare(
      `SELECT id FROM members WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL`
    )
    .get(input.space_id, input.principal) as { id: string } | null;
  if (!member) return ctx.toolError('member_not_found', 'no active member row');
  const result = ctx.leaveSpace(ctx.db, { member_id: member.id });
  if (result === 'creator_must_disband')
    return ctx.toolError(
      'creator_must_disband',
      'creators must disband instead of leaving'
    );
  return { ok: true, data: { ok: true } };
}

export function spaceKick(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    member_name: unknown;
  }
): ToolResponse<{ ok: true }> {
  if (typeof input.member_name !== 'string' || input.member_name.length === 0) {
    return ctx.toolError(
      'invalid_member_name',
      'member_name must be a non-empty string'
    );
  }
  const member = ctx.db
    .prepare(
      `SELECT id FROM members WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL`
    )
    .get(input.space_id, input.principal) as { id: string } | null;
  if (!member) return ctx.toolError('member_not_found', 'no active member row');
  const result = ctx.kickMember(ctx.db, {
    requester_member_id: member.id,
    target_member_name: input.member_name
  });
  if (result === 'not_creator')
    return ctx.toolError('not_creator', 'only the creator can kick members');
  if (result === 'cannot_self_kick')
    return ctx.toolError(
      'cannot_self_kick',
      'creators cannot kick themselves; disband instead'
    );
  if (result === 'target_not_found')
    return ctx.toolError('target_not_found', 'no active member with that name');
  return { ok: true, data: { ok: true } };
}

export function spaceRotateCode(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
  }
): ToolResponse<{ room_code: string; rotated_at: string }> {
  // Inlined sync version of `ctx.rotateRoomCode` from spaces.ts. The
  // underlying helper is declared `async` but does no actual await
  // work; the route-layer tool dispatch invokes handlers synchronously,
  // so wrapping a Promise here breaks the `{ ok, data }` contract that
  // every other tool returns.
  const member = ctx.db
    .prepare(
      `SELECT id, space_id, is_creator FROM members WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL`
    )
    .get(input.space_id, input.principal) as {
    id: string;
    space_id: string;
    is_creator: number;
  } | null;
  if (!member) return ctx.toolError('member_not_found', 'no active member row');
  // Creator-only, mirroring POST /spaces/rotate-code: rotation invalidates
  // the standing invite code for everyone, so a non-creator member must not
  // be able to grief pending joins by rotating at will.
  if (member.is_creator !== 1)
    return ctx.toolError(
      'not_creator',
      'only the creator can rotate the room code'
    );
  // Re-implement the ctx.rotateRoomCode body inline (sync). Mirrors the
  // canonical helper one-to-one — same generated code shape, same
  // upsert SQL, same response payload.
  const ROOM_CODE_TTL_SECONDS = 30 * 24 * 60 * 60;
  const expires_at = new Date(
    Date.now() + ROOM_CODE_TTL_SECONDS * 1000
  ).toISOString();
  const rotated_at = new Date().toISOString();
  // generateRoomCode in spaces.ts uses ctx.nanoid(8); inline the same call.
  let room_code: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = ctx.nanoid(8);
    const taken = ctx.db
      .prepare('SELECT 1 FROM room_codes WHERE code = ?')
      .get(candidate);
    if (!taken) {
      room_code = candidate;
      break;
    }
  }
  if (!room_code) {
    return ctx.toolError(
      'room_code_collision',
      'failed to generate unique code'
    );
  }
  ctx.db
    .prepare(
      `INSERT INTO room_codes (space_id, code, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(space_id) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at,
     created_at = datetime('now')`
    )
    .run(member.space_id, room_code, expires_at);
  void ctx.rotateRoomCode; // keep import binding live; helper is canonical reference.
  return { ok: true, data: { room_code, rotated_at } };
}
