/**
 * CLI command: bun run src/cli/install-git-hooks.ts [--uninstall]
 *
 * Installs teamem's post-commit git hook into the current repo's Git hooks dir.
 * Backs up any existing hook to <name>.teamem-backup before overwriting.
 * Idempotent — re-running with identical content is a no-op.
 * --uninstall removes teamem's hook and restores any backup.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  chmodSync,
  mkdirSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function resolveInvocationCwd(): string {
  // When `bun run --cwd <X>` is used, bun rewrites process.cwd() to X but the
  // shell-set PWD env var still points at the user's original shell cwd. Use
  // PWD as the source-of-truth when it differs from process.cwd() — that's
  // the signal the user invoked from a different directory. Fall back to
  // INIT_CWD (npm convention; bun does not set it currently but may in the
  // future) and finally process.cwd() for direct invocations and tests.
  const pwd = process.env.PWD;
  const initCwd = process.env.INIT_CWD;
  const cwd = process.cwd();
  if (initCwd && initCwd !== cwd) return initCwd;
  if (pwd && pwd !== cwd) return pwd;
  return cwd;
}

function getRepoRoot(): string {
  const cwd = resolveInvocationCwd();
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`Not inside a git repository (cwd: ${cwd})`);
  }
  return result.stdout.trim();
}

function getPluginRoot(): string {
  // Plugin root is relative to this file: src/cli/ -> ../../plugin
  return resolve(import.meta.dir, '../../plugin');
}

function getScriptSourceRepoRoot(): string {
  // The repo that contains this CLI's source — used to detect accidental
  // self-install (the common footgun: `bun run --cwd <teamem-poc> teamem
  // install-git-hooks` resets PWD and installs into teamem-poc itself).
  return resolve(import.meta.dir, '../..');
}

const HOOK_NAMES = ['post-commit', 'post-checkout'] as const;
const TEAMEM_HOOK_MARKER = '# teamem-managed-hook';
const TEAMEM_PLUGIN_ROOT_PLACEHOLDER = '__TEAMEM_PLUGIN_ROOT__';

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function getHooksDir(repoRoot: string): string {
  const configuredHooksPath = spawnSync(
    'git',
    ['-C', repoRoot, 'config', '--get', 'core.hooksPath'],
    {
      encoding: 'utf8'
    }
  );
  const hooksPath =
    configuredHooksPath.status === 0 ? configuredHooksPath.stdout.trim() : '';
  if (hooksPath) {
    const resolved = resolve(repoRoot, hooksPath);
    // Defense against silent contamination: if core.hooksPath was set by an
    // earlier test or a misconfigured tool to a path outside the repo, the
    // user almost never actually wants hooks installed there. We hit this
    // exact failure mode (hooks landing in /tmp/somewhere) when a stale
    // config leaked between repos.
    if (!resolved.startsWith(repoRoot + '/') && resolved !== repoRoot) {
      process.stderr.write(
        `teamem: WARNING — core.hooksPath resolves outside the repo root.\n` +
          `  repo:    ${repoRoot}\n` +
          `  hooks:   ${resolved}\n` +
          `  If this is unintended, run:\n` +
          `    git -C ${repoRoot} config --unset core.hooksPath\n`
      );
    }
    return resolved;
  }

  const gitHooksPath = git(repoRoot, ['rev-parse', '--git-path', 'hooks']);
  return resolve(repoRoot, gitHooksPath);
}

function withTeamemMarker(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[1]?.startsWith(TEAMEM_HOOK_MARKER)) return normalized;
  lines.splice(1, 0, TEAMEM_HOOK_MARKER);
  return lines.join('\n');
}

function substitutePluginRoot(content: string, pluginRoot: string): string {
  return content.replaceAll(TEAMEM_PLUGIN_ROOT_PLACEHOLDER, pluginRoot);
}

function isTeamemManagedHook(content: string): boolean {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines[1]?.startsWith(TEAMEM_HOOK_MARKER) === true;
}

export function installGitHooks(repoRoot?: string): void {
  const root = repoRoot ?? getRepoRoot();
  const pluginRoot = getPluginRoot();
  // Self-install guard: when the user runs the CLI through bun's package.json
  // script chain with `bun run --cwd <teamem-poc> teamem install-git-hooks`,
  // bun resets PWD so we cannot recover the user's shell cwd, and getRepoRoot
  // resolves teamem-poc itself. Almost always unintended. Force the user to
  // either pass --repo explicitly or set TEAMEM_ALLOW_SELF_INSTALL=1.
  if (
    repoRoot === undefined &&
    resolve(root) === getScriptSourceRepoRoot() &&
    process.env.TEAMEM_ALLOW_SELF_INSTALL !== '1'
  ) {
    throw new Error(
      `teamem: refusing to install hooks into the teamem-poc source repo itself.\n` +
        `  Resolved repo root: ${root}\n` +
        `  This usually means \`bun run --cwd <teamem-poc> teamem install-git-hooks\`\n` +
        `  was invoked from a different shell directory; bun resets PWD for\n` +
        `  package.json scripts so the user's shell cwd cannot be recovered.\n` +
        `  Use one of these instead:\n` +
        `    1. cd <target-repo> && bun run ${join(import.meta.dir, 'teamem.ts')} install-git-hooks\n` +
        `    2. bun run --cwd <teamem-poc> teamem install-git-hooks --repo <target-repo>\n` +
        `  To install into teamem-poc itself, set TEAMEM_ALLOW_SELF_INSTALL=1.`
    );
  }
  const hooksDir = getHooksDir(root);
  mkdirSync(hooksDir, { recursive: true });

  for (const hookName of HOOK_NAMES) {
    const srcHook = join(pluginRoot, 'git-hooks', hookName);
    const destHook = join(hooksDir, hookName);
    const backupHook = join(hooksDir, `${hookName}.teamem-backup`);

    if (!existsSync(srcHook)) {
      process.stderr.write(`teamem: hook source not found: ${srcHook}\n`);
      continue;
    }

    const srcContent = substitutePluginRoot(
      withTeamemMarker(readFileSync(srcHook, 'utf-8')),
      pluginRoot
    );

    if (existsSync(destHook)) {
      const destContent = readFileSync(destHook, 'utf-8');
      if (destContent === srcContent) {
        // Idempotent — content identical, nothing to do
        continue;
      }
      if (!isTeamemManagedHook(destContent)) {
        if (existsSync(backupHook)) {
          throw new Error(
            'Cannot install: a non-teamem hook exists and a backup is already present at .teamem-backup. Resolve manually.'
          );
        }
        // Back up before overwriting a user-owned hook.
        copyFileSync(destHook, backupHook);
        process.stderr.write(
          `teamem: backed up existing ${hookName} to ${hookName}.teamem-backup\n`
        );
      }
    }

    writeFileSync(destHook, srcContent, { mode: 0o755 });
    chmodSync(destHook, 0o755);
    process.stdout.write(
      `teamem: installed ${hookName} hook into ${hooksDir}\n`
    );
  }
}

export function uninstallGitHooks(repoRoot?: string): void {
  const root = repoRoot ?? getRepoRoot();
  const hooksDir = getHooksDir(root);

  for (const hookName of HOOK_NAMES) {
    const destHook = join(hooksDir, hookName);
    const backupHook = join(hooksDir, `${hookName}.teamem-backup`);

    if (!existsSync(destHook)) continue;

    unlinkSync(destHook);
    if (existsSync(backupHook)) {
      copyFileSync(backupHook, destHook);
      chmodSync(destHook, 0o755);
      unlinkSync(backupHook);
      process.stdout.write(`teamem: restored ${hookName} from backup\n`);
    } else {
      process.stdout.write(`teamem: removed ${hookName} hook\n`);
    }
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    uninstallGitHooks();
  } else {
    installGitHooks();
  }
}
