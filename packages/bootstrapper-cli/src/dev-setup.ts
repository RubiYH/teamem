import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DevProfilePaths } from './dev-profiles.js';
import type { DevSourceResolution } from './dev-source.js';
import type {
  SetupInvocationResult,
  SetupProcessRunner
} from './setup-delegation.js';

const LOCAL_SETUP_BUNDLE = join('plugin', 'lib', 'setup.js');

export interface DevSetupFileSystem {
  exists(path: string): boolean;
}

export interface DevSetupInvocation {
  readonly source: DevSourceResolution;
  readonly profile: DevProfilePaths;
}

export interface DevSetupRunner {
  run(invocation: DevSetupInvocation): SetupInvocationResult;
}

export interface DevSetupRunnerEnvironment {
  readonly fileSystem?: DevSetupFileSystem;
  readonly processRunner?: SetupProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
}

export function createNodeDevSetupFileSystem(): DevSetupFileSystem {
  return {
    exists(path: string): boolean {
      return existsSync(path);
    }
  };
}

export function createLocalDevSetupRunner(
  environment: DevSetupRunnerEnvironment = {}
): DevSetupRunner {
  const fileSystem = environment.fileSystem ?? createNodeDevSetupFileSystem();
  const processRunner = environment.processRunner ?? {
    run(
      command: string,
      args: readonly string[],
      options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv }
    ): {
      readonly status: number | null;
      readonly error?: Error;
    } {
      return spawnSync(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: 'inherit'
      });
    }
  };

  return {
    run(invocation: DevSetupInvocation): SetupInvocationResult {
      const setupScript = join(
        invocation.source.teamemRoot,
        LOCAL_SETUP_BUNDLE
      );
      if (!fileSystem.exists(setupScript)) {
        return {
          ok: false,
          exitCode: 1,
          message: `Local Teamem setup bundle is missing at ${setupScript}. Run bun run build:plugin from the selected Teamem source checkout.`
        };
      }

      const result = processRunner.run('bun', ['run', setupScript], {
        cwd: invocation.source.launchCwd,
        env: {
          ...(environment.env ?? process.env),
          TEAMEM_CREDENTIALS: invocation.profile.credentialsPath
        }
      });

      if (result.error) {
        return {
          ok: false,
          exitCode: 1,
          message: `Failed to launch profile-scoped Teamem setup: ${result.error.message}`
        };
      }

      const exitCode = result.status ?? 1;
      return exitCode === 0
        ? {
            ok: true,
            exitCode,
            message: 'Profile-scoped Teamem setup completed.'
          }
        : {
            ok: false,
            exitCode,
            message: `Profile-scoped Teamem setup exited with code ${exitCode}.`
          };
    }
  };
}
