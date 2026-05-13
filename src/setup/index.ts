/**
 * Phase 3 — `src/setup/index.ts`
 *
 * Plan-named entry point for `bun run setup`. The actual interactive
 * CLI plus non-interactive `--json` driver was already authored in
 * `src/cli/setup.ts` (which the e2e tests at tests/e2e/setup-create.test.ts
 * and tests/e2e/setup-join.test.ts spawn directly). This file delegates
 * to `src/cli/setup.ts` so a single implementation handles both
 * `bun run setup` (this file, per package.json) and the e2e harness
 * spawn path.
 *
 * Subcommand routing for `leave`, `kick`, `disband`, `rotate-code`, and
 * `list` lives in `src/cli/space.ts` (already authored — uses
 * @clack/prompts for the disband label-confirmation and supports
 * `--space <id>`, `TEAMEM_SPACE` env, and `--yes-i-am-sure --label
 * <expected>` for non-interactive disband once the typecheck-clean
 * version lands).
 *
 * Routing logic:
 *   bun run setup                       -> src/cli/setup.ts (interactive create/join)
 *   bun run setup --json {...}          -> src/cli/setup.ts (non-interactive)
 *   bun run setup create [flags]        -> src/cli/setup.ts (mapped to --json)
 *   bun run setup join [flags]          -> src/cli/setup.ts (mapped to --json)
 *   bun run setup leave|kick|disband|
 *                rotate-code|list       -> src/cli/space.ts
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(__dirname, '..', '..');
const SETUP_SCRIPT = pathResolve(REPO_ROOT, 'src/cli/setup.ts');
const SPACE_SCRIPT = pathResolve(REPO_ROOT, 'src/cli/space.ts');
const USAGE =
  'Usage: bun run setup [<subcommand>] [flags]\n' +
  'Subcommands: create, join, leave, kick <name>, disband, rotate-code, list\n' +
  'Run with no subcommand for the interactive create/join flow.\n';

type ParsedFlags = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function execScript(script: string, scriptArgs: string[]): never {
  const child = spawn('bun', ['run', script, ...scriptArgs], {
    stdio: 'inherit',
    cwd: REPO_ROOT
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  // unreachable fallback
  child.on('error', (err) => {
    process.stderr.write(
      `setup: failed to spawn ${script}: ${(err as Error).message}\n`
    );
    process.exit(1);
  });
  // Keep the type system happy — spawn handlers above always exit.
  return undefined as never;
}

function delegateCreate(parsed: ParsedFlags): never {
  const memberName = parsed.flags['member-name'];
  const label = parsed.flags['label'];
  const serverUrl = parsed.flags['server-url'];

  if (!process.stdin.isTTY && (!memberName || !serverUrl)) {
    process.stderr.write(
      'create: non-TTY mode requires --member-name and --server-url\n'
    );
    process.exit(1);
  }

  if (memberName && serverUrl) {
    const json = JSON.stringify({
      flow: 'create',
      memberName: String(memberName),
      ...(label ? { spaceLabel: String(label) } : {}),
      serverUrl: String(serverUrl)
    });
    return execScript(SETUP_SCRIPT, ['--json', json]);
  }
  // Otherwise, fall through to interactive create flow in src/cli/setup.ts.
  return execScript(SETUP_SCRIPT, []);
}

function delegateJoin(parsed: ParsedFlags): never {
  const code = parsed.flags['code'];
  const memberName = parsed.flags['member-name'];
  const serverUrl = parsed.flags['server-url'];

  if (!process.stdin.isTTY && (!code || !memberName || !serverUrl)) {
    process.stderr.write(
      'join: non-TTY mode requires --code, --member-name, and --server-url\n'
    );
    process.exit(1);
  }

  if (code && memberName && serverUrl) {
    // R3 / req 11: confirm URL prominently before joining.
    if (process.stdin.isTTY) {
      process.stdout.write(`\n  Server URL: ${String(serverUrl)}\n`);
      process.stdout.write(
        '  Confirm this matches what your teammate sent? [y/N] '
      );
      const answer = (prompt('') ?? '').trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        process.stderr.write('Join aborted (URL not confirmed).\n');
        process.exit(1);
      }
    }
    const json = JSON.stringify({
      flow: 'join',
      memberName: String(memberName),
      roomCode: String(code),
      serverUrl: String(serverUrl)
    });
    return execScript(SETUP_SCRIPT, ['--json', json]);
  }
  return execScript(SETUP_SCRIPT, []);
}

function main(): never {
  // Pass `--json {...}` and `--check` straight through to the existing CLI driver.
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (argv.includes('--json') || argv.includes('--check')) {
    return execScript(SETUP_SCRIPT, argv);
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case undefined:
    case '':
      return execScript(SETUP_SCRIPT, []);

    case 'create':
      return delegateCreate(parseFlags(rest));

    case 'join':
      return delegateJoin(parseFlags(rest));

    case 'leave':
    case 'kick':
    case 'disband':
    case 'rotate-code':
    case 'list':
      return execScript(SPACE_SCRIPT, [sub, ...rest]);

    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

main();
