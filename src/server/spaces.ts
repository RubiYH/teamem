import type { Database } from 'bun:sqlite';
import { nanoid } from 'nanoid';
import { ulid } from 'ulidx';
import type { CloudRuntimeSpacePlan } from '../cloud/provisioning-contract.js';
import { signJwt } from './jwt.js';

const ROOM_CODE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_CODE_RETRIES = 3;
export const FREE_TRIAL_EXPIRED_SUSPENSION_REASON = 'free_trial_expired';
export const DISBAND_GRACE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const cloudPolicyColumnCache = new WeakMap<Database, boolean>();

interface MemberRow {
  id: string;
  space_id: string;
  name: string;
  joined_at: string;
  left_at: string | null;
  is_creator: number;
}

interface SpaceRow {
  id: string;
  label: string;
  creator_member_id: string;
  created_at: string;
  disbanded_at: string | null;
  disbanded_grace_until: string | null;
  cloud_provisioning_source?: string | null;
  cloud_control_plane_space_id?: string | null;
  cloud_provisioning_request_id?: string | null;
  cloud_idempotency_key?: string | null;
  cloud_plan?: CloudRuntimeSpacePlan | null;
  cloud_trial_expires_at?: string | null;
  cloud_member_limit?: number | null;
  cloud_suspended_at?: string | null;
  cloud_suspension_reason?: string | null;
}

function generateRoomCode(db: Database): string {
  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    const code = nanoid(8);
    const existing = db
      .prepare('SELECT 1 FROM room_codes WHERE code = ?')
      .get(code);
    if (!existing) return code;
  }
  throw new Error('room_code_collision');
}

export async function createSpace(
  db: Database,
  opts: { label?: string; member_name: string },
  secret: string
): Promise<{
  space_id: string;
  label: string;
  room_code: string;
  member_id: string;
  jwt: string;
}> {
  const space_id = ulid();
  const member_id = ulid();
  // Server is the source of truth for the label. The default `<member>'s space`
  // must round-trip back to the client so `bun run space disband`'s
  // label_confirmation matches what was actually stored (security review P2#3).
  const label = opts.label ?? opts.member_name + "'s space";
  const room_code = generateRoomCode(db);
  const expires_at = new Date(
    Date.now() + ROOM_CODE_TTL_SECONDS * 1000
  ).toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO spaces (id, label, creator_member_id) VALUES (?, ?, ?)`
    ).run(space_id, label, member_id);

    db.prepare(
      `INSERT INTO members (id, space_id, name, is_creator) VALUES (?, ?, ?, 1)`
    ).run(member_id, space_id, opts.member_name);

    db.prepare(
      `INSERT INTO room_codes (space_id, code, expires_at) VALUES (?, ?, ?)`
    ).run(space_id, room_code, expires_at);
  })();

  const jwt = await signJwt({ sub: opts.member_name, space_id }, secret);
  return { space_id, label, room_code, member_id, jwt };
}

export type CloudAdminCreateSpaceInput = {
  label: string;
  idempotencyKey: string;
  controlPlaneSpaceId: string;
  provisioningRequestId: string;
  runtimeServerUrl: string;
  plan: CloudRuntimeSpacePlan;
  trialExpiresAt: string | null;
  memberLimit: number | null;
};

export type CloudAdminCreateSpaceResult = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  label: string;
  roomCode: string;
  runtimeServerUrl: string;
  status: 'active';
  correlation: {
    source: 'teamem-cloud';
    controlPlaneSpaceId: string;
    provisioningRequestId: string;
  };
};

export type CloudAdminCreateSpaceError =
  | 'idempotency_conflict'
  | 'control_plane_space_conflict'
  | 'invalid_policy_metadata';

export type CloudAdminRotateRoomCodeInput = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  idempotencyKey: string;
};

export type CloudAdminRotateRoomCodeResult = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  roomCode: string;
};

export type CloudAdminRotateRoomCodeError =
  | 'space_not_found'
  | 'control_plane_space_mismatch'
  | 'idempotency_conflict'
  | 'space_suspended';

export type CloudAdminSoftDeleteSpaceInput = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  idempotencyKey: string;
  reason: 'owner_requested' | 'quota_reclaim' | 'operator_action';
};

export type CloudAdminSoftDeleteSpaceResult = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  status: 'soft_deleted';
  deletedAt: string;
};

export type CloudAdminSoftDeleteSpaceError =
  | 'space_not_found'
  | 'control_plane_space_mismatch'
  | 'idempotency_conflict';

export type CloudAdminSpaceRuntimeStatusInput = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
};

export type CloudAdminUpdateSpacePolicyInput =
  CloudAdminSpaceRuntimeStatusInput & {
    trialExpiresAt: string;
    memberLimit: number;
  };

export type CloudAdminSpaceRuntimeStatus = {
  controlPlaneSpaceId: string;
  runtimeSpaceId: string;
  plan: CloudRuntimeSpacePlan | null;
  trialExpiresAt: string | null;
  memberLimit: number | null;
  activeUserFacingMemberCount: number;
  suspendedAt: string | null;
  suspensionReason: string | null;
  setupAvailable: boolean;
  controlsAvailable: boolean;
};

export type CloudAdminSpaceRuntimeStatusError =
  | 'space_not_found'
  | 'control_plane_space_mismatch';

export type CloudAdminUpdateSpacePolicyError =
  | CloudAdminSpaceRuntimeStatusError
  | 'invalid_policy_metadata';

export type SpaceSuspended = {
  error: 'space_suspended';
  reason: string;
};

export function createCloudAdminSpace(
  db: Database,
  opts: CloudAdminCreateSpaceInput
): CloudAdminCreateSpaceResult | CloudAdminCreateSpaceError {
  if (!isValidCloudAdminSpacePolicyMetadata(opts)) {
    return 'invalid_policy_metadata';
  }

  return db
    .transaction(() => {
      const existingByIdempotencyKey = db
        .prepare(
          `SELECT s.id, s.label, s.cloud_control_plane_space_id, s.cloud_provisioning_request_id,
                  s.cloud_plan, s.cloud_trial_expires_at, s.cloud_member_limit,
                  rc.code AS room_code
             FROM spaces s
             JOIN room_codes rc ON rc.space_id = s.id
            WHERE s.cloud_idempotency_key = ?1`
        )
        .get(opts.idempotencyKey) as
        | {
            id: string;
            label: string;
            cloud_control_plane_space_id: string;
            cloud_provisioning_request_id: string;
            cloud_plan: CloudRuntimeSpacePlan | null;
            cloud_trial_expires_at: string | null;
            cloud_member_limit: number | null;
            room_code: string;
          }
        | undefined;

      if (existingByIdempotencyKey) {
        if (
          existingByIdempotencyKey.cloud_control_plane_space_id !==
            opts.controlPlaneSpaceId ||
          existingByIdempotencyKey.cloud_provisioning_request_id !==
            opts.provisioningRequestId ||
          existingByIdempotencyKey.label !== opts.label ||
          existingByIdempotencyKey.cloud_plan !== opts.plan ||
          existingByIdempotencyKey.cloud_trial_expires_at !==
            opts.trialExpiresAt ||
          existingByIdempotencyKey.cloud_member_limit !== opts.memberLimit
        ) {
          return 'idempotency_conflict' as const;
        }
        return buildCloudAdminCreateSpaceResult({
          runtimeSpaceId: existingByIdempotencyKey.id,
          label: existingByIdempotencyKey.label,
          roomCode: existingByIdempotencyKey.room_code,
          runtimeServerUrl: opts.runtimeServerUrl,
          controlPlaneSpaceId: opts.controlPlaneSpaceId,
          provisioningRequestId: opts.provisioningRequestId
        });
      }

      const existingByControlPlaneId = db
        .prepare(
          `SELECT 1
             FROM spaces
            WHERE cloud_control_plane_space_id = ?1`
        )
        .get(opts.controlPlaneSpaceId);
      if (existingByControlPlaneId) {
        return 'control_plane_space_conflict' as const;
      }

      const space_id = ulid();
      const member_id = ulid();
      const room_code = generateRoomCode(db);
      const expires_at = new Date(
        Date.now() + ROOM_CODE_TTL_SECONDS * 1000
      ).toISOString();

      db.prepare(
        `INSERT INTO spaces (
          id,
          label,
          creator_member_id,
          cloud_provisioning_source,
          cloud_control_plane_space_id,
          cloud_provisioning_request_id,
          cloud_idempotency_key,
          cloud_plan,
          cloud_trial_expires_at,
          cloud_member_limit,
          cloud_suspended_at,
          cloud_suspension_reason
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
      ).run(
        space_id,
        opts.label,
        member_id,
        'teamem-cloud',
        opts.controlPlaneSpaceId,
        opts.provisioningRequestId,
        opts.idempotencyKey,
        opts.plan,
        opts.trialExpiresAt,
        opts.memberLimit,
        null,
        null
      );

      db.prepare(
        `INSERT INTO members (id, space_id, name, is_creator) VALUES (?, ?, ?, 1)`
      ).run(member_id, space_id, 'teamem-cloud');

      db.prepare(
        `INSERT INTO member_system_markers (member_id, space_id, marker)
         VALUES (?1, ?2, ?3)`
      ).run(member_id, space_id, 'cloud_bootstrap');

      db.prepare(
        `INSERT INTO room_codes (space_id, code, expires_at) VALUES (?, ?, ?)`
      ).run(space_id, room_code, expires_at);

      return buildCloudAdminCreateSpaceResult({
        runtimeSpaceId: space_id,
        label: opts.label,
        roomCode: room_code,
        runtimeServerUrl: opts.runtimeServerUrl,
        controlPlaneSpaceId: opts.controlPlaneSpaceId,
        provisioningRequestId: opts.provisioningRequestId
      });
    })
    .immediate();
}

