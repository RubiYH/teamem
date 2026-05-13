import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('uses defaults when env is missing', () => {
    const cfg = loadConfig({});
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.repoId).toBe('teamem-poc');
  });

  it('respects explicit env vars', () => {
    const cfg = loadConfig({ TEAMEM_REPO_ID: 'demo' });
    expect(cfg.repoId).toBe('demo');
  });
});
