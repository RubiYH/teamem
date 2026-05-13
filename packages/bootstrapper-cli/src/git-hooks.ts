import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';

import { findInstalledTeamemPlugin } from './claude-plugin-list.js';
import type { CliIo } from './cli.js';
import { TEAMEM_PLUGIN, type PluginScope } from './plugin-installer.js';
import {
  createSystemCommandRunner,
  type CommandRunner
} from './prerequisites.js';
import {
  isInteractiveTerminal,
  promptWithRuntime,
  type RuntimePromptEnvironment
} from './runtime-prompt.js';

const HOOK_NAMES = ['post-commit', 'post-checkout'] as const;
const TEAMEM_HOOK_MARKER = '# teamem-managed-hook';
const TEAMEM_PLUGIN_ROOT_PLACEHOLDER = '__TEAMEM_PLUGIN_ROOT__';

export interface GitHookPromptContext {
  readonly scope: PluginScope;
}

export type GitHookPrompter = (context: GitHookPromptContext) => boolean;

export type GitHookPromptEnvironment = RuntimePromptEnvironment;

export interface GitHookInstaller {
  install(options: { readonly scope: PluginScope }): GitHookInstallResult;
}

export interface GitHookInstallerEnvironment {
  readonly cwd: string;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: GitHookFileSystem;
}

export interface GitHookFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(
    path: string,
    content: string,
    options?: { readonly mode?: number }
  ): void;
  copyFile(source: string, destination: string): void;
  mkdir(path: string): void;
  chmod(path: string, mode: number): void;
}

export type GitHookInstallResult =
  | { readonly ok: true; readonly exitCode: 0; readonly message: string }
  | { readonly ok: false; readonly exitCode: 1; readonly message: string };

export function createInteractiveGitHookPrompter(
  io: CliIo,
  environment: GitHookPromptEnvironment = {}
): GitHookPrompter {
  return () => {
    if (!isInteractiveTerminal(environment)) {
      return false;
    }

    while (true) {
      const answer = (
        promptWithRuntime(
          'Install Teamem git hooks in this repository? [Y/n]: ',
          environment
        ) ?? ''
      )
        .trim()
        .toLowerCase();
      if (answer.length === 0 || answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }
      io.stdout.write('Enter y, yes, n, no, or press Enter for yes.\n');
    }
  };
}

export function createGitHookInstaller(
  environment: GitHookInstallerEnvironment
): GitHookInstaller {
  const commandRunner =
    environment.commandRunner ?? createSystemCommandRunner(environment.cwd);
  const fileSystem = environment.fileSystem ?? createNodeGitHookFileSystem();

  return {
    install(options: { readonly scope: PluginScope }): GitHookInstallResult {
      const pluginRoot = resolveInstalledPluginRoot({
        commandRunner,
        fileSystem,
        scope: options.scope
      });
      if (!pluginRoot.ok) {
        return pluginRoot;
      }

      const repoRoot = resolveRepoRoot(commandRunner);
      if (!repoRoot.ok) {
        return repoRoot;
      }

      const hooksDir = resolveHooksDir({
        commandRunner,
        repoRoot: repoRoot.repoRoot
      });
      if (!hooksDir.ok) {
        return hooksDir;
      }

      try {
        fileSystem.mkdir(hooksDir.path);
        for (const hookName of HOOK_NAMES) {
          installHookFile({
            fileSystem,
            hooksDir: hooksDir.path,
            pluginRoot: pluginRoot.pluginRoot,
            hookName
          });
        }
      } catch (error) {
        return {
          ok: false,
          exitCode: 1,
          message: error instanceof Error ? error.message : String(error)
        };
      }

      return {
        ok: true,
        exitCode: 0,
        message: `Installed Teamem git hooks from ${pluginRoot.pluginRoot} into ${hooksDir.path}.`
      };
    }
  };
}

