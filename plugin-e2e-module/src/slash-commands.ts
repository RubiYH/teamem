import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SlashCommand,
  SlashCommandInventory,
  SlashCommandMetadata
} from './types.js';

const FRONTMATTER_BOUNDARY = '---';

export async function readSlashCommands(
  pluginDir: string
): Promise<SlashCommandInventory> {
  const commandsDir = join(pluginDir, 'commands');
  const commands = (await commandsDirExists(commandsDir))
    ? await readCommandFiles(commandsDir)
    : [];

  return {
    kind: 'slash-command-inventory',
    pluginDir,
    commandsDir,
    commands,
    scope: {
      slashCommands: 'supported',
      skills: 'deferred',
      agents: 'deferred'
    }
  };
}

async function readCommandFiles(commandsDir: string): Promise<SlashCommand[]> {
  const glob = new Bun.Glob('**/*.md');
  const commands: SlashCommand[] = [];

  for await (const entry of glob.scan({
    cwd: commandsDir,
    dot: false,
    onlyFiles: true
  })) {
    const filePath = join(commandsDir, entry);
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseSlashCommandMarkdown(raw);

    commands.push({
      name: commandNameFromEntry(entry),
      filePath,
      content: parsed.content,
      metadata: parsed.metadata
    });
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function commandNameFromEntry(entry: string): string {
  const withoutExtension = entry.replace(/\.md$/u, '');
  return withoutExtension.split(/[\\/]/u).join('/');
}

function parseSlashCommandMarkdown(raw: string): {
  content: string;
  metadata: SlashCommandMetadata;
} {
  const normalized = raw.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== FRONTMATTER_BOUNDARY) {
    return { content: normalized, metadata: {} };
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line === FRONTMATTER_BOUNDARY
  );
  if (endIndex === -1) {
    return { content: normalized, metadata: {} };
  }

  return {
    content: lines.slice(endIndex + 1).join('\n'),
    metadata: parseSupportedFrontmatter(lines.slice(1, endIndex))
  };
}

function parseSupportedFrontmatter(lines: string[]): SlashCommandMetadata {
  const metadata: SlashCommandMetadata = {};

  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === 'description') {
      metadata.description = unquote(value);
    } else if (key === 'allowed-tools') {
      metadata.allowedTools = parseAllowedTools(value);
    } else if (key === 'argument-hint') {
      metadata.argumentHint = unquote(value);
    }
  }

  return metadata;
}

function parseAllowedTools(value: string): string[] {
  if (!value) {
    return [];
  }
  if (value === '[]') {
    return [];
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }
  return value
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function commandsDirExists(commandsDir: string): Promise<boolean> {
  return access(commandsDir)
    .then(() => true)
    .catch(() => false);
}
