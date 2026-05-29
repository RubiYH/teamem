import { TEAMEM_MARKETPLACE, TEAMEM_PLUGIN } from './plugin-installer.js';

export type BootstrapperCommand =
  | 'init'
  | 'cc'
  | 'update'
  | 'uninstall'
  | 'dev'
  | 'claude';

export type BootstrapperActionKind =
  | 'diagnose-prerequisites'
  | 'ensure-marketplace'
  | 'install-plugin'
  | 'uninstall-plugin'
  | 'remove-marketplace'
  | 'uninstall-git-hooks'
  | 'clear-local-state'
  | 'run-setup-flow'
  | 'check-for-updates'
  | 'launch-claude'
  | 'report-cc-migration'
  | 'manage-claude-launcher'
  | 'manage-dev-profile';

export interface PlannedExternalCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface PlannedAction {
  readonly kind: BootstrapperActionKind;
  readonly title: string;
  readonly description: string;
  readonly externalCommand?: PlannedExternalCommand;
}

export interface ActionPlan {
  readonly command: BootstrapperCommand;
  readonly dryRun: boolean;
  readonly actions: readonly PlannedAction[];
}

export interface BuildActionPlanOptions {
  readonly command: BootstrapperCommand;
  readonly dryRun?: boolean;
  readonly scope?: string;
  readonly claudeArgs?: readonly string[];
  readonly includeUpdateCheck?: boolean;
}

export function buildActionPlan(options: BuildActionPlanOptions): ActionPlan {
  const dryRun = options.dryRun ?? false;
  const scope = options.scope ?? '<scope>';

  switch (options.command) {
    case 'init':
      return {
        command: 'init',
        dryRun,
        actions: [
          {
            kind: 'diagnose-prerequisites',
            title: 'Diagnose prerequisites',
            description:
              'Inspect Claude Code, Bun, Git, and repository availability without installing third-party tools.'
          },
          {
            kind: 'ensure-marketplace',
            title: 'Ensure Teamem marketplace',
            description:
              'Add or refresh the Teamem GitHub marketplace metadata before plugin installation.',
            externalCommand: {
              command: 'claude',
              args: ['plugin', 'marketplace', 'add', '<teamem-alpha-source>']
            }
          },
          {
            kind: 'install-plugin',
            title: 'Install Teamem plugin',
            description:
              'Install the Teamem marketplace plugin at the selected Claude Code scope.',
            externalCommand: {
              command: 'claude',
              args: ['plugin', 'install', TEAMEM_PLUGIN, '--scope', scope]
            }
          },
          {
            kind: 'run-setup-flow',
            title: 'Run create/join setup',
            description:
              'Delegate to the installed Teamem plugin setup bundle so credential writing and multi-space behavior stay in one implementation.',
            externalCommand: {
              command: 'bun',
              args: ['run', '<installed-teamem-plugin>/lib/setup.js']
            }
          }
        ]
      };
    case 'cc':
      return {
        command: 'cc',
        dryRun,
        actions: [
          {
            kind: 'report-cc-migration',
            title: 'Report `teamem cc` migration',
            description:
              '`teamem cc` no longer launches Claude Code. Use `teamem claude install` to opt into the machine-local `claude` shim, which prompts before starting Claude Code with Teamem and preserves a pure Claude Code path.'
          }
        ]
      };
    case 'claude':
      return {
        command: 'claude',
        dryRun,
        actions: [
          {
            kind: 'manage-claude-launcher',
            title: 'Manage Teamem-aware Claude launcher',
            description:
              'Install, inspect, or remove Teamem-owned machine-local launcher state and shim files. With --dry-run, report planned launcher file changes without mutating local state.'
          }
        ]
      };
    case 'dev':
      return {
        command: 'dev',
        dryRun,
        actions: [
          {
            kind: 'manage-dev-profile',
            title: 'Manage Teamem dev profile',
            description:
              'Select, create, inspect, or delete a machine-local Teamem dev profile without touching normal Claude or marketplace plugin state.'
          }
        ]
      };
    case 'update':
      return {
        command: 'update',
        dryRun,
        actions: [
          {
            kind: 'ensure-marketplace',
            title: 'Refresh Teamem marketplace',
            description:
              'Refresh Teamem marketplace metadata before applying plugin updates.',
            externalCommand: {
              command: 'claude',
              args: ['plugin', 'marketplace', 'update', TEAMEM_MARKETPLACE]
            }
          },
          {
            kind: 'install-plugin',
            title: 'Update Teamem plugin',
            description:
              'Update the installed Teamem plugin at the configured Claude Code scope.',
            externalCommand: {
              command: 'claude',
              args: ['plugin', 'update', TEAMEM_PLUGIN, '--scope', scope]
            }
          }
        ]
      };
    case 'uninstall':
      return {
        command: 'uninstall',
        dryRun,
        actions: [
          {
            kind: 'uninstall-plugin',
            title: 'Uninstall Teamem plugin',
            description:
              'Remove the Teamem Claude Code plugin from the selected scope and prune unused dependencies.',
            externalCommand: {
              command: 'claude',
              args: [
                'plugin',
                'uninstall',
                TEAMEM_PLUGIN,
                '--scope',
                scope,
                '--prune',
                '-y'
              ]
            }
          },
          {
            kind: 'remove-marketplace',
            title: 'Remove Teamem marketplace',
            description:
              'Remove the Teamem marketplace registration from Claude Code.',
            externalCommand: {
              command: 'claude',
              args: ['plugin', 'marketplace', 'remove', TEAMEM_MARKETPLACE]
            }
          },
          {
            kind: 'uninstall-git-hooks',
            title: 'Uninstall Teamem git hooks',
            description:
              'Remove Teamem-managed post-commit and post-checkout hooks from the current repository and restore .teamem-backup hooks.'
          },
          {
            kind: 'manage-claude-launcher',
            title: 'Remove Teamem-aware Claude launcher',
            description:
              'Remove Teamem-owned machine-local Claude launcher state and shim files while preserving non-Teamem files.'
          },
          {
            kind: 'clear-local-state',
            title: 'Clear local Teamem state',
            description:
              'Delete local Teamem credentials, run/cache state, Claude plugin session data, and bootstrapper scope memory.'
          }
        ]
      };
  }
}
