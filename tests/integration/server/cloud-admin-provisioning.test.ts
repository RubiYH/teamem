import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { createRouter } from '../../../src/server/routes.js';
import { resetRateLimitBuckets } from '../../../src/server/rate-limit.js';
import { signJwt } from '../../../src/server/jwt.js';
import { runAllMigrations } from '../../helpers/migrations.js';
import { CLOUD_ADMIN_ENDPOINTS } from '../../../src/cloud/runtime-admin-contract.js';
import {
  countActiveUserFacingMembers,
  kickMember
} from '../../../src/server/spaces.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';
const SERVICE_TOKEN = 'runtime-service-token-32bytes-ok';
const RUNTIME_URL = 'https://runtime.teamem.test';

function setup() {
  resetRateLimitBuckets();
  const db = createSqliteClient(':memory:');
  runAllMigrations(db);
  const store = new SqliteEventStore(db);
  const tools = createTeamemTools({ db, store });
  const app = createRouter(tools, db, TEST_JWT_SECRET, undefined, {
    provisioningToken: SERVICE_TOKEN,
    runtimeServerUrl: RUNTIME_URL
  });
  return { app, db };
}

function adminHeaders(token = SERVICE_TOKEN): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    label: 'Launch Space',
    idempotencyKey: 'idem-1',
    controlPlaneSpaceId: 'csp-1',
    provisioningRequestId: 'req-1',
    plan: 'free',
    trialExpiresAt: '2026-06-01T00:00:00.000Z',
    memberLimit: 3,
    ...overrides
  };
}

function rotateRequest(overrides: Record<string, unknown> = {}) {
  return {
    controlPlaneSpaceId: 'csp-1',
    runtimeSpaceId: 'runtime-1',
    idempotencyKey: 'rotate-1',
    ...overrides
  };
}

function softDeleteRequest(overrides: Record<string, unknown> = {}) {
  return {
    controlPlaneSpaceId: 'csp-1',
    runtimeSpaceId: 'runtime-1',
    idempotencyKey: 'delete-1',
    reason: 'owner_requested',
    ...overrides
  };
}

function policyRequest(overrides: Record<string, unknown> = {}) {
  return {
    controlPlaneSpaceId: 'csp-1',
    runtimeSpaceId: 'runtime-1',
    trialExpiresAt: '2026-07-01T00:00:00.000Z',
    memberLimit: 5,
    ...overrides
  };
}

async function postAdminCreate(
  app: ReturnType<typeof setup>['app'],
  body: unknown,
  headers = adminHeaders()
) {
  return app.request(CLOUD_ADMIN_ENDPOINTS.createSpace, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

async function postAdminRotate(
  app: ReturnType<typeof setup>['app'],
  runtimeSpaceId: string,
  body: unknown,
  headers = adminHeaders()
) {
  return app.request(
    CLOUD_ADMIN_ENDPOINTS.rotateRoomCode.replace(
      ':runtimeSpaceId',
      encodeURIComponent(runtimeSpaceId)
    ),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
  );
}

async function postAdminSoftDelete(
  app: ReturnType<typeof setup>['app'],
  runtimeSpaceId: string,
  body: unknown,
  headers = adminHeaders()
) {
  return app.request(
    CLOUD_ADMIN_ENDPOINTS.softDeleteSpace.replace(
      ':runtimeSpaceId',
      encodeURIComponent(runtimeSpaceId)
    ),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
  );
}

async function postAdminPolicy(
  app: ReturnType<typeof setup>['app'],
  runtimeSpaceId: string,
  body: unknown,
  headers = adminHeaders()
) {
  return app.request(
    CLOUD_ADMIN_ENDPOINTS.updateSpacePolicy.replace(
      ':runtimeSpaceId',
      encodeURIComponent(runtimeSpaceId)
    ),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
  );
}

async function getAdminStatus(
  app: ReturnType<typeof setup>['app'],
  runtimeSpaceId: string,
  controlPlaneSpaceId = 'csp-1',
  headers = adminHeaders()
) {
  const url = new URL(
    CLOUD_ADMIN_ENDPOINTS.spaceStatus.replace(
      ':runtimeSpaceId',
      encodeURIComponent(runtimeSpaceId)
    ),
    'https://runtime.teamem.test'
  );
  url.searchParams.set('controlPlaneSpaceId', controlPlaneSpaceId);
  return app.request(`${url.pathname}${url.search}`, {
    method: 'GET',
    headers
  });
}

async function postJoin(
  app: ReturnType<typeof setup>['app'],
  roomCode: string,
  memberName: string
) {
  return app.request('/spaces/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_code: roomCode,
      member_name: memberName
    })
  });
}

