import type { ToolContext } from './context.js';
import type { ToolResponse } from '../types.js';
import type { CoordPref } from '../../domain/conflicts/coord-pref.js';

export function updateCoordPref(
  ctx: ToolContext,
  input: {
    space_id: string;
    principal: string;
    value: unknown;
  }
): ToolResponse<{ coord_pref: CoordPref }> {
  if (!ctx.isCoordPref(input.value)) {
    return ctx.toolError(
      'invalid_coord_pref',
      'value must be one of auto-skip | auto-discuss'
    );
  }
  const result = ctx.db
    .prepare(
      `UPDATE members
          SET coord_pref = ?1
        WHERE space_id = ?2
          AND name = ?3
          AND left_at IS NULL`
    )
    .run(input.value, input.space_id, input.principal);
  if (result.changes === 0) {
    // Auth middleware would normally reject before reaching here, but
    // a race (member kicked between the auth probe and this UPDATE)
    // could leave us with no row. Surface a typed error rather than
    // silently no-op'ing.
    return ctx.toolError(
      'member_not_found',
      'no active member row matched the caller'
    );
  }
  return { ok: true, data: { coord_pref: input.value } };
}
