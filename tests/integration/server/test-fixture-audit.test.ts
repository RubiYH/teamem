/**
 * AC17 — CI guard: every test file that instantiates the server via
 * createRouter/createServer must either pass jwtSecret or have "dev-mode"
 * in its filename.
 *
 * A missing jwtSecret silently exercises the dev-mode bypass branch, which
 * means tests pass even when the production auth gate is broken.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_ROOT = join(process.cwd(), 'tests');
const DEV_MODE_PATTERN = /dev-mode/i;

// Patterns that indicate server instantiation via createRouter
const SERVER_INSTANTIATION_RE = /createRouter\s*\(/g;

// Pattern that indicates jwtSecret is passed in the same file
// Accepts: createRouter(tools, db, SECRET), createRouter(tools, db, jwtSecret), etc.
// We check: any call to createRouter where arg3 is not undefined/empty
// Strategy: check if the file contains createRouter AND a non-undefined 3rd argument.
// We do this by looking for createRouter( with at least 3 comma-separated args before ).
const ROUTER_WITH_SECRET_RE =
  /createRouter\s*\(\s*[^,]+,\s*[^,]+,\s*(?!undefined\b|'\s*'\s*|"\s*"\s*)`?[^,)]{3,}/;

function walkTests(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkTests(full));
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results;
}

describe('AC17 — test fixture audit: all server fixtures have jwtSecret or are tagged dev-mode', () => {
  it('all server-fixture tests have jwtSecret or are tagged dev-mode', () => {
    const allTests = walkTests(TESTS_ROOT);
    const violations: string[] = [];

    for (const filePath of allTests) {
      const content = readFileSync(filePath, 'utf-8');

      // Skip if no server instantiation
      if (!SERVER_INSTANTIATION_RE.test(content)) continue;
      // Reset lastIndex after test
      SERVER_INSTANTIATION_RE.lastIndex = 0;

      // If filename has "dev-mode", it's an intentional dev-mode test — allowed
      const relPath = filePath.replace(TESTS_ROOT + '/', '');
      if (DEV_MODE_PATTERN.test(relPath)) continue;

      // Check that every createRouter call has a real 3rd argument (jwtSecret)
      if (!ROUTER_WITH_SECRET_RE.test(content)) {
        violations.push(relPath);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `The following test files instantiate createRouter without jwtSecret and are not tagged "dev-mode":\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          `\n\nFix: pass a test secret (e.g. 'test-secret-32bytes-padded-xxxxx') as the 3rd arg,` +
          ` or rename the file to include "dev-mode" if the test intentionally exercises unauthenticated mode.`
      );
    }

    expect(violations).toHaveLength(0);
  });
});
