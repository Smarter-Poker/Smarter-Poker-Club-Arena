/**
 * THE TOURNAMENT INFO BOX IS A COLLAPSIBLE DOCK UNDER THE ACTION BAR, AND THE
 * UPPER-RIGHT CORNER HOLDS THE LOBBY BUTTON (Dan 2026-10-04)
 *
 * "THE TOURNAMENT INFO BOX MUST NEVER BE DISPLAYED OVER THE TOP LIKE IT
 *  CURRENTLY IS. IT SHOULD BE A COLLAPSABLE BOX, UNDER THE 'ACTION BAR' ON THE
 *  BOTTOM OF THE PAGE (UNDER FOLD CHECK BET). IN THE UPPER RIGHT HAND CORNER
 *  WHERE '36 LEFT' IS SHOULD BE THE LOBBY BUTTON THAT OPENS UP TO THE
 *  TOURNAMENT LOBBY PAGE."
 *
 * From 2026-08-25 the level / blinds / countdown bar sat in the felt's
 * upper-right HUD corner, scaled to 0.74 on a phone and still lying across
 * the top seats. This law keeps it out of that corner for good, and keeps the
 * older one it could easily break: the felt never changes size (2026-08-28).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const PAGE = strip(read('src/pages/TablePage.tsx'));
const HUD = strip(read('src/components/tournament/TournamentHUD.tsx'));
const DOCK_CSS = strip(read('src/components/tournament/TournamentHUD.css'));
const HUD_LAYER_CSS = strip(read('src/components/table/TableHUD.css'));

const rule = (css: string, selector: string) => {
  const at = css.indexOf(selector);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

describe('the box is not on the felt', () => {
  it('the upper-right corner holds no TournamentHUD', () => {
    const corner = PAGE.indexOf('upperRight={');
    const next = PAGE.indexOf('bottomLeft={', corner);
    expect(corner).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(corner);
    expect(PAGE.slice(corner, next)).not.toMatch(/<TournamentHUD/);
  });

  it('it is mounted once, directly above the action bar wrapper, told when it is off screen', () => {
    expect(PAGE.match(/<TournamentHUD/g)).toHaveLength(1);
    const dock = PAGE.indexOf('<TournamentHUD');
    const wrapper = PAGE.indexOf('<div className="action-panel-wrapper">');
    expect(wrapper).toBeGreaterThan(dock);
    expect(wrapper - dock).toBeLessThan(600);
    const mount = PAGE.slice(dock, PAGE.indexOf('/>', dock));
    expect(mount).toMatch(/hidden=\{!isVisible\}/);
    expect(mount).toMatch(/collapsed=\{tournamentDockCollapsed\}/);
    expect(mount).toMatch(/onToggleCollapsed=\{toggleTournamentDock\}/);
  });

  it('the dock is pinned to the foot of the viewport, above the home indicator', () => {
    const dock = rule(DOCK_CSS, '.tournament-dock {');
    expect(dock).toMatch(/position:\s*fixed/);
    expect(dock).toMatch(/bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
    expect(dock).toMatch(/left:\s*0/);
    expect(dock).toMatch(/right:\s*0/);
    expect(dock).not.toMatch(/(^|[\s;{])top:/);
    // The scale rules that kept the old bar off the top seats went with it.
    expect(HUD_LAYER_CSS).not.toMatch(/tournament-hud-bar/);
  });

  it('the action bar and the pre-action bar stand on top of it', () => {
    expect(DOCK_CSS).toMatch(
      /\.table-page--tournament \.action-panel,\s*\.table-page--tournament \.pre-action-bar,\s*\.table-page--tournament \.action-panel-wrapper \{\s*padding-bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ var\(--sp-tdock-now\)\) !important;/
    );
  });
});

describe('it is collapsible, and collapsing it never resizes the felt', () => {
  it('the page owns the flag, remembers it, and publishes it on its own root', () => {
    expect(PAGE).toMatch(
      /const \[tournamentDockCollapsed, setTournamentDockCollapsed\] = useState/
    );
    expect(PAGE).toMatch(/localStorage\.setItem\(TOURNAMENT_DOCK_COLLAPSED_KEY/);
    expect(PAGE).toMatch(
      /data-tdock=\{\s*tableState\.isTournament && tableState\.tournamentId\s*\? tournamentDockCollapsed\s*\? 'collapsed'\s*: 'expanded'\s*: undefined\s*\}/
    );
  });

  it('the felt reserve is a constant: only --sp-tdock-now follows the toggle', () => {
    const base = rule(DOCK_CSS, '.table-page--tournament {');
    expect(base).toMatch(
      /--sp-tdock-reserve:\s*calc\(var\(--sp-tdock-line-h\) \+ var\(--sp-tdock-row-h\)\)/
    );
    expect(base).toMatch(
      /--sp-action-reserve:\s*calc\(\s*var\(--sp-bottom-row-h, 96px\) \+ env\(safe-area-inset-bottom, 0px\) \+ var\(--sp-tdock-reserve\)\s*\)/
    );
    const collapsed = rule(DOCK_CSS, ".table-page--tournament[data-tdock='collapsed'] {");
    expect(collapsed).toMatch(/--sp-tdock-now:/);
    expect(collapsed).not.toMatch(/--sp-tdock-reserve|--sp-action-reserve/);
    // The reserve hangs on the KIND of table, never on a state attribute
    // (tests/unit/feltReserveIsStatic.test.ts refuses that for every sheet).
    expect(PAGE).toMatch(/tableState\.isTournament \? ' table-page--tournament' : ''/);
    // And nothing else in the sheet redeclares the reserve for a toggle state.
    expect(DOCK_CSS.match(/--sp-action-reserve:/g)).toHaveLength(1);
    expect(DOCK_CSS.match(/--sp-tdock-reserve:/g)).toHaveLength(1);
  });

  it('tapping the dock toggles it; collapsed is one line, open is every figure', () => {
    expect(HUD).toMatch(/data-collapsed=\{collapsed \? 'true' : 'false'\}/);
    expect(HUD).toMatch(/onClick=\{toggle\}/);
    expect(HUD).toMatch(/aria-expanded=\{toggle \? !collapsed : undefined\}/);
    expect(HUD).toMatch(/\{!collapsed && \(\s*<div className="tournament-dock__row">/);
    for (const label of ["'Level'", 'Blinds', 'Rank', 'Left', "? 'Prize' : 'Avg'"]) {
      expect(HUD, label).toContain(label);
    }
    // The collapsed line carries the three figures a player glances at.
    expect(HUD).toMatch(/const statusLine = collapsed\s*\? \[\s*levelText,\s*blindsText/);
    expect(HUD).toMatch(/clockText,/);
  });
});

describe('the corner holds the lobby button', () => {
  it('a 44px button with the LOBBY plate that opens the tournament lobby', () => {
    const corner = PAGE.slice(PAGE.indexOf('upperRight={'), PAGE.indexOf('bottomLeft={'));
    expect(corner).toMatch(/className="tournament-lobby-corner-btn"/);
    expect(corner).toMatch(/setShowTournamentLobby\(true\)/);
    expect(corner).toMatch(/aria-label="Open Tournament Lobby"/);
    expect(corner).toMatch(/src=\{lobbyButtonArt\}/);
    expect(PAGE).toMatch(/import lobbyButtonArt from '\.\.\/assets\/lobby-button\.webp';/);
    const btn = rule(DOCK_CSS, '.tournament-lobby-corner-btn {');
    expect(btn).toMatch(/width:\s*44px/);
    expect(btn).toMatch(/height:\s*44px/);
  });
});
