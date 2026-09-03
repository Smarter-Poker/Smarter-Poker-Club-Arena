/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HAMBURGER MENU LAW (Dan 2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim:
 *  1. "WHEN YOU OPEN THE HAMBURGER MENU INSIDE THE CLUB ARENA, THE TICKER
 *     SHOULD NEVER APPEAR OVER THIS, THIS SHOULD EVER ONLY APPEAR WHILE LIVE
 *     AT A TABLE, NOT ANYWHERE ELSE."
 *  2. "THE FIRST LETTER OF EVERY WORD INSIDE THE HAMBURGER MENU MUST BE
 *     CAPITALIZED. AS WELL AS EVERY CLICKABLE PAGE AND SUBPAGE."
 *  3. "MAKE SURE EVERY PAGE AND SUBPAGE IS FULLY BUILD OUT AND ACTUALLY
 *     CONNECTED AND FUNCTIONAL."
 *
 * These pins are source-text and config-level, in the house style of
 * mttTickerAnchor.test.ts: each one is a bug that shipped or a rule that
 * would silently drift without it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  getClubArenaNavigation,
  CLUB_ARENA_SUPPORT_NAV,
} from '../../src/config/clubArenaNavigation';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TICKER = read('src/components/tournament/TournamentStartingTicker.tsx');
const MENU = read('src/components/navigation/HamburgerMenu.tsx');
const MENU_CSS = read('src/components/navigation/HamburgerMenu.module.css');
const APP = read('src/App.tsx');

describe('1. the ticker exists on tables and club lobbies, and never over the menu', () => {
  it('route gate covers /table/* and the exact club-lobby route only', () => {
    expect(TICKER).toMatch(/atLiveTable\s*=\s*location\.pathname\.startsWith\('\/table'\)/);
    expect(TICKER).toContain('const atClubLobby =');
    expect(TICKER).toContain('const onTickerRoute = atLiveTable || atClubLobby;');
    // A broad startsWith('/clubs/') would leak the ticker onto club settings,
    // cashier, players, and every other club operation page.
    expect(TICKER).not.toMatch(/startsWith\('\/clubs\/'\)\s*\|\|/);
    expect(TICKER).toMatch(/onTickerRoute\s*&&/);
  });

  it('the open drawer stacks ABOVE the ticker (z 9400) and below dialogs (9600+)', () => {
    const z = (selector: string): number => {
      const at = MENU_CSS.indexOf(`${selector} {`);
      expect(at, `${selector} must exist`).toBeGreaterThan(-1);
      const block = MENU_CSS.slice(at, MENU_CSS.indexOf('\n}', at));
      const m = block.match(/z-index:\s*(\d+)/);
      expect(m, `${selector} must declare z-index`).toBeTruthy();
      return Number(m![1]);
    };
    const backdrop = z('.backdrop');
    const drawer = z('.drawer');
    expect(backdrop).toBeGreaterThan(9400);
    expect(drawer).toBeGreaterThan(backdrop);
    expect(drawer).toBeLessThan(9600);
  });
});

describe('2. first letter of every word, on every label the drawer renders', () => {
  it('labels and descriptions pass through the house title-case transform', () => {
    // Render-path enforcement, not a convention: same reasoning as the Toast
    // layer's formatPopupText rule.
    expect(MENU).toMatch(/import \{ formatPopupText \} from '\.\.\/\.\.\/utils\/popupStyle'/);
    expect(MENU).toMatch(/const tc = formatPopupText/);
    expect(MENU).toMatch(/\{styles\.navLabel\}>\{tc\(item\.label\)\}/);
    expect(MENU).toMatch(/\{styles\.navDescription\}>\{tc\(item\.description\)\}/);
    expect(MENU).toMatch(/\{tc\(group\.label\)\}/);
    // No render site left raw.
    expect(MENU).not.toMatch(/\{styles\.navLabel\}>\{item\.label\}/);
    expect(MENU).not.toMatch(/\{styles\.navDescription\}>\{item\.description\}/);
  });
});

describe('3. every menu destination is actually connected to a route', () => {
  // Route patterns declared in App.tsx (nested under the "/" layout).
  const declared = new Set(
    [...APP.matchAll(/path="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''))
  );

  const matchesRoute = (navPath: string): boolean => {
    const clean = navPath.split('?')[0].replace(/^\//, '');
    if (clean === '') return APP.includes('path="/"');
    for (const pattern of declared) {
      const segs = pattern.split('/');
      const navSegs = clean.split('/');
      if (segs.length !== navSegs.length) continue;
      if (segs.every((s, i) => s.startsWith(':') || s === '*' || s === navSegs[i])) return true;
    }
    return false;
  };

  const groups = getClubArenaNavigation({
    clubId: 'sample-club',
    clubRole: 'owner',
    isPlatformStaff: true,
  });
  const allItems = [...groups.flatMap((g) => g.items), ...CLUB_ARENA_SUPPORT_NAV];

  for (const item of allItems) {
    // Messages is an external Smarter.Poker Messenger surface, resolved by
    // the World Hub, not by this SPA's router.
    if (item.external) continue;
    it(`"${item.label}" (${item.path}) resolves to a declared route`, () => {
      expect(matchesRoute(item.path), `${item.path} has no route in App.tsx`).toBe(true);
    });
  }
});

describe('4. Table Studio takes control from the command drawer', () => {
  it('opens the studio and closes the drawer in the same launcher action', () => {
    expect(MENU).toContain(`const handleOpenTableStudio = () => {
    setShowThemeSettings(true);
    onClose();
  };`);
    expect(MENU).toContain('onClick={handleOpenTableStudio}');
    expect(MENU).not.toContain('onClick={() => setShowThemeSettings(true)}');
  });
});
