export type ClaudePluginTesterErrorCode =
  | 'CLAUDE_BINARY'
  | 'CLAUDE_AUTH'
  | 'CLAUDE_FEATURE'
  | 'CLAUDE_VERSION'
  | 'PLUGIN_VALIDATION'
  | 'PLUGIN_INSTRUMENTATION'
  | 'CLAUDE_RUN'
  | 'INTERACTIVE_TIMEOUT'
  | 'INTERACTIVE_PROCESS'
  | 'TRACE_ASSERTION'
  | 'REDACTION_CONFIG';

export class ClaudePluginTesterError extends Error {
  readonly code: ClaudePluginTesterErrorCode;

  constructor(code: ClaudePluginTesterErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ClaudeBinaryError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('CLAUDE_BINARY', message);
  }
}

export class ClaudeAuthError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('CLAUDE_AUTH', message);
  }
}

export class ClaudeFeatureError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('CLAUDE_FEATURE', message);
  }
}

export class ClaudeVersionError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('CLAUDE_VERSION', message);
  }
}

export class PluginValidationError extends ClaudePluginTesterError {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly artifactsDir?: string;
  readonly artifactPaths: string[];

  constructor(
    message: string,
    details: {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      artifactsDir?: string;
      artifactPaths?: string[];
    } = {}
  ) {
    super('PLUGIN_VALIDATION', message);
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.exitCode = details.exitCode;
    this.artifactsDir = details.artifactsDir;
    this.artifactPaths = details.artifactPaths ?? [];
  }
}

export class PluginInstrumentationError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('PLUGIN_INSTRUMENTATION', message);
  }
}

export class ClaudeRunError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('CLAUDE_RUN', message);
  }
}

export class InteractiveTimeoutError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('INTERACTIVE_TIMEOUT', message);
  }
}

export class InteractiveProcessError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('INTERACTIVE_PROCESS', message);
  }
}

export class TraceAssertionError extends ClaudePluginTesterError {
  readonly artifactsDir?: string;
  readonly artifactPaths: string[];

  constructor(
    message: string,
    artifactsDir?: string,
    artifactPaths: string[] = []
  ) {
    super('TRACE_ASSERTION', message);
    this.artifactsDir = artifactsDir;
    this.artifactPaths = artifactPaths;
  }
}

export class RedactionConfigError extends ClaudePluginTesterError {
  constructor(message: string) {
    super('REDACTION_CONFIG', message);
  }
}
