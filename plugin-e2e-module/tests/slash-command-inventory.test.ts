import { describe, expect, it } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudePluginTester, readSlashCommands } from '../src/index.js';

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fakePluginDir = join(moduleRoot, 'fixtures', 'fake-plugin');

describe('slash command inventory', () => {
  it('reads slash commands and supported frontmatter from plugin source', async () => {
    const before = await readFile(
      join(fakePluginDir, 'commands', 'echo.md'),
      'utf8'
    );

    const inventory = await readSlashCommands(fakePluginDir);

    expect(inventory.kind).toBe('slash-command-inventory');
    expect(inventory.scope).toEqual({
      slashCommands: 'supported',
      skills: 'deferred',
      agents: 'deferred'
    });
    expect(inventory.commands.map((command) => command.name)).toEqual([
      'echo',
      'plain'
    ]);
    expect(inventory.commands[0]).toMatchObject({
      name: 'echo',
      metadata: {
        description:
          'Echo slash-command arguments through the generic fake plugin fixture',
        allowedTools: [],
        argumentHint: '<message>'
      },
      content: '\nEcho the supplied slash-command arguments: $ARGUMENTS\n'
    });
    expect(inventory.commands[0].filePath).toBe(
      join(fakePluginDir, 'commands', 'echo.md')
    );
    expect(inventory.commands[1]).toMatchObject({
      name: 'plain',
      metadata: {},
      content: 'Plain command body without frontmatter.\n'
    });
    await expect(
      readFile(join(fakePluginDir, 'commands', 'echo.md'), 'utf8')
    ).resolves.toBe(before);
  });

  it('reads slash commands from copied plugin directories', async () => {
    const copiedPluginDir = await mkdtemp(
      join(tmpdir(), 'claude-plugin-e2e-copy-')
    );
    try {
      await cp(fakePluginDir, copiedPluginDir, { recursive: true });
      await writeFile(
        join(copiedPluginDir, 'commands', 'ask.md'),
        [
          '---',
          'description: "Ask a copied fixture command"',
          'allowed-tools: [Read, "Bash(git status:*)"]',
          'argument-hint: "[question]"',
          'ignored-field: ignored',
          '---',
          '',
          'Ask from the copied plugin.'
        ].join('\n'),
        'utf8'
      );

      const inventory = await readSlashCommands(copiedPluginDir);

      expect(inventory.commands.map((command) => command.name)).toEqual([
        'ask',
        'echo',
        'plain'
      ]);
      expect(inventory.commands[0].metadata).toEqual({
        description: 'Ask a copied fixture command',
        allowedTools: ['Read', 'Bash(git status:*)'],
        argumentHint: '[question]'
      });
    } finally {
      await rm(copiedPluginDir, { recursive: true, force: true });
    }
  });

  it('exposes slash command inventory through the tester without booting Claude', async () => {
    const calls: unknown[] = [];
    const tester = createClaudePluginTester({
      pluginDir: fakePluginDir,
      processRunner: async (request) => {
        calls.push(request);
        return { exitCode: 1, stdout: '', stderr: 'should not run' };
      }
    });

    const inventory = await tester.slashCommands();

    expect(inventory.commands.map((command) => command.name)).toEqual([
      'echo',
      'plain'
    ]);
    expect(calls).toEqual([]);
  });

  it('formats namespaced slash command prompt text without booting Claude', async () => {
    const calls: unknown[] = [];
    const tester = createClaudePluginTester({
      pluginDir: fakePluginDir,
      processRunner: async (request) => {
        calls.push(request);
        return { exitCode: 1, stdout: '', stderr: 'should not run' };
      }
    });

    await expect(
      tester.slashCommandPrompt('echo', ' issue 07 proof ')
    ).resolves.toBe('/generic-fake-plugin:echo issue 07 proof');
    await expect(tester.slashCommandPrompt('plain')).resolves.toBe(
      '/generic-fake-plugin:plain'
    );
    await expect(tester.slashCommandPrompt('missing')).rejects.toThrow(
      'Slash command was not found in plugin inventory: missing'
    );
    expect(calls).toEqual([]);
  });
});