function isValidCloudAdminSpacePolicyMetadata(
  opts: CloudAdminCreateSpaceInput
): boolean {
  if (!['free', 'team', 'enterprise'].includes(opts.plan)) {
    return false;
  }

  if (opts.plan === 'free') {
    const memberLimit = opts.memberLimit;
    return (
      typeof opts.trialExpiresAt === 'string' &&
      Number.isFinite(Date.parse(opts.trialExpiresAt)) &&
      typeof memberLimit === 'number' &&
      Number.isInteger(memberLimit) &&
      memberLimit > 0
    );
  }

  return opts.trialExpiresAt === null && opts.memberLimit === null;
}

export function rotateCloudAdminRoomCode(
  db: Database,
  opts: CloudAdminRotateRoomCodeInput
): CloudAdminRotateRoomCodeResult | CloudAdminRotateRoomCodeError {
  return db
    .transaction(() => {
      const requestJson = JSON.stringify({
        controlPlaneSpaceId: opts.controlPlaneSpaceId,
        runtimeSpaceId: opts.runtimeSpaceId
      });
      const existingIdempotency = db
        .prepare(
          `SELECT request_json, response_json
             FROM cloud_admin_room_code_rotations
            WHERE idempotency_key = ?1`
        )
        .get(opts.idempotencyKey) as
        | { request_json: string; response_json: string }
        | undefined;

      if (existingIdempotency) {
        if (existingIdempotency.request_json !== requestJson) {
          return 'idempotency_conflict' as const;
        }
        return JSON.parse(
          existingIdempotency.response_json
        ) as CloudAdminRotateRoomCodeResult;
      }

      const space = db
        .prepare(
          `SELECT id, cloud_control_plane_space_id
             FROM spaces
            WHERE id = ?1
              AND cloud_provisioning_source = 'teamem-cloud'
              AND disbanded_at IS NULL`
        )
        .get(opts.runtimeSpaceId) as
        | { id: string; cloud_control_plane_space_id: string | null }
        | undefined;

      if (!space) {
        return 'space_not_found' as const;
      }
      if (space.cloud_control_plane_space_id !== opts.controlPlaneSpaceId) {
        return 'control_plane_space_mismatch' as const;
      }
      const suspension = applyCloudFreeTrialSuspensionIfExpired(db, space.id);
      if (suspension) {
        return 'space_suspended' as const;
      }

      const roomCode = generateRoomCode(db);
      const expiresAt = new Date(
        Date.now() + ROOM_CODE_TTL_SECONDS * 1000
      ).toISOString();

      db.prepare(
        `INSERT INTO room_codes (space_id, code, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(space_id) DO UPDATE SET
           code = excluded.code,
           expires_at = excluded.expires_at,
           created_at = datetime('now')`
      ).run(space.id, roomCode, expiresAt);

      const result = {
        controlPlaneSpaceId: opts.controlPlaneSpaceId,
        runtimeSpaceId: space.id,
        roomCode
      };
      db.prepare(
        `INSERT INTO cloud_admin_room_code_rotations (
          idempotency_key,
          space_id,
          control_plane_space_id,
          room_code,
          request_json,
          response_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).run(
        opts.idempotencyKey,
        space.id,
        opts.controlPlaneSpaceId,
        roomCode,
        requestJson,
        JSON.stringify(result)
      );

      return result;
    })
    .immediate();
}

export function softDeleteCloudAdminSpace(
  db: Database,
  opts: CloudAdminSoftDeleteSpaceInput
): CloudAdminSoftDeleteSpaceResult | CloudAdminSoftDeleteSpaceError {
  return db
    .transaction(() => {
      const requestJson = JSON.stringify({
        controlPlaneSpaceId: opts.controlPlaneSpaceId,
        runtimeSpaceId: opts.runtimeSpaceId,
        reason: opts.reason
      });
      const existingIdempotency = db
        .prepare(
          `SELECT request_json, response_json
             FROM cloud_admin_space_soft_deletions
            WHERE idempotency_key = ?1`
        )
        .get(opts.idempotencyKey) as
        | { request_json: string; response_json: string }
        | undefined;

      if (existingIdempotency) {
        if (existingIdempotency.request_json !== requestJson) {
          return 'idempotency_conflict' as const;
        }
        return JSON.parse(
          existingIdempotency.response_json
        ) as CloudAdminSoftDeleteSpaceResult;
      }

      const space = db
        .prepare(
          `SELECT id, cloud_control_plane_space_id, disbanded_at
             FROM spaces
            WHERE id = ?1
              AND cloud_provisioning_source = 'teamem-cloud'`
        )
        .get(opts.runtimeSpaceId) as
        | {
            id: string;
            cloud_control_plane_space_id: string | null;
            disbanded_at: string | null;
          }
        | undefined;

      if (!space) {
        return 'space_not_found' as const;
      }
      if (space.cloud_control_plane_space_id !== opts.controlPlaneSpaceId) {
        return 'control_plane_space_mismatch' as const;
      }

      const deletedAt = space.disbanded_at ?? new Date().toISOString();
      const graceUntil = new Date(
        Date.now() + DISBAND_GRACE_SECONDS * 1000
      ).toISOString();
      db.prepare(
        `UPDATE spaces
            SET disbanded_at = ?2,
                disbanded_grace_until = ?3
          WHERE id = ?1 AND disbanded_at IS NULL`
      ).run(space.id, deletedAt, graceUntil);

      const result: CloudAdminSoftDeleteSpaceResult = {
        controlPlaneSpaceId: opts.controlPlaneSpaceId,
        runtimeSpaceId: space.id,
        status: 'soft_deleted',
        deletedAt
      };
      db.prepare(
        `INSERT INTO cloud_admin_space_soft_deletions (
          idempotency_key,
          space_id,
          control_plane_space_id,
          reason,
          request_json,
          response_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).run(
        opts.idempotencyKey,
        space.id,
        opts.controlPlaneSpaceId,
        opts.reason,
        requestJson,
        JSON.stringify(result)
      );

      return result;
    })
    .immediate();
}

function buildCloudAdminCreateSpaceResult(input: {
  runtimeSpaceId: string;
  label: string;
  roomCode: string;
  runtimeServerUrl: string;
  controlPlaneSpaceId: string;
  provisioningRequestId: string;
}): CloudAdminCreateSpaceResult {
  return {
    controlPlaneSpaceId: input.controlPlaneSpaceId,
    runtimeSpaceId: input.runtimeSpaceId,
    label: input.label,
    roomCode: input.roomCode,
    runtimeServerUrl: input.runtimeServerUrl,
    status: 'active',
    correlation: {
      source: 'teamem-cloud',
      controlPlaneSpaceId: input.controlPlaneSpaceId,
      provisioningRequestId: input.provisioningRequestId
    }
  };
}

export type JoinError =
  | 'invalid_code'
  | 'code_expired'
  | 'name_taken'
  | 'space_disbanded';

export type SpaceMemberLimitReached = {
  error: 'space_member_limit_reached';
  member_limit: number;
  active_member_count: number;
};

type JoinSuccess = {
  space_id: string;
  label: string;
  member_id: string;
  jwt: string;
};

type PendingJoinSuccess = Omit<JoinSuccess, 'jwt'> & {
  member_name: string;
};

export function countActiveUserFacingMembers(
  db: Database,
  space_id: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM members
        WHERE space_id = ?1
          AND left_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM member_system_markers msm
             WHERE msm.member_id = members.id
          )`
    )
    .get(space_id) as { count: number };
  return row.count;
}

export function getCloudAdminSpaceRuntimeStatus(
  db: Database,
  input: CloudAdminSpaceRuntimeStatusInput
): CloudAdminSpaceRuntimeStatus | CloudAdminSpaceRuntimeStatusError {
  const row = db
    .prepare(
      `SELECT id, cloud_control_plane_space_id, cloud_plan,
              cloud_trial_expires_at, cloud_member_limit,
              cloud_suspended_at, cloud_suspension_reason,
              disbanded_at
         FROM spaces
        WHERE id = ?1
          AND cloud_provisioning_source = 'teamem-cloud'`
    )
    .get(input.runtimeSpaceId) as
    | {
        id: string;
        cloud_control_plane_space_id: string | null;
        cloud_plan: CloudRuntimeSpacePlan | null;
        cloud_trial_expires_at: string | null;
        cloud_member_limit: number | null;
        cloud_suspended_at: string | null;
        cloud_suspension_reason: string | null;
        disbanded_at: string | null;
      }
    | undefined;

  if (!row) {
    return 'space_not_found';
  }
  if (row.cloud_control_plane_space_id !== input.controlPlaneSpaceId) {
    return 'control_plane_space_mismatch';
  }
  const suspension = applyCloudFreeTrialSuspensionIfExpired(db, row.id);
  if (suspension) {
    row.cloud_suspended_at = suspension.suspendedAt;
    row.cloud_suspension_reason = suspension.suspensionReason;
  }

  const available =
    row.disbanded_at === null && row.cloud_suspended_at === null;

  return {
    controlPlaneSpaceId: input.controlPlaneSpaceId,
    runtimeSpaceId: row.id,
    plan: row.cloud_plan,
    trialExpiresAt: row.cloud_trial_expires_at,
    memberLimit: row.cloud_member_limit,
    activeUserFacingMemberCount: countActiveUserFacingMembers(db, row.id),
    suspendedAt: row.cloud_suspended_at,
    suspensionReason: row.cloud_suspension_reason,
    setupAvailable: available,
    controlsAvailable: available
  };
}

export function updateCloudAdminSpaceRuntimePolicy(
  db: Database,
  input: CloudAdminUpdateSpacePolicyInput
): CloudAdminSpaceRuntimeStatus | CloudAdminUpdateSpacePolicyError {
  if (!isValidResolvedFreePolicy(input)) {
    return 'invalid_policy_metadata';
  }

  return db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT id, cloud_control_plane_space_id, cloud_plan,
                  cloud_suspended_at, cloud_suspension_reason,
                  disbanded_at
             FROM spaces
            WHERE id = ?1
              AND cloud_provisioning_source = 'teamem-cloud'`
        )
        .get(input.runtimeSpaceId) as
        | {
            id: string;
            cloud_control_plane_space_id: string | null;
            cloud_plan: CloudRuntimeSpacePlan | null;
            cloud_suspended_at: string | null;
            cloud_suspension_reason: string | null;
            disbanded_at: string | null;
          }
        | undefined;

      if (!row) {
        return 'space_not_found' as const;
      }
      if (row.cloud_control_plane_space_id !== input.controlPlaneSpaceId) {
        return 'control_plane_space_mismatch' as const;
      }

      const clearsExpiredTrialSuspension =
        row.cloud_suspended_at !== null &&
        row.cloud_suspension_reason === FREE_TRIAL_EXPIRED_SUSPENSION_REASON &&
        new Date(input.trialExpiresAt) > new Date();

      db.prepare(
        `UPDATE spaces
            SET cloud_plan = 'free',
                cloud_trial_expires_at = ?2,
                cloud_member_limit = ?3,
                cloud_suspended_at = CASE
                  WHEN ?4 = 1 THEN NULL
                  ELSE cloud_suspended_at
                END,
                cloud_suspension_reason = CASE
                  WHEN ?4 = 1 THEN NULL
                  ELSE cloud_suspension_reason
                END
          WHERE id = ?1`
      ).run(
        input.runtimeSpaceId,
        input.trialExpiresAt,
        input.memberLimit,
        clearsExpiredTrialSuspension ? 1 : 0
      );

      const status = getCloudAdminSpaceRuntimeStatus(db, input);
      if (typeof status === 'string') {
        return status;
      }
      return status;
    })
    .immediate();
}

