import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InteractiveProcessError,
  InteractiveTimeoutError,
  createClaudePluginTester,
  type InteractivePtyAdapter,
  type InteractivePtyProcess,
  type InteractivePtySpawnRequest,
  type ProcessRunRequest,
  type ProcessRunResult,
  type ProcessRunner
} from '../src/index.js';

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakePluginDir = join(moduleRoot, 'fixtures', 'fake-plugin');

describe('plugin-e2e-module interactive PTY execution', () => {
  it('types a namespaced slash command through the TTY and waits for visible response evidence', async () => {
    const ptySpawns: InteractivePtySpawnRequest[] = [];
    const slashResponse = 'slash command observed through interactive TTY';
    const fakePty = new FakePty({
      readinessText: 'Ready\n',
      commandResponses: {
        '/generic-fake-plugin:echo issue 09 proof': `${slashResponse}\n`
      }
    });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-slash-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter(ptySpawns, fakePty)
      });
      const prompt = await tester.slashCommandPrompt(
        'echo',
        'issue 09 proof'
      );

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        waitTimeoutMs: 20,
        closeTimeoutMs: 20
      });
      await session.submit(prompt, { delayMs: 0 });
      await session.waitFor(slashResponse, { timeoutMs: 20 });
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();

      const rawTranscript = await readFile(
        session.artifacts.rawTranscriptPath,
        'utf8'
      );
      const normalizedTranscript = await readFile(
        session.artifacts.normalizedTranscriptPath,
        'utf8'
      );

      expect(prompt).toBe('/generic-fake-plugin:echo issue 09 proof');
      expect(fakePty.writes).toEqual([prompt, '\n', '/exit\n']);
      expect(
        session.events().filter((event) => event.type === 'input')
      ).toHaveLength(3);
      expect(session.normalizedTranscript()).toContain(slashResponse);
      expect(rawTranscript).not.toContain(slashResponse);
      expect(normalizedTranscript).not.toContain(slashResponse);
      expect(rawTranscript).toBe('[REDACTED]');
      expect(normalizedTranscript).toBe('[REDACTED]');
      expect(normalizedTranscript).not.toContain('\x1b[');
      expect(ptySpawns).toHaveLength(1);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('launches Claude with the instrumented plugin dir and supports multiple submissions', async () => {
    const processCalls: ProcessRunRequest[] = [];
    const ptySpawns: InteractivePtySpawnRequest[] = [];
    const fakePty = new FakePty({ readinessText: '\x1b[32mReady\x1b[0m\r\n' });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        claudeCommand: { command: '/usr/bin/env', args: ['claude', '--shim'] },
        env: {
          PATH: process.env.PATH
        },
        processRunner: createFakeClaudeRunner(processCalls),
        ptyAdapter: createFakePtyAdapter(ptySpawns, fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        closeTimeoutMs: 20
      });
      await session.submit('first', { delayMs: 0 });
      await session.submit('second', { delayMs: 0 });
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();

      expect(session.kind).toBe('interactive');
      expect(ptySpawns).toHaveLength(1);
      expect(ptySpawns[0].command).toBe('/usr/bin/env');
      expect(ptySpawns[0].args.slice(0, 4)).toEqual([
        'claude',
        '--shim',
        '--plugin-dir',
        session.command.args.at(3) ?? ''
      ]);
      expect(session.command.args.at(2)).toBe('--plugin-dir');
      expect(session.command.args.at(3)).toContain(
        'instrumented-plugin-workspace'
      );
      expect(session.command.args.at(3)).not.toBe(fakePluginDir);
      expect(ptySpawns[0].env.CLAUDE_PLUGIN_E2E_HOOK_TRACE_DIR).toBe(
        session.artifacts.hookTraceDir
      );
      expect(ptySpawns[0].env).not.toHaveProperty('CLAUDE_PLUGIN_DATA');
      expect(fakePty.writes).toEqual([
        'first',
        '\n',
        'second',
        '\n',
        '/exit\n'
      ]);
      expect(
        session.events().filter((event) => event.type === 'input')
      ).toHaveLength(5);
      expect(
        processCalls.filter((call) =>
          call.args.includes('--include-hook-events')
        )
      ).toHaveLength(0);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('passes interactive Claude launch options through without headless-only flags', async () => {
    const ptySpawns: InteractivePtySpawnRequest[] = [];
    const fakePty = new FakePty({ readinessText: 'Ready\n' });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-options-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter(ptySpawns, fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        closeTimeoutMs: 20,
        permissionMode: 'bypassPermissions',
        allowedTools: ['Read', 'Bash(git status)'],
        disallowedTools: ['Edit'],
        settingSources: ['user', 'project'],
        systemPrompt: 'system text',
        appendSystemPrompt: 'append text',
        model: 'claude-sonnet-4-6',
        maxBudgetUsd: 1.25,
        maxTurns: 99
      } as Parameters<typeof tester.launchInteractive>[0] & {
        maxTurns: number;
      });
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();

      expect(ptySpawns).toHaveLength(1);
      expect(ptySpawns[0].args).toEqual([
        '--plugin-dir',
        session.command.args.at(1) ?? '',
        '--permission-mode',
        'bypassPermissions',
        '--allowedTools',
        'Read',
        '--allowedTools',
        'Bash(git status)',
        '--disallowedTools',
        'Edit',
        '--setting-sources',
        'user,project',
        '--system-prompt',
        'system text',
        '--append-system-prompt',
        'append text',
        '--model',
        'claude-sonnet-4-6',
        '--max-budget-usd',
        '1.25'
      ]);
      expect(ptySpawns[0].args).not.toContain('-p');
      expect(ptySpawns[0].args).not.toContain('option prompt');
      expect(ptySpawns[0].args).not.toContain('--max-turns');
      expect(ptySpawns[0].args).not.toContain('--settings');
      expect(ptySpawns[0].args).not.toContain('--isolation');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('supports every documented interactive permission mode', async () => {
    const ptySpawns: InteractivePtySpawnRequest[] = [];
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-permission-modes-')
    );
    const modes = [
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions'
    ] as const;

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: {
          spawn(request) {
            ptySpawns.push(request);
            const pty = new FakePty({
              readinessText: 'Ready\n',
              exitOnKill: 0
            });
            pty.start();
            return pty;
          }
        }
      });

      for (const mode of modes) {
        const session = await tester.launchInteractive({
          readiness: 'Ready',
          readinessTimeoutMs: 20,
          closeTimeoutMs: 20,
          permissionMode: mode
        });
        await session.close();
      }

      expect(
        ptySpawns.map(
          (spawn) => spawn.args[spawn.args.indexOf('--permission-mode') + 1]
        )
      ).toEqual([...modes]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('captures raw and normalized transcripts plus synthetic events', async () => {
    const fakePty = new FakePty({ readinessText: '\x1b[31mReady\x1b[0m\r\n' });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-artifacts-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: /Ready/,
        readinessTimeoutMs: 20,
        closeTimeoutMs: 20
      });
      fakePty.emitData('answer: \x1b[1mok\x1b[0m\r\n');
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();

      const rawTranscript = await readFile(
        session.artifacts.rawTranscriptPath,
        'utf8'
      );
      const normalizedTranscript = await readFile(
        session.artifacts.normalizedTranscriptPath,
        'utf8'
      );
      const events = JSON.parse(
        await readFile(session.artifacts.interactiveEventsPath, 'utf8')
      ) as Array<{ type: string }>;
      const summary = JSON.parse(
        await readFile(session.artifacts.summaryPath, 'utf8')
      ) as { kind: string; result: { eventCount: number } };

      expect(session.rawTranscript()).toContain('\x1b[31mReady\x1b[0m');
      expect(session.rawTranscript()).toContain('\r\n');
      expect(session.normalizedTranscript()).toContain('Ready\n');
      expect(session.normalizedTranscript()).toContain('answer: ok\n');
      expect(rawTranscript).toBe('[REDACTED]');
      expect(normalizedTranscript).toBe('[REDACTED]');
      expect(normalizedTranscript).not.toContain('\x1b[');
      expect(events.map((event) => event.type)).toContain('ready');
      expect(events.map((event) => event.type)).toContain('close-step');
      expect(JSON.stringify(events)).not.toContain('answer: ok');
      expect(summary.kind).toBe('interactive');
      expect(summary.result.eventCount).toBe(events.length);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('throws InteractiveTimeoutError when readiness text never appears', async () => {
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-timeout-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], new FakePty())
      });

      await expect(
        tester.launchInteractive({
          readiness: 'never-ready',
          readinessTimeoutMs: 1
        })
      ).rejects.toThrow(InteractiveTimeoutError);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('does not treat generic Claude banner text as default readiness', async () => {
    const fakePty = new FakePty();
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-readiness-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], fakePty)
      });

      let resolved = false;
      const launch = tester
        .launchInteractive({
          readinessTimeoutMs: 50,
          closeTimeoutMs: 20
        })
        .then((session) => {
          resolved = true;
          return session;
        });

      await fakePty.waitForDataListenerCount(2);
      fakePty.emitData('Claude Code\n> ');
      expect(resolved).toBe(false);

      fakePty.emitData('\x1b[32mReady\x1b[0m\r\n');
      const session = await launch;
      expect(session.normalizedTranscript()).toContain('Ready\n');
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('writes type, press, and submit bytes and escalates close to kill', async () => {
    const fakePty = new FakePty({
      readinessText: 'Ready\n',
      exitOnKill: 0
    });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-close-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        closeTimeoutMs: 1
      });
      await session.type('ab', { delayMs: 0 });
      await session.press('enter');
      await session.submit('done', { delayMs: 0 });
      await session.close();

      expect(fakePty.writes).toEqual([
        'ab',
        '\n',
        'done',
        '\n',
        '/exit\n',
        '\x03'
      ]);
      expect(fakePty.killCalls).toEqual([undefined]);
      expect(
        session
          .events()
          .filter((event) => event.type === 'close-step')
          .map((event) => ('step' in event ? event.step : undefined))
      ).toEqual(['exit-command', 'ctrl-c', 'kill']);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('throws and records a failure when kill does not close the PTY', async () => {
    const fakePty = new FakePty({ readinessText: 'Ready\n' });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-close-timeout-')
    );

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        closeTimeoutMs: 1
      });

      await expect(session.close()).rejects.toThrow(InteractiveProcessError);
      await session.close();

      const summary = JSON.parse(
        await readFile(session.artifacts.summaryPath, 'utf8')
      ) as {
        exitStatus: {
          exitCode: number | null;
          errorCode?: string;
          errorReason?: string;
        };
      };

      expect(summary.exitStatus.exitCode).toBe(null);
      expect(summary.exitStatus.errorCode).toBe('CLOSE_TIMEOUT');
      expect(summary.exitStatus.errorReason).toContain(
        'did not exit after kill'
      );
      expect(fakePty.killCalls).toEqual([undefined]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('redacts submitted interactive input from persisted safe artifacts', async () => {
    const fakePty = new FakePty({ readinessText: 'Ready\n' });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-redaction-')
    );
    const secret = 'secret-input-must-not-leak';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        closeTimeoutMs: 20
      });
      await session.submit(secret, { delayMs: 0 });
      fakePty.emitData(`echoed ${secret}\n`);
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();

      const rawTranscript = await readFile(
        session.artifacts.rawTranscriptPath,
        'utf8'
      );
      const normalizedTranscript = await readFile(
        session.artifacts.normalizedTranscriptPath,
        'utf8'
      );
      const events = await readFile(
        session.artifacts.interactiveEventsPath,
        'utf8'
      );

      expect(session.rawTranscript()).toContain(secret);
      expect(JSON.stringify(session.events())).toContain(secret);
      expect(rawTranscript).not.toContain(secret);
      expect(normalizedTranscript).not.toContain(secret);
      expect(events).not.toContain(secret);
      expect(events).toContain('[REDACTED]');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('redacts arbitrary PTY output from persisted safe artifacts even when it was never typed', async () => {
    const fakePty = new FakePty({ readinessText: 'Ready\n' });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-output-redaction-')
    );
    const secret = 'untyped-pty-output-secret-must-not-leak';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        closeTimeoutMs: 20
      });
      fakePty.emitData(`plugin emitted ${secret}\n`);
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();

      const rawTranscript = await readFile(
        session.artifacts.rawTranscriptPath,
        'utf8'
      );
      const normalizedTranscript = await readFile(
        session.artifacts.normalizedTranscriptPath,
        'utf8'
      );
      const events = await readFile(
        session.artifacts.interactiveEventsPath,
        'utf8'
      );

      expect(session.rawTranscript()).toContain(secret);
      expect(JSON.stringify(session.events())).toContain(secret);
      expect(rawTranscript).not.toContain(secret);
      expect(normalizedTranscript).not.toContain(secret);
      expect(events).not.toContain(secret);
      expect(rawTranscript).toBe('[REDACTED]');
      expect(normalizedTranscript).toBe('[REDACTED]');
      expect(events).toContain('[REDACTED]');
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('preserves submitted interactive input when unredacted artifacts are explicitly allowed', async () => {
    const previousAllowUnredacted =
      process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED = '1';

    const fakePty = new FakePty({ readinessText: 'Ready\n' });
    const artifactsDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-interactive-unredacted-')
    );
    const secret = 'allowed-unredacted-input';

    try {
      const tester = createClaudePluginTester({
        pluginDir: fakePluginDir,
        artifactsDir,
        cleanup: 'never',
        redaction: { mode: 'off' },
        processRunner: createFakeClaudeRunner([]),
        ptyAdapter: createFakePtyAdapter([], fakePty)
      });

      const session = await tester.launchInteractive({
        readiness: 'Ready',
        readinessTimeoutMs: 20,
        closeTimeoutMs: 20
      });
      await session.submit(secret, { delayMs: 0 });
      fakePty.emitData(`echoed ${secret}\n`);
      fakePty.exitOnWrite('/exit\n', 0);
      await session.close();

      expect(
        await readFile(session.artifacts.rawTranscriptPath, 'utf8')
      ).toContain(secret);
      expect(
        await readFile(session.artifacts.interactiveEventsPath, 'utf8')
      ).toContain(secret);
    } finally {
      if (previousAllowUnredacted === undefined) {
        delete process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED;
      } else {
        process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED =
          previousAllowUnredacted;
      }
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

function createFakePtyAdapter(
  spawns: InteractivePtySpawnRequest[],
  pty: FakePty
): InteractivePtyAdapter {
  return {
    spawn(request) {
      spawns.push(request);
      pty.start();
      return pty;
    }
  };
}

class FakePty implements InteractivePtyProcess {
  readonly pid = 1234;
  readonly writes: string[] = [];
  readonly killCalls: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  private started = false;
  private exitTriggers = new Map<string, number>();
  private pendingCommandResponse: string | undefined;

  constructor(
    private readonly options: {
      readinessText?: string;
      exitOnKill?: number;
      commandResponses?: Record<string, string>;
    } = {}
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.options.readinessText) {
      setTimeout(() => this.emitData(this.options.readinessText ?? ''), 0);
    }
  }

  write(data: string | Buffer): void {
    const text = String(data);
    this.writes.push(text);
    if (text === '\n' && this.pendingCommandResponse !== undefined) {
      const response = this.pendingCommandResponse;
      this.pendingCommandResponse = undefined;
      setTimeout(() => this.emitData(response), 0);
    } else if (this.options.commandResponses?.[text] !== undefined) {
      this.pendingCommandResponse = this.options.commandResponses[text];
    }
    const exitCode = this.exitTriggers.get(text);
    if (exitCode !== undefined) {
      setTimeout(() => this.emitExit(exitCode), 0);
    }
  }

  kill(signal?: string): void {
    this.killCalls.push(signal);
    if (this.options.exitOnKill !== undefined) {
      setTimeout(() => this.emitExit(this.options.exitOnKill ?? 0), 0);
    }
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => this.dataListeners.delete(listener)
    };
  }

  async waitForDataListenerCount(
    expectedCount: number,
    timeoutMs = 100
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.dataListeners.size < expectedCount) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${expectedCount} fake PTY data listeners; got ${this.dataListeners.size}.`
        );
      }
      await delay(1);
    }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  } {
    this.exitListeners.add(listener);
    return {
      dispose: () => this.exitListeners.delete(listener)
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  exitOnWrite(data: string, exitCode: number): void {
    this.exitTriggers.set(data, exitCode);
  }

  private emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode });
    }
  }
}

function createFakeClaudeRunner(calls: ProcessRunRequest[]): ProcessRunner {
  return async (request: ProcessRunRequest): Promise<ProcessRunResult> => {
    calls.push(request);

    if (request.args.at(-1) === '--version') {
      return ok('2.1.158 (Claude Code)');
    }

    if (request.args.slice(-3).join(' ') === 'auth status --json') {
      return ok('{"authenticated":true}');
    }

    if (request.args.at(-1) === '--help') {
      return ok(
        'Usage: claude --plugin-dir ./plugin -p --output-format stream-json --verbose --include-hook-events --permission-mode auto'
      );
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unexpected fake Claude call: ${request.args.join(' ')}`
    };
  };
}

function ok(stdout: string): ProcessRunResult {
  return {
    exitCode: 0,
    stdout,
    stderr: ''
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
