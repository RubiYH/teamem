import { installGitHooks, uninstallGitHooks } from './install-git-hooks.js';

function printUsage(): void {
  process.stderr.write(`Usage:
  bun run teamem install-git-hooks [--repo <path>]
  bun run teamem install-git-hooks --uninstall [--repo <path>]
  bun run teamem uninstall [--yes] [--keep-credentials] [--keep-bridge] [--repo <path>] [--bob-home <path>]
  bun run teamem reset [--yes] [--keep-credentials] [--keep-bridge] [--repo <path>] [--bob-home <path>]

Notes:
  --repo <path>   Explicit target repo (overrides INIT_CWD / cwd inference).
                  Useful when the bun script is invoked via --cwd from a
                  different shell directory.
`);
}

function parseRepoFlag(args: readonly string[]): string | undefined {
  const idx = args.indexOf('--repo');
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    process.stderr.write('teamem: --repo requires a path argument\n');
    process.exit(1);
  }
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const isUninstall = argv.includes('--uninstall');

  if (command === 'install-git-hooks') {
    const repo = parseRepoFlag(argv);
    if (isUninstall) {
      uninstallGitHooks(repo);
    } else {
      installGitHooks(repo);
    }
  } else if (command === 'uninstall' || command === 'reset') {
    const { runResetCli } = await import('./reset.js');
    await runResetCli(argv.slice(1), {
      commandName: `bun run teamem ${command}`,
      title: `teamem ${command}`
    });
  } else {
    printUsage();
    process.exit(1);
  }
}