function isValidResolvedFreePolicy(input: {
  trialExpiresAt: string;
  memberLimit: number;
}): boolean {
  return (
    typeof input.trialExpiresAt === 'string' &&
    Number.isFinite(Date.parse(input.trialExpiresAt)) &&
    typeof input.memberLimit === 'number' &&
    Number.isInteger(input.memberLimit) &&
    input.memberLimit > 0
  );
}

export async function joinSpace(
  db: Database,
  opts: { room_code: string; member_name: string },
  secret: string
): Promise<JoinSuccess | JoinError | SpaceMemberLimitReached | SpaceSuspended> {
  const pending = db
    .transaction(
      ():
        | PendingJoinSuccess
        | JoinError
        | SpaceMemberLimitReached
        | SpaceSuspended => {
        // Codex F27 — JOIN against `spaces` so we can refuse joins for tombstoned
        // spaces. `/spaces/join` is unauthenticated (the room code IS the auth),
        // so it never hits the JWT middleware that 410s disbanded spaces. Without
        // this filter, a leaked room code admits a member during the 7-day
        // grace; a subsequent `/teamem-restore` reactivates that membership.
        const codeRow = db
          .prepare(
            `SELECT rc.space_id, rc.expires_at,
                  s.label, s.disbanded_at, s.cloud_provisioning_source,
                  s.cloud_plan, s.cloud_trial_expires_at,
                  s.cloud_member_limit, s.cloud_suspended_at,
                  s.cloud_suspension_reason
             FROM room_codes rc
             JOIN spaces s ON s.id = rc.space_id
            WHERE rc.code = ?`
          )
          .get(opts.room_code) as {
          space_id: string;
          expires_at: string;
          label: string;
          disbanded_at: string | null;
          cloud_provisioning_source: string | null;
          cloud_plan: CloudRuntimeSpacePlan | null;
          cloud_trial_expires_at: string | null;
          cloud_member_limit: number | null;
          cloud_suspended_at: string | null;
          cloud_suspension_reason: string | null;
        } | null;

        if (!codeRow) return 'invalid_code';
        // F27 fix: refuse joins to tombstoned spaces during the grace window.
        // The route layer maps this to 410, mirroring the JWT auth middleware.
        if (codeRow.disbanded_at) return 'space_disbanded';
        const suspension = applyCloudFreeTrialSuspensionIfExpired(
          db,
          codeRow.space_id
        );
        if (suspension) {
          return {
            error: 'space_suspended',
            reason: suspension.suspensionReason
          };
        }
        if (new Date(codeRow.expires_at) <= new Date()) return 'code_expired';

        const space_id = codeRow.space_id;

        // Check name uniqueness among active members.
        const taken = db
          .prepare(
            `SELECT 1 FROM members
            WHERE space_id = ?1 AND name = ?2 AND left_at IS NULL`
          )
          .get(space_id, opts.member_name);
        if (taken) return 'name_taken';

        const activeMemberCount = countActiveUserFacingMembers(db, space_id);
        if (
          codeRow.cloud_provisioning_source === 'teamem-cloud' &&
          codeRow.cloud_plan === 'free' &&
          typeof codeRow.cloud_member_limit === 'number' &&
          activeMemberCount >= codeRow.cloud_member_limit
        ) {
          return {
            error: 'space_member_limit_reached',
            member_limit: codeRow.cloud_member_limit,
            active_member_count: activeMemberCount
          };
        }

        const member_id = ulid();
        try {
          db.prepare(
            `INSERT INTO members (id, space_id, name, is_creator)
           VALUES (?, ?, ?, 0)`
          ).run(member_id, space_id, opts.member_name);
        } catch (err) {
          // Concurrent join with same (space_id, member_name) racing past the
          // SELECT. idx_members_space_name_active (partial unique index) catches
          // it here.
          if (
            err instanceof Error &&
            /UNIQUE constraint failed: idx_members_space_name_active|UNIQUE constraint failed: members\.space_id, members\.name/.test(
              err.message
            )
          ) {
            return 'name_taken';
          }
          throw err;
        }

        // Surface the space label so the joiner's local credential entry matches
        // the server-side authoritative value (security review P2#3).
        return {
          space_id,
          label: codeRow.label,
          member_id,
          member_name: opts.member_name
        };
      }
    )
    .immediate();

  if (typeof pending === 'string' || 'error' in pending) {
    return pending;
  }

  const jwt = await signJwt(
    { sub: pending.member_name, space_id: pending.space_id },
    secret
  );
  return {
    space_id: pending.space_id,
    label: pending.label,
    member_id: pending.member_id,
    jwt
  };
}

