import { describe, expect, it } from 'bun:test';
import { runAllMigrations } from '../../helpers/migrations.js';
import { Database } from 'bun:sqlite';
import {
  countActiveUserFacingMembers,
  createCloudAdminSpace,
  joinSpace,
  createSpace
} from '../../../src/server/spaces.js';

const TEST_SECRET = 'test-secret-32bytes-padded-xxxxx';

function buildDb(): Database {
  const db = new Database(':memory:');
  runAllMigrations(db);
  return db;
}

describe('joinSpace concurrent race — UNIQUE constraint → name_taken', () => {
  it('two concurrent joins with same member_name: one succeeds, one returns name_taken, neither throws', async () => {
    const db = buildDb();

    const { room_code } = await createSpace(
      db,
      { member_name: 'alice' },
      TEST_SECRET
    );

    const results = await Promise.all([
      joinSpace(db, { room_code, member_name: 'bob' }, TEST_SECRET),
      joinSpace(db, { room_code, member_name: 'bob' }, TEST_SECRET)
    ]);

    const successes = results.filter(
      (r) => typeof r === 'object' && r !== null
    );
    const nameTaken = results.filter((r) => r === 'name_taken');

    expect(successes).toHaveLength(1);
    expect(nameTaken).toHaveLength(1);
  });

  it('sequential same-name joins: second returns name_taken', async () => {
    const db = buildDb();

    const { room_code } = await createSpace(
      db,
      { member_name: 'alice' },
      TEST_SECRET
    );

    const first = await joinSpace(
      db,
      { room_code, member_name: 'carol' },
      TEST_SECRET
    );
    expect(typeof first).toBe('object');

    const second = await joinSpace(
      db,
      { room_code, member_name: 'carol' },
      TEST_SECRET
    );
    expect(second).toBe('name_taken');
  });
});

describe('joinSpace concurrent race — HTTP layer: one 200, one 409', () => {
  it('two concurrent POST /spaces/join return one 200 and one 409 (not 500)', async () => {
    // Import here to avoid circular deps at module load time
    const { setupAuthApp } = await import('../../integration/auth/helpers.js');
    const { app } = setupAuthApp();

    // Create the space
    const createRes = await app.request('/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_name: 'alice' })
    });
    const { room_code } = (await createRes.json()) as { room_code: string };

    const joinReq = () =>
      app.request('/spaces/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_code, member_name: 'dave' })
      });

    const [res1, res2] = await Promise.all([joinReq(), joinReq()]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const body409 =
      res1.status === 409
        ? ((await res1.json()) as { error: string })
        : ((await res2.json()) as { error: string });
    expect(body409.error).toBe('name_taken');
  });
});

describe('joinSpace concurrent race — Cloud free member cap', () => {
  it('concurrent joins into the final slots cannot exceed the runtime policy cap', async () => {
    const db = buildDb();

    const created = createCloudAdminSpace(db, {
      label: 'Cloud Space',
      idempotencyKey: 'idem-race',
      controlPlaneSpaceId: 'csp-race',
      provisioningRequestId: 'req-race',
      runtimeServerUrl: 'https://runtime.teamem.test',
      plan: 'free',
      trialExpiresAt: '2026-06-01T00:00:00.000Z',
      memberLimit: 3
    });
    expect(typeof created).toBe('object');
    if (typeof created !== 'object') {
      throw new Error(`unexpected create failure: ${created}`);
    }

    const results = await Promise.all(
      ['owner-local', 'bob', 'carol', 'dave'].map((memberName) =>
        joinSpace(
          db,
          { room_code: created.roomCode, member_name: memberName },
          TEST_SECRET
        )
      )
    );

    const successes = results.filter(
      (result) =>
        typeof result === 'object' && result !== null && !('error' in result)
    );
    const limitFailures = results.filter(
      (result) =>
        typeof result === 'object' &&
        result !== null &&
        'error' in result &&
        result.error === 'space_member_limit_reached'
    );

    expect(successes).toHaveLength(3);
    expect(limitFailures).toEqual([
      {
        error: 'space_member_limit_reached',
        member_limit: 3,
        active_member_count: 3
      }
    ]);
    expect(countActiveUserFacingMembers(db, created.runtimeSpaceId)).toBe(3);
  });
});
