import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldShowClubFooter } from '../../src/components/club/clubFooterVisibility';

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const routePaths = [...appSource.matchAll(/\bpath="([^"]+)"/g)].map((match) => match[1]);
const absolute = (path: string) => (path.startsWith('/') ? path : `/${path}`);

describe('Club Arena global footer route audit', () => {
  it('inventories every declared route and defaults production surfaces to the footer', () => {
    expect(routePaths.length).toBeGreaterThan(115);
    expect(
      routePaths.filter((path) => shouldShowClubFooter(absolute(path))).length
    ).toBeGreaterThan(105);
  });

  it.each([
    '/clubs/:clubId',
    '/clubs/:clubId/lobby',
    '/clubs/:clubId/tournaments',
    '/tournaments',
    '/tournaments/:tournamentId',
    '/waitlist',
    '/clubs/:clubId/cashier',
    '/players',
    '/marketplace',
    '/settings',
    '/stats',
    '/data',
    '/clubs/:clubId/operations',
    '/clubs/:clubId/reports',
    '/clubs/:clubId/tables/:tableId/bomb-settings',
  ])('shows the footer on %s', (path) => {
    expect(shouldShowClubFooter(path)).toBe(true);
  });

  it.each([
    '/',
    '',
    '/clubs/diamond-arena',
    '/clubs/diamond-arena/finance',
    '/clubs/002c2d27-9584-4e52-835a-bb2be148fc81/agents',
    '/auth',
    '/share/hand/:handId',
    '/replay',
    '/sim',
    '/table/:tableId',
    '/health',
    '/legal/tos',
    '/legal/promotions',
    '/legal/fair-gaming',
    '/legal/privacy',
  ])('keeps the public or immersive surface %s footerless', (path) => {
    expect(shouldShowClubFooter(path)).toBe(false);
  });
});
