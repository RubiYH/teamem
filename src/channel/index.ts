import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type Request, type Result } from '@modelcontextprotocol/sdk/types.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createHttpClient,
  SpaceDisbandedError
} from '../bridge/http-client.js';
import {
  AmbiguousSpaceLabelError,
  checkJwtExp,
  loadCredentials,
  pickEntry,
  SessionExpiredError,
  UnknownSpaceError,
  type CredentialEntry
} from '../bridge/credentials.js';
import { TOOL_BINDINGS } from '../bridge/tool-bindings.js';
import {
  createClaudeChannelNotification,
  isUrgentTeamemChannelEvent,
  type ClaudeChannelNotification,
  type TeamemChannelEvent
} from './payload.js';
import { shouldEmitTeamemChannelEvent } from './runtime.js';

function pluginDataEnvLooksTeamem(): boolean {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!data) return false;
  const name = basename(data);
  return (
    name === 'teamem' ||
    name.startsWith('teamem-') ||
    name === 'teamem2' ||
    name.startsWith('teamem2-')
  );
}

function dataDirFromInstalledCache(pluginRoot: string): string | null {
  const pluginDir = dirname(pluginRoot);
  const marketplaceDir = dirname(pluginDir);
  const cacheDir = dirname(marketplaceDir);
  if (basename(cacheDir) !== 'cache') return null;
  const pluginName = basename(pluginDir);
  const marketplace = basename(marketplaceDir);
  if (!pluginName || !marketplace) return null;
  return join(
    homedir(),
    '.claude/plugins/data',
    `${pluginName}-${marketplace}`
  );
}

function dataDirFromSourcePlugin(pluginRoot: string): string | null {
  const manifestPath = join(pluginRoot, '.claude-plugin/plugin.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: unknown;
    };
    if (manifest.name === 'teamem' || manifest.name === 'teamem2') {
      const marketplacePath = join(
        dirname(pluginRoot),
        '.claude-plugin/marketplace.json'
      );
      if (existsSync(marketplacePath)) {
        const marketplace = JSON.parse(
          readFileSync(marketplacePath, 'utf8')
        ) as { name?: unknown };
        if (typeof marketplace.name === 'string' && marketplace.name) {
          return join(
            homedir(),
            '.claude/plugins/data',
            `teamem-${marketplace.name}`
          );
        }
      }
      return join(homedir(), '.claude/plugins/data/teamem-inline');
    }
  } catch {
    return null;
  }
  return null;
}

function resolvePluginDataDir(): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const derived =
      dataDirFromInstalledCache(pluginRoot) ??
      dataDirFromSourcePlugin(pluginRoot);
    if (derived) {
      return pluginDataEnvLooksTeamem()
        ? process.env.CLAUDE_PLUGIN_DATA!
        : derived;
    }
  }

  return (
    process.env.CLAUDE_PLUGIN_DATA ??
    join(homedir(), '.claude/plugins/data/teamem')
  );
}

const PLUGIN_DATA = resolvePluginDataDir();
const SESSION_ID = process.env.CLAUDE_SESSION_ID ?? 'default';
const SESSION_DIR = join(PLUGIN_DATA, 'sessions', SESSION_ID);
const ACTIVE_FLAG = join(SESSION_DIR, 'active');
const SPACE_PIN = join(SESSION_DIR, 'space');
const CURSOR_FILE = join(SESSION_DIR, 'channel-cursor');
const NOTIF_LOG = join(SESSION_DIR, 'notifications.log');
const CHANNEL_LOG = join(PLUGIN_DATA, 'channel.log');
const REQUIRE_ACTIVE =
  process.env.TEAMEM_CHANNEL_REQUIRE_ACTIVE === '1' ||
  process.env.TEAMEM_CHANNEL_REQUIRE_ACTIVE === 'true';
const ALLOWED_SENDERS = new Set(
  (process.env.TEAMEM_CHANNEL_ALLOWED_SENDERS ?? '')
    .split(',')
    .map((sender) => sender.trim())
    .filter(Boolean)
);
const POLL_MS = Math.max(
  1000,
  Number.parseInt(process.env.TEAMEM_CHANNEL_POLL_MS ?? '10000', 10)
);
const RATE_PER_MIN = Math.min(
  60,
  Math.max(
    1,
    Number.parseInt(
      process.env.CLAUDE_PLUGIN_OPTION_WATCHER_RATE_PER_MIN ?? '6',
      10
    )
  )
);

