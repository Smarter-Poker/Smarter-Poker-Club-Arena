/**
 * THE LOBBY ALWAYS HAS ITS FOOTER (Dan 2026-09-04, binding)
 *
 * "WHEN YOU ARE ON A LIVE TABLE AND HIT THE + BUTTON AND GO TO THE LOBBY, THE
 * FOOTER MENU DOESN'T DISPLAY, AND IT NEEDS TO BE THERE ANYTIME YOU ARE IN
 * THE LOBBY, REGARDLESS OF HOW YOU GOT THERE OR WHICH ROUTE YOU TOOK."
 *
 * The "+" lobby is a tab inside the multi-table container on /table/<id>, and
 * the one global footer is gated on the pathname, so the lobby a player
 * reached from a game had no footer while the same lobby reached by URL did.
 * This law pins the second input: the container publishes "the tab on screen
 * is a lobby", and the app-root gate honours it. It also pins the other half
 * of the bargain - the footer must never float over a live felt.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  shouldShowClubFooter,
  shouldShowClubFooterFor,
  shouldShowClubFooterForVisitor,
  shouldShowDiamondFooterFor,
} from '../src/components/club/clubFooterVisibility';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('the lobby always has its footer', () => {
  it('a lobby tab on a /table route gets the footer; a live table does not', () => {
    expect(shouldShowClubFooter('/table/abc')).toBe(false);
    expect(shouldShowClubFooterFor('/table/abc', false)).toBe(false);
    expect(shouldShowClubFooterFor('/table/abc', true)).toBe(true);
    // The in-tab flag never hides a footer a route already owes.
    expect(shouldShowClubFooterFor('/clubs/club-jaqk', false)).toBe(true);
  });

  it('a signed-out visitor on a public page is not shown the authenticated footer; a signed-in player is', () => {
    for (const path of ['/help', '/help/', '/legal/tos', '/legal/privacy']) {
      expect(shouldShowClubFooterForVisitor(path, false, undefined, false)).toBe(false);
    }
    expect(shouldShowClubFooterForVisitor('/help', false, undefined, true)).toBe(true);
    expect(shouldShowClubFooterForVisitor('/legal/tos', false, undefined, true)).toBe(false);
    // A private route keeps its footer whatever the store says: AuthGuard,
    // not the footer, is what turns a signed-out visitor away.
    expect(shouldShowClubFooterForVisitor('/clubs/club-jaqk', false, undefined, false)).toBe(true);
    // The lobby tab on a table wins regardless.
    expect(shouldShowClubFooterForVisitor('/table/abc', true, undefined, false)).toBe(true);
  });

  it('keeps chip navigation off every Diamond Arena route', () => {
    expect(shouldShowClubFooter('/clubs/diamond-arena')).toBe(false);
    expect(shouldShowClubFooter('/clubs/diamond-arena/finance')).toBe(false);
    expect(shouldShowClubFooter('/clubs/002c2d27-9584-4e52-835a-bb2be148fc81/agents')).toBe(false);
    expect(shouldShowClubFooterFor('/clubs/diamond-arena', true)).toBe(false);
    // The player routes too: Players, Messages and Tournaments under the
    // arena are Diamond surfaces and the chip bar has no business there.
    for (const rest of ['/members', '/members/u/statistics', '/messages', '/tournaments']) {
      expect(shouldShowClubFooter(`/clubs/diamond-arena${rest}`)).toBe(false);
      expect(shouldShowClubFooterFor(`/clubs/diamond-arena${rest}`, false)).toBe(false);
    }
  });

  /* A DIAMOND PLAYER CAN FIND THEIR WAY (2026-09-19). The lobby always has
     ITS footer, and the Diamond lobby's footer is the Diamond one: on the
     arena's player routes, and on the lobby opened as a tab from a table,
     the same two inputs answer the Diamond bar instead of the chip bar.
     Never both, never on an operator route. */
  it('the Diamond lobby always has the Diamond footer, and never the chip one', () => {
    for (const path of [
      '/clubs/diamond-arena',
      '/clubs/diamond-arena/lobby',
      '/clubs/002c2d27-9584-4e52-835a-bb2be148fc81/members',
      '/clubs/diamond-arena/messages',
      '/clubs/diamond-arena/tournaments',
    ]) {
      expect(shouldShowDiamondFooterFor(path, '', false), path).toBe(true);
      expect(shouldShowClubFooterFor(path, false), path).toBe(false);
    }
    // The "+" lobby tab on a live table follows the club in the tab.
    expect(shouldShowDiamondFooterFor('/table/abc', '', true, 'diamond-arena')).toBe(true);
    expect(shouldShowClubFooterFor('/table/abc', true, 'diamond-arena')).toBe(false);
    expect(shouldShowDiamondFooterFor('/table/abc', '', true, 'shark-club')).toBe(false);
    expect(shouldShowClubFooterFor('/table/abc', true, 'shark-club')).toBe(true);
    expect(shouldShowDiamondFooterFor('/table/abc', '', true, null)).toBe(false);
    // A live felt with no lobby tab: neither bar.
    expect(shouldShowDiamondFooterFor('/table/abc', '', false)).toBe(false);
    // An operator route under the arena: neither bar, it is the safe shell.
    for (const rest of ['/finance', '/agents', '/operations', '/cashier', '/wheel']) {
      expect(shouldShowDiamondFooterFor(`/clubs/diamond-arena${rest}`, '', false)).toBe(false);
      expect(shouldShowClubFooterFor(`/clubs/diamond-arena${rest}`, false)).toBe(false);
    }
  });

  it('the app root reads both inputs', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('useInTabLobbyActive()');
    // Discoverability phase 5 (2026-09-17): the visitor-aware wrapper reads the
    // same two inputs plus whether anyone is signed in, and defers to
    // shouldShowClubFooterFor for every signed-in or lobby case.
    expect(app).toMatch(
      /shouldShowClubFooterForVisitor\(\s*location\.pathname,\s*inTabLobbyActive,\s*inTabLobbyClubId,\s*footerVisitorSignedIn\s*\)/
    );
    expect(app).toContain('useUserStore((state) => state.isAuthenticated)');
    // And the Diamond bar reads the same two inputs plus the search, so the
    // Hand History and Stats doors keep their bar while scoped to the arena.
    expect(app).toMatch(
      /const diamondFooterVisible = shouldShowDiamondFooterFor\(\s*location\.pathname,\s*location\.search,\s*inTabLobbyActive,\s*inTabLobbyClubId\s*\)/
    );
    expect(app.match(/<DiamondBottomNav/g)).toHaveLength(1);
    /* ONE BOTTOM EDGE, ONE BAR. `/hand-history` and `/stats` are estate pages
       the chip rules return true for and cannot change their mind about - they
       never see a query string - so on those two the Diamond bar and the chip
       bar are both owed. This guard is the only thing that stops two fixed
       bars stacking there, and it is pinned because the module's own rules
       cannot express it. */
    expect(
      app,
      'the chip footer is no longer suppressed where the Diamond bar stands. On ' +
        '/hand-history?arena=diamond and /stats?club=diamond-arena both rules are true, so ' +
        'without this guard the player gets two fixed bars on one bottom edge.'
    ).toMatch(/\{!diamondFooterVisible &&\s*shouldShowClubFooterForVisitor\(/);
  });

  it('the container publishes only the tab on screen, and clears on unmount', () => {
    const page = read('src/pages/MultiTablePage.tsx');
    expect(page).toContain(
      'publishInTabLobbyActive(!hidden && !!cur && isLobbyTab(cur), selectedClub)'
    );
    expect(page).toContain('useEffect(() => () => publishInTabLobbyActive(false), [])');
  });

  it('the hook follows the container, and the footer follows the hook', async () => {
    const { renderHook, act } = await import('@testing-library/react');
    const mod = await import('../src/components/club/inTabLobbySurface');
    mod.resetInTabLobbyActiveForTests();
    const hook = renderHook(() => mod.useInTabLobbyActive());
    expect(hook.result.current).toBe(false);
    expect(shouldShowClubFooterFor('/table/abc', hook.result.current)).toBe(false);
    act(() => mod.publishInTabLobbyActive(true));
    expect(hook.result.current).toBe(true);
    expect(shouldShowClubFooterFor('/table/abc', hook.result.current)).toBe(true);
    // The lobby tab slides behind a live table: the footer leaves with it.
    act(() => mod.publishInTabLobbyActive(false));
    expect(hook.result.current).toBe(false);
    hook.unmount();
    mod.resetInTabLobbyActiveForTests();
  });
});