export function resolveInstalledPluginRoot(options: {
  readonly commandRunner: CommandRunner;
  readonly fileSystem: Pick<GitHookFileSystem, 'exists'>;
  readonly scope: PluginScope;
}):
  | { readonly ok: true; readonly pluginRoot: string }
  | { readonly ok: false; readonly exitCode: 1; readonly message: string } {
  const result = options.commandRunner.run('claude', [
    'plugin',
    'list',
    '--json'
  ]);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'Could not inspect installed Claude Code plugins before installing Teamem git hooks.'
    };
  }

  const plugin = findInstalledTeamemPlugin(
    result.stdout,
    TEAMEM_PLUGIN,
    options.scope
  );
  if (!plugin) {
    return {
      ok: false,
      exitCode: 1,
      message: `Teamem is not installed at scope '${options.scope}'. Re-run teamem init --scope ${options.scope} before installing git hooks.`
    };
  }

  for (const hookName of HOOK_NAMES) {
    const templatePath = join(plugin.installPath, 'git-hooks', hookName);
    if (!options.fileSystem.exists(templatePath)) {
      return {
        ok: false,
        exitCode: 1,
        message: `Teamem plugin is installed, but ${join('git-hooks', hookName)} is missing at ${plugin.installPath}. Reinstall ${TEAMEM_PLUGIN}.`
      };
    }
  }

  return {
    ok: true,
    pluginRoot: plugin.installPath
  };
}

function installHookFile(options: {
  readonly fileSystem: GitHookFileSystem;
  readonly hooksDir: string;
  readonly pluginRoot: string;
  readonly hookName: (typeof HOOK_NAMES)[number];
}): void {
  const sourceHook = join(options.pluginRoot, 'git-hooks', options.hookName);
  const destinationHook = join(options.hooksDir, options.hookName);
  const backupHook = join(
    options.hooksDir,
    `${options.hookName}.teamem-backup`
  );

  const sourceContent = substitutePluginRoot(
    withTeamemMarker(options.fileSystem.readFile(sourceHook)),
    options.pluginRoot
  );

  if (options.fileSystem.exists(destinationHook)) {
    const destinationContent = options.fileSystem.readFile(destinationHook);
    if (
      destinationContent !== sourceContent &&
      !isTeamemManagedHook(destinationContent)
    ) {
      if (options.fileSystem.exists(backupHook)) {
        throw new Error(
          `Cannot install Teamem git hooks: ${options.hookName} already has a non-Teamem backup at ${backupHook}. Resolve it manually, then rerun teamem init --install-git-hooks.`
        );
      }
      options.fileSystem.copyFile(destinationHook, backupHook);
    }
    if (destinationContent === sourceContent) {
      options.fileSystem.chmod(destinationHook, 0o755);
      return;
    }
  }

  options.fileSystem.writeFile(destinationHook, sourceContent, { mode: 0o755 });
  options.fileSystem.chmod(destinationHook, 0o755);
}

function resolveRepoRoot(
  commandRunner: CommandRunner
):
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly exitCode: 1; readonly message: string } {
  const result = commandRunner.run('git', ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'Git hooks can only be installed inside a git repository. Re-run teamem init from a repository root or pass --skip-git-hooks.'
    };
  }

  return {
    ok: true,
    repoRoot: result.stdout.trim()
  };
}

function resolveHooksDir(options: {
  readonly commandRunner: CommandRunner;
  readonly repoRoot: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly exitCode: 1; readonly message: string } {
  const configuredHooksPath = options.commandRunner.run('git', [
    'config',
    '--get',
    'core.hooksPath'
  ]);
  if (configuredHooksPath.exitCode === 0) {
    const hooksPath = configuredHooksPath.stdout.trim();
    if (hooksPath.length > 0) {
      return {
        ok: true,
        path: resolve(options.repoRoot, hooksPath)
      };
    }
  }

  const fallback = options.commandRunner.run('git', [
    'rev-parse',
    '--git-path',
    'hooks'
  ]);
  if (fallback.exitCode !== 0) {
    return {
      ok: false,
      exitCode: 1,
      message:
        'Could not resolve the git hooks directory for this repository. Check `git config core.hooksPath` and rerun teamem init --install-git-hooks.'
    };
  }

  return {
    ok: true,
    path: resolve(options.repoRoot, fallback.stdout.trim())
  };
}

function createNodeGitHookFileSystem(): GitHookFileSystem {
  return {
    exists(path: string): boolean {
      return existsSync(path);
    },
    readFile(path: string): string {
      return readFileSync(path, 'utf8');
    },
    writeFile(
      path: string,
      content: string,
      options?: { readonly mode?: number }
    ): void {
      writeFileSync(path, content, {
        encoding: 'utf8',
        mode: options?.mode
      });
    },
    copyFile(source: string, destination: string): void {
      copyFileSync(source, destination);
    },
    mkdir(path: string): void {
      mkdirSync(path, { recursive: true });
    },
    chmod(path: string, mode: number): void {
      chmodSync(path, mode);
    }
  };
}

function withTeamemMarker(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[1]?.startsWith(TEAMEM_HOOK_MARKER)) {
    return normalized;
  }
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
