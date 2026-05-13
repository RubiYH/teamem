import { installGitHooks, uninstallGitHooks } from './install-git-hooks.js';

function printUsage(): void {
  process.stderr.write(`Usage:
  bun run teamem install-git-hooks [--repo <path>]
  bun run teamem install-git-hooks --uninstall [--repo <path>]

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
  const repo = parseRepoFlag(argv);

  if (command === 'install-git-hooks') {
    if (isUninstall) {
      uninstallGitHooks(repo);
    } else {
      installGitHooks(repo);
    }
  } else {
    printUsage();
    process.exit(1);
  }
}
