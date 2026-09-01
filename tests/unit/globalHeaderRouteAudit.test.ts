/**
 * Global-header route audit.
 *
 * This is intentionally manifest-based: representative screenshots cannot
 * prove that a nested or legacy route inherits the shared shell. Every literal
 * React Router path in App.tsx is classified here, including dynamic paths and
 * redirects, so a new route cannot silently land outside the header system.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const APP = read('../../src/App.tsx');
const APP_LAYOUT = read('../../src/components/layouts/AppLayout.tsx');
const APP_LAYOUT_CSS = read('../../src/components/layouts/AppLayout.module.css');
const HOME = read('../../src/pages/HomePage.tsx');

const routePaths = (source: string) =>
  [...source.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);

const shellStart = APP.indexOf('<Route element={<AppLayout />}>');
const shellEnd = APP.indexOf('</Routes>', shellStart);
const shellPaths = routePaths(APP.slice(shellStart, shellEnd));
const allPaths = routePaths(APP);

const INTENTIONAL_EXCEPTIONS = [
  '/auth',
  '/share/hand/:handId',
  '/replay',
  '/sim',
  '/dev/footer',
  '/dev/customization',
  '/dev/financial-decisions',
  'table/:tableId',
] as const;
const intentionalExceptions = new Set<string>(INTENTIONAL_EXCEPTIONS);

describe('the complete route manifest inherits one global header', () => {
  it('discovers every current route, including dynamic and legacy redirect paths', () => {
    // 127 since phase 7 added clubs/:clubId/anti-cheat, the club-scoped door
    // onto AntiCheatPage that the operations rail links.
    expect(allPaths).toHaveLength(129); // +1: development-only financial decision harness
    expect(allPaths).toContain('clubs/:clubId/create-table/:gameType');
    expect(allPaths).toContain('messages/clubs/:conversationId');
    expect(allPaths).toContain('*');
  });

  it('puts every shell route under AppLayout', () => {
    expect(shellPaths).toHaveLength(120); // +1: financial-incidents (zero-drift drift dashboard)
    expect(APP_LAYOUT).toContain('{showGlobalHeader && <GlobalHeader />}');
  });

  it('gives the standalone authenticated lobby the same shared component', () => {
    expect(HOME).toContain('<GlobalHeader />');
  });

  it('leaves only explicit public or immersive-table exceptions outside the header', () => {
    const applicable = new Set(['/', ...shellPaths]);
    const unclassified = allPaths.filter(
      (path) => !applicable.has(path) && !intentionalExceptions.has(path)
    );

    expect(applicable.size).toBe(121); // +1: financial-incidents (zero-drift drift dashboard)
    expect(unclassified).toEqual([]);
  });

  it("has removed AppLayout's unreachable legacy header CSS", () => {
    for (const selector of [
      '.header {',
      '.headerContent {',
      '.mobileMenuToggle {',
      '.mobileNav {',
    ]) {
      expect(APP_LAYOUT_CSS).not.toContain(selector);
    }
  });
});
