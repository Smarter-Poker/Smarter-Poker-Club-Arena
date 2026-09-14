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
    // +1 again for unions/:unionId/data - the union lead's own rake page,
    // which until now could only be reached by walking into a member club.
    // +1 for clubs/:clubId/hand-review (Previous Hand phase 6): the flagged-hand
    // queue and the audited hole-card lookup, beside Reports and Disputes.
    // +1 for clubs/:clubId/advertise - the club owner's own door onto the ad
    // surfaces they buy with diamonds. It is a shell route on purpose: a page
    // that spends a club's money should carry the same header, and the same
    // way back, as every other operator page.
    // +1 for advertise (2026-09-13): the outside sponsor's door, no club in
    // the path, same page in sponsor mode. Same header, same way back.
    // +6 for the Diamond Games player pages and operator consoles.
    expect(allPaths).toHaveLength(141); // +2 management consoles, +1 financial decision harness, +1 sponsor advertise
    expect(allPaths).toContain('clubs/:clubId/create-table/:gameType');
    expect(allPaths).toContain('messages/clubs/:conversationId');
    expect(allPaths).toContain('*');
  });

  it('puts every shell route under AppLayout', () => {
    expect(shellPaths).toHaveLength(132); // +2: club and union table-management consoles, +1: union data, +1: hand review, +1: club advertise, +1: sponsor advertise, +6: diamond games
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

    expect(applicable.size).toBe(133); // +2: club and union table-management consoles, +1: union data, +1: hand review, +1: club advertise, +1: sponsor advertise, +6: diamond games
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
