import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginValidationError } from './errors.js';
import type { ValidatedPluginSource } from './types.js';

export async function validatePluginSource(
  pluginDir: string
): Promise<ValidatedPluginSource> {
  const pluginStats = await stat(pluginDir).catch(() => null);
  if (!pluginStats?.isDirectory()) {
    throw new PluginValidationError(
      `Plugin source directory does not exist: ${pluginDir}`
    );
  }

  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  const manifest = await readJson(manifestPath, 'plugin manifest');
  const name = manifest.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new PluginValidationError(
      `Plugin manifest must include a non-empty name: ${manifestPath}`
    );
  }

  const hooksPath = join(pluginDir, 'hooks', 'hooks.json');
  const mcpPath = join(pluginDir, '.mcp.json');

  await readOptionalJson(hooksPath, 'hook config');
  await readOptionalJson(mcpPath, 'MCP config');

  return {
    pluginDir,
    manifestPath,
    manifest: {
      ...manifest,
      name
    },
    hooksPath: (await exists(hooksPath)) ? hooksPath : undefined,
    mcpPath: (await exists(mcpPath)) ? mcpPath : undefined
  };
}

async function readOptionalJson(path: string, label: string): Promise<void> {
  if (await exists(path)) {
    await readJson(path, label);
  }
}

async function readJson(
  path: string,
  label: string
): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    throw new PluginValidationError(
      `Unable to read ${label} at ${path}: ${formatUnknownError(error)}`
    );
  });

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PluginValidationError(
        `${label} must be a JSON object: ${path}`
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PluginValidationError) {
      throw error;
    }
    throw new PluginValidationError(
      `Unable to parse ${label} at ${path}: ${formatUnknownError(error)}`
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
