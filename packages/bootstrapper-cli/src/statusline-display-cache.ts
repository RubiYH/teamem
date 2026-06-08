import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const TEAMEM_STATUSLINE_CACHE_FORMAT_VERSION = 1;
export const TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH = join(
  'statusline',
  'display.json'
);

export interface StatuslineDisplayCacheIdentity {
  readonly project_key?: string;
  readonly session_id?: string;
  readonly workspace_current_dir?: string;
}

export interface StatuslineDisplayCacheRecord {
  readonly format_version: 1;
  readonly updated_at: string;
  readonly fresh_until: string;
  readonly identity: StatuslineDisplayCacheIdentity;
  readonly space?: {
    readonly id?: string;
    readonly label: string;
  };
  readonly sprint?: unknown;
  readonly monitor?: unknown;
  readonly run?: unknown;
}

export interface StatuslineRenderContext {
  readonly session_id?: string;
  readonly workspace_current_dir?: string;
  readonly project_key?: string;
}

export interface StatuslineDisplayState {
  readonly space?: {
    readonly id?: string;
    readonly label: string;
  };
  readonly sprint?: {
    readonly id?: string;
    readonly slug?: string;
    readonly name: string;
  };
}

export interface StatuslineDisplayCacheOptions {
  readonly now?: Date;
  readonly homeDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly readFile?: (path: string) => string;
  readonly exists?: (path: string) => boolean;
  readonly candidatePaths?: readonly string[];
}

export function readStatuslineDisplayCache(
  context: StatuslineRenderContext,
  options: StatuslineDisplayCacheOptions = {}
): StatuslineDisplayState {
  const nowMs = (options.now ?? new Date()).getTime();
  for (const path of resolveCacheCandidatePaths(options)) {
    const record = readCacheRecord(path, options);
    if (!record) continue;
    if (!isFresh(record, nowMs)) continue;
    if (!matchesContext(record.identity, context)) continue;
    const space = normalizeSpace(record.space);
    const sprint = normalizeSprint(record.sprint);
    return {
      ...(space ? { space } : {}),
      ...(sprint ? { sprint } : {})
    };
  }
  return {};
}

export function resolveStatuslineRenderContext(
  input: Record<string, unknown>
): StatuslineRenderContext {
  return {
    session_id:
      readNestedString(input, ['session_id']) ??
      readNestedString(input, ['sessionId']),
    workspace_current_dir:
      readNestedString(input, ['workspace', 'current_dir']) ??
      readNestedString(input, ['cwd']),
    project_key: readNestedString(input, ['teamem', 'project_key'])
  };
}

function resolveCacheCandidatePaths(
  options: StatuslineDisplayCacheOptions
): string[] {
  if (options.candidatePaths) {
    return [...options.candidatePaths];
  }

  const env = options.env ?? process.env;
  const candidates = new Set<string>();
  if (env.TEAMEM_STATUSLINE_CACHE) {
    candidates.add(env.TEAMEM_STATUSLINE_CACHE);
  }
  if (env.TEAMEM_DATA) {
    candidates.add(
      join(env.TEAMEM_DATA, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH)
    );
  }
  if (
    env.CLAUDE_PLUGIN_DATA &&
    looksLikeTeamemDataDir(env.CLAUDE_PLUGIN_DATA)
  ) {
    candidates.add(
      join(env.CLAUDE_PLUGIN_DATA, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH)
    );
  }

  const dataRoot = join(options.homeDir ?? homedir(), '.claude/plugins/data');
  try {
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && looksLikeTeamemDataDir(entry.name)) {
        candidates.add(
          join(dataRoot, entry.name, TEAMEM_STATUSLINE_CACHE_RELATIVE_PATH)
        );
      }
    }
  } catch {
    // Local cache lookup is best-effort; bad or absent data roots render empty.
  }

  return [...candidates];
}

function readCacheRecord(
  path: string,
  options: StatuslineDisplayCacheOptions
): StatuslineDisplayCacheRecord | undefined {
  const exists = options.exists ?? existsSync;
  if (!exists(path)) return undefined;
  try {
    const readFile =
      options.readFile ?? ((target) => readFileSync(target, 'utf8'));
    const parsed = JSON.parse(readFile(path));
    if (!isCacheRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isCacheRecord(value: unknown): value is StatuslineDisplayCacheRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.format_version === TEAMEM_STATUSLINE_CACHE_FORMAT_VERSION &&
    typeof record.updated_at === 'string' &&
    typeof record.fresh_until === 'string' &&
    !!record.identity &&
    typeof record.identity === 'object' &&
    !Array.isArray(record.identity)
  );
}

function isFresh(record: StatuslineDisplayCacheRecord, nowMs: number): boolean {
  const freshUntilMs = Date.parse(record.fresh_until);
  return Number.isFinite(freshUntilMs) && freshUntilMs > nowMs;
}

function matchesContext(
  identity: StatuslineDisplayCacheIdentity,
  context: StatuslineRenderContext
): boolean {
  if (identity.session_id && context.session_id) {
    return identity.session_id === context.session_id;
  }
  if (identity.project_key && context.project_key) {
    return identity.project_key === context.project_key;
  }
  if (identity.workspace_current_dir && context.workspace_current_dir) {
    return pathsMatch(
      identity.workspace_current_dir,
      context.workspace_current_dir
    );
  }
  return false;
}

function normalizeSpace(
  value: StatuslineDisplayCacheRecord['space']
): StatuslineDisplayState['space'] {
  if (!value || typeof value.label !== 'string' || !value.label.trim()) {
    return undefined;
  }
  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : undefined,
    label: value.label.trim()
  };
}

function normalizeSprint(
  value: StatuslineDisplayCacheRecord['sprint']
): StatuslineDisplayState['sprint'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const sprint = value as Record<string, unknown>;
  const id = readStringValue(sprint.sprint_id) ?? readStringValue(sprint.id);
  const slug = readStringValue(sprint.slug);
  const name =
    readStringValue(sprint.display_name) ??
    readStringValue(sprint.name) ??
    slug ??
    id;
  return name
    ? {
        ...(id ? { id } : {}),
        ...(slug ? { slug } : {}),
        name
      }
    : undefined;
}

function readNestedString(
  value: Record<string, unknown>,
  path: readonly string[]
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim()
    ? current.trim()
    : undefined;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pathsMatch(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return basename(a) === basename(b) && a === b;
  }
}

function looksLikeTeamemDataDir(pathOrName: string): boolean {
  const name = basename(pathOrName);
  return (
    name === 'teamem' ||
    name.startsWith('teamem-') ||
    name === 'teamem2' ||
    name.startsWith('teamem2-')
  );
}
