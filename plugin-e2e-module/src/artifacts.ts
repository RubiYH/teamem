import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RedactionConfigError } from './errors.js';
import type { CleanupMode, RedactionMode, RunArtifacts } from './types.js';

const CURATED_ENV_KEYS = [
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PROJECT_DIR'
] as const;

export type ArtifactManager = {
  root: string;
  createRunArtifacts(kind: string): Promise<RunArtifacts>;
  writeRunBaseline(
    artifacts: RunArtifacts,
    env: NodeJS.ProcessEnv
  ): Promise<void>;
  writeTextArtifact(path: string, value: string): Promise<void>;
  writeJsonArtifact(path: string, value: unknown): Promise<void>;
  cleanupRun(artifacts: RunArtifacts, success: boolean): Promise<void>;
};

export async function createArtifactManager(options: {
  artifactsDir?: string;
  cleanup: CleanupMode;
  redactionMode: RedactionMode;
}): Promise<ArtifactManager> {
  assertRedactionAllowed(options.redactionMode);

  const root =
    options.artifactsDir ??
    (await mkdtemp(join(tmpdir(), 'claude-plugin-e2e-')));
  await mkdir(root, { recursive: true });

  return {
    root,
    async createRunArtifacts(kind: string): Promise<RunArtifacts> {
      const runId = `${Date.now()}-${kind}-${randomUUID()}`;
      const dir = join(root, runId);
      const rawDir = join(dir, 'raw');
      const hookTraceDir = join(rawDir, 'hook-traces');
      const mcpTraceDir = join(rawDir, 'mcp-traces');
      await mkdir(hookTraceDir, { recursive: true });
      await mkdir(mcpTraceDir, { recursive: true });

      return {
        runId,
        dir,
        rawDir,
        hookTraceDir,
        mcpTraceDir,
        summaryPath: join(dir, 'run-summary.json'),
        environmentPath: join(dir, 'environment.json'),
        rawStdoutPath: join(rawDir, 'stdout.raw'),
        rawStderrPath: join(rawDir, 'stderr.raw'),
        debugLogPath: join(rawDir, 'debug.log'),
        streamEventsPath: join(rawDir, 'stream-events.json'),
        streamParseErrorsPath: join(rawDir, 'stream-parse-errors.json'),
        rawTranscriptPath: join(rawDir, 'interactive-transcript.raw'),
        normalizedTranscriptPath: join(
          rawDir,
          'interactive-transcript.normalized.txt'
        ),
        interactiveEventsPath: join(rawDir, 'interactive-events.json')
      };
    },
    async writeRunBaseline(
      artifacts: RunArtifacts,
      env: NodeJS.ProcessEnv
    ): Promise<void> {
      const capturedEnv = captureCuratedEnv(env, options.redactionMode);
      await writeJson(artifacts.environmentPath, {
        redactionMode: options.redactionMode,
        env: capturedEnv
      });
      await writeJson(artifacts.summaryPath, {
        runId: artifacts.runId,
        artifactsDir: artifacts.dir,
        rawDir: artifacts.rawDir,
        cleanup: options.cleanup
      });
    },
    async writeTextArtifact(path: string, value: string): Promise<void> {
      await writeFileAtomic(path, value);
    },
    async writeJsonArtifact(path: string, value: unknown): Promise<void> {
      await writeJson(path, value);
    },
    async cleanupRun(artifacts: RunArtifacts, success: boolean): Promise<void> {
      if (
        options.cleanup === 'always' ||
        (options.cleanup === 'on-success' && success)
      ) {
        await rm(artifacts.dir, { recursive: true, force: true });
      }
    }
  };
}

export function captureCuratedEnv(
  env: NodeJS.ProcessEnv,
  redactionMode: RedactionMode
): Record<string, string> {
  return Object.fromEntries(
    CURATED_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      if (!value) {
        return [];
      }
      return [[key, redact(value, redactionMode)]];
    })
  );
}

export function redactArtifactText(value: string, mode: RedactionMode): string {
  if (mode === 'off') {
    return value;
  }
  return value.length === 0 ? value : '[REDACTED]';
}

function redact(value: string, mode: RedactionMode): string {
  return redactArtifactText(value, mode);
}

function assertRedactionAllowed(mode: RedactionMode): void {
  if (
    mode === 'off' &&
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED !== '1'
  ) {
    throw new RedactionConfigError(
      'redaction.mode "off" requires CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED=1.'
    );
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAtomic(path: string, value: string): Promise<void> {
  await writeFile(`${path}.tmp`, value, 'utf8');
  await rename(`${path}.tmp`, path);
}
