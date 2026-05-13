import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { createHttpClient, SpaceDisbandedError } from './http-client.js';
import { TOOL_BINDINGS } from './tool-bindings.js';
import {
  loadCredentials,
  pickEntry,
  checkJwtExp,
  SessionExpiredError,
  UnknownSpaceError,
  AmbiguousSpaceLabelError,
  type CredentialEntry
} from './credentials.js';

const SECONDS_PER_DAY = 86_400;
const EXPIRY_WARN_DAYS = 7;

function getEnv(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

export function emitStartupLogs(entry: CredentialEntry): void {
  process.stderr.write(
    `[teamem] using space ${entry.space_id} (${entry.label})\n`
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const secondsUntilExp = entry.jwt_exp - nowSec;
  if (
    typeof entry.jwt_exp === 'number' &&
    secondsUntilExp > 0 &&
    secondsUntilExp < EXPIRY_WARN_DAYS * SECONDS_PER_DAY
  ) {
    const days = Math.max(1, Math.ceil(secondsUntilExp / SECONDS_PER_DAY));
    process.stderr.write(
      `[teamem] WARNING: JWT for space "${entry.label}" expires in ${days} day${days === 1 ? '' : 's'}.\n`
    );
    process.stderr.write(
      `[teamem] Re-run 'bun run setup' and re-join this space to refresh.\n`
    );
  }
}

function stampIdentity(
  input: Record<string, unknown>,
  _spaceId: string,
  _memberName: string
): Record<string, unknown> {
  // Server now extracts space_id and principal from the verified JWT (plan §2
  // req 6). Top-level space_id/principal in the request body returns 400
  // scope_in_body_unsupported. Strip both keys defensively in case any caller
  // (older MCP host, fixture) supplies them.
  const stamped = { ...input };
  delete stamped.space_id;
  delete stamped.principal;
  return stamped;
}

async function resolveCredential(
  env: Record<string, string | undefined>,
  spaceFlag?: string
) {
  const creds = await loadCredentials();
  if (!creds) {
    process.stderr.write(
      "[teamem] No credentials found. Run 'bun run setup' to create or join a space.\n"
    );
    process.exit(1);
  }

  let entry;
  try {
    entry = pickEntry({ flag: spaceFlag, env: env.TEAMEM_SPACE, creds });
  } catch (err) {
    if (err instanceof UnknownSpaceError) {
      process.stderr.write(`[teamem] ${err.message}\n`);
      process.stderr.write(
        "[teamem] Run 'bun run setup' to add it, or pass --space <id> / set TEAMEM_SPACE. Both space_id (ULID) and label are accepted.\n"
      );
      process.exit(1);
    }
    if (err instanceof AmbiguousSpaceLabelError) {
      // Codex F11: the user passed a label that matches multiple entries.
      // The error message already lists the matching IDs.
      process.stderr.write(`[teamem] ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`[teamem] ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    checkJwtExp(entry);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      process.stderr.write(`[teamem] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  return entry;
}

function parseSpaceFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--space' && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

export async function startBridge(argv: string[] = process.argv.slice(2)) {
  const env = getEnv();
  const spaceFlag = parseSpaceFlag(argv);
  const entry = await resolveCredential(env, spaceFlag);

  emitStartupLogs(entry);

  const client = createHttpClient({
    baseUrl: entry.server_url.replace(/\/$/, ''),
    jwt: entry.jwt,
    spaceId: entry.space_id,
    spaceLabel: entry.label
  });

  const server = new Server(
    { name: 'teamem-bridge', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOL_BINDINGS).map(([name, binding]) => ({
      name,
      description: binding.description,
      inputSchema: {
        type: 'object' as const,
        ...binding.inputSchema._def
      }
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const binding = TOOL_BINDINGS[name];

    if (!binding) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` })
          }
        ],
        isError: true
      };
    }

    const rawInput =
      typeof req.params.arguments === 'object' && req.params.arguments !== null
        ? req.params.arguments
        : {};

    const stamped = stampIdentity(
      rawInput as Record<string, unknown>,
      entry.space_id,
      entry.member_name
    );

    let result: unknown;
    try {
      const parsed = binding.inputSchema.parse(stamped);
      result = await binding.handler(parsed, client);
    } catch (err) {
      if (err instanceof SpaceDisbandedError) {
        process.stderr.write(
          `Space ${err.space_id} (label: ${err.space_label}) was disbanded — removed from credentials.json\n`
        );
        process.exit(1);
      }
      result = { ok: false, error: (err as Error).message };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result)
        }
      ]
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('teamem-bridge started\n');
}

async function runArgvMode() {
  const args = process.argv.slice(2);
  // argv syntax: call <tool_name> [--space <space_id>] [--actor Z] [--delegation D] [--token-budget N] [--json '{"k":"v"}']
  if (args[0] !== 'call' || !args[1]) {
    process.stderr.write(
      'Usage: bridge call <tool_name> [--space <space_id>] [--actor Z] [--delegation D] [--token-budget N] [--json \'{"k":"v"}\']\n'
    );
    process.exit(1);
  }

  const toolName = args[1];
  const binding = TOOL_BINDINGS[toolName];
  if (!binding) {
    process.stderr.write(
      `Unknown tool: ${toolName}\nAvailable: ${Object.keys(TOOL_BINDINGS).join(', ')}\n`
    );
    process.exit(1);
  }

  // Parse flag arguments — extract --space before resolving credential
  const input: Record<string, unknown> = {};
  let spaceFlag: string | undefined;
  const flagArgs = args.slice(2);
  for (let i = 0; i < flagArgs.length; i++) {
    const flag = flagArgs[i];
    const val = flagArgs[i + 1];
    if (flag === '--space') {
      spaceFlag = val;
      i++;
    } else if (flag === '--space-id') {
      input.space_id = val;
      i++;
    } else if (flag === '--actor') {
      input.actor = val;
      i++;
    } else if (flag === '--delegation') {
      input.delegation = val;
      i++;
    } else if (flag === '--token-budget') {
      input.token_budget = Number(val);
      i++;
    } else if (flag === '--json') {
      try {
        Object.assign(input, JSON.parse(val ?? '{}'));
      } catch {
        /* ignore */
      }
      i++;
    }
  }

  const env = getEnv();
  const entry = await resolveCredential(env, spaceFlag);

  emitStartupLogs(entry);

  const stamped = stampIdentity(input, entry.space_id, entry.member_name);

  const parsed = binding.inputSchema.safeParse(stamped);
  if (!parsed.success) {
    process.stderr.write(`Invalid input: ${parsed.error.message}\n`);
    process.exit(1);
  }

  const client = createHttpClient({
    baseUrl: entry.server_url.replace(/\/$/, ''),
    jwt: entry.jwt,
    spaceId: entry.space_id,
    spaceLabel: entry.label
  });

  try {
    const result = await binding.handler(parsed.data, client);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    if (err instanceof SpaceDisbandedError) {
      process.stderr.write(
        `Space ${err.space_id} (label: ${err.space_label}) was disbanded — removed from credentials.json\n`
      );
      process.exit(1);
    }
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const isArgvMode = args[0] === 'call';
  if (isArgvMode) {
    runArgvMode().catch((err) => {
      process.stderr.write(`teamem-bridge fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
  } else {
    startBridge(args).catch((err) => {
      process.stderr.write(`teamem-bridge fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
  }
}
