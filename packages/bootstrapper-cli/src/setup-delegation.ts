import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { findInstalledTeamemPlugin } from './claude-plugin-list.js';
import type { SetupSelectionArgs } from './cli.js';
import {
  TEAMEM_PLUGIN,
  type BootstrapperFileSystem,
  type PluginScope
} from './plugin-installer.js';
import {
  createSystemCommandRunner,
  type CommandRunner
} from './prerequisites.js';

const SETUP_BUNDLE = join('lib', 'setup.js');

export interface SetupInvocation {
  readonly mode: 'interactive' | 'non-interactive';
  readonly args: readonly string[];
}

export interface SetupInvocationResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly message: string;
}

export interface SetupCommandRunner {
  run(invocation: SetupInvocation): SetupInvocationResult;
}

export interface SetupProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string }
  ): { readonly status: number | null; readonly error?: Error };
}

export interface SetupRunnerEnvironment {
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: Pick<BootstrapperFileSystem, 'exists'>;
  readonly processRunner?: SetupProcessRunner;
  readonly cwd?: string;
}

export type SetupSelectionParseResult =
  | { readonly ok: true; readonly value: SetupInvocation }
  | { readonly ok: false; readonly error: string };

export function parseSetupSelection(
  selection: SetupSelectionArgs | undefined
): SetupSelectionParseResult {
  if (!selection?.flow) {
    return {
      ok: true,
      value: { mode: 'interactive', args: [] }
    };
  }

  if (!selection.serverUrl || !selection.memberName) {
    return {
      ok: false,
      error:
        'Non-interactive init setup requires --server-url and --member-name'
    };
  }

  if (selection.flow === 'create') {
    if (selection.roomCode) {
      return {
        ok: false,
        error: '--room-code is only valid with --join'
      };
    }

    return {
      ok: true,
      value: {
        mode: 'non-interactive',
        args: [
          '--json',
          JSON.stringify({
            flow: 'create',
            serverUrl: selection.serverUrl,
            memberName: selection.memberName,
            ...(selection.spaceLabel
              ? { spaceLabel: selection.spaceLabel }
              : {})
          })
        ]
      }
    };
  }

  if (!selection.roomCode) {
    return {
      ok: false,
      error: 'Non-interactive join requires --room-code'
    };
  }

  if (selection.spaceLabel) {
    return {
      ok: false,
      error: '--label is only valid with --create'
    };
  }

  return {
    ok: true,
    value: {
      mode: 'non-interactive',
      args: [
        '--json',
        JSON.stringify({
          flow: 'join',
          serverUrl: selection.serverUrl,
          memberName: selection.memberName,
          roomCode: selection.roomCode
        })
      ]
    }
  };
}

export function createSetupRunner(
  scope: PluginScope,
  environment: SetupRunnerEnvironment = {}
): SetupCommandRunner {
  const cwd = environment.cwd ?? process.cwd();
  const commandRunner =
    environment.commandRunner ?? createSystemCommandRunner(cwd);
  const fileSystem = environment.fileSystem ?? {
    exists(path: string): boolean {
      return existsSync(path);
    }
  };
  const processRunner = environment.processRunner ?? {
    run(
      command: string,
      args: readonly string[]
    ): {
      readonly status: number | null;
      readonly error?: Error;
    } {
      return spawnSync(command, [...args], {
        cwd,
        stdio: 'inherit'
      });
    }
  };

  return {
    run(invocation: SetupInvocation): SetupInvocationResult {
      const setupScript = resolveInstalledSetupBundle({
        commandRunner,
        fileSystem,
        scope
      });
      if (!setupScript.ok) {
        return {
          ok: false,
          exitCode: 1,
          message: setupScript.message
        };
      }

      const result = processRunner.run(
        'bun',
        ['run', setupScript.path, ...invocation.args],
        { cwd }
      );

      if (result.error) {
        return {
          ok: false,
          exitCode: 1,
          message: `Failed to launch Teamem setup: ${result.error.message}`
        };
      }

      const exitCode = result.status ?? 1;
      return exitCode === 0
        ? {
            ok: true,
            exitCode,
            message: 'Teamem setup completed.'
          }
        : {
            ok: false,
            exitCode,
            message: `Teamem setup exited with code ${exitCode}.`
          };
    }
  };
}

export type SetupBundleResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

export function resolveInstalledSetupBundle(options: {
  readonly commandRunner: CommandRunner;
  readonly fileSystem: Pick<BootstrapperFileSystem, 'exists'>;
  readonly scope: PluginScope;
}): SetupBundleResolution {
  const result = options.commandRunner.run('claude', [
    'plugin',
    'list',
    '--json'
  ]);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      message:
        'Could not inspect installed Claude Code plugins after Teamem install.'
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
      message: `Teamem setup bundle was not found for scope '${options.scope}'. Re-run teamem init --scope ${options.scope}.`
    };
  }

  const setupPath = join(plugin.installPath, SETUP_BUNDLE);
  if (!options.fileSystem.exists(setupPath)) {
    return {
      ok: false,
      message: `Teamem plugin is installed, but ${SETUP_BUNDLE} is missing at ${plugin.installPath}. Reinstall ${TEAMEM_PLUGIN}.`
    };
  }

  return {
    ok: true,
    path: setupPath
  };
}
