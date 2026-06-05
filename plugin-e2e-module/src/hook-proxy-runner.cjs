#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = parseArgs(process.argv.slice(2));
const traceRoot =
  process.env.CLAUDE_PLUGIN_E2E_HOOK_TRACE_DIR ||
  process.env.CLAUDE_PLUGIN_E2E_FALLBACK_HOOK_TRACE_DIR;

if (!traceRoot) {
  process.stderr.write(
    'CLAUDE_PLUGIN_E2E_HOOK_TRACE_DIR is required for hook tracing.\n'
  );
  process.exit(2);
}

if (!args.event || !args.shellCommand || !args.commandBase64) {
  process.stderr.write(
    '--event, --shell-command, and --command-base64 are required for hook tracing.\n'
  );
  process.exit(2);
}

const originalCommand = Buffer.from(args.commandBase64, 'base64').toString(
  'utf8'
);
const invocationDir = join(
  traceRoot,
  `${Date.now()}-${safeName(args.event)}-${randomUUID()}`
);
const stdinPath = join(invocationDir, 'stdin.raw');
const stdoutPath = join(invocationDir, 'stdout.raw');
const stderrPath = join(invocationDir, 'stderr.raw');
const tracePath = join(invocationDir, 'trace.json');
const redactionMode = resolveRedactionMode();
mkdirSync(invocationDir, { recursive: true });

readStdin()
  .then((stdin) => runHook({ stdin }))
  .catch((error) => {
    process.stderr.write(formatError(error));
    process.exit(1);
  });

async function runHook({ stdin }) {
  const shell = {
    command: args.shellCommand,
    args: args.shellArgs
  };
  const startedAt = Date.now();
  const child = spawn(shell.command, [...shell.args, originalCommand], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });
  child.stdin.end(stdin);

  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => {
      stderr += formatError(error);
      resolve(127);
    });
    child.on('close', (code) => resolve(code));
  });
  const durationMs = Date.now() - startedAt;
  const artifactStdin = redactText(stdin);
  const artifactStdout = redactText(stdout);
  const artifactStderr = redactText(stderr);

  writeFileSync(stdinPath, artifactStdin);
  writeFileSync(stdoutPath, artifactStdout);
  writeFileSync(stderrPath, artifactStderr);
  writeFileSync(
    tracePath,
    `${JSON.stringify(
      {
        event: args.event,
        stdin: artifactStdin,
        stdinJson: redactJson(parseJson(stdin)),
        stdout: artifactStdout,
        stderr: artifactStderr,
        exitCode,
        durationMs,
        environment: captureEnvironment(),
        artifacts: {
          tracePath,
          stdinPath,
          stdoutPath,
          stderrPath
        }
      },
      null,
      2
    )}\n`
  );

  process.exit(exitCode ?? 1);
}

function parseArgs(argv) {
  const parsed = { shellArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--event') {
      parsed.event = value;
      index += 1;
    } else if (key === '--shell-command') {
      parsed.shellCommand = value;
      index += 1;
    } else if (key === '--shell-arg') {
      parsed.shellArgs.push(value);
      index += 1;
    } else if (key === '--command-base64') {
      parsed.commandBase64 = value;
      index += 1;
    }
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      stdin += chunk;
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(stdin));
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function resolveRedactionMode() {
  if (
    process.env.CLAUDE_PLUGIN_E2E_REDACTION_MODE === 'off' &&
    process.env.CLAUDE_PLUGIN_E2E_ALLOW_UNREDACTED === '1'
  ) {
    return 'off';
  }
  return 'safe';
}

function redactText(value) {
  if (redactionMode === 'off') {
    return value;
  }
  return value.length === 0 ? value : '[REDACTED]';
}

function redactJson(value) {
  if (redactionMode === 'off') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length === 0 ? value : '[REDACTED]';
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, redactJson(field)])
  );
}

function captureEnvironment() {
  const keys = [
    'CLAUDE_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_DATA',
    'CLAUDE_SESSION_ID',
    'CLAUDE_PROJECT_DIR'
  ];
  return {
    redactionMode,
    env: Object.fromEntries(
      keys.flatMap((key) => {
        const value = process.env[key];
        if (!value) {
          return [];
        }
        return [[key, redactText(value)]];
      })
    )
  };
}

function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function formatError(error) {
  return error instanceof Error ? `${error.message}\n` : `${String(error)}\n`;
}
