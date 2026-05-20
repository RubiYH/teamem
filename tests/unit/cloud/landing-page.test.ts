import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pageSource = readFileSync(
  join(process.cwd(), 'apps/web/app/[locale]/page.tsx'),
  'utf8'
);
const globalsSource = readFileSync(
  join(process.cwd(), 'apps/web/app/globals.css'),
  'utf8'
);
const messagesSource = readFileSync(
  join(process.cwd(), 'apps/web/messages/en.json'),
  'utf8'
);

describe('Teamem Cloud landing page', () => {
  it('renders README-derived positioning and current Claude Code capabilities', () => {
    expect(messagesSource).toContain(
      'Teamem is team memory for humans and their coding agents.'
    );
    expect(messagesSource).toContain('Claude Code plugin');
    expect(messagesSource).toContain('Shared work context');
    expect(messagesSource).toContain('Scope coordination');
    expect(messagesSource).toContain('Durable decisions');
    expect(messagesSource).toContain('Safer conflict avoidance');
  });

  it('keeps Teamem Cloud primary while preserving self-hosting as secondary', () => {
    expect(messagesSource).toContain('Managed-server path');
    expect(messagesSource).toContain('Self-hosting remains available');
    expect(pageSource).toContain(
      'const dashboardHref = `/${locale}/dashboard`;'
    );
    expect(pageSource).toContain('href={dashboardHref}');
    expect(messagesSource).toContain('Start with Teamem Cloud');
    expect(pageSource).toContain('href="https://github.com/RubiYH/teamem"');
    expect(messagesSource).toContain('Self-host instead');
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
