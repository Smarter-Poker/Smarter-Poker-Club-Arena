/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MOBILE LOBBY CONTROLS — the three fixes that shipped without a pin
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-02 seven mobile fixes shipped together. Four were pinned the same
 * day; three were not, and this file is that debt being paid:
 *
 *   ITEM 3  the mobile sort bar
 *   ITEM 5  one create button, belonging to the tab you are looking at
 *   ITEM 7  numeric bays print 0, never a dash and never "Unavailable"
 *
 * Behaviour is asserted by RENDERING or by CALLING wherever that is possible -
 * a string match on a stylesheet proves a rule was typed, not that it applies.
 * The source-text cases that remain are the ones with no cheap runtime
 * equivalent, and each says what it is standing in for.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import GameCreationActions from '../../src/components/club/GameCreationActions';
import {
  CLUB_IDENTITY_CANVAS,
  CLUB_IDENTITY_ZONES,
  ClubIdentityCard,
} from '../../src/components/club-buttons/ClubIdentityCard';
import { NUMERIC_ZONES, zoneText } from '../../src/components/lobby/game-cards/arenaGameCardTypes';
import { playerDisplayName } from '../../src/utils/playerDisplayName';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * Source with its comments removed.
 *
 * Needed because this codebase explains its fixes IN the file, so a pin that
 * greps raw text matches the note describing the old behaviour and reports the
 * bug as still present. It happened twice in one afternoon - once on a CSS
 * function name, once on the phrase "Game Unavailable" - and the same guard
 * already exists in tests/unit/clubPageHardening.test.ts.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const PAGE = read('src/pages/ClubHomePage.tsx');
const TABLE = read('src/components/lobby/LobbyTable.tsx');
const TABLE_CSS = read('src/components/lobby/LobbyTable.css');
const CARD = read('src/components/lobby/game-cards/ArenaGameCard.tsx');
const PREMIUM = read('src/components/lobby/game-cards/NlhPremiumCard.tsx');
const LOBBY_CARD = read('src/components/lobby/game-cards/ArenaLobbyGameCard.tsx');

/* ═══════════════════════════════════════════════════════════════════════════
   ITEM 3 — THE MOBILE SORT BAR
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the mobile sort bar', () => {
  it('is built from the same columns and the same click handler as the desktop headings', () => {
    /*
     * The point of the design, and why there is no second sort implementation
     * to drift: same keys, same asc/desc flip, same per-club per-tab memory.
     * If these stop matching, a phone and a desktop can order the same board
     * differently.
     */
    expect(TABLE).toContain('const sortableColumns = columns.filter((col) => col.sortable)');
    /* Dan 2026-09-03: the Variant heading is the game selector and opens a
       menu instead; every other chip still goes straight to the one handler. */
    expect(TABLE).toMatch(/lobby-sortbar__chip[\s\S]{0,1800}handleHeaderClick\(col\);/);
  });

  it('renders BEFORE the card list, never between it and the desktop table', () => {
    /*
     * LobbyTable.css hides the dense desktop table on a phone with the
     * ADJACENT-SIBLING selector `.arena-lobby-card-list + .lobby-table-wrap`.
     * Anything inserted between those two breaks the adjacency and puts the
     * table back on every phone - a full-width regression no snapshot of the
     * sort bar itself would catch.
     */
    const bar = TABLE.indexOf('className="lobby-sortbar"');
    const cards = TABLE.indexOf('className="arena-lobby-card-list"');
    const table = TABLE.indexOf('className="lobby-table-wrap"');
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(cards);
    expect(cards).toBeLessThan(table);
    expect(TABLE_CSS).toContain('.arena-lobby-card-list + .lobby-table-wrap');
  });

  it('is hidden above 900px, where the heading row already does this job', () => {
    expect(TABLE_CSS).toMatch(/\.lobby-sortbar\s*\{\s*display:\s*none;\s*\}/);
    expect(TABLE_CSS).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.lobby-sortbar\s*\{[^}]*display:\s*flex/
    );
  });

  it('declares BOTH overflow axes on its scroller', () => {
    /*
     * `overflow-x` alone computes `overflow-y` to `auto`, making the element
     * an accidental scroll container - the declaration
     * footer-stays-on-the-footer.law.test.ts exists to ban, because on iOS it
     * is how the fixed bottom nav comes unstuck from the bottom of the screen.
     */
    const chips = TABLE_CSS.match(/\.lobby-sortbar__chips\s*\{[^}]*\}/s)?.[0] || '';
    expect(chips).toContain('overflow-x: auto');
    expect(chips).toContain('overflow-y: hidden');
  });

  it('gives its toolbar role the roving tabindex that role promises', () => {
    /*
     * A toolbar is a composite widget: one tab stop, arrows moving inside it.
     * The role shipped without that, which told a screen reader the arrows
     * worked and then ignored them, and left six tab stops in the middle of
     * the lobby for a keyboard user to walk past on the way to the games.
     */
    expect(TABLE).toContain('role="toolbar"');
    expect(TABLE).toContain('onKeyDown={handleSortbarKeyDown}');
    expect(TABLE).toMatch(
      /tabIndex=\{index === Math\.min\(sortFocus, sortableColumns\.length - 1\)/
    );
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(TABLE).toContain(`case '${key}'`);
    }
  });

  it('announces the sort on the one surface where the other live region is hidden', () => {
    // `.lobby-table-wrap` is display:none on a phone and a hidden element
    // announces nothing, so without this, sorting was silent on mobile.
    expect(TABLE).toMatch(/lobby-sortbar[\s\S]{0,1400}role="status"/);
  });
});

