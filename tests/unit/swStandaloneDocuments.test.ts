import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * public/sw-bus.js serves every /hub/club-arena/* navigation from ONE cache
 * entry, SHELL_KEY, and stores whatever the network returned for that
 * navigation back under the same key. That is correct for the SPA, whose
 * routes all resolve to index.html. The standalone Diamond bonus test entry
 * (dist/diamond-test.html) is a different document with different scripts:
 * routed through the shell path it boots the arena instead of the test page,
 * and once stored under SHELL_KEY it boots the test page instead of the arena
 * for every navigation until the next revalidation lands. It is excluded.
 */
const sw = readFileSync(path.join(__dirname, '..', '..', 'public', 'sw-bus.js'), 'utf8');

describe('standalone documents never pass through the shell cache', () => {
  it('names the Diamond test entry as a standalone document', () => {
    expect(sw).toContain(
      "const STANDALONE_DOCUMENTS = new Set(['/hub/club-arena/diamond-test.html']);"
    );
  });

  it('excludes standalone documents from the cache-first navigation branch', () => {
    const nav = sw.slice(sw.indexOf('const isClubArenaNav ='), sw.indexOf('if (isClubArenaNav)'));
    expect(nav).toContain('!STANDALONE_DOCUMENTS.has(url.pathname)');
    // Declared before the fetch listener that reads it.
    expect(sw.indexOf('const STANDALONE_DOCUMENTS')).toBeLessThan(
      sw.indexOf('const isClubArenaNav =')
    );
  });

  it('the test page scripts live outside the two cache-first directories', () => {
    // vite.config.ts writes the second pass under dist/diamond-test/; the SW
    // caches only /assets/ and /fonts/, so the test page is always fresh.
    const vite = readFileSync(path.join(__dirname, '..', '..', 'vite.config.ts'), 'utf8');
    expect(vite).toContain("const SCRIPT_DIR = TEST_ENTRY ? 'diamond-test' : 'assets';");
    expect(sw).toContain("url.pathname.startsWith('/hub/club-arena/assets/')");
    expect(sw).not.toContain("'/hub/club-arena/diamond-test/'");
  });
});
