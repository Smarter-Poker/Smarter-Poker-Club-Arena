import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  shouldShowClubFooter,
  shouldShowClubFooterFor,
  shouldShowDiamondFooterFor,
} from '../../src/components/club/clubFooterVisibility';
import {
  DIAMOND_PLAYER_SEGMENTS,
  isDiamondArenaOperatorPath,
  isDiamondArenaPlayerPath,
} from '../../src/components/arena/diamondArenaRoutes';
import { DIAMOND_FOOTER_DOORS } from '../../src/components/arena/DiamondBottomNav';

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

/**
 * A DIAMOND PLAYER CAN FIND THEIR WAY (2026-09-19).
 *
 * The chip footer stays off every Diamond Arena route, and the Diamond footer
 * stands on exactly the player routes: the two answers never overlap, and the
 * doors the Diamond footer offers are the doors the boundary opens. Operator,
 * finance, agent and union routes under the arena get neither bar, because
 * they get the safe shell.
 */
describe('the Diamond Arena footer route audit', () => {
  const ARENA_KEYS = ['diamond-arena', '002c2d27-9584-4e52-835a-bb2be148fc81'];
  const PLAYER_ROUTES = [
    '',
    '/lobby',
    '/tournaments',
    '/messages',
    '/members',
    '/members/user-1',
    '/members/user-1/statistics',
  ];
  /* Every declared route under a club that is not a player route, read off
     App.tsx so a route added tomorrow is classified today. */
  const clubRoutes = routePaths
    .filter((path) => path.startsWith('clubs/:clubId'))
    .map((path) => path.slice('clubs/:clubId'.length).replace(':userId', 'user-1'));
  const operatorRoutes = clubRoutes.filter((rest) => !PLAYER_ROUTES.includes(rest));

  it('classifies every declared club route, and the operator side is the long side', () => {
    expect(clubRoutes.length).toBeGreaterThan(40);
    expect(operatorRoutes.length).toBeGreaterThan(30);
    for (const rest of clubRoutes) {
      const path = `/clubs/diamond-arena${rest}`;
      expect(
        isDiamondArenaPlayerPath(path) !== isDiamondArenaOperatorPath(path),
        `${path} must be exactly one of player or operator`
      ).toBe(true);
    }
  });

  it.each(ARENA_KEYS)(
    'under %s, a player route gets the Diamond footer and never the chip one',
    (key) => {
      for (const rest of PLAYER_ROUTES) {
        const path = `/clubs/${key}${rest}`;
        expect(isDiamondArenaPlayerPath(path), path).toBe(true);
        expect(shouldShowDiamondFooterFor(path, '', false), path).toBe(true);
        expect(shouldShowClubFooter(path), path).toBe(false);
        expect(shouldShowClubFooterFor(path, false), path).toBe(false);
      }
    }
  );

  it.each(ARENA_KEYS)('under %s, every operator route gets no footer at all', (key) => {
    for (const rest of operatorRoutes) {
      const path = `/clubs/${key}${rest}`;
      expect(isDiamondArenaPlayerPath(path), path).toBe(false);
      expect(shouldShowDiamondFooterFor(path, '', false), path).toBe(false);
      expect(shouldShowClubFooter(path), path).toBe(false);
    }
    for (const rest of ['/agents', '/finance', '/operations', '/control', '/cashier', '/wheel']) {
      expect(operatorRoutes, `${rest} is no longer a declared operator route`).toContain(rest);
    }
  });

  it('never opens a chip club route to the Diamond classifier', () => {
    for (const rest of [...PLAYER_ROUTES, ...operatorRoutes]) {
      const path = `/clubs/shark-club${rest}`;
      expect(isDiamondArenaPlayerPath(path)).toBe(false);
      expect(isDiamondArenaOperatorPath(path)).toBe(false);
      expect(shouldShowDiamondFooterFor(path, '', false)).toBe(false);
    }
  });

  it('follows the two global doors only while they are scoped to the arena', () => {
    expect(shouldShowDiamondFooterFor('/hand-history', '?arena=diamond', false)).toBe(true);
    expect(shouldShowDiamondFooterFor('/hand-history', '', false)).toBe(false);
    expect(shouldShowDiamondFooterFor('/hand-history', '?arena=chips', false)).toBe(false);
    expect(shouldShowDiamondFooterFor('/stats', '?club=diamond-arena', false)).toBe(true);
    expect(shouldShowDiamondFooterFor('/stats', '?club=shark-club', false)).toBe(false);
    expect(shouldShowDiamondFooterFor('/stats', '', false)).toBe(false);
    // The chip rules for those paths are what they always were.
    expect(shouldShowClubFooter('/hand-history')).toBe(true);
    expect(shouldShowClubFooter('/stats')).toBe(true);
  });

  /**
   * THE OVERLAP IS REAL, AND IT IS STATED HERE (2026-09-20).
   *
   * Under the arena the two rules cannot both be true: every path the Diamond
   * bar claims there is a path the chip rules already refuse. On the two
   * ESTATE pages it follows the player onto they CAN, because
   * `shouldShowClubFooter` has always returned true for `/hand-history` and
   * `/stats` and it never sees a query string. So the exclusivity is not a
   * property of these functions, it is a decision App.tsx makes, and a comment
   * claiming otherwise would be the "answered when it could not tell" shape
   * CLAUDE.md 10.86 rule 1 is about. This test names the overlap so it cannot
   * be believed away, and the law test holds the guard that resolves it.
   */
  it('states where the two rules overlap, and where the guard resolves it', () => {
    const bothTrue: string[] = [];
    for (const [path, search] of [
      ['/hand-history', '?arena=diamond'],
      ['/stats', '?club=diamond-arena'],
    ] as const) {
      if (shouldShowDiamondFooterFor(path, search, false) && shouldShowClubFooterFor(path, false)) {
        bothTrue.push(`${path}${search}`);
      }
    }
    expect(
      bothTrue,
      'the two global doors are the overlap App.tsx resolves with !diamondFooterVisible. If this ' +
        'list is empty the chip rule started refusing them on its own, and the guard in App.tsx ' +
        'became dead code that should be deleted rather than left reading as the reason.'
    ).toEqual(['/hand-history?arena=diamond', '/stats?club=diamond-arena']);

    // Everywhere the Diamond bar stands under the arena, the chip rules refuse
    // on their own and the guard is not load-bearing.
    for (const rest of PLAYER_ROUTES) {
      const path = `/clubs/diamond-arena${rest}`;
      expect(shouldShowDiamondFooterFor(path, '', false), path).toBe(true);
      expect(shouldShowClubFooterFor(path, false), path).toBe(false);
    }
  });

  it('offers exactly the player doors, each of which the boundary opens or the estate serves', () => {
    const segments = [...DIAMOND_PLAYER_SEGMENTS];
    expect(segments).toEqual(['lobby', 'tournaments', 'messages', 'members']);
    for (const door of DIAMOND_FOOTER_DOORS) {
      if (door.to === null) continue; // the wallet opens in place
      const [pathname, search = ''] = door.to.split('?');
      const scoped =
        isDiamondArenaPlayerPath(pathname) ||
        shouldShowDiamondFooterFor(pathname, `?${search}`, false);
      expect(scoped, `${door.label} -> ${door.to} is not a Diamond player door`).toBe(true);
      expect(door.to).not.toMatch(/agent|union|finance|operation|cashier|wheel|control|settlement/);
    }
  });
});
