import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pageSource = readFileSync(
  join(process.cwd(), 'apps/web/app/page.tsx'),
  'utf8'
);
const globalsSource = readFileSync(
  join(process.cwd(), 'apps/web/app/globals.css'),
  'utf8'
);

describe('Teamem Cloud landing page', () => {
  it('renders README-derived positioning and current Claude Code capabilities', () => {
    expect(pageSource).toContain(
      'Teamem is team memory for humans and their coding agents.'
    );
    expect(pageSource).toContain('Claude Code plugin');
    expect(pageSource).toContain('Shared work context');
    expect(pageSource).toContain('Scope coordination');
    expect(pageSource).toContain('Durable decisions');
    expect(pageSource).toContain('Safer conflict avoidance');
  });

  it('keeps Teamem Cloud primary while preserving self-hosting as secondary', () => {
    expect(pageSource).toContain('Managed-server path');
    expect(pageSource).toContain('Self-hosting remains available');
    expect(pageSource).toContain('href="/dashboard"');
    expect(pageSource).toContain('Start with Teamem Cloud');
    expect(pageSource).toContain('href="https://github.com/RubiYH/teamem"');
    expect(pageSource).toContain('Self-host instead');
  });

  it('has a responsive first viewport and avoids flashy marketing imagery', () => {
    expect(pageSource).toContain('min-h-screen');
    expect(pageSource).toContain('sm:px-8');
    expect(pageSource).toContain('lg:grid-cols-[1.05fr_0.95fr]');
    expect(pageSource).toContain('sm:grid-cols-2');
    expect(pageSource).toContain('lg:grid-cols-4');
    expect(pageSource.toLowerCase()).not.toContain('ai-powered');
    expect(pageSource).not.toContain('<img');
    expect(pageSource).not.toContain('<svg');
    expect(globalsSource).toContain('--background: 31 24% 7%');
    expect(globalsSource).not.toContain('linear-gradient');
  });
});