export function applyCloudFreeTrialSuspensionIfExpired(
  db: Database,
  spaceId: string,
  nowIso = new Date().toISOString()
): { suspendedAt: string; suspensionReason: string } | null {
  if (!hasCloudPolicyColumns(db)) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT id, cloud_provisioning_source, cloud_plan,
              cloud_trial_expires_at, cloud_suspended_at,
              cloud_suspension_reason, disbanded_at
         FROM spaces
        WHERE id = ?1`
    )
    .get(spaceId) as
    | {
        id: string;
        cloud_provisioning_source: string | null;
        cloud_plan: CloudRuntimeSpacePlan | null;
        cloud_trial_expires_at: string | null;
        cloud_suspended_at: string | null;
        cloud_suspension_reason: string | null;
        disbanded_at: string | null;
      }
    | undefined;

  if (!row || row.cloud_provisioning_source !== 'teamem-cloud') {
    return null;
  }

  if (row.cloud_suspended_at) {
    return {
      suspendedAt: row.cloud_suspended_at,
      suspensionReason:
        row.cloud_suspension_reason ?? FREE_TRIAL_EXPIRED_SUSPENSION_REASON
    };
  }

  if (
    row.disbanded_at !== null ||
    row.cloud_plan !== 'free' ||
    typeof row.cloud_trial_expires_at !== 'string' ||
    !Number.isFinite(Date.parse(row.cloud_trial_expires_at)) ||
    new Date(row.cloud_trial_expires_at) > new Date(nowIso)
  ) {
    return null;
  }

  db.prepare(
    `UPDATE spaces
        SET cloud_suspended_at = ?2,
            cloud_suspension_reason = ?3
      WHERE id = ?1
        AND cloud_suspended_at IS NULL`
  ).run(spaceId, nowIso, FREE_TRIAL_EXPIRED_SUSPENSION_REASON);

  const updated = db
    .prepare(
      `SELECT cloud_suspended_at, cloud_suspension_reason
         FROM spaces
        WHERE id = ?1`
    )
    .get(spaceId) as {
    cloud_suspended_at: string;
    cloud_suspension_reason: string | null;
  };

  return {
    suspendedAt: updated.cloud_suspended_at,
    suspensionReason:
      updated.cloud_suspension_reason ?? FREE_TRIAL_EXPIRED_SUSPENSION_REASON
  };
}

function hasCloudPolicyColumns(db: Database): boolean {
  const cached = cloudPolicyColumnCache.get(db);
  if (cached !== undefined) {
    return cached;
  }

  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(spaces)').all() as Array<{ name: string }>
    ).map((column) => column.name)
  );
  const hasColumns =
    columns.has('cloud_provisioning_source') &&
    columns.has('cloud_plan') &&
    columns.has('cloud_trial_expires_at') &&
    columns.has('cloud_suspended_at') &&
    columns.has('cloud_suspension_reason');
  cloudPolicyColumnCache.set(db, hasColumns);
  return hasColumns;
}

export type LeaveError = 'creator_must_disband';

export function leaveSpace(
  db: Database,
  opts: { member_id: string }
): 'ok' | LeaveError {
  const member = db
    .prepare(`SELECT is_creator FROM members WHERE id = ? AND left_at IS NULL`)
    .get(opts.member_id) as Pick<MemberRow, 'is_creator'> | null;

  if (!member) return 'ok'; // already gone
  if (member.is_creator) return 'creator_must_disband';

  db.prepare(`UPDATE members SET left_at = datetime('now') WHERE id = ?`).run(
    opts.member_id
  );
  return 'ok';
}

export type KickError = 'not_creator' | 'cannot_self_kick' | 'target_not_found';

export function kickMember(
  db: Database,
  opts: { requester_member_id: string; target_member_name: string }
): 'ok' | KickError {
  const requester = db
    .prepare(
      `SELECT id, space_id, is_creator FROM members WHERE id = ? AND left_at IS NULL`
    )
    .get(opts.requester_member_id) as Pick<
    MemberRow,
    'id' | 'space_id' | 'is_creator'
  > | null;

  if (!requester) return 'not_creator';
  if (!requester.is_creator) return 'not_creator';

  const target = db
    .prepare(
      `SELECT id, name FROM members WHERE space_id = ? AND name = ? AND left_at IS NULL`
    )
    .get(requester.space_id, opts.target_member_name) as Pick<
    MemberRow,
    'id' | 'name'
  > | null;

  if (!target) return 'target_not_found';
  if (target.id === requester.id) return 'cannot_self_kick';

  db.prepare(`UPDATE members SET left_at = datetime('now') WHERE id = ?`).run(
    target.id
  );
  return 'ok';
}

export type DisbandError = 'not_creator';

/**
 * Soft-disband (ADR-0004). Sets `disbanded_at = now` and
 * `disbanded_grace_until = now + 7 days`. Data is retained for the grace
 * window; the creator can call `restoreSpace` to undo. The periodic GC
 * sweep (`gcDisbandedSpaces`) hard-cascades after grace expires.
 *
 * JWT rejection is immediate regardless of grace state — the existing auth
 * middleware filter `s.disbanded_at IS NULL` already gates `410
 * space_disbanded`.
 */
export function disbandSpace(
  db: Database,
  opts: { requester_member_id: string }
): 'ok' | DisbandError {
  const requester = db
    .prepare(
      `SELECT space_id, is_creator FROM members WHERE id = ? AND left_at IS NULL`
    )
    .get(opts.requester_member_id) as Pick<
    MemberRow,
    'space_id' | 'is_creator'
  > | null;

  if (!requester || !requester.is_creator) return 'not_creator';

  const space_id = requester.space_id;
  const graceUntil = new Date(
    Date.now() + DISBAND_GRACE_SECONDS * 1000
  ).toISOString();

  db.prepare(
    `UPDATE spaces
        SET disbanded_at = datetime('now'),
            disbanded_grace_until = ?2
      WHERE id = ?1 AND disbanded_at IS NULL`
  ).run(space_id, graceUntil);
  return 'ok';
}

export type RestoreError = 'not_creator' | 'not_disbanded' | 'expired';

/**
 * Restore a soft-disbanded space within its grace window. Wrapped in
 * `BEGIN IMMEDIATE` so a concurrent GC sweep cannot hard-delete the same
 * row mid-flight (Pre-mortem F4).
 */
export function restoreSpace(
  db: Database,
  opts: { requester_member_id: string }
): 'ok' | RestoreError {
  const requester = db
    .prepare(
      // The auth middleware rejects disbanded spaces, so the requester must
      // resolve their membership via members.id directly (the JOIN through
      // spaces would filter the row out). The creator's row stays alive
      // through soft-disband; only when GC fires does the row vanish.
      `SELECT space_id, is_creator FROM members WHERE id = ?`
    )
    .get(opts.requester_member_id) as Pick<
    MemberRow,
    'space_id' | 'is_creator'
  > | null;

  if (!requester || !requester.is_creator) return 'not_creator';

  const space_id = requester.space_id;

  return db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT disbanded_at, disbanded_grace_until FROM spaces WHERE id = ?`
        )
        .get(space_id) as
        | { disbanded_at: string | null; disbanded_grace_until: string | null }
        | undefined;

      if (!row || row.disbanded_at === null) return 'not_disbanded' as const;
      if (
        !row.disbanded_grace_until ||
        new Date(row.disbanded_grace_until) <= new Date()
      ) {
        return 'expired' as const;
      }

      db.prepare(
        `UPDATE spaces
            SET disbanded_at = NULL,
                disbanded_grace_until = NULL
          WHERE id = ?`
      ).run(space_id);
      return 'ok' as const;
    })
    .immediate();
}