export const EMPTY_CHANNEL_CURSOR = '__teamem_channel_primed_empty__';
const PRIME_PAGE_SIZE = 100;

type ChannelUpdateResult = {
  ok?: boolean;
  data?: { events?: TeamemChannelEvent[]; next_cursor?: string | null };
};

type GetUpdatesArgs = {
  since?: string;
  limit: number;
};

type ChannelPollServer = {
  notification(notification: ClaudeChannelNotification): Promise<void>;
};

type ChannelPollOptions = {
  server: ChannelPollServer;
  entry: CredentialEntry;
  cursor: string | null;
  client?: ReturnType<typeof createHttpClient>;
  getUpdates: (
    args: GetUpdatesArgs,
    client: ReturnType<typeof createHttpClient>
  ) => Promise<ChannelUpdateResult>;
  isActive?: () => boolean;
  rateOk?: () => boolean;
  onGetUpdatesNotOk?: () => void;
  onNotification?: (notification: ClaudeChannelNotification) => void;
  onPersistCursor?: (cursor: string) => void;
  onPrimeCursor?: (cursor: string) => void;
};

async function primeCursorToLatest(
  options: ChannelPollOptions,
  client: ReturnType<typeof createHttpClient>
): Promise<string | null> {
  let cursor: string | null = null;
  for (;;) {
    const result = await options.getUpdates(
      cursor
        ? { since: cursor, limit: PRIME_PAGE_SIZE }
        : { limit: PRIME_PAGE_SIZE },
      client
    );
    if (!result?.ok) {
      options.onGetUpdatesNotOk?.();
      return options.cursor;
    }
    const events = result.data?.events ?? [];
    const nextCursor = result.data?.next_cursor ?? events.at(-1)?.event_id;
    if (!nextCursor) return cursor ?? EMPTY_CHANNEL_CURSOR;
    if (nextCursor === cursor) return cursor;
    cursor = nextCursor;
    if (events.length < PRIME_PAGE_SIZE) return cursor;
  }
}

function logInternal(msg: string): void {
  try {
    mkdirSync(PLUGIN_DATA, { recursive: true });
    appendFileSync(
      CHANNEL_LOG,
      JSON.stringify({ ts: new Date().toISOString(), msg }) + '\n'
    );
  } catch {
    /* best effort */
  }
}

function resolveSpaceInput(): string | undefined {
  try {
    const pin = readFileSync(SPACE_PIN, 'utf-8').trim();
    if (pin) return pin;
  } catch {
    /* no session pin */
  }
  if (process.env.TEAMEM_SPACE) return process.env.TEAMEM_SPACE;
  if (process.env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE) {
    return process.env.CLAUDE_PLUGIN_OPTION_DEFAULT_SPACE;
  }
  return undefined;
}

async function resolveCredential(): Promise<CredentialEntry> {
  const creds = await loadCredentials();
  if (!creds) {
    throw new Error("No credentials found. Run '/teamem-setup' first.");
  }

  try {
    const entry = pickEntry({
      flag: resolveSpaceInput(),
      env: undefined,
      creds
    });
    checkJwtExp(entry);
    return entry;
  } catch (err) {
    if (
      err instanceof UnknownSpaceError ||
      err instanceof AmbiguousSpaceLabelError ||
      err instanceof SessionExpiredError
    ) {
      throw new Error(err.message);
    }
    throw err;
  }
}

function isActive(): boolean {
  if (!REQUIRE_ACTIVE) return true;
  return existsSync(ACTIVE_FLAG);
}

function createRateLimiter(): () => boolean {
  const recentTs: number[] = [];
  return () => {
    const now = Date.now();
    while (recentTs.length && recentTs[0]! < now - 60_000) recentTs.shift();
    if (recentTs.length >= RATE_PER_MIN) return false;
    recentTs.push(now);
    return true;
  };
}

