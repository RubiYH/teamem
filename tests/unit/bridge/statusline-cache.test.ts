import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeStatuslineDisplayCacheFromToolResponse,
  type StatuslineCacheCredential
} from '../../../src/bridge/statusline-cache.js';

const credential: StatuslineCacheCredential = {
  space_id: 'space-1',
  label: 'Alpha Space'
};

function readCache(dataRoot: string) {
  return JSON.parse(
    readFileSync(join(dataRoot, 'statusline/display.json'), 'utf8')
  );
}

describe('bridge statusline display cache', () => {
  it('writes Sprint cache from a production-shaped create_sprint response', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-bridge-statusline-'));
    try {
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.create_sprint',
        {
          ok: true,
          data: {
            sprint: {
              sprint_id: 'sprint-new',
              slug: 'new-sprint',
              display_name: 'New Sprint',
              goal: 'Ship it.',
              status: 'active'
            },
            old_context: {
              mode: 'sprint',
              sprint: {
                sprint_id: 'sprint-old',
                slug: 'old-sprint',
                display_name: 'Old Sprint',
                goal: 'Old work.',
                status: 'active'
              }
            },
            new_context: {
              mode: 'sprint',
              sprint: {
                sprint_id: 'sprint-new',
                slug: 'new-sprint',
                display_name: 'New Sprint',
                goal: 'Ship it.',
                status: 'active'
              }
            },
            event_ids: ['evt-1', 'evt-2'],
            idempotent: false,
            message: 'Left old-sprint; joined new-sprint.',
            warnings: []
          }
        },
        {
          credential,
          env: {
            TEAMEM_DATA: work,
            CLAUDE_SESSION_ID: 'sess-1'
          },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:00:00.000Z')
        }
      );

      expect(written).toBe(true);
      expect(readCache(work)).toMatchObject({
        format_version: 1,
        identity: {
          session_id: 'sess-1',
          workspace_current_dir: '/tmp/project'
        },
        space: { id: 'space-1', label: 'Alpha Space' },
        sprint: {
          sprint_id: 'sprint-new',
          slug: 'new-sprint',
          display_name: 'New Sprint'
        }
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('does not use old_context as a current Sprint source', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-bridge-statusline-leave-'));
    try {
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.leave_sprint',
        {
          ok: true,
          data: {
            sprint: null,
            old_context: {
              mode: 'sprint',
              sprint: {
                sprint_id: 'sprint-old',
                slug: 'old-sprint',
                display_name: 'Old Sprint',
                goal: 'Old work.',
                status: 'active'
              }
            },
            new_context: { mode: 'space', sprint: null },
            event_ids: ['evt-1'],
            idempotent: false,
            message: 'Left old-sprint; now in Space mode.',
            warnings: []
          }
        },
        {
          credential,
          env: {
            TEAMEM_DATA: work,
            CLAUDE_SESSION_ID: 'sess-1'
          },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:00:00.000Z')
        }
      );

      expect(written).toBe(true);
      const cache = readCache(work);
      expect(cache.space).toEqual({ id: 'space-1', label: 'Alpha Space' });
      expect(cache.sprint).toBeUndefined();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('writes Sprint cache from a production-shaped get_current_sprint response', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-bridge-statusline-current-')
    );
    try {
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.get_current_sprint',
        {
          ok: true,
          data: {
            context: {
              mode: 'sprint',
              sprint: {
                sprint_id: 'sprint-current',
                slug: 'current-sprint',
                display_name: 'Current Sprint',
                goal: 'Stay current.',
                status: 'active'
              }
            },
            sprint: {
              sprint_id: 'sprint-current',
              slug: 'current-sprint',
              display_name: 'Current Sprint',
              goal: 'Stay current.',
              status: 'active'
            },
            current_members: ['alice']
          }
        },
        {
          credential,
          env: {
            TEAMEM_DATA: work,
            CLAUDE_SESSION_ID: 'sess-current'
          },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:00:00.000Z')
        }
      );

      expect(written).toBe(true);
      expect(readCache(work).sprint).toEqual({
        sprint_id: 'sprint-current',
        slug: 'current-sprint',
        display_name: 'Current Sprint'
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('writes Sprint cache from a Sprint-mode get_briefing response', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-bridge-statusline-briefing-sprint-')
    );
    try {
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.get_briefing',
        {
          ok: true,
          data: {
            current_context: {
              mode: 'sprint',
              sprint: {
                sprint_id: 'sprint-briefing',
                slug: 'briefing-sprint',
                display_name: 'Briefing Sprint',
                goal: 'Read the briefing.',
                status: 'active',
                current_members: ['alice']
              },
              routing_reasons: ['current Sprint briefing-sprint']
            },
            current_plan: null,
            active_claims: [],
            recent_decisions: [],
            active_risks: { open_blockers: [], standing_conflicts: [] },
            recent_progress: [],
            recent_notifications: [],
            outside_current_context: { active_claims: [] },
            recent_joins: [],
            recent_findings: [],
            recent_artifacts: [],
            meta: { token_estimate: 1, cursor: null, lag_seconds: null }
          }
        },
        {
          credential,
          env: {
            TEAMEM_DATA: work,
            CLAUDE_SESSION_ID: 'sess-briefing'
          },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:00:00.000Z')
        }
      );

      expect(written).toBe(true);
      expect(readCache(work)).toMatchObject({
        space: { id: 'space-1', label: 'Alpha Space' },
        sprint: {
          sprint_id: 'sprint-briefing',
          slug: 'briefing-sprint',
          display_name: 'Briefing Sprint'
        }
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('clears Sprint cache from a Space-mode get_briefing response', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-bridge-statusline-briefing-space-')
    );
    try {
      expect(
        writeStatuslineDisplayCacheFromToolResponse(
          'teamem.get_current_sprint',
          {
            ok: true,
            data: {
              context: {
                mode: 'sprint',
                sprint: {
                  sprint_id: 'sprint-current',
                  slug: 'current-sprint',
                  display_name: 'Current Sprint'
                }
              }
            }
          },
          {
            credential,
            env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-briefing' },
            cwd: '/tmp/project',
            now: new Date('2026-06-08T00:00:00.000Z')
          }
        )
      ).toBe(true);

      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.get_briefing',
        {
          ok: true,
          data: {
            current_context: {
              mode: 'space',
              sprint: null,
              routing_reasons: ['Space-mode events']
            },
            current_plan: null,
            active_claims: [],
            recent_decisions: [],
            active_risks: { open_blockers: [], standing_conflicts: [] },
            recent_progress: [],
            recent_notifications: [],
            outside_current_context: { active_claims: [] },
            recent_joins: [],
            recent_findings: [],
            recent_artifacts: [],
            meta: { token_estimate: 1, cursor: null, lag_seconds: null }
          }
        },
        {
          credential,
          env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-briefing' },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:01:00.000Z')
        }
      );

      expect(written).toBe(true);
      const cache = readCache(work);
      expect(cache.space).toEqual({ id: 'space-1', label: 'Alpha Space' });
      expect(cache.sprint).toBeUndefined();
      expect(cache.updated_at).toBe('2026-06-08T00:01:00.000Z');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('does not fake Sprint cache from the production session_sync shape', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-bridge-statusline-sync-'));
    try {
      mkdirSync(join(work, 'statusline'), { recursive: true });
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.session_sync',
        {
          ok: true,
          data: {
            space_rules_snapshot: {
              has_server_rules: false,
              rendered_rules_body: '',
              metadata: {
                format_version: 1,
                source: 'none',
                managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
                managed_end: '<!-- END TEAMEM SPACE RULES -->',
                rules_version: 0,
                rules_hash:
                  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                generated_at: '2026-06-08T00:00:00.000Z',
                space_id: 'space-1',
                space_label: 'Alpha Space',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decisions: [],
            decision_replays: [],
            gotcha_notices: []
          }
        },
        {
          credential,
          env: {
            TEAMEM_DATA: work,
            CLAUDE_SESSION_ID: 'sess-1'
          },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:00:00.000Z')
        }
      );

      expect(written).toBe(true);
      const cache = readCache(work);
      expect(cache.space).toEqual({ id: 'space-1', label: 'Alpha Space' });
      expect(cache.sprint).toBeUndefined();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('does not create Sprint cache from fake session_sync current-context data', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-bridge-statusline-sync-fake-sprint-')
    );
    try {
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.session_sync',
        {
          ok: true,
          data: {
            space: { id: 'space-1', label: 'Alpha Space' },
            new_context: {
              mode: 'sprint',
              sprint: {
                sprint_id: 'fake-sprint',
                slug: 'fake',
                display_name: 'Fake Sprint'
              }
            },
            decisions: [],
            gotcha_notices: []
          }
        },
        {
          credential,
          env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-1' },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:00:00.000Z')
        }
      );

      expect(written).toBe(true);
      const cache = readCache(work);
      expect(cache.space).toEqual({ id: 'space-1', label: 'Alpha Space' });
      expect(cache.sprint).toBeUndefined();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('does not erase or extend fresh Sprint cache from whoami in the same Space', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-bridge-statusline-whoami-')
    );
    try {
      expect(
        writeStatuslineDisplayCacheFromToolResponse(
          'teamem.get_current_sprint',
          {
            ok: true,
            data: {
              context: {
                mode: 'sprint',
                sprint: {
                  sprint_id: 'sprint-current',
                  slug: 'current-sprint',
                  display_name: 'Current Sprint'
                }
              }
            }
          },
          {
            credential,
            env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-current' },
            cwd: '/tmp/project',
            now: new Date('2026-06-08T00:00:00.000Z'),
            freshnessMs: 5 * 60 * 1000
          }
        )
      ).toBe(true);
      const before = readCache(work);

      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.whoami',
        {
          ok: true,
          data: {
            principal: 'alice',
            space_id: 'space-1',
            label: 'Alpha Space'
          }
        },
        {
          credential,
          env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-current' },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:01:00.000Z'),
          freshnessMs: 10 * 60 * 1000
        }
      );

      expect(written).toBe(false);
      expect(readCache(work)).toEqual(before);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('clears fresh Sprint cache from whoami when the incoming Space differs', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-bridge-statusline-whoami-switch-')
    );
    try {
      expect(
        writeStatuslineDisplayCacheFromToolResponse(
          'teamem.get_current_sprint',
          {
            ok: true,
            data: {
              context: {
                mode: 'sprint',
                sprint: {
                  sprint_id: 'sprint-current',
                  slug: 'current-sprint',
                  display_name: 'Current Sprint'
                }
              }
            }
          },
          {
            credential,
            env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-current' },
            cwd: '/tmp/project',
            now: new Date('2026-06-08T00:00:00.000Z'),
            freshnessMs: 5 * 60 * 1000
          }
        )
      ).toBe(true);

      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.whoami',
        {
          ok: true,
          data: {
            principal: 'alice',
            space_id: 'space-2',
            label: 'Beta Space'
          }
        },
        {
          credential: { space_id: 'space-2', label: 'Beta Space' },
          env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-current' },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:01:00.000Z'),
          freshnessMs: 10 * 60 * 1000
        }
      );

      expect(written).toBe(true);
      const cache = readCache(work);
      expect(cache.space).toEqual({ id: 'space-2', label: 'Beta Space' });
      expect(cache.sprint).toBeUndefined();
      expect(cache.updated_at).toBe('2026-06-08T00:01:00.000Z');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('clears fresh Sprint cache from session_sync when the incoming Space differs', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-bridge-statusline-sync-preserve-')
    );
    try {
      expect(
        writeStatuslineDisplayCacheFromToolResponse(
          'teamem.get_current_sprint',
          {
            ok: true,
            data: {
              context: {
                mode: 'sprint',
                sprint: {
                  sprint_id: 'sprint-current',
                  slug: 'current-sprint',
                  display_name: 'Current Sprint'
                }
              }
            }
          },
          {
            credential,
            env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-current' },
            cwd: '/tmp/project',
            now: new Date('2026-06-08T00:00:00.000Z'),
            freshnessMs: 5 * 60 * 1000
          }
        )
      ).toBe(true);
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.session_sync',
        {
          ok: true,
          data: {
            space_rules_snapshot: {
              metadata: {
                space_id: 'space-2',
                space_label: 'Beta Space'
              }
            },
            decisions: [],
            gotcha_notices: []
          }
        },
        {
          credential: { space_id: 'space-2', label: 'Beta Space' },
          env: { TEAMEM_DATA: work, CLAUDE_SESSION_ID: 'sess-current' },
          cwd: '/tmp/project',
          now: new Date('2026-06-08T00:01:00.000Z'),
          freshnessMs: 10 * 60 * 1000
        }
      );

      expect(written).toBe(true);
      const cache = readCache(work);
      expect(cache.space).toEqual({ id: 'space-2', label: 'Beta Space' });
      expect(cache.sprint).toBeUndefined();
      expect(cache.updated_at).toBe('2026-06-08T00:01:00.000Z');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('skips non-authoritative responses', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-bridge-statusline-skip-'));
    try {
      const written = writeStatuslineDisplayCacheFromToolResponse(
        'teamem.fetch_unread_notifications',
        {
          ok: true,
          data: { notifications: [] }
        },
        {
          credential,
          env: { TEAMEM_DATA: work },
          cwd: '/tmp/project'
        }
      );

      expect(written).toBe(false);
      expect(existsSync(join(work, 'statusline/display.json'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
