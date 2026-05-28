import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf-8');
}

describe('Sprint plugin docs contract', () => {
  it('documents the shipped Sprint command verbs and discussion routing markers', () => {
    const command = read('plugin/commands/teamem-sprint.md');
    const pluginReadme = read('plugin/README.md');
    const publicPluginDoc = read('docs/integrations/claude-code-plugin.md');
    const operatorPluginDoc = read('.docs/integrations/claude-code-plugin.md');

    for (const verb of [
      'create',
      'join',
      'leave',
      'list',
      'history',
      'archive',
      'reopen'
    ]) {
      expect(command).toContain(`\`${verb}`);
      expect(pluginReadme).toContain(`/teamem-sprint ${verb}`);
      expect(publicPluginDoc).toContain(`/teamem-sprint ${verb}`);
      expect(operatorPluginDoc).toContain(`/teamem-sprint ${verb}`);
    }

    for (const doc of [pluginReadme, publicPluginDoc, operatorPluginDoc]) {
      const normalizedDoc = doc.replace(/\s+/g, ' ');

      expect(doc).toContain('Space mode');
      expect(doc).toContain('Sprint mode');
      expect(doc).toContain('privacy boundary');
      expect(doc).toContain('direct');
      expect(doc).toContain('`*`');
      expect(doc).toContain('`**`');
      expect(normalizedDoc).toContain('not an all-Sprints feed');
      expect(doc).toContain('non-private');
    }

    expect(pluginReadme).not.toContain('/teamem-sprint use');
    expect(pluginReadme).not.toContain('/teamem-sprint off');
    expect(publicPluginDoc).not.toContain('/teamem-sprint use');
    expect(publicPluginDoc).not.toContain('/teamem-sprint off');
    expect(operatorPluginDoc).not.toContain('/teamem-sprint use');
    expect(operatorPluginDoc).not.toContain('/teamem-sprint off');
  });
});
