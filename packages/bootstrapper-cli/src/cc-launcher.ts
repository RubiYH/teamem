import { spawnSync } from 'node:child_process';

import type { CliIo } from './cli.js';
import { TEAMEM_PLUGIN, type ExecutedCommand } from './plugin-installer.js';
import {
  executePluginUpdate,
  type UpdateExecutionEnvironment,
  type UpdateExecutionResult
} from './update-executor.js';
import {
  isInteractiveTerminal,
  promptWithRuntime,
  type RuntimePromptEnvironment
} from './runtime-prompt.js';

export type CcUpdateMode = 'prompt' | 'always' | 'never';

export interface ClaudeLauncherResult {
  readonly status: number | null;
  readonly error?: Error;
}

export interface ClaudeProcessLauncher {
  launch(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string }
  ): ClaudeLauncherResult;
}

export interface CcLaunchEnvironment extends UpdateExecutionEnvironment {
  readonly claudeLauncher?: ClaudeProcessLauncher;
}

export interface CcLaunchOptions {
  readonly dryRun: boolean;
  readonly updateMode: CcUpdateMode;
  readonly requestedScope?: 'project' | 'user' | 'local';
  readonly claudeArgs: readonly string[];
}

export interface CcExecutionResult {
  readonly ok: boolean;
  readonly updateAttempted: boolean;
  readonly update?: UpdateExecutionResult;
  readonly launchCommand: ExecutedCommand;
  readonly message: string;
}

export type CcUpdatePrompter = () => boolean;

export type CcUpdatePromptEnvironment = RuntimePromptEnvironment;

export function createInteractiveCcUpdatePrompter(
  io: CliIo,
  environment: CcUpdatePromptEnvironment = {}
): CcUpdatePrompter {
  return () => {
    if (!isInteractiveTerminal(environment)) {
      return true;
    }

    while (true) {
      const answer = (
        promptWithRuntime(
          'Update Teamem before launching Claude Code? [Y/n]: ',
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

export function createClaudeProcessLauncher(): ClaudeProcessLauncher {
  return {
    launch(command, args, options) {
      return spawnSync(command, [...args], {
        cwd: options.cwd,
        stdio: 'inherit'
      });
    }
  };
}

export function buildClaudeLaunchCommand(
  claudeArgs: readonly string[] = []
): ExecutedCommand {
  return {
    command: 'claude',
    args: [
      '--dangerously-load-development-channels',
      `plugin:${TEAMEM_PLUGIN}`,
      ...claudeArgs
    ]
  };
}

export function executeCcLaunch(
  options: CcLaunchEnvironment &
    CcLaunchOptions & {
      readonly updatePrompter?: CcUpdatePrompter;
    }
): CcExecutionResult {
  const launchCommand = buildClaudeLaunchCommand(options.claudeArgs);
  if (options.dryRun) {
    return {
      ok: true,
      updateAttempted: options.updateMode !== 'never',
      launchCommand,
      message: 'dry-run: Teamem launch/update actions were planned only'
    };
  }

  const shouldUpdate =
    options.updateMode === 'always'
      ? true
      : options.updateMode === 'never'
        ? false
        : (options.updatePrompter?.() ?? false);

  const update = shouldUpdate
    ? executePluginUpdate({
        cwd: options.cwd,
        commandRunner: options.commandRunner,
        fileSystem: options.fileSystem,
        dryRun: false,
        requestedScope: options.requestedScope
      })
    : undefined;

  const launcher = options.claudeLauncher ?? createClaudeProcessLauncher();
  const launchResult = launcher.launch(
    launchCommand.command,
    launchCommand.args,
    { cwd: options.cwd }
  );

  if (launchResult.error) {
    return {
      ok: false,
      updateAttempted: shouldUpdate,
      update,
      launchCommand,
      message: `Failed to launch Claude Code: ${launchResult.error.message}`
    };
  }

  const exitCode = launchResult.status ?? 1;
  return {
    ok: exitCode === 0,
    updateAttempted: shouldUpdate,
    update,
    launchCommand,
    message: `Claude Code exited with code ${exitCode}.`
  };
}
