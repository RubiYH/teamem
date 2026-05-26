/**
 * Slice #35 regression — session-start.sh offline delivery path.
 *
 * Stages a fake plugin, inserts an unread_notifications row directly into the
 * bridge's stub response, fires SessionStart, and asserts:
 *  - The fetch_unread_notifications call was made.
 *  - Each force-release notification was surfaced as a warn line on stderr.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  chmodSync,
  existsSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { marketplaceEnv } from '../helpers/marketplace-env.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');

function expectedBriefingPrompt(space?: string): string {
  const payload = space
    ? JSON.stringify({ token_budget: 2000, space })
    : '{"token_budget":2000}';
  return (
    'teamem: Teamem is active at session startup/resume. The first Teamem step ' +
    'for this session is one mcp__teamem__get_briefing call with ' +
    `${payload}; later edit coordination uses Teamem claim/conflict tools, ` +
    'so full briefing is not repeated before every edit.\n'
  );
}

function stageFakePlugin(
  workdir: string,
  sessionSyncResponse: Record<string, unknown>,
  notifications: Array<{
    event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>,
  options: { whoamiOk?: boolean } = {}
): { sentinel: string } {
  mkdirSync(join(workdir, 'plugin/scripts'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/bin'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/lib'), { recursive: true });
  mkdirSync(join(workdir, 'plugin/templates'), { recursive: true });

  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/_common.sh'),
    join(workdir, 'plugin/scripts/_common.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/space-rules-file.js'),
    join(workdir, 'plugin/scripts/space-rules-file.js')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/scripts/session-start.sh'),
    join(workdir, 'plugin/scripts/session-start.sh')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/bin/teamem-flag'),
    join(workdir, 'plugin/bin/teamem-flag')
  );
  copyFileSync(
    join(REPO_ROOT, 'plugin/templates/TEAMEM.starter.md'),
    join(workdir, 'plugin/templates/TEAMEM.starter.md')
  );
  chmodSync(join(workdir, 'plugin/scripts/session-start.sh'), 0o755);
  chmodSync(join(workdir, 'plugin/scripts/space-rules-file.js'), 0o755);
  chmodSync(join(workdir, 'plugin/bin/teamem-flag'), 0o755);

  const sentinel = join(workdir, 'argv.log');
  const notifJson = JSON.stringify(notifications);
  const syncJson = JSON.stringify(sessionSyncResponse);
  writeFileSync(
    join(workdir, 'plugin/lib/bridge.js'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify(argv) + '\\n');

const tool = argv[1];
if (tool === 'teamem.session_sync') {
  process.stdout.write(JSON.stringify(${syncJson}));
} else if (tool === 'teamem.fetch_unread_notifications') {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: { notifications: ${notifJson} }
  }));
} else if (tool === 'teamem.whoami') {
  if (${JSON.stringify(options.whoamiOk === false)}) {
    process.stderr.write('unknown space');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    data: { principal: 'alice', space_id: 'space-B', label: 'Beta' }
  }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: {} }));
}
process.exit(0);
`,
    { mode: 0o755 }
  );

  return { sentinel };
}

function activateSession(workdir: string, sessionId: string, space?: string) {
  const sd = join(workdir, 'plugin-data/sessions', sessionId);
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'active'), '');
  if (space) writeFileSync(join(sd, 'space'), space);
}

function runSessionStart(
  workdir: string,
  sessionId: string,
  cwd = workdir,
  source?: 'startup' | 'resume' | 'clear' | 'compact',
  defaultSpace?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number | null; stderr: string; stdout: string } {
  const env = marketplaceEnv({
    CLAUDE_PLUGIN_ROOT: join(workdir, 'plugin'),
    CLAUDE_PLUGIN_DATA: join(workdir, 'plugin-data'),
    CLAUDE_SESSION_ID: sessionId,
    CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE: defaultSpace,
    ...extraEnv
  });
  const r = spawnSync(
    'bash',
    [join(workdir, 'plugin/scripts/session-start.sh')],
    {
      cwd,
      env,
      input: JSON.stringify({
        session_id: sessionId,
        ...(source ? { source } : {})
      }),
      encoding: 'utf-8',
      timeout: 15_000
    }
  );
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

describe('session-start.sh offline notification delivery (slice #35)', () => {
  it('injects the exact one-line briefing prompt on startup and resume only', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-prompt-'));
    try {
      stageFakePlugin(
        work,
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
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-prompt';
      activateSession(work, sessionId, 'space-A');

      const startup = runSessionStart(
        work,
        sessionId,
        work,
        'startup',
        'space-default'
      );
      const resume = runSessionStart(
        work,
        sessionId,
        work,
        'resume',
        'space-default'
      );
      const clear = runSessionStart(work, sessionId, work, 'clear');
      const compact = runSessionStart(work, sessionId, work, 'compact');

      for (const result of [startup, resume, clear, compact]) {
        expect(result.status).toBe(0);
      }
      expect(startup.stdout).toBe(expectedBriefingPrompt('space-A'));
      expect(resume.stdout).toBe(expectedBriefingPrompt('space-A'));
      expect(clear.stdout).toBe('');
      expect(compact.stdout).toBe('');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps the fallback briefing payload when no session or default space resolves', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-fallback-'));
    try {
      stageFakePlugin(
        work,
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
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-default',
                space_label: 'Default',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-fallback';
      activateSession(work, sessionId);

      const startup = runSessionStart(work, sessionId, work, 'startup');

      expect(startup.status).toBe(0);
      expect(startup.stdout).toBe(expectedBriefingPrompt());
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('activates from launcher intent before running briefing and session sync', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-launch-'));
    try {
      const { sentinel } = stageFakePlugin(
        work,
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
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-B',
                space_label: 'Beta',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-launch-intent';

      const startup = runSessionStart(
        work,
        sessionId,
        work,
        'startup',
        undefined,
        {
          TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate',
          TEAMEM_CLAUDE_LAUNCH_SPACE: 'space-B'
        }
      );

      expect(startup.status).toBe(0);
      expect(startup.stdout).toBe(expectedBriefingPrompt('space-B'));
      const sessionDir = join(work, 'plugin-data/sessions', sessionId);
      expect(existsSync(join(sessionDir, 'active'))).toBe(true);
      expect(readFileSync(join(sessionDir, 'space'), 'utf8')).toBe('space-B');

      const argvLines = readFileSync(sentinel, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(argvLines).toContainEqual([
        'call',
        'teamem.whoami',
        '--space',
        'space-B',
        '--json',
        '{}'
      ]);
      expect(argvLines).toContainEqual([
        'call',
        'teamem.session_sync',
        '--space',
        'space-B',
        '--json',
        '{}'
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('stops after warning when explicit launcher Space fails validation despite project auto-on', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-invalid-launch-'));
    try {
      const { sentinel } = stageFakePlugin(
        work,
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
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        [],
        { whoamiOk: false }
      );

      const setupEnv = marketplaceEnv({
        CLAUDE_PLUGIN_ROOT: join(work, 'plugin'),
        CLAUDE_PLUGIN_DATA: join(work, 'plugin-data'),
        CLAUDE_SESSION_ID: 'setup-session'
      });
      const persisted = spawnSync(
        'bash',
        [join(work, 'plugin/bin/teamem-flag'), 'enable', '--persist'],
        { cwd: work, env: setupEnv, encoding: 'utf-8' }
      );
      expect(persisted.status).toBe(0);

      const startup = runSessionStart(
        work,
        'sess-start-invalid-launch-intent',
        work,
        'startup',
        'space-A',
        {
          TEAMEM_CLAUDE_LAUNCH_INTENT: 'activate',
          TEAMEM_CLAUDE_LAUNCH_SPACE: 'missing-space'
        }
      );

      expect(startup.status).toBe(0);
      expect(startup.stdout).toBe('');
      expect(startup.stderr).toContain('could not activate Teamem for Space');
      expect(startup.stderr).toContain('missing-space');

      const argvLines = readFileSync(sentinel, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      expect(argvLines).toContainEqual([
        'call',
        'teamem.whoami',
        '--space',
        'missing-space',
        '--json',
        '{}'
      ]);
      expect(
        argvLines.some(
          (argv) =>
            argv.includes('teamem.session_sync') ||
            argv.includes('teamem.fetch_unread_notifications')
        )
      ).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('calls fetch_unread_notifications on SessionStart', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-'));
    try {
      const { sentinel } = stageFakePlugin(
        work,
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
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-01';
      activateSession(work, sessionId, 'space-A');

      const { status } = runSessionStart(work, sessionId);
      expect(status).toBe(0);

      expect(existsSync(sentinel)).toBe(true);
      const calls = readFileSync(sentinel, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
      const fetchCalls = calls.filter((c) =>
        c.includes('teamem.fetch_unread_notifications')
      );
      const syncCalls = calls.filter((c) => c.includes('teamem.session_sync'));
      expect(syncCalls.length).toBeGreaterThanOrEqual(1);
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('surfaces claim_force_released notification as warn line on stderr', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-notif-'));
    try {
      const notifications = [
        {
          event_id: 'evt-001',
          event_type: 'claim_force_released',
          payload: {
            path: 'src/Form.jsx',
            branch: 'feature/alice',
            released_by: 'bob',
            released_at: '2026-05-05T10:00:00.000Z',
            original_holder: 'alice'
          },
          created_at: '2026-05-05T10:00:00.000Z'
        }
      ];
      stageFakePlugin(
        work,
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
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        notifications
      );
      const sessionId = 'sess-start-02';
      activateSession(work, sessionId, 'space-A');

      const { status, stderr, stdout } = runSessionStart(work, sessionId);
      expect(status).toBe(0);
      expect(stdout).toBe(expectedBriefingPrompt('space-A'));

      // Should contain the path and released_by in the warn output.
      expect(stderr).toContain('src/Form.jsx');
      expect(stderr).toContain('bob');
      expect(stderr).toContain('force-release');
      expect(stdout).not.toContain('src/Form.jsx');
      expect(stdout).not.toContain('bob');
      expect(stdout).not.toContain('force-release');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('surfaces decision replays and gotcha notices from session_sync together', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-space-memory-'));
    try {
      stageFakePlugin(
        work,
        {
          ok: true,
          data: {
            space_rules_snapshot: {
              has_server_rules: true,
              rendered_rules_body: 'Prefer focused diffs.',
              metadata: {
                format_version: 1,
                source: 'server',
                managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
                managed_end: '<!-- END TEAMEM SPACE RULES -->',
                rules_version: 1,
                rules_hash:
                  '2a33b36266ae01c7781be15a110564b9efeeb188fff4ab580455e4f1378f6758',
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: 'evt-rules-1',
                snapshot_updated_at: '2026-05-10T00:00:00.000Z',
                snapshot_updated_by: 'alice'
              }
            },
            decisions: [
              {
                event_id: 'evt-decision-1',
                event_type: 'decision_published',
                principal: 'bob',
                created_at: '2026-05-10T01:00:00.000Z',
                payload: {
                  decision_id: 'dec-space-memory',
                  title: 'Use session_sync as the catch-up path',
                  summary: 'Decisions should replay with full text.',
                  body: 'Full decision body for SessionStart.',
                  kind: 'process',
                  version: 1
                }
              }
            ],
            decision_replays: [
              {
                event_id: 'evt-decision-1',
                event_type: 'decision_published',
                principal: 'bob',
                created_at: '2026-05-10T01:00:00.000Z',
                payload: {
                  decision_id: 'dec-space-memory',
                  title: 'Use session_sync as the catch-up path',
                  summary: 'Decisions should replay with full text.',
                  body: 'Full decision body for SessionStart.',
                  kind: 'process',
                  version: 1
                }
              }
            ],
            gotcha_notices: [
              {
                event_id: 'evt-gotcha-1',
                event_type: 'gotcha_notice',
                created_at: '2026-05-10T01:05:00.000Z',
                payload: {
                  finding_id: 'finding-space-memory',
                  version: 2,
                  summary: 'Refresh TEAMEM.md only from the server snapshot.',
                  severity: 'warning',
                  paths: ['plugin/scripts/session-start.sh'],
                  tags: ['space-memory'],
                  recipient_mode: 'broadcast',
                  recipient_principals: [],
                  relevance: 'path_overlap'
                }
              }
            ]
          }
        },
        []
      );
      const sessionId = 'sess-start-space-memory';
      activateSession(work, sessionId, 'space-A');

      const { status, stderr, stdout } = runSessionStart(work, sessionId);
      expect(status).toBe(0);
      expect(stdout).toBe(expectedBriefingPrompt('space-A'));
      expect(stderr).toContain(
        '[decision] decision_published dec-space-memory'
      );
      expect(stderr).toContain('Full decision body for SessionStart.');
      expect(stderr).toContain(
        '[gotcha:warning] finding-space-memory — Refresh TEAMEM.md only from the server snapshot.'
      );
      expect(stderr).toContain('teamem.get_finding');
      expect(stderr).toContain('teamem.acknowledge_finding');
      expect(stdout).not.toContain('dec-space-memory');
      expect(stdout).not.toContain('finding-space-memory');
      expect(stdout).not.toContain('Full decision body for SessionStart.');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('exits 0 with no bridge calls when session is inactive', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-inactive-'));
    try {
      const { sentinel } = stageFakePlugin(
        work,
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
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: null,
                snapshot_updated_at: null,
                snapshot_updated_by: null
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-inactive';
      // Do NOT activate the session.

      const { status } = runSessionStart(work, sessionId);
      expect(status).toBe(0);

      // Bridge should not be called at all.
      if (existsSync(sentinel)) {
        const calls = readFileSync(sentinel, 'utf-8')
          .trim()
          .split('\n')
          .filter(Boolean);
        expect(calls.length).toBe(0);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('rewrites only the managed block when the server is newer and the local copy is unchanged', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-rules-refresh-'));
    try {
      stageFakePlugin(
        work,
        {
          ok: true,
          data: {
            space_rules_snapshot: {
              has_server_rules: true,
              rendered_rules_body:
                'Prefer focused diffs.\nAlways read the latest decision thread.',
              metadata: {
                format_version: 1,
                source: 'server',
                managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
                managed_end: '<!-- END TEAMEM SPACE RULES -->',
                rules_version: 2,
                rules_hash:
                  '0ff2a02c208bb0ed73fe41f6db7a3ab4d04d3f967be3fb5ef424e486fb7a6d46',
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: 'evt-rules-2',
                snapshot_updated_at: '2026-05-10T00:00:00.000Z',
                snapshot_updated_by: 'alice'
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-rules-refresh';
      activateSession(work, sessionId, 'space-A');
      const repo = join(work, 'repo');
      mkdirSync(repo, { recursive: true });
      const originalPrefix =
        '# TEAMEM.md\n\nLocal intro.\n\n## Teamem Space Rules\n\n';
      const originalSuffix = '\nLocal outro.\n';
      writeFileSync(
        join(repo, 'TEAMEM.md'),
        `${originalPrefix}<!-- BEGIN TEAMEM SPACE RULES -->\n<!-- teamem:space-rules {"format_version":1,"source":"server","managed_begin":"\\u003c!-- BEGIN TEAMEM SPACE RULES --\\u003e","managed_end":"\\u003c!-- END TEAMEM SPACE RULES --\\u003e","rules_version":1,"rules_hash":"2a33b36266ae01c7781be15a110564b9efeeb188fff4ab580455e4f1378f6758","generated_at":"2026-05-09T00:00:00.000Z","space_id":"space-A","space_label":"Space A","source_event_id":"evt-rules-1","snapshot_updated_at":"2026-05-09T00:00:00.000Z","snapshot_updated_by":"alice"} -->\nPrefer focused diffs.\n<!-- END TEAMEM SPACE RULES -->${originalSuffix}`
      );

      const { status, stderr } = runSessionStart(work, sessionId, repo);
      expect(status).toBe(0);
      expect(stderr).not.toContain('space_rules_sync_conflict');

      const teamem = readFileSync(join(repo, 'TEAMEM.md'), 'utf8');
      expect(teamem.startsWith(originalPrefix)).toBe(true);
      expect(teamem.endsWith(originalSuffix)).toBe(true);
      expect(teamem).toContain('Always read the latest decision thread.');
      expect(teamem).toContain('"rules_version":2');
      expect(teamem).not.toContain('"rules_version":1');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('preserves a local draft when the server snapshot is unchanged', () => {
    const work = mkdtempSync(join(tmpdir(), 'teamem-sessstart-rules-draft-'));
    try {
      stageFakePlugin(
        work,
        {
          ok: true,
          data: {
            space_rules_snapshot: {
              has_server_rules: true,
              rendered_rules_body: 'Prefer focused diffs.',
              metadata: {
                format_version: 1,
                source: 'server',
                managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
                managed_end: '<!-- END TEAMEM SPACE RULES -->',
                rules_version: 1,
                rules_hash:
                  '2a33b36266ae01c7781be15a110564b9efeeb188fff4ab580455e4f1378f6758',
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: 'evt-rules-1',
                snapshot_updated_at: '2026-05-10T00:00:00.000Z',
                snapshot_updated_by: 'alice'
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-rules-draft';
      activateSession(work, sessionId, 'space-A');
      const repo = join(work, 'repo');
      mkdirSync(repo, { recursive: true });
      const original = `# TEAMEM.md

## Teamem Space Rules

<!-- BEGIN TEAMEM SPACE RULES -->
<!-- teamem:space-rules {"format_version":1,"source":"server","managed_begin":"\\u003c!-- BEGIN TEAMEM SPACE RULES --\\u003e","managed_end":"\\u003c!-- END TEAMEM SPACE RULES --\\u003e","rules_version":1,"rules_hash":"2a33b36266ae01c7781be15a110564b9efeeb188fff4ab580455e4f1378f6758","generated_at":"2026-05-09T00:00:00.000Z","space_id":"space-A","space_label":"Space A","source_event_id":"evt-rules-1","snapshot_updated_at":"2026-05-09T00:00:00.000Z","snapshot_updated_by":"alice"} -->
Prefer focused diffs.
Add an extra local draft line.
<!-- END TEAMEM SPACE RULES -->
`;
      writeFileSync(join(repo, 'TEAMEM.md'), original);

      const { status, stderr } = runSessionStart(work, sessionId, repo);
      expect(status).toBe(0);
      expect(stderr).not.toContain('space_rules_sync_conflict');
      expect(readFileSync(join(repo, 'TEAMEM.md'), 'utf8')).toBe(original);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses overwrite with a typed conflict when both the local draft and server changed', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-sessstart-rules-conflict-')
    );
    try {
      stageFakePlugin(
        work,
        {
          ok: true,
          data: {
            space_rules_snapshot: {
              has_server_rules: true,
              rendered_rules_body:
                'Prefer focused diffs.\nRead the current plan.',
              metadata: {
                format_version: 1,
                source: 'server',
                managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
                managed_end: '<!-- END TEAMEM SPACE RULES -->',
                rules_version: 2,
                rules_hash:
                  'd00990fca9e30f12c23816f0dc82c38548063f07151c5d54f7f7cf91cc8c7bc1',
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: 'evt-rules-2',
                snapshot_updated_at: '2026-05-10T00:00:00.000Z',
                snapshot_updated_by: 'alice'
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-rules-conflict';
      activateSession(work, sessionId, 'space-A');
      const repo = join(work, 'repo');
      mkdirSync(repo, { recursive: true });
      const original = `# TEAMEM.md

## Teamem Space Rules

<!-- BEGIN TEAMEM SPACE RULES -->
<!-- teamem:space-rules {"format_version":1,"source":"server","managed_begin":"\\u003c!-- BEGIN TEAMEM SPACE RULES --\\u003e","managed_end":"\\u003c!-- END TEAMEM SPACE RULES --\\u003e","rules_version":1,"rules_hash":"2a33b36266ae01c7781be15a110564b9efeeb188fff4ab580455e4f1378f6758","generated_at":"2026-05-09T00:00:00.000Z","space_id":"space-A","space_label":"Space A","source_event_id":"evt-rules-1","snapshot_updated_at":"2026-05-09T00:00:00.000Z","snapshot_updated_by":"alice"} -->
Prefer focused diffs.
Local draft divergence.
<!-- END TEAMEM SPACE RULES -->
`;
      writeFileSync(join(repo, 'TEAMEM.md'), original);

      const { status, stderr } = runSessionStart(work, sessionId, repo);
      expect(status).toBe(0);
      expect(readFileSync(join(repo, 'TEAMEM.md'), 'utf8')).toBe(original);
      expect(stderr).toContain('"code":"space_rules_sync_conflict"');
      expect(stderr).toContain('"local_version":1');
      expect(stderr).toContain('"server_version":2');
      expect(stderr).toContain(
        '"server_hash":"d00990fca9e30f12c23816f0dc82c38548063f07151c5d54f7f7cf91cc8c7bc1"'
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  it('is idempotent on repeated SessionStart once TEAMEM.md matches the server snapshot', () => {
    const work = mkdtempSync(
      join(tmpdir(), 'teamem-sessstart-rules-idempotent-')
    );
    try {
      stageFakePlugin(
        work,
        {
          ok: true,
          data: {
            space_rules_snapshot: {
              has_server_rules: true,
              rendered_rules_body: 'Prefer focused diffs.',
              metadata: {
                format_version: 1,
                source: 'server',
                managed_begin: '<!-- BEGIN TEAMEM SPACE RULES -->',
                managed_end: '<!-- END TEAMEM SPACE RULES -->',
                rules_version: 1,
                rules_hash:
                  '2a33b36266ae01c7781be15a110564b9efeeb188fff4ab580455e4f1378f6758',
                generated_at: '2026-05-10T00:00:00.000Z',
                space_id: 'space-A',
                space_label: 'Space A',
                source_event_id: 'evt-rules-1',
                snapshot_updated_at: '2026-05-10T00:00:00.000Z',
                snapshot_updated_by: 'alice'
              }
            },
            decision_replays: [],
            gotcha_notices: []
          }
        },
        []
      );
      const sessionId = 'sess-start-rules-idempotent';
      activateSession(work, sessionId, 'space-A');
      const repo = join(work, 'repo');
      mkdirSync(repo, { recursive: true });

      const first = runSessionStart(work, sessionId, repo);
      expect(first.status).toBe(0);

      const teamemPath = join(repo, 'TEAMEM.md');
      const cache = join(repo, '.teamem', 'space-rules-snapshot.json');
      const firstTeamem = readFileSync(teamemPath, 'utf8');
      const firstTeamemMtime = statSync(teamemPath).mtimeMs;
      const firstCacheMtime = statSync(cache).mtimeMs;

      const second = runSessionStart(work, sessionId, repo);
      expect(second.status).toBe(0);
      expect(readFileSync(teamemPath, 'utf8')).toBe(firstTeamem);
      expect(statSync(teamemPath).mtimeMs).toBe(firstTeamemMtime);
      expect(statSync(cache).mtimeMs).toBe(firstCacheMtime);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});
