import { describe, expect, it } from 'bun:test';
import {
  rewriteLocaleSensitiveSearch,
  sanitizeReturnTarget
} from './return-target';

describe('sanitizeReturnTarget', () => {
  it('rewrites supported locale-prefixed relative paths to the active locale', () => {
    expect(sanitizeReturnTarget('/en/dashboard', 'ko')).toBe('/ko/dashboard');
    expect(sanitizeReturnTarget('/ko/dashboard?created=1#top', 'en')).toBe(
      '/en/dashboard?created=1#top'
    );
  });

  it('prefixes unlocalized relative paths with the active locale', () => {
    expect(sanitizeReturnTarget('/dashboard?create=quota', 'ko')).toBe(
      '/ko/dashboard?create=quota'
    );
  });

  it('rejects open redirect shapes and unsupported locale prefixes', () => {
    expect(sanitizeReturnTarget('https://example.com/en/dashboard', 'ko')).toBe(
      '/ko/dashboard'
    );
    expect(sanitizeReturnTarget('//example.com/en/dashboard', 'ko')).toBe(
      '/ko/dashboard'
    );
    expect(sanitizeReturnTarget('/fr/dashboard', 'ko')).toBe('/ko/dashboard');
  });
});

describe('rewriteLocaleSensitiveSearch', () => {
  it('rewrites only the locale-sensitive from parameter', () => {
    const search = rewriteLocaleSensitiveSearch(
      'from=%2Fen%2Fdashboard&utm=keep',
      'ko'
    );

    expect(search).toBe('from=%2Fko%2Fdashboard&utm=keep');
  });
});