export async function pollChannelOnce(
  options: ChannelPollOptions
): Promise<string | null> {
  if (!(options.isActive?.() ?? true)) return options.cursor;

  const client =
    options.client ??
    createHttpClient({
      baseUrl: options.entry.server_url.replace(/\/$/, ''),
      jwt: options.entry.jwt,
      spaceId: options.entry.space_id,
      spaceLabel: options.entry.label
    });

  if (!options.cursor) {
    const primedCursor = await primeCursorToLatest(options, client);
    if (primedCursor) {
      options.onPrimeCursor?.(primedCursor);
      options.onPersistCursor?.(primedCursor);
    }
    return primedCursor;
  }

  const result = await options.getUpdates(
    options.cursor === EMPTY_CHANNEL_CURSOR
      ? { limit: 50 }
      : { since: options.cursor, limit: 50 },
    client
  );

  if (!result?.ok) {
    options.onGetUpdatesNotOk?.();
    return options.cursor;
  }

  const rateOk = options.rateOk ?? (() => true);
  const events = result.data?.events ?? [];
  const nextCursor = result.data?.next_cursor ?? events.at(-1)?.event_id;
  for (const ev of events) {
    if (
      !shouldEmitTeamemChannelEvent(ev, {
        myPrincipal: options.entry.member_name,
        allowedSenders: ALLOWED_SENDERS.size > 0 ? ALLOWED_SENDERS : undefined
      })
    ) {
      continue;
    }
    if (!isUrgentTeamemChannelEvent(ev) && !rateOk()) continue;

    const notification = createClaudeChannelNotification(ev);
    await options.server.notification(notification);
    options.onNotification?.(notification);
  }

  if (!nextCursor) return options.cursor;

  options.onPersistCursor?.(nextCursor);
  return nextCursor;
}

async function startPolling(
  server: Server<Request, ClaudeChannelNotification, Result>,
  entry: CredentialEntry
): Promise<() => void> {
  const client = createHttpClient({
    baseUrl: entry.server_url.replace(/\/$/, ''),
    jwt: entry.jwt,
    spaceId: entry.space_id,
    spaceLabel: entry.label
  });
  const getUpdates = TOOL_BINDINGS['teamem.get_updates'];
  if (!getUpdates) throw new Error('teamem.get_updates binding missing');

  mkdirSync(SESSION_DIR, { recursive: true });

  let cursor: string | null = null;
  try {
    cursor = readFileSync(CURSOR_FILE, 'utf-8').trim() || null;
    if (cursor) {
      logInternal(`loaded cursor=${cursor}`);
    }
  } catch {
    /* fresh cursor */
  }

  const rateOk = createRateLimiter();
  async function pollOnce(): Promise<void> {
    cursor = await pollChannelOnce({
      server,
      entry,
      client,
      cursor,
      getUpdates: async (args, boundClient) =>
        (await getUpdates.handler(args, boundClient)) as ChannelUpdateResult,
      isActive,
      rateOk,
      onGetUpdatesNotOk: () => logInternal('get_updates_not_ok'),
      onNotification: (notification) => {
        try {
          appendFileSync(NOTIF_LOG, notification.params.content + '\n');
        } catch {
          /* best effort */
        }
      },
      onPrimeCursor: (nextCursor) => {
        logInternal(`primed cursor=${nextCursor}`);
      },
      onPersistCursor: (nextCursor) => {
        try {
          writeFileSync(CURSOR_FILE, nextCursor);
        } catch {
          /* best effort */
        }
      }
    });
  }

  const timer = setInterval(() => {
    pollOnce().catch((err) => logInternal(`poll_error: ${err.message}`));
  }, POLL_MS);

  if (typeof timer.unref === 'function') timer.unref();
  await pollOnce();

  return () => {
    clearInterval(timer);
  };
}

export async function startChannel(): Promise<void> {
  const entry = await resolveCredential();

  const server = new Server<Request, ClaudeChannelNotification, Result>(
    { name: 'teamem-channel', version: '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {}
      },
      instructions:
        'Teamem events arrive as <channel source="teamem-channel" ...>. The body is a JSON Teamem event envelope. Surface directed discussion messages, decision broadcasts, gotcha notices, and urgent permission_requested alerts immediately. Reply to Teamem discussions through the normal teamem.post_message MCP tool or a human-facing Teamem path; the experimental channel reply helper is postponed.'
    }
  );

  await server.connect(new StdioServerTransport());
  logInternal(
    `start session=${SESSION_ID} principal=${entry.member_name} require_active=${REQUIRE_ACTIVE ? '1' : '0'} data=${PLUGIN_DATA}`
  );

  let stopPolling: (() => void) | null = null;
  try {
    stopPolling = await startPolling(server, entry);
  } catch (err) {
    if (err instanceof SpaceDisbandedError) {
      throw err;
    }
    logInternal(`startup_poll_error: ${(err as Error).message}`);
  }

  const shutdown = () => {
    stopPolling?.();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.main) {
  startChannel().catch((err) => {
    process.stderr.write(`teamem-channel fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