/**
 * Periodic sweep (called from the server's scheduler) that hard-cascades
 * any space whose grace window has expired. The cascade runs inside
 * `BEGIN IMMEDIATE` so a parallel restore is serialised at BEGIN — only
 * one of restore-vs-GC commits its UPDATE.
 *
 * Returns the list of space_ids that were swept.
 */
export function gcDisbandedSpaces(db: Database): string[] {
  const candidates = db
    .prepare(
      `SELECT id
         FROM spaces
        WHERE disbanded_at IS NOT NULL
          AND disbanded_grace_until IS NOT NULL
          AND disbanded_grace_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    .all() as Array<{ id: string }>;

  const swept: string[] = [];
  for (const { id: space_id } of candidates) {
    const wasSwept = db
      .transaction(() => {
        // Re-read inside the immediate tx so a restore that just committed
        // is visible. If the grace cleared (restore won) or vanished entirely,
        // skip — restore wins.
        const row = db
          .prepare(
            `SELECT disbanded_at, disbanded_grace_until FROM spaces WHERE id = ?`
          )
          .get(space_id) as
          | {
              disbanded_at: string | null;
              disbanded_grace_until: string | null;
            }
          | undefined;
        if (
          !row ||
          row.disbanded_at === null ||
          !row.disbanded_grace_until ||
          new Date(row.disbanded_grace_until) > new Date()
        ) {
          return false;
        }
        // Hard cascade: idempotency_keys FIRST (their FK target is `events`,
        // and the row predicate is `event_id IN (SELECT … FROM events …)` —
        // events must still exist when we resolve those IDs). Codex F1 +
        // F3: delete keys before events; iterate `HARD_CASCADE_TABLES` to
        // catch every space-scoped projection (no orphan tenant data).
        db.prepare(
          `DELETE FROM idempotency_keys
            WHERE event_id IN (SELECT event_id FROM events WHERE space_id = ?)`
        ).run(space_id);
        db.prepare(`DELETE FROM events WHERE space_id = ?`).run(space_id);
        for (const table of HARD_CASCADE_TABLES) {
          db.prepare(`DELETE FROM ${table} WHERE space_id = ?`).run(space_id);
        }
        db.prepare(`DELETE FROM member_system_markers WHERE space_id = ?`).run(
          space_id
        );
        db.prepare(`DELETE FROM members WHERE space_id = ?`).run(space_id);
        db.prepare(`DELETE FROM spaces WHERE id = ?`).run(space_id);
        return true;
      })
      .immediate();
    if (wasSwept) swept.push(space_id);
  }
  return swept;
}

// Projection tables that carry the soft-wipe `tombstoned_at` column. Every
// space-scoped projection ships its table name here so wipe/unwipe iterate
// a single source of truth. `events`, `cursors`, `idempotency_keys`,
// `members`, `spaces`, and `room_codes` are intentionally excluded:
//   - events / idempotency_keys: source of truth, not projection rows.
//   - cursors / members / spaces / room_codes: auth-layer concerns.
//
// Cross-checked against `grep -l 'tombstoned_at' src/infra/db/migrations/`:
//   006_pending_edits, 013_projection_tombstones (claims/decisions/blockers/
//   discussions/contracts/task_state), 014_findings, 015_artifacts,
//   016_permission_requests, 017_disputes, 018_focus.
const TOMBSTONED_PROJECTION_TABLES = [
  'claims',
  'decisions',
  'blockers',
  'discussions',
  'contracts',
  'task_state',
  'pending_edits',
  'findings',
  'artifacts',
  'permission_requests',
  'disputes',
  'focus'
] as const;

// Tables that must be hard-deleted when a space is destroyed (disband-grace
// expiry GC OR `wipeSpace({hard:true})`). One source of truth — fixes Codex
// F3 (disband GC orphans) and ensures hard-wipe + GC stay in lockstep.
//
// Order matters for two reasons:
//   1. `idempotency_keys.event_id` references events; we look those keys up
//      via the events table BEFORE deleting events themselves.
//   2. `events` carries the source-of-truth event log; its delete comes after
//      idempotency_keys.
//
// `spaces` is NOT in this list — `gcDisbandedSpaces` deletes `spaces` itself
// at the very end of its tx; `wipeSpace({hard:true})` preserves it so the
// auth middleware can still resolve the creator's membership.
// `space_rules_snapshots` has no soft-wipe tombstone; it is durable Space
// state during soft wipes, but hard delete / disband GC must remove it to
// avoid tenant-data orphans. The same rule applies to the newer
// space-scoped tables that do not have tombstone semantics:
// discussion_threads, decision_history, finding_acknowledgements, and
// unread_notifications.
const HARD_CASCADE_TABLES = [
  ...TOMBSTONED_PROJECTION_TABLES,
  'space_rules_snapshots',
  'discussion_threads',
  'decision_history',
  'finding_acknowledgements',
  'unread_notifications',
  'cursors',
  'room_codes',
  'cloud_admin_room_code_rotations',
  'cloud_admin_space_soft_deletions'
] as const;

export type WipeError = 'not_creator' | 'space_disbanded';

/**
 * Soft-wipe (default) or hard-wipe a space.
 *
 * **Soft** (`hard: false` / default): set `tombstoned_at = now` on every
 * projection row in the space and append a `space_wiped` event. Briefing
 * and read queries gate on `tombstoned_at IS NULL`, so the space appears
 * empty until an `unwipeSpace` call clears the tombstones.
 *
 * **Hard** (`hard: true`): delete every event + every projection row for
 * the space, irreversibly. The `spaces` row itself is preserved so the
 * auth middleware can still resolve membership and emit a clean response.
 * The caller is responsible for typed-label confirmation at the route
 * layer (mirror of disband). Hard-wipe cannot be reversed by `unwipeSpace`.
 *
 * Atomic — either every projection row carries the tombstone (or every
 * row is gone) AND the marker event lands, or nothing does. Both modes
 * require `is_creator` and reject if the space is currently disbanded
 * (defense in depth — the route auth middleware already 410s before the
 * call reaches this function).
 */
export function wipeSpace(
  db: Database,
  opts: { requester_member_id: string; hard?: boolean }
): { ok: true; wiped_at: string } | WipeError {
  const requester = db
    .prepare(
      `SELECT space_id, is_creator FROM members WHERE id = ? AND left_at IS NULL`
    )
    .get(opts.requester_member_id) as Pick<
    MemberRow,
    'space_id' | 'is_creator'
  > | null;
  if (!requester || !requester.is_creator) return 'not_creator';

  const space_id = requester.space_id;
  const wipedAt = new Date().toISOString();
  const eventId = ulid();
  const idempotencyKey = `space_wiped:${space_id}:${wipedAt}`;
  const hard = opts.hard === true;

  return db
    .transaction(() => {
      // Refuse to wipe a disbanded space — keeps composition rules clean
      // (disband-then-wipe is forbidden / no-op). The auth gate normally
      // rejects this with 410 before reaching us; this is defense in depth.
      const spaceRow = db
        .prepare('SELECT disbanded_at FROM spaces WHERE id = ?')
        .get(space_id) as { disbanded_at: string | null } | undefined;
      if (!spaceRow || spaceRow.disbanded_at !== null) {
        return 'space_disbanded' as const;
      }

      if (hard) {
        // Hard wipe: nuke events + every projection row for the space.
        // Spaces + members survive so the creator can still log in and the
        // briefing returns an empty (but valid) response. `room_codes` is
        // included in `HARD_CASCADE_TABLES` so a hard-wiped space gets a
        // fresh code on next rotate (avoids leaking a pre-wipe code).
        //
        // Codex F1 fix: delete `idempotency_keys` BEFORE `events`. The
        // predicate `event_id IN (SELECT event_id FROM events WHERE …)`
        // depends on events still being present; the prior order produced
        // an empty inner SELECT and left every key behind, causing
        // re-claim collisions on deterministic keys.
        db.prepare(
          `DELETE FROM idempotency_keys
            WHERE event_id IN (SELECT event_id FROM events WHERE space_id = ?)`
        ).run(space_id);
        db.prepare(`DELETE FROM events WHERE space_id = ?`).run(space_id);
        // Iterate the shared HARD_CASCADE_TABLES so wipe and disband-GC
        // stay in lockstep — fixes Codex F2 (wipe missing tables) + F3
        // (disband GC orphans) by sharing one constant.
        for (const table of HARD_CASCADE_TABLES) {
          db.prepare(`DELETE FROM ${table} WHERE space_id = ?`).run(space_id);
        }
      } else {
        // Soft wipe: stamp tombstoned_at on every projection row.
        for (const table of TOMBSTONED_PROJECTION_TABLES) {
          db.prepare(
            `UPDATE ${table} SET tombstoned_at = ?1 WHERE space_id = ?2 AND tombstoned_at IS NULL`
          ).run(wipedAt, space_id);
        }
        // Append the marker event so the unwipe path can find the wipe
        // boundary (and so audit queries can see the wipe in history).
        db.prepare(
          `INSERT INTO events (
            event_id, idempotency_key, space_id, timestamp, principal, actor, delegation,
            event_type, scope_json, payload_json, refs_json, confidence, schema_version, raw_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
        ).run(
          eventId,
          idempotencyKey,
          space_id,
          wipedAt,
          'system',
          'system',
          'system',
          'space_wiped',
          JSON.stringify({}),
          JSON.stringify({ hard: false }),
          null,
          null,
          '1.0',
          JSON.stringify({
            schema_version: '1.0',
            event_id: eventId,
            idempotency_key: idempotencyKey,
            space_id,
            timestamp: wipedAt,
            principal: 'system',
            actor: 'system',
            delegation: 'system',
            event_type: 'space_wiped',
            scope: {},
            payload: { hard: false }
          })
        );
        db.prepare(
          'INSERT INTO idempotency_keys (idempotency_key, event_id, created_at) VALUES (?1, ?2, ?3)'
        ).run(idempotencyKey, eventId, wipedAt);
      }
      return { ok: true as const, wiped_at: wipedAt };
    })
    .immediate();
}

