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

  it('the app root reads both inputs', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('useInTabLobbyActive()');
    expect(app).toContain('shouldShowClubFooterFor(location.pathname, inTabLobbyActive)');
  });

  it('the container publishes only the tab on screen, and clears on unmount', () => {
    const page = read('src/pages/MultiTablePage.tsx');
    expect(page).toContain('publishInTabLobbyActive(!hidden && !!cur && isLobbyTab(cur))');
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
