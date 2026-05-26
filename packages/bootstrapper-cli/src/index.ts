export {
  detectInstalledTeamemScopeFromJson,
  findInstalledTeamemPlugin,
  parseClaudePluginListJson,
  type ClaudePluginListEntry
} from './claude-plugin-list.js';
export {
  buildActionPlan,
  type ActionPlan,
  type BuildActionPlanOptions,
  type BootstrapperCommand,
  type PlannedAction
} from './action-plan.js';
export {
  parseCliArgs,
  renderHelp,
  renderPlan,
  runCli,
  type ClaudeLifecycleCommand,
  type CliEnvironment,
  type CliFailure,
  type CliIo,
  type CliParseResult,
  type CliSuccess,
  type ParsedCliArgs
} from './cli.js';
export {
  DEFAULT_MARKETPLACE_SOURCE,
  TEAMEM_MARKETPLACE,
  TEAMEM_PLUGIN,
  createNodeFileSystem,
  detectInstalledScope,
  executeInitInstall,
  isPluginScope,
  readRememberedScope,
  renderInitExecutionReport,
  resolveScope,
  type BootstrapperFileSystem,
  type ExecutedCommand,
  type InitExecutionEnvironment,
  type InitExecutionOptions,
  type InitExecutionResult,
  type PluginScope,
  type ScopeResolution
} from './plugin-installer.js';
export {
  createInteractiveScopePrompter,
  type ScopePromptContext,
  type ScopePrompter
} from './scope-prompt.js';
export {
  createGitHookInstaller,
  createInteractiveGitHookPrompter,
  resolveInstalledPluginRoot,
  type GitHookFileSystem,
  type GitHookInstallResult,
  type GitHookInstaller,
  type GitHookInstallerEnvironment,
  type GitHookPromptContext,
  type GitHookPrompter
} from './git-hooks.js';
export {
  createSetupRunner,
  parseSetupSelection,
  resolveInstalledSetupBundle,
  type SetupCommandRunner,
  type SetupInvocation,
  type SetupInvocationResult,
  type SetupProcessRunner,
  type SetupRunnerEnvironment,
  type SetupBundleResolution,
  type SetupSelectionParseResult
} from './setup-delegation.js';
export {
  createSystemCommandRunner,
  detectPrerequisites,
  type CommandProbeResult,
  type CommandRunner,
  type DiagnosticSeverity,
  type PrerequisiteDiagnostic,
  type PrerequisiteEnvironment,
  type PrerequisiteReport
} from './prerequisites.js';
export {
  executePluginUpdate,
  renderUpdateExecutionReport,
  resolveUpdateScope,
  type UpdateExecutionEnvironment,
  type UpdateExecutionOptions,
  type UpdateExecutionResult,
  type UpdateScopeResolution
} from './update-executor.js';
export {
  createNodeLocalStateFileSystem,
  executeUninstall,
  renderUninstallExecutionReport,
  type LocalStateFileSystem,
  type LocalCleanupFailure,
  type UninstallCommandFailure,
  type UninstallExecutionEnvironment,
  type UninstallExecutionOptions,
  type UninstallExecutionResult
} from './uninstall-executor.js';
export {
  createNodeClaudeLauncherFileSystem,
  getClaudeLauncherStatus,
  installClaudeLauncher,
  launchClaudeWithTeamemPolicy,
  renderClaudeLauncherReport,
  uninstallClaudeLauncher,
  type ClaudeLaunchEnvironment,
  type ClaudeLaunchMode,
  type ClaudeLaunchProcessRunner,
  type ClaudeLaunchResult,
  type ClaudeLauncherEnvironment,
  type ClaudeLauncherFileSystem,
  type ClaudeLauncherPaths,
  type ClaudeLauncherResult,
  type ClaudeLauncherState,
  type ClaudeLauncherStatus
} from './claude-launcher.js';