describe('mobile live-table selector metadata', () => {
  it('keeps table identity and live occupancy on the wrapper that is visible on a phone', () => {
    expect(LOBBY_CARD).toContain('data-testid="arena-lobby-game-card"');
    expect(LOBBY_CARD).toContain('data-id={entry.id}');
    expect(LOBBY_CARD).toContain('data-kind={entry.kind}');
    expect(LOBBY_CARD).toContain("data-live={entry.live ? 'true' : 'false'}");
    expect(LOBBY_CARD).toContain('data-players={entry.players}');
    expect(LOBBY_CARD).toContain("data-target={entry.game ? 'game' : 'table'}");
    expect(LOBBY_CARD).toContain('presentation="mobile"');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ITEM 5 — ONE CREATE BUTTON, BELONGING TO THE TAB
   ═══════════════════════════════════════════════════════════════════════════ */

type ActionProps = Parameters<typeof GameCreationActions>[0];

const renderActions = (props: Partial<ActionProps> = {}) =>
  render(
    <MemoryRouter>
      <GameCreationActions managementPath="/clubs/1/table-management" {...props} />
    </MemoryRouter>
  );

describe('the create-game row', () => {
  it('renders nothing at all when the tab has no creation of its own', () => {
    // Dan: "THE ADD TABLE BUTTONS SHOULD NEVER DISPLAY ON THE ALL FIELD."
    const { container } = renderActions({ only: null });
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['table', 'Add Table'],
    ['event', 'Event'],
    ['spin', 'Spins'],
    ['sng', 'Sit N Go'],
  ] as const)('renders exactly one button for %s', (target, label) => {
    renderActions({ only: target });
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(label);
  });

  it('still renders the full set for hosts that pass no tab', () => {
    /*
     * The union and game-management screens have no tab strip to be
     * independent of, and this row is their ONLY route to creating a game.
     * Narrowing them too would have removed a feature rather than tidied a
     * lobby.
     */
    renderActions();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('is desktop-only ONLY when a host asks, and leaks no stray whitespace', () => {
    const { container: plain } = renderActions({ only: 'table' });
    const plainClass = plain.querySelector('[aria-label="Create Games"]')?.className || '';
    const { container: desktop } = renderActions({ only: 'table', desktopOnly: true });
    const desktopClass = desktop.querySelector('[aria-label="Create Games"]')?.className || '';

    expect(plainClass).not.toEqual('');
    expect(desktopClass).not.toEqual(plainClass);
    // Two false ternaries used to leave a trailing double space in the class
    // attribute on every non-compact render.
    expect(plainClass).not.toMatch(/\s{2,}|\s$/);
    expect(desktopClass).not.toMatch(/\s{2,}|\s$/);
  });

  it('maps every lobby tab to a creation, and ALL to none', () => {
    /*
     * Read from source rather than imported, because the map is a
     * module-private constant on a 5,000-line page component. The pin is on
     * the DECISION - which tab earns which button - and Dan named six of the
     * seven himself.
     */
    const map = PAGE.match(/const CREATE_TARGET_FOR_TAB[\s\S]*?\n\};/)?.[0] || '';
    expect(map).toMatch(/ALL:\s*null/);
    expect(map).toMatch(/MTT:\s*'event'/);
    expect(map).toMatch(/HOLDEM:\s*'table'/);
    expect(map).toMatch(/OMAHA:\s*'table'/);
    expect(map).toMatch(/LIMIT:\s*'table'/);
    expect(map).toMatch(/SPIN:\s*'spin'/);
    expect(map).toMatch(/SNG:\s*'sng'/);
    // Exhaustive over GameType, so a game type added later shows NO button
    // until somebody decides what it earns, rather than inheriting a cash
    // table from a default branch.
    expect(map).toMatch(/MIXED:\s*null/);
  });

  it('is wired to the lobby with both the tab and the desktop-only flag', () => {
    expect(PAGE).toMatch(/only=\{CREATE_TARGET_FOR_TAB\[gameType\]\}/);
    expect(PAGE).toMatch(/<GameCreationActions[\s\S]{0,320}desktopOnly/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE CLUB IDENTITY CARD STACK (Dan 2026-09-02)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the club identity card', () => {
  const renderCard = (clubName = 'Deep Stack Society') =>
    render(
      <ClubIdentityCard
        clubName={clubName}
        pokerAlias="Dan Bekavac"
        clubId={11192}
        playerId={1}
        level={26}
        playersPlaying={174}
        shareIcon={<svg />}
      />
    );

  it('shows the poker alias and never the real name', () => {
    /*
     * Dan 2026-09-02: "THE REAL NAME SHOULD NEVER BE DISPLAYED, IT SHOULD
     * ALWAYS BE USING THE POKER ALIAS - KingFish instead of the real name."
     *
     * His own production row is the case, and it is not unusual: `display_name`
     * equals `full_name` on 264 of 1,308 profiles, so the old
     * `display_name || username` chain printed a legal name on the club card
     * for hundreds of accounts - none of whom had `use_real_name` set, because
     * nobody has.
     *
     * Rendered rather than grepped, because the thing being guarded is what a
     * player SEES.
     */
    const dan = {
      alias: 'KingFish',
      username: 'kingfish',
      display_name: 'Dan Bekavac',
      full_name: 'Dan Bekavac',
      use_real_name: false,
    };

    const { container } = render(
      <ClubIdentityCard
        clubName="Deep Stack Society"
        pokerAlias={playerDisplayName(dan, 'arena')}
        clubId={11192}
        playerId={1}
        playersPlaying={174}
        shareIcon={<svg />}
      />
    );

    expect(container.querySelector('.club-identity__alias')?.textContent).toBe('KingFish');
    expect(container.textContent).not.toContain('Dan Bekavac');
    expect(container.textContent).not.toContain('Bekavac');
  });

  it('keeps the club name first, spoken to assistive tech, never painted', () => {
    // Dan 2026-09-02 asked for the name across the top; his 2026-09-04
    // master has no name band (the lobby header carries it), so the H2 stays
    // first in the DOM for screen readers and is visually hidden.
    const { container } = renderCard();
    const name = container.querySelector('.club-identity__name');
    expect(name).not.toBeNull();
    expect(name?.tagName).toBe('H2');
    expect(name?.textContent).toBe('Deep Stack Society');
    // It is a sibling of the rest of the card, not a row inside a grid that
    // something else can push around - which is what made a long name wrap
    // down onto the alias.
    expect(container.querySelector('.club-identity__details')).toBeNull();
    expect(name?.parentElement?.classList.contains('club-identity')).toBe(true);
  });

  it('renders the stack in the order Dan gave', () => {
    // name, then Dan Bekavac, then club ID, then player ID, then the count and
    // the copy link.
    const { container } = renderCard();
    const order = [
      '.club-identity__name',
      '.club-identity__alias',
      '.club-identity__ids',
      '.club-identity__footer',
    ].map((selector) => {
      const el = container.querySelector(selector);
      expect(el, `missing ${selector}`).not.toBeNull();
      return [...container.querySelectorAll('*')].indexOf(el!);
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const ids = container.querySelectorAll('.club-identity__ids .club-identity__line');
    expect(ids).toHaveLength(2);
    expect(ids[0].textContent).toContain('11192'); // club ID first
    expect(ids[1].textContent).toContain('1'); // then player ID
  });

  it('prints the alias into its measured zone and fits it by measurement', () => {
    /*
     * Two of Dan's rules meet on the headline: it may not wrap, and it may
     * not be cut off. CSS alone cannot satisfy both - `clamp()` sizes from
     * the CARD's width, never from how much text there is - so the alias is
     * fitted the way every card title is: useFitText measures the laid-out
     * span against its zone and writes `--fit`, and the font-size is
     * `calc(8.1cqw * var(--fit, 1))`. In happy-dom every width is 0, so the
     * hook must leave the text at its natural size rather than collapse it.
     */
    const { container } = renderCard();
    const alias = container.querySelector<HTMLElement>('.club-identity__alias');
    expect(alias).not.toBeNull();
    // The measurable span is what the fit pass reads; without it there is
    // nothing whose width can be compared to the zone's.
    expect(alias?.querySelector(':scope > span')?.textContent).toBe('Dan Bekavac');

    // The zone is the master's alias band, converted to percentages of the
    // 1566 x 672 canvas, so every phone prints it in the same place.
    const z = CLUB_IDENTITY_ZONES.alias;
    const pct = (n: number, of: number) => `${(n / of) * 100}%`;
    expect(alias?.style.left).toBe(pct(z.x, CLUB_IDENTITY_CANVAS.width));
    expect(alias?.style.top).toBe(pct(z.y, CLUB_IDENTITY_CANVAS.height));
    expect(alias?.style.width).toBe(pct(z.width, CLUB_IDENTITY_CANVAS.width));
    expect(alias?.style.height).toBe(pct(z.height, CLUB_IDENTITY_CANVAS.height));

    // No layout, no change: with nothing measured the fit stays at 1 (or is
    // simply absent), never 0 - a server render must not blank the name.
    const fit = alias?.querySelector<HTMLElement>(':scope > span')?.style.getPropertyValue('--fit');
    expect(fit === '' || Number(fit) === 1).toBe(true);

    // The club name is still in the DOM for assistive tech, but not painted:
    // the master carries no name band and the lobby header already says it.
    const name = container.querySelector('.club-identity__name');
    expect(name?.classList.contains('sr-only')).toBe(true);
    expect(container.querySelector('.club-identity__name')?.getAttribute('style')).toBeNull();
  });

  it('puts the count and the copy link on the same line', () => {
    // "LAST LIKE 192 PLAYING AND THE COPY LINK."
    const { container } = renderCard();
    const footer = container.querySelector('.club-identity__footer');
    expect(footer?.querySelector('.club-identity__playing')?.textContent).toContain('174');
    expect(footer?.querySelector('.club-identity__share')).not.toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ITEM 7 — NUMERIC BAYS PRINT 0
   ═══════════════════════════════════════════════════════════════════════════ */

describe('what an empty card bay prints', () => {
  it('prints 0 for a count and a dash for anything that is not one', () => {
    // Dan: "THEY SHOULD HAVE 0'S UNTIL THE CARD LOADS."
    expect(zoneText('players')).toBe('0');
    expect(zoneText('stakes')).toBe('0');
    expect(zoneText('buyIn')).toBe('0');
    expect(zoneText('registered')).toBe('0');
    // 0 of a variant, a format or a start time is not a thing, and would be a
    // worse lie than the dash it replaced.
    expect(zoneText('gameType')).toBe('-');
    expect(zoneText('format')).toBe('-');
    expect(zoneText('startingTime')).toBe('-');
  });

  it('never overrides a real value, including a zero one', () => {
    expect(zoneText('players', '3/6')).toBe('3/6');
    expect(zoneText('players', '0/6')).toBe('0/6');
    expect(zoneText('gameType', "Hold'em")).toBe("Hold'em");
  });

  it('covers every numeric field the card families actually render', () => {
    for (const zone of [
      'buyIn',
      'currentLevel',
      'guarantee',
      'maxPayout',
      'players',
      'registered',
      'stakes',
      'startingStack',
    ]) {
      expect(NUMERIC_ZONES.has(zone)).toBe(true);
    }
  });

  it('leaves no renderer hand-rolling its own empty-bay answer', () => {
    /*
     * THE BUG THIS CATCHES, which shipped on 2026-09-02 and was found in the
     * follow-up audit: the fallback lived inside ArenaGameCard's `LiveValue`,
     * which covers the NLH, PLO, Spin and Heads-Up machines - and missed the
     * two renderers a phone is most likely to show. MttMachine hand-rolled six
     * bays as `{data.buyIn || '-'}`, and NlhPremiumCard - the layered card in
     * Dan's own screenshot - hand-rolled three more. Both printed a dash where
     * every other bay had already been changed to print 0.
     *
     * One helper, one answer, and this pin is what stops a fourth renderer
     * introducing a tenth.
     */
    expect(CARD).not.toMatch(/\{data\.\w+ \|\| '-'\}/);
    expect(PREMIUM).not.toMatch(/\{data\.\w+ \|\| '-'\}/);
    expect(CARD).toContain("zoneText('buyIn', data.buyIn)");
    expect(PREMIUM).toContain("zoneText('players', data.players)");
  });

  it('labels a card that is showing a remembered number', () => {
    /*
     * The cache is only honest if it admits when it is being used.
     * ArenaGameCard already had the vocabulary - `stale` renders the small
     * "Last Known Game State" chip at the foot of the card - and nothing in
     * the lobby ever set `dataState`, so that affordance was dead code and a
     * remembered figure was indistinguishable from a live one.
     *
     * Conditional on purpose: a card with complete live data carries no chip,
     * and the label clears itself the moment the real value lands.
     */
    const lobbyCard = read('src/components/lobby/game-cards/ArenaLobbyGameCard.tsx');
    expect(lobbyCard).toContain('const filledFromMemory = Object.keys(remembered).length > 0');
    expect(lobbyCard).toMatch(/filledFromMemory \? \{ dataState: 'stale' as const \} : null/);
    expect(read('src/components/lobby/game-cards/ArenaGameCard.css')).toMatch(
      /\[data-state='stale'\] \.arena-game-card__notice/
    );
  });

  it('remembers only what the server actually said', () => {
    /*
     * Writing the MERGED card back would re-persist a remembered figure as
     * though it had just been observed: the entry could never age out of the
     * LRU, and a value the lobby has genuinely stopped reporting would be
     * refreshed forever by the very card still displaying it.
     */
    const lobbyCard = read('src/components/lobby/game-cards/ArenaLobbyGameCard.tsx');
    expect(lobbyCard).toContain('rememberFigures(`game:${entry.id}`, data.live)');
    expect(lobbyCard).not.toMatch(/rememberFigures\([\s\S]{0,80}CACHED_FIGURE_KEYS\.map/);
  });

  it('never calls a game unavailable, on screen OR out loud', () => {
    /*
     * The card is still showing figures - cached, or zero - so what actually
     * happened is that they stopped being current, not that the game is gone.
     *
     * The second assertion is the one the audit turned up: the card's
     * `aria-label` read `|| 'player count unavailable'`, so the moment the
     * bays began printing 0 a sighted player saw "0/6" while a screen-reader
     * user heard the exact word Dan asked never to appear. Two descriptions of
     * the same card, disagreeing.
     */
    expect(code(CARD)).not.toMatch(/[Uu]navailable/);
    expect(CARD).toContain('Last Known Game State');
    expect(CARD).toMatch(/summary = [\s\S]{0,200}zoneText\(\s*'players'/);
  });
});