describe('runtime cloud-admin provisioning', () => {
  it('stays unconfigured when no service credential is supplied', async () => {
    const db = createSqliteClient(':memory:');
    runAllMigrations(db);
    const store = new SqliteEventStore(db);
    const tools = createTeamemTools({ db, store });
    const app = createRouter(tools, db, TEST_JWT_SECRET);

    const res = await postAdminCreate(app, createRequest());
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'cloud_admin_unconfigured'
    });
  });

  it('requires a service credential that is separate from public Space setup JWTs', async () => {
    const { app } = setup();

    const publicCreate = await app.request('/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_name: 'alice', label: 'Public Space' })
    });
    expect(publicCreate.status).toBe(201);
    const publicBody = (await publicCreate.json()) as { jwt: string };

    const missing = await postAdminCreate(app, createRequest(), {
      'Content-Type': 'application/json'
    });
    expect(missing.status).toBe(401);
    expect((await missing.json()) as { error: string }).toEqual({
      error: 'invalid_service_authorization'
    });

    const memberJwt = await postAdminCreate(
      app,
      createRequest(),
      adminHeaders(publicBody.jwt)
    );
    expect(memberJwt.status).toBe(401);

    const invalid = await postAdminCreate(
      app,
      createRequest(),
      adminHeaders('wrong-token')
    );
    expect(invalid.status).toBe(401);
  });

  it('provisions a runtime Space and stores only opaque cloud correlation metadata', async () => {
    const { app, db } = setup();

    const res = await postAdminCreate(app, createRequest());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      label: string;
      roomCode: string;
      runtimeServerUrl: string;
      status: string;
      correlation: {
        source: string;
        controlPlaneSpaceId: string;
        provisioningRequestId: string;
      };
    };

    expect(body).toMatchObject({
      controlPlaneSpaceId: 'csp-1',
      label: 'Launch Space',
      runtimeServerUrl: RUNTIME_URL,
      status: 'active',
      correlation: {
        source: 'teamem-cloud',
        controlPlaneSpaceId: 'csp-1',
        provisioningRequestId: 'req-1'
      }
    });
    expect(body.runtimeSpaceId).toBeTruthy();
    expect(body.roomCode).toHaveLength(8);

    const row = db
      .prepare(
        `SELECT label, cloud_provisioning_source, cloud_control_plane_space_id,
                cloud_provisioning_request_id, cloud_idempotency_key,
                cloud_plan, cloud_trial_expires_at, cloud_member_limit,
                cloud_suspended_at, cloud_suspension_reason
           FROM spaces
          WHERE id = ?1`
      )
      .get(body.runtimeSpaceId) as {
      label: string;
      cloud_provisioning_source: string;
      cloud_control_plane_space_id: string;
      cloud_provisioning_request_id: string;
      cloud_idempotency_key: string;
      cloud_plan: string;
      cloud_trial_expires_at: string;
      cloud_member_limit: number;
      cloud_suspended_at: string | null;
      cloud_suspension_reason: string | null;
    } | null;

    expect(row).toEqual({
      label: 'Launch Space',
      cloud_provisioning_source: 'teamem-cloud',
      cloud_control_plane_space_id: 'csp-1',
      cloud_provisioning_request_id: 'req-1',
      cloud_idempotency_key: 'idem-1',
      cloud_plan: 'free',
      cloud_trial_expires_at: '2026-06-01T00:00:00.000Z',
      cloud_member_limit: 3,
      cloud_suspended_at: null,
      cloud_suspension_reason: null
    });

    const columns = (
      db.prepare('PRAGMA table_info(spaces)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).not.toContain('email');
    expect(columns).not.toContain('user_email');
    expect(columns).not.toContain('oauth_provider_id');
    expect(columns).not.toContain('better_auth_user_id');
    expect(columns).not.toContain('cloud_account_id');
  });

  it('requires valid free-plan policy metadata on cloud-admin create', async () => {
    const { app } = setup();

    for (const overrides of [
      { plan: undefined },
      { trialExpiresAt: null },
      { trialExpiresAt: 'not-a-date' },
      { memberLimit: null },
      { memberLimit: 0 },
      { memberLimit: 1.5 }
    ]) {
      const res = await postAdminCreate(app, createRequest(overrides));
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({
        error: 'invalid_payload'
      });
    }
  });

  it('returns the existing runtime Space on exact retry instead of creating a duplicate active Space', async () => {
    const { app, db } = setup();

    const first = await postAdminCreate(app, createRequest());
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const retry = await postAdminCreate(app, createRequest());
    expect(retry.status).toBe(201);
    const retryBody = (await retry.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    expect(retryBody).toMatchObject(firstBody);
    const count = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM spaces
          WHERE cloud_control_plane_space_id = ?1
            AND disbanded_at IS NULL`
      )
      .get('csp-1') as { count: number };
    expect(count.count).toBe(1);
  });

  it('rejects idempotency and control-plane correlation conflicts', async () => {
    const { app, db } = setup();

    const first = await postAdminCreate(app, createRequest());
    expect(first.status).toBe(201);

    const idempotencyConflict = await postAdminCreate(
      app,
      createRequest({ controlPlaneSpaceId: 'csp-2' })
    );
    expect(idempotencyConflict.status).toBe(409);
    expect((await idempotencyConflict.json()) as { error: string }).toEqual({
      error: 'idempotency_conflict'
    });

    const policyConflict = await postAdminCreate(
      app,
      createRequest({ memberLimit: 4 })
    );
    expect(policyConflict.status).toBe(409);
    expect((await policyConflict.json()) as { error: string }).toEqual({
      error: 'idempotency_conflict'
    });

    const controlPlaneConflict = await postAdminCreate(
      app,
      createRequest({ idempotencyKey: 'idem-2' })
    );
    expect(controlPlaneConflict.status).toBe(409);
    expect((await controlPlaneConflict.json()) as { error: string }).toEqual({
      error: 'control_plane_space_conflict'
    });

    const count = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM spaces
          WHERE cloud_control_plane_space_id = ?1
            AND disbanded_at IS NULL`
      )
      .get('csp-1') as { count: number };
    expect(count.count).toBe(1);
  });

  it('rejects invalid payloads and forbidden runtime metadata fields', async () => {
    const { app } = setup();

    const invalid = await postAdminCreate(
      app,
      createRequest({ provisioningRequestId: '' })
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as { error: string }).toEqual({
      error: 'invalid_payload'
    });

    const forbidden = await postAdminCreate(
      app,
      createRequest({ email: 'owner@example.com' })
    );
    expect(forbidden.status).toBe(400);
    expect(
      (await forbidden.json()) as { error: string; field: string }
    ).toEqual({
      error: 'forbidden_runtime_metadata',
      field: 'email'
    });
  });

  it('rejects valid JSON primitives as invalid payloads instead of throwing', async () => {
    const { app } = setup();

    for (const primitive of [null, 'string', 42, true, []]) {
      const res = await postAdminCreate(app, primitive);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({
        error: 'invalid_payload'
      });
    }
  });

  it('rotates a cloud-correlated runtime Space room code through the service-authenticated admin route', async () => {
    const { app } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      roomCode: string;
    };

    const rotate = await postAdminRotate(
      app,
      created.runtimeSpaceId,
      rotateRequest({ runtimeSpaceId: created.runtimeSpaceId })
    );
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      roomCode: string;
    };

    expect(rotated.controlPlaneSpaceId).toBe(created.controlPlaneSpaceId);
    expect(rotated.runtimeSpaceId).toBe(created.runtimeSpaceId);
    expect(rotated.roomCode).toHaveLength(8);
    expect(rotated.roomCode).not.toBe(created.roomCode);
  });

  it('keeps invite validity runtime-owned when the admin route rotates the code', async () => {
    const { app } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const rotate = await postAdminRotate(
      app,
      created.runtimeSpaceId,
      rotateRequest({ runtimeSpaceId: created.runtimeSpaceId })
    );
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as { roomCode: string };

    const oldJoin = await app.request('/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_code: created.roomCode,
        member_name: 'old-code-user'
      })
    });
    expect(oldJoin.status).toBe(404);
    expect((await oldJoin.json()) as { error: string }).toEqual({
      error: 'invalid_code'
    });

    const newJoin = await app.request('/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_code: rotated.roomCode,
        member_name: 'new-code-user'
      })
    });
    expect(newJoin.status).toBe(200);
    expect((await newJoin.json()) as { space_id: string }).toMatchObject({
      space_id: created.runtimeSpaceId
    });
  });

  it('enforces the free Space member cap from runtime policy while excluding the system bootstrap member', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const bootstrap = db
      .prepare(
        `SELECT m.name, m.is_creator, msm.marker AS system_marker
           FROM members m
           JOIN member_system_markers msm ON msm.member_id = m.id
          WHERE m.space_id = ?1
          ORDER BY m.joined_at ASC
          LIMIT 1`
      )
      .get(created.runtimeSpaceId) as {
      name: string;
      is_creator: number;
      system_marker: string;
    };
    expect(bootstrap).toEqual({
      name: 'teamem-cloud',
      is_creator: 1,
      system_marker: 'cloud_bootstrap'
    });
    expect(countActiveUserFacingMembers(db, created.runtimeSpaceId)).toBe(0);

    const ownerJoin = await postJoin(app, created.roomCode, 'owner-local');
    expect(ownerJoin.status).toBe(200);
    const bobJoin = await postJoin(app, created.roomCode, 'bob');
    expect(bobJoin.status).toBe(200);
    const carolJoin = await postJoin(app, created.roomCode, 'carol');
    expect(carolJoin.status).toBe(200);
    expect(countActiveUserFacingMembers(db, created.runtimeSpaceId)).toBe(3);

    const full = await postJoin(app, created.roomCode, 'dave');
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({
      error: 'space_member_limit_reached',
      member_limit: 3,
      active_member_count: 3
    });
  });

  it('smokes runtime create, join, full-space failure, and expiry suspension together', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2999-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    for (const memberName of ['owner-local', 'bob', 'carol']) {
      const join = await postJoin(app, created.roomCode, memberName);
      expect(join.status).toBe(200);
    }

    const full = await postJoin(app, created.roomCode, 'dave');
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({
      error: 'space_member_limit_reached',
      member_limit: 3,
      active_member_count: 3
    });

    db.prepare(
      `UPDATE spaces
          SET cloud_trial_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?1`
    ).run(created.runtimeSpaceId);

    const status = await getAdminStatus(app, created.runtimeSpaceId);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      suspensionReason: 'free_trial_expired',
      setupAvailable: false,
      controlsAvailable: false
    });

    const lateJoin = await postJoin(app, created.roomCode, 'late-user');
    expect(lateJoin.status).toBe(410);
    expect(await lateJoin.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });
  });

  it('reports live runtime status through the cloud-admin credential boundary for active trials', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2999-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      roomCode: string;
    };

    const ownerJoin = await postJoin(app, created.roomCode, 'owner-local');
    expect(ownerJoin.status).toBe(200);
    const bobJoin = await postJoin(app, created.roomCode, 'bob');
    expect(bobJoin.status).toBe(200);

    const status = await getAdminStatus(app, created.runtimeSpaceId);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      controlPlaneSpaceId: created.controlPlaneSpaceId,
      runtimeSpaceId: created.runtimeSpaceId,
      plan: 'free',
      trialExpiresAt: '2999-01-01T00:00:00.000Z',
      memberLimit: 3,
      activeUserFacingMemberCount: 2,
      suspendedAt: null,
      suspensionReason: null,
      setupAvailable: true,
      controlsAvailable: true
    });

    const row = db
      .prepare(
        `SELECT cloud_suspended_at, cloud_suspension_reason
           FROM spaces
          WHERE id = ?1`
      )
      .get(created.runtimeSpaceId) as {
      cloud_suspended_at: string | null;
      cloud_suspension_reason: string | null;
    };
    expect(row).toEqual({
      cloud_suspended_at: null,
      cloud_suspension_reason: null
    });
  });

  it('lazily suspends expired free Spaces on cloud-admin status reads', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2000-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
    };

    const first = await getAdminStatus(app, created.runtimeSpaceId);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      suspendedAt: string | null;
      suspensionReason: string | null;
      setupAvailable: boolean;
      controlsAvailable: boolean;
    };
    expect(firstBody.suspendedAt).toBeTruthy();
    expect(firstBody.suspensionReason).toBe('free_trial_expired');
    expect(firstBody.setupAvailable).toBe(false);
    expect(firstBody.controlsAvailable).toBe(false);

    const second = await getAdminStatus(app, created.runtimeSpaceId);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { suspendedAt: string | null };
    expect(secondBody.suspendedAt).toBe(firstBody.suspendedAt);

    const row = db
      .prepare(
        `SELECT cloud_suspended_at, cloud_suspension_reason
           FROM spaces
          WHERE id = ?1`
      )
      .get(created.runtimeSpaceId) as {
      cloud_suspended_at: string | null;
      cloud_suspension_reason: string | null;
    };
    expect(row.cloud_suspended_at).toBe(firstBody.suspendedAt);
    expect(row.cloud_suspension_reason).toBe('free_trial_expired');
  });

  it('protects runtime policy updates with cloud-admin auth', async () => {
    const { app } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
    };
    const request = policyRequest({ runtimeSpaceId: created.runtimeSpaceId });

    const missing = await postAdminPolicy(
      app,
      created.runtimeSpaceId,
      request,
      {
        'Content-Type': 'application/json'
      }
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: 'invalid_service_authorization'
    });

    const invalid = await postAdminPolicy(
      app,
      created.runtimeSpaceId,
      request,
      adminHeaders('wrong-token')
    );
    expect(invalid.status).toBe(401);
  });

  it('updates runtime policy fields and reflects them in cloud-admin status', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
    };

    const update = await postAdminPolicy(
      app,
      created.runtimeSpaceId,
      policyRequest({ runtimeSpaceId: created.runtimeSpaceId })
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      controlPlaneSpaceId: created.controlPlaneSpaceId,
      runtimeSpaceId: created.runtimeSpaceId,
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5,
      suspendedAt: null,
      suspensionReason: null
    });

    const status = await getAdminStatus(app, created.runtimeSpaceId);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      trialExpiresAt: '2026-07-01T00:00:00.000Z',
      memberLimit: 5
    });

    const row = db
      .prepare(
        `SELECT cloud_trial_expires_at, cloud_member_limit
           FROM spaces
          WHERE id = ?1`
      )
      .get(created.runtimeSpaceId) as {
      cloud_trial_expires_at: string;
      cloud_member_limit: number;
    };
    expect(row).toEqual({
      cloud_trial_expires_at: '2026-07-01T00:00:00.000Z',
      cloud_member_limit: 5
    });
  });

  it('clears trial-expired suspension when an operator extends expiry into the future', async () => {
    const { app } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2000-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const suspended = await getAdminStatus(app, created.runtimeSpaceId);
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({
      suspensionReason: 'free_trial_expired',
      setupAvailable: false
    });

    const update = await postAdminPolicy(
      app,
      created.runtimeSpaceId,
      policyRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        trialExpiresAt: '2999-01-01T00:00:00.000Z',
        memberLimit: 3
      })
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      trialExpiresAt: '2999-01-01T00:00:00.000Z',
      suspendedAt: null,
      suspensionReason: null,
      setupAvailable: true,
      controlsAvailable: true
    });

    const join = await postJoin(app, created.roomCode, 'owner-local');
    expect(join.status).toBe(200);
  });

  it('keeps trial suspension after policy update when overridden expiry remains expired', async () => {
    const { app } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2000-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };
    const first = await getAdminStatus(app, created.runtimeSpaceId);
    expect(first.status).toBe(200);

    const update = await postAdminPolicy(
      app,
      created.runtimeSpaceId,
      policyRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        trialExpiresAt: '2001-01-01T00:00:00.000Z',
        memberLimit: 5
      })
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      trialExpiresAt: '2001-01-01T00:00:00.000Z',
      memberLimit: 5,
      suspensionReason: 'free_trial_expired',
      setupAvailable: false
    });

    const join = await postJoin(app, created.roomCode, 'late-user');
    expect(join.status).toBe(410);
    expect(await join.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });
  });

  it('enforces an overridden member limit after runtime policy propagation', async () => {
    const { app } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({
        trialExpiresAt: '2999-01-01T00:00:00.000Z',
        memberLimit: 3
      })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const shrink = await postAdminPolicy(
      app,
      created.runtimeSpaceId,
      policyRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        trialExpiresAt: '2999-01-01T00:00:00.000Z',
        memberLimit: 1
      })
    );
    expect(shrink.status).toBe(200);

    const owner = await postJoin(app, created.roomCode, 'owner-local');
    expect(owner.status).toBe(200);
    const blocked = await postJoin(app, created.roomCode, 'bob');
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: 'space_member_limit_reached',
      member_limit: 1,
      active_member_count: 1
    });

    const expand = await postAdminPolicy(
      app,
      created.runtimeSpaceId,
      policyRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        trialExpiresAt: '2999-01-01T00:00:00.000Z',
        memberLimit: 2
      })
    );
    expect(expand.status).toBe(200);
    const bob = await postJoin(app, created.roomCode, 'bob');
    expect(bob.status).toBe(200);
  });

  it('keeps invalid room-code behavior before applying suspension policy', async () => {
    const { app } = setup();

    const invalid = await postJoin(app, 'BADCODE1', 'late-user');
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual({ error: 'invalid_code' });
  });

  it('returns suspension before code expiry, name checks, or member-cap checks once a room code maps to an expired Space', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2999-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    for (const memberName of ['owner-local', 'bob', 'carol']) {
      const join = await postJoin(app, created.roomCode, memberName);
      expect(join.status).toBe(200);
    }
    db.prepare(
      `UPDATE spaces
          SET cloud_trial_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?1`
    ).run(created.runtimeSpaceId);
    db.prepare(
      `UPDATE room_codes
          SET expires_at = '2000-01-01T00:00:00.000Z'
        WHERE code = ?1`
    ).run(created.roomCode);

    const existingName = await postJoin(app, created.roomCode, 'owner-local');
    expect(existingName.status).toBe(410);
    expect(await existingName.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });

    const overLimit = await postJoin(app, created.roomCode, 'dave');
    expect(overLimit.status).toBe(410);
    expect(await overLimit.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });
  });

  it('reveals suspension only after valid JWT and member validation', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2999-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const join = await postJoin(app, created.roomCode, 'owner-local');
    expect(join.status).toBe(200);
    const joined = (await join.json()) as { jwt: string };
    db.prepare(
      `UPDATE spaces
          SET cloud_trial_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?1`
    ).run(created.runtimeSpaceId);

    const nonMemberJwt = await signJwt(
      { sub: 'mallory', space_id: created.runtimeSpaceId },
      TEST_JWT_SECRET
    );
    const nonMember = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${nonMemberJwt}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(nonMember.status).toBe(401);
    expect((await nonMember.json()) as { error: string }).toMatchObject({
      error: 'member_left'
    });

    const validMember = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${joined.jwt}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(validMember.status).toBe(410);
    expect(await validMember.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });
  });

  it('blocks normal runtime access for suspended Spaces while allowing explicit cleanup paths', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(
      app,
      createRequest({ trialExpiresAt: '2999-01-01T00:00:00.000Z' })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };
    const join = await postJoin(app, created.roomCode, 'owner-local');
    expect(join.status).toBe(200);
    const member = (await join.json()) as { jwt: string };
    const directCleanupJoin = await postJoin(
      app,
      created.roomCode,
      'cleanup-direct'
    );
    expect(directCleanupJoin.status).toBe(200);
    const directCleanupMember = (await directCleanupJoin.json()) as {
      jwt: string;
    };
    const mcpCleanupJoin = await postJoin(app, created.roomCode, 'cleanup-mcp');
    expect(mcpCleanupJoin.status).toBe(200);
    const mcpCleanupMember = (await mcpCleanupJoin.json()) as { jwt: string };

    db.prepare(
      `UPDATE spaces
          SET cloud_trial_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE id = ?1`
    ).run(created.runtimeSpaceId);

    const suspend = await getAdminStatus(app, created.runtimeSpaceId);
    expect(suspend.status).toBe(200);
    expect(
      (await suspend.json()) as { suspensionReason: string | null }
    ).toMatchObject({
      suspensionReason: 'free_trial_expired'
    });

    const rotate = await app.request('/spaces/rotate-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${member.jwt}`
      },
      body: JSON.stringify({})
    });
    expect(rotate.status).toBe(410);
    expect(await rotate.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });

    const tool = await app.request('/tools/teamem.get_briefing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${member.jwt}`
      },
      body: JSON.stringify({})
    });
    expect(tool.status).toBe(410);
    expect(await tool.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });

    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${member.jwt}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(mcp.status).toBe(410);
    expect(await mcp.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });

    const blockedMcpTool = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${member.jwt}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'teamem.get_updates', arguments: {} }
      })
    });
    expect(blockedMcpTool.status).toBe(410);
    expect(await blockedMcpTool.json()).toEqual({
      error: 'space_suspended',
      reason: 'free_trial_expired'
    });

    const directToolLeave = await app.request('/tools/teamem.space_leave', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${directCleanupMember.jwt}`
      },
      body: JSON.stringify({})
    });
    expect(directToolLeave.status).toBe(200);
    expect(await directToolLeave.json()).toEqual({
      ok: true,
      data: { ok: true }
    });

    const mcpToolLeave = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mcpCleanupMember.jwt}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'teamem.space_leave', arguments: {} }
      })
    });
    expect(mcpToolLeave.status).toBe(200);
    expect(await mcpToolLeave.json()).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { ok: true, data: { ok: true } }
    });

    const leave = await app.request('/spaces/leave', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${member.jwt}`
      },
      body: JSON.stringify({})
    });
    expect(leave.status).toBe(200);
    expect(await leave.json()).toEqual({ ok: true });

    const adminStatus = await getAdminStatus(app, created.runtimeSpaceId);
    expect(adminStatus.status).toBe(200);

    const softDelete = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      softDeleteRequest({ runtimeSpaceId: created.runtimeSpaceId })
    );
    expect(softDelete.status).toBe(200);
    expect((await softDelete.json()) as { status: string }).toMatchObject({
      status: 'soft_deleted'
    });
  });

  it('protects runtime status with cloud-admin auth and control-plane correlation', async () => {
    const { app } = setup();
    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
    };

    const missingAuth = await getAdminStatus(
      app,
      created.runtimeSpaceId,
      'csp-1',
      {
        'Content-Type': 'application/json'
      }
    );
    expect(missingAuth.status).toBe(401);

    const mismatch = await getAdminStatus(
      app,
      created.runtimeSpaceId,
      'other-csp'
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: 'control_plane_space_mismatch'
    });
  });

  it('reuses free member slots after members leave or are kicked', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const ownerJoin = await postJoin(app, created.roomCode, 'owner-local');
    expect(ownerJoin.status).toBe(200);
    const bobJoin = await postJoin(app, created.roomCode, 'bob');
    expect(bobJoin.status).toBe(200);
    const bob = (await bobJoin.json()) as { jwt: string };
    const carolJoin = await postJoin(app, created.roomCode, 'carol');
    expect(carolJoin.status).toBe(200);

    const blocked = await postJoin(app, created.roomCode, 'dave');
    expect(blocked.status).toBe(409);

    const leave = await app.request('/spaces/leave', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bob.jwt}`
      },
      body: JSON.stringify({})
    });
    expect(leave.status).toBe(200);
    expect(countActiveUserFacingMembers(db, created.runtimeSpaceId)).toBe(2);

    const daveJoin = await postJoin(app, created.roomCode, 'dave');
    expect(daveJoin.status).toBe(200);
    expect(countActiveUserFacingMembers(db, created.runtimeSpaceId)).toBe(3);

    const bootstrap = db
      .prepare(
        `SELECT m.id
           FROM members m
           JOIN member_system_markers msm ON msm.member_id = m.id
          WHERE m.space_id = ?1
          LIMIT 1`
      )
      .get(created.runtimeSpaceId) as { id: string };
    const kick = kickMember(db, {
      requester_member_id: bootstrap.id,
      target_member_name: 'carol'
    });
    expect(kick).toBe('ok');
    expect(countActiveUserFacingMembers(db, created.runtimeSpaceId)).toBe(2);

    const erinJoin = await postJoin(app, created.roomCode, 'erin');
    expect(erinJoin.status).toBe(200);
    expect(countActiveUserFacingMembers(db, created.runtimeSpaceId)).toBe(3);
  });

  it('keeps cloud-admin room-code rotation available when a free Space is full', async () => {
    const { app } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    for (const memberName of ['owner-local', 'bob', 'carol']) {
      const join = await postJoin(app, created.roomCode, memberName);
      expect(join.status).toBe(200);
    }

    const rotate = await postAdminRotate(
      app,
      created.runtimeSpaceId,
      rotateRequest({ runtimeSpaceId: created.runtimeSpaceId })
    );
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as { roomCode: string };
    expect(rotated.roomCode).toHaveLength(8);
    expect(rotated.roomCode).not.toBe(created.roomCode);

    const oldCode = await postJoin(app, created.roomCode, 'old-code-user');
    expect(oldCode.status).toBe(404);

    const stillFull = await postJoin(app, rotated.roomCode, 'dave');
    expect(stillFull.status).toBe(409);
    expect(await stillFull.json()).toEqual({
      error: 'space_member_limit_reached',
      member_limit: 3,
      active_member_count: 3
    });
  });

  it('reuses the first room-code rotation result for exact idempotency retries', async () => {
    const { app } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      roomCode: string;
    };
    const request = rotateRequest({ runtimeSpaceId: created.runtimeSpaceId });

    const first = await postAdminRotate(app, created.runtimeSpaceId, request);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const retry = await postAdminRotate(app, created.runtimeSpaceId, request);
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    expect(retryBody).toEqual(firstBody);

    const conflict = await postAdminRotate(
      app,
      created.runtimeSpaceId,
      rotateRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        idempotencyKey: 'rotate-1',
        controlPlaneSpaceId: 'csp-other'
      })
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as { error: string }).toEqual({
      error: 'idempotency_conflict'
    });

    const oldJoin = await app.request('/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_code: created.roomCode,
        member_name: 'old-code-user'
      })
    });
    expect(oldJoin.status).toBe(404);

    const currentJoin = await app.request('/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_code: firstBody.roomCode,
        member_name: 'current-code-user'
      })
    });
    expect(currentJoin.status).toBe(200);
    expect((await currentJoin.json()) as { space_id: string }).toMatchObject({
      space_id: firstBody.runtimeSpaceId
    });
  });

  it('rejects room-code rotation for mismatched cloud correlation or public JWT auth', async () => {
    const { app } = setup();

    const publicCreate = await app.request('/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_name: 'alice', label: 'Public Space' })
    });
    expect(publicCreate.status).toBe(201);
    const publicBody = (await publicCreate.json()) as { jwt: string };

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as { runtimeSpaceId: string };

    const memberJwt = await postAdminRotate(
      app,
      created.runtimeSpaceId,
      rotateRequest({ runtimeSpaceId: created.runtimeSpaceId }),
      adminHeaders(publicBody.jwt)
    );
    expect(memberJwt.status).toBe(401);

    const mismatch = await postAdminRotate(
      app,
      created.runtimeSpaceId,
      rotateRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        controlPlaneSpaceId: 'csp-other'
      })
    );
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()) as { error: string }).toEqual({
      error: 'control_plane_space_mismatch'
    });
  });

  it('soft-deletes a cloud-correlated runtime Space without hard-deleting runtime state', async () => {
    const { app, db } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      roomCode: string;
    };

    const deleted = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      softDeleteRequest({ runtimeSpaceId: created.runtimeSpaceId })
    );
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as {
      controlPlaneSpaceId: string;
      runtimeSpaceId: string;
      status: string;
      deletedAt: string;
    };
    expect(deletedBody).toMatchObject({
      controlPlaneSpaceId: created.controlPlaneSpaceId,
      runtimeSpaceId: created.runtimeSpaceId,
      status: 'soft_deleted'
    });
    expect(deletedBody.deletedAt).toBeTruthy();

    const row = db
      .prepare(
        `SELECT disbanded_at, disbanded_grace_until
           FROM spaces
          WHERE id = ?1`
      )
      .get(created.runtimeSpaceId) as {
      disbanded_at: string | null;
      disbanded_grace_until: string | null;
    } | null;
    expect(row?.disbanded_at).toBeTruthy();
    expect(row?.disbanded_grace_until).toBeTruthy();

    const join = await app.request('/spaces/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_code: created.roomCode,
        member_name: 'late-user'
      })
    });
    expect(join.status).toBe(410);
    expect((await join.json()) as { error: string }).toEqual({
      error: 'space_disbanded'
    });
  });

  it('keeps create idempotency durable after soft-delete so late retries do not recreate runtime state', async () => {
    const { app, db } = setup();
    const request = createRequest();

    const create = await postAdminCreate(app, request);
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };

    const deleted = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      softDeleteRequest({ runtimeSpaceId: created.runtimeSpaceId })
    );
    expect(deleted.status).toBe(200);

    const retry = await postAdminCreate(app, request);
    expect(retry.status).toBe(201);
    const retryBody = (await retry.json()) as {
      runtimeSpaceId: string;
      roomCode: string;
    };
    expect(retryBody).toMatchObject({
      runtimeSpaceId: created.runtimeSpaceId,
      roomCode: created.roomCode
    });

    const allCorrelated = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM spaces
          WHERE cloud_control_plane_space_id = ?1`
      )
      .get('csp-1') as { count: number };
    expect(allCorrelated.count).toBe(1);

    const freshCreate = await postAdminCreate(
      app,
      createRequest({
        idempotencyKey: 'idem-2',
        controlPlaneSpaceId: 'csp-2',
        provisioningRequestId: 'req-2'
      })
    );
    expect(freshCreate.status).toBe(201);
    const freshBody = (await freshCreate.json()) as { runtimeSpaceId: string };
    expect(freshBody.runtimeSpaceId).not.toBe(created.runtimeSpaceId);
  });

  it('reuses cloud-admin soft-delete idempotency results and rejects conflicts', async () => {
    const { app } = setup();

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      runtimeSpaceId: string;
    };
    const request = softDeleteRequest({
      runtimeSpaceId: created.runtimeSpaceId
    });

    const first = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      request
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      runtimeSpaceId: string;
      deletedAt: string;
    };

    const retry = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      request
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstBody);

    const conflict = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      softDeleteRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        idempotencyKey: 'delete-1',
        reason: 'operator_action'
      })
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as { error: string }).toEqual({
      error: 'idempotency_conflict'
    });
  });

  it('rejects soft-delete for mismatched cloud correlation, forbidden metadata, or public JWT auth', async () => {
    const { app } = setup();

    const publicCreate = await app.request('/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_name: 'alice', label: 'Public Space' })
    });
    expect(publicCreate.status).toBe(201);
    const publicBody = (await publicCreate.json()) as { jwt: string };

    const create = await postAdminCreate(app, createRequest());
    expect(create.status).toBe(201);
    const created = (await create.json()) as { runtimeSpaceId: string };

    const memberJwt = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      softDeleteRequest({ runtimeSpaceId: created.runtimeSpaceId }),
      adminHeaders(publicBody.jwt)
    );
    expect(memberJwt.status).toBe(401);

    const mismatch = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      softDeleteRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        controlPlaneSpaceId: 'csp-other'
      })
    );
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()) as { error: string }).toEqual({
      error: 'control_plane_space_mismatch'
    });

    const forbidden = await postAdminSoftDelete(
      app,
      created.runtimeSpaceId,
      softDeleteRequest({
        runtimeSpaceId: created.runtimeSpaceId,
        email: 'owner@example.com'
      })
    );
    expect(forbidden.status).toBe(400);
    expect(
      (await forbidden.json()) as { error: string; field: string }
    ).toEqual({
      error: 'forbidden_runtime_metadata',
      field: 'email'
    });
  });
});
