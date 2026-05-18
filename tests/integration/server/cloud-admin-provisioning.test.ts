import { describe, expect, it } from 'bun:test';
import { createSqliteClient } from '../../../src/infra/db/sqlite-client.js';
import { SqliteEventStore } from '../../../src/infra/db/sqlite-event-store.js';
import { createTeamemTools } from '../../../src/server/tools/index.js';
import { createRouter } from '../../../src/server/routes.js';
import { runAllMigrations } from '../../helpers/migrations.js';
import { CLOUD_ADMIN_ENDPOINTS } from '../../../src/cloud/runtime-admin-contract.js';

const TEST_JWT_SECRET = 'test-secret-32bytes-padded-xxxxx';
const SERVICE_TOKEN = 'runtime-service-token-32bytes-ok';
const RUNTIME_URL = 'https://runtime.teamem.test';

function setup() {
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
                cloud_provisioning_request_id, cloud_idempotency_key
           FROM spaces
          WHERE id = ?1`
      )
      .get(body.runtimeSpaceId) as Record<string, string> | null;

    expect(row).toEqual({
      label: 'Launch Space',
      cloud_provisioning_source: 'teamem-cloud',
      cloud_control_plane_space_id: 'csp-1',
      cloud_provisioning_request_id: 'req-1',
      cloud_idempotency_key: 'idem-1'
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