export type UnwipeError = 'not_creator' | 'space_disbanded' | 'not_wiped';

/**
 * Reverse a soft-wipe by clearing tombstones whose timestamp matches the
 * most recent `space_wiped` event's timestamp. Earlier wipes (that were
 * already unwiped) leave no tombstones — there is nothing to clear from
 * them. A hard-wipe leaves no events to find, so this returns `not_wiped`.
 *
 * Appends a `space_unwiped` event so audit history shows the reversal.
 */
export function unwipeSpace(
  db: Database,
  opts: { requester_member_id: string }
): { ok: true; unwiped_at: string } | UnwipeError {
  const requester = db
    .prepare(
      `SELECT space_id, is_creator FROM members WHERE id = ? AND left_at IS NULL`
    )
    .get(opts.requester_member_id) as Pick<
    MemberRow,
    'space_id' | 'is_creator'
  > | null;
  if (!requester || !requester.is_creator) return 'not_creator';

  const space_id = requester.space_id;
  const unwipedAt = new Date().toISOString();
  const eventId = ulid();
  const idempotencyKey = `space_unwiped:${space_id}:${unwipedAt}`;

  return db
    .transaction(() => {
      const spaceRow = db
        .prepare('SELECT disbanded_at FROM spaces WHERE id = ?')
        .get(space_id) as { disbanded_at: string | null } | undefined;
      if (!spaceRow || spaceRow.disbanded_at !== null) {
        return 'space_disbanded' as const;
      }

      const lastWipe = db
        .prepare(
          `SELECT timestamp FROM events
            WHERE space_id = ?1 AND event_type = 'space_wiped'
            ORDER BY timestamp DESC LIMIT 1`
        )
        .get(space_id) as { timestamp: string } | undefined;
      if (!lastWipe) return 'not_wiped' as const;

      // Clear only tombstones stamped at the most recent wipe. Older wipes
      // (that the user already unwiped) leave no tombstones at their time
      // — nothing to clear from them. Newer rows (post-wipe) have
      // tombstoned_at = NULL — we filter them in the WHERE anyway.
      let clearedAny = false;
      for (const table of TOMBSTONED_PROJECTION_TABLES) {
        const res = db
          .prepare(
            `UPDATE ${table} SET tombstoned_at = NULL
              WHERE space_id = ?1 AND tombstoned_at = ?2`
          )
          .run(space_id, lastWipe.timestamp);
        if ((res.changes ?? 0) > 0) clearedAny = true;
      }
      if (!clearedAny) return 'not_wiped' as const;

      db.prepare(
        `INSERT INTO events (
          event_id, idempotency_key, space_id, timestamp, principal, actor, delegation,
          event_type, scope_json, payload_json, refs_json, confidence, schema_version, raw_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
      ).run(
        eventId,
        idempotencyKey,
        space_id,
        unwipedAt,
        'system',
        'system',
        'system',
        'space_unwiped',
        JSON.stringify({}),
        JSON.stringify({ wipe_timestamp: lastWipe.timestamp }),
        null,
        null,
        '1.0',
        JSON.stringify({
          schema_version: '1.0',
          event_id: eventId,
          idempotency_key: idempotencyKey,
          space_id,
          timestamp: unwipedAt,
          principal: 'system',
          actor: 'system',
          delegation: 'system',
          event_type: 'space_unwiped',
          scope: {},
          payload: { wipe_timestamp: lastWipe.timestamp }
        })
      );
      db.prepare(
        'INSERT INTO idempotency_keys (idempotency_key, event_id, created_at) VALUES (?1, ?2, ?3)'
      ).run(idempotencyKey, eventId, unwipedAt);

      return { ok: true as const, unwiped_at: unwipedAt };
    })
    .immediate();
}

export type RotateError = 'not_member';

export async function rotateRoomCode(
  db: Database,
  opts: { requester_member_id: string }
): Promise<{ room_code: string; rotated_at: string } | RotateError> {
  const member = db
    .prepare(`SELECT space_id FROM members WHERE id = ? AND left_at IS NULL`)
    .get(opts.requester_member_id) as Pick<MemberRow, 'space_id'> | null;

  if (!member) return 'not_member';

  const room_code = generateRoomCode(db);
  const expires_at = new Date(
    Date.now() + ROOM_CODE_TTL_SECONDS * 1000
  ).toISOString();
  const rotated_at = new Date().toISOString();

  db.prepare(
    `INSERT INTO room_codes (space_id, code, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(space_id) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at,
     created_at = datetime('now')`
  ).run(member.space_id, room_code, expires_at);

  return { room_code, rotated_at };
}

export function getMemberById(
  db: Database,
  member_id: string
): MemberRow | null {
  return db
    .prepare(`SELECT * FROM members WHERE id = ?`)
    .get(member_id) as MemberRow | null;
}

export function getSpaceById(db: Database, space_id: string): SpaceRow | null {
  return db
    .prepare(`SELECT * FROM spaces WHERE id = ?`)
    .get(space_id) as SpaceRow | null;
}
