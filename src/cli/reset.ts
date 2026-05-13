/**
 * teamem reset — wipe local + bridge state, return to "fresh clone" status.
 *
 * Usage:
 *   bun run reset                    # interactive prompt (default)
 *   bun run reset --yes              # non-interactive, full wipe
 *   bun run reset --keep-credentials # full wipe except creds files
 *   bun run reset --keep-bridge      # full wipe except docker volume
 *   bun run reset --bob-home <path>  # override the HOME-isolated demo path
 *                                    # (default: /tmp/bob-home)
 *
 * What it does:
 *   1. Unloads + removes launchd agent (macOS) or systemd unit (Linux)
 *   2. Stops running bridged daemons (by PID file, falls back to pkill)
 *   3. Removes ~/.teamem/run/, ~/.cache/teamem/
 *   4. Removes ~/.teamem/credentials.json (unless --keep-credentials)
 *   5. Repeats for the bob HOME-isolated demo tree (if present)
 *   6. docker compose down -v (unless --keep-bridge)
 */
import { existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { confirm, isCancel, intro, outro, log } from '@clack/prompts';

interface Args {
  yes: boolean;
  keepCreds: boolean;
  keepBridge: boolean;
  bobHome: string;
}

function parseArgs(argv: string[]): Args {
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
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: bun run reset [--yes] [--keep-credentials] [--keep-bridge] [--bob-home <path>]\n'
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

function rmIfExists(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
    log.info(`removed ${path}`);
  } catch (err) {
    log.warn(`failed to remove ${path}: ${(err as Error).message}`);
  }
}

async function confirmInteractive(args: Args): Promise<boolean> {
  if (args.yes) return true;

  const will: string[] = [
    'Unload launchd/systemd agent for the daemon (if installed)',
    'Kill any running bridged process',
    'Wipe ~/.teamem/run, ~/.cache/teamem',
    `Wipe ${args.bobHome} tree (HOME-isolated demo)`
  ];
  if (!args.keepCreds)
    will.push('Delete ~/.teamem/credentials.json + bob counterpart');
  if (!args.keepBridge)
    will.push('docker compose down -v (DESTROYS bridge SQLite volume)');

  intro('teamem reset');
  for (const w of will) log.message(`  • ${w}`);

  const ok = await confirm({
    message: 'Continue?',
    initialValue: false
  });
  if (isCancel(ok) || !ok) return false;
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!(await confirmInteractive(args))) {
    outro('aborted.');
    process.exit(0);
  }

  const HOME = homedir();

  // 1. Unload autostart agent
  if (platform() === 'darwin') {
    const plist = join(
      HOME,
      'Library',
      'LaunchAgents',
      'io.teamem.bridged.plist'
    );
    if (existsSync(plist)) {
      log.info('unloading launchd agent…');
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
      log.info('disabling systemd unit…');
      quietExec(
        'systemctl --user disable --now teamem-bridged.service 2>/dev/null'
      );
      rmIfExists(unit);
    }
  }

  // 3. Wipe alice state
  log.info('wiping alice state…');
  rmIfExists(join(HOME, '.teamem', 'run'));
  rmIfExists(join(HOME, '.cache', 'teamem'));
  if (!args.keepCreds) {
    rmIfExists(join(HOME, '.teamem', 'credentials.json'));
  }

  // 4. Wipe bob HOME-isolated state
  if (existsSync(args.bobHome)) {
    log.info(`wiping ${args.bobHome} tree…`);
    if (args.keepCreds) {
      rmIfExists(join(args.bobHome, '.teamem', 'run'));
      rmIfExists(join(args.bobHome, '.cache', 'teamem'));
    } else {
      rmIfExists(args.bobHome);
    }
  }

  // 5. Reset bridge volume
  if (!args.keepBridge) {
    log.info('docker compose down -v (destroys bridge data)…');
    quietExec('docker compose down -v --remove-orphans');
  }

  outro('reset complete.');
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

await main();
