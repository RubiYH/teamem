/**
 * teamem uninstall/reset — wipe local + bridge state, return to "fresh clone" status.
 *
 * Usage:
 *   bun run reset                    # interactive prompt (default)
 *   bun run reset --yes              # non-interactive, full wipe
 *   bun run reset --keep-credentials # full wipe except creds files
 *   bun run reset --keep-bridge      # full wipe except docker volume
 *   bun run reset --repo <path>      # uninstall Teamem git hooks from repo
 *   bun run reset --bob-home <path>  # override the HOME-isolated demo path
 *                                    # (default: /tmp/bob-home)
 *
 * What it does:
 *   1. Unloads + removes launchd agent (macOS) or systemd unit (Linux)
 *   2. Stops running bridged daemons (by PID file, falls back to pkill)
 *   3. Removes ~/.teamem/run/, ~/.cache/teamem/
 *   4. Removes known Teamem Claude plugin data dirs (sessions/auto-on state)
 *   5. Removes Teamem-managed git hooks and restores .teamem-backup files
 *   6. Removes ~/.teamem/credentials.json (unless --keep-credentials)
 *   7. Repeats for the bob HOME-isolated demo tree (if present)
 *   8. docker compose down -v (unless --keep-bridge)
 */
import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { uninstallGitHooks } from './install-git-hooks.js';

interface Args {
  yes: boolean;
  keepCreds: boolean;
  keepBridge: boolean;
  bobHome: string;
  repo?: string;
}

interface ResetCliOptions {
  commandName?: string;
  title?: string;
}

function parseArgs(argv: string[], commandName: string): Args {
  const args: Args = {
    yes: false,
    keepCreds: false,
    keepBridge: false,
    bobHome: '/tmp/bob-home'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--keep-credentials') args.keepCreds = true;
    else if (a === '--keep-bridge') args.keepBridge = true;
    else if (a === '--bob-home') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        process.stderr.write('--bob-home requires a path argument\n');
        process.exit(2);
      }
      args.bobHome = next;
      i++;
    } else if (a === '--repo') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        process.stderr.write('--repo requires a path argument\n');
        process.exit(2);
      }
      args.repo = next;
      i++;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        `Usage: ${commandName} [--yes] [--keep-credentials] [--keep-bridge] [--repo <path>] [--bob-home <path>]\n`
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function quietExec(cmd: string): void {
  try {
    execSync(cmd, { stdio: 'ignore' });
  } catch {
    /* best-effort cleanup */
  }
}

function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function rmIfExists(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
    info(`removed ${path}`);
  } catch (err) {
    warn(`failed to remove ${path}: ${(err as Error).message}`);
  }
}

function pluginDataPaths(home: string): string[] {
  const dataRoot = join(home, '.claude', 'plugins', 'data');
  return [
    join(dataRoot, 'teamem'),
    join(dataRoot, 'teamem-teamem-alpha'),
    join(dataRoot, 'teamem-teamem-local'),
    join(dataRoot, 'teamem-teamem2-local'),
    join(dataRoot, 'teamem2'),
    join(dataRoot, 'teamem2-teamem-alpha'),
    join(dataRoot, 'teamem2-teamem-local'),
    join(dataRoot, 'teamem2-teamem2-local'),
    join(dataRoot, 'teamem2-inline'),
    join(dataRoot, 'teamem-inline')
  ];
}

async function confirmInteractive(args: Args, title: string): Promise<boolean> {
  if (args.yes) return true;

  const will: string[] = [
    'Unload launchd/systemd agent for the daemon (if installed)',
    'Kill any running bridged process',
    'Wipe ~/.teamem/run, ~/.cache/teamem, and known Teamem Claude plugin data directories',
    `Wipe ${args.bobHome} tree (HOME-isolated demo)`
  ];
  will.push(
    args.repo
      ? `Uninstall Teamem git hooks from ${args.repo}`
      : 'Uninstall Teamem git hooks from the current git repository (if present)'
  );
  if (!args.keepCreds)
    will.push('Delete ~/.teamem/credentials.json + bob counterpart');
  if (!args.keepBridge)
    will.push('docker compose down -v (DESTROYS bridge SQLite volume)');

  info(title);
  for (const w of will) info(`  - ${w}`);

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Continue? [y/N] ');
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runResetCli(
  argv: string[],
  options: ResetCliOptions = {}
): Promise<void> {
  const commandName = options.commandName ?? 'bun run reset';
  const title = options.title ?? 'teamem reset';
  const args = parseArgs(argv, commandName);

  if (!(await confirmInteractive(args, title))) {
    info('aborted.');
    process.exit(0);
  }

  const HOME = homedir();

  try {
    uninstallGitHooks(args.repo);
  } catch (err) {
    warn(`failed to uninstall git hooks: ${(err as Error).message}`);
  }

  // 1. Unload autostart agent
  if (platform() === 'darwin') {
    const plist = join(
      HOME,
      'Library',
      'LaunchAgents',
      'io.teamem.bridged.plist'
    );
    if (existsSync(plist)) {
      info('unloading launchd agent...');
      quietExec(`launchctl unload "${plist}" 2>/dev/null`);
      rmIfExists(plist);
    }
  } else if (platform() === 'linux') {
    const unit = join(
      HOME,
      '.config',
      'systemd',
      'user',
      'teamem-bridged.service'
    );
    if (existsSync(unit)) {
      info('disabling systemd unit...');
      quietExec(
        'systemctl --user disable --now teamem-bridged.service 2>/dev/null'
      );
      rmIfExists(unit);
    }
  }

  // 3. Wipe alice state
  info('wiping alice state...');
  rmIfExists(join(HOME, '.teamem', 'run'));
  rmIfExists(join(HOME, '.cache', 'teamem'));
  for (const path of pluginDataPaths(HOME)) {
    rmIfExists(path);
  }
  if (!args.keepCreds) {
    rmIfExists(join(HOME, '.teamem', 'credentials.json'));
  }

  // 4. Wipe bob HOME-isolated state
  if (existsSync(args.bobHome)) {
    info(`wiping ${args.bobHome} tree...`);
    if (args.keepCreds) {
      rmIfExists(join(args.bobHome, '.teamem', 'run'));
      rmIfExists(join(args.bobHome, '.cache', 'teamem'));
      for (const path of pluginDataPaths(args.bobHome)) {
        rmIfExists(path);
      }
    } else {
      rmIfExists(args.bobHome);
    }
  }

  // 5. Reset bridge volume
  if (!args.keepBridge) {
    info('docker compose down -v (destroys bridge data)...');
    quietExec('docker compose down -v --remove-orphans');
  }

  info('reset complete.');
  process.stdout.write(
    [
      '',
      'Next steps:',
      '  1. docker compose up -d --build       # restart bridge with fresh DB',
      '  2. bun run setup                       # create new space (alice)',
      `  3. HOME=${args.bobHome} bun run setup  # join with bob`,
      '     (then add `allow_plaintext: true` to credentials.json if your bridge_url is http://)',
      ''
    ].join('\n')
  );
}

if (import.meta.main) {
  await runResetCli(process.argv.slice(2));
}
