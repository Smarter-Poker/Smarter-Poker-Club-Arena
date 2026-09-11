import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HERO'S VPIP TRACKER, THE ANTE, AND THE STYLE ON THE FELT (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "IF THE GAME IS CLASSIC, ACTION OR MADNESS, IT MUST SAY IT ON THE TABLE
 * UNDER THE BLINDS." "ANTES OR VPIPS ARE NOT DISPLAYING OR CALCULATING."
 * "VPIP SHOULD BE DISPLAYED AS A REALTIME PERCENTAGE TRACKER TO THE LEFT OF
 * THE HERO (ONLY VISIBLE FOR THE USER)."
 */

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import HeroVpipTracker, {
  VPIP_BACKSTOP_MS,
  VPIP_REFRESH_DELAY_MS,
} from '../../src/components/table/HeroVpipTracker';
import { mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';
import {
  MASTHEAD_GAME_FIT_MARGIN_PX,
  MASTHEAD_GAME_MIN_RATIO,
  MastheadGameLine,
  mastheadGameFit,
} from '../../src/components/table/MastheadGameLine';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/* THE `vpipStanding` SUITE WAS DELETED WITH THE FUNCTION (2026-09-07).
   It graded the hero none/sample/safe/edge/under and the tracker emitted the
   grade as a CSS class. Dan's badge specification section 25 forbids the badge
   colouring itself by whether the player is passing, so when the rectangle
   became the badge every one of those five classes lost its styling and the
   grade was computed and thrown away. Testing a pure function nothing calls is
   how dead code keeps its air of being wired up. If an eligibility indicator
   is approved later it arrives with a consumer, and its tests with it. */

describe('the tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const seated = (over: Record<string, unknown> = {}) => ({
    data: {
      ok: true,
      seated: true,
      nit_game: true,
      required: 30,
      window: 10,
      hands: 7,
      vpip: 42.3,
      ...over,
    },
    error: null,
  });

  it("asks the database for the hero's own figure and prints it with the floor and the count", async () => {
    rpc.mockResolvedValue(seated());
    render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(rpc).toHaveBeenCalledWith('fn_cash_vpip_status', { p_table_id: 't1' });
    const el = screen.getByTestId('hero-vpip');
    expect(el.textContent).toContain('VPIP');
    /* REDESIGNED 2026-09-07 (Dan item 3): "VPIP NEEDS TO BE A SIMPLE SQUARE
       WITH THE MINIMUM GAME REQUIREMENT AND THE USERS CURRENT VPIP INSIDE A
       SQUARE BOX NEXT TO THE HERO, NOT A LARGE GENERIC RECTANGLE." Two
       numbers, not four: the hand count and the sampling window are how the
       floor is enforced, not something a player plays differently for, and
       they were most of what made the old readout a rectangle. */
    expect(el.textContent).toContain('CURRENT');
    expect(el.textContent).toContain('42%');
    expect(el.textContent).toContain('MIN 30%');
    expect(el.textContent).not.toContain('Hands');
    expect(el.style.left).toBe('50%');
    expect(el.style.top).toBe('100%');
  });

  it('refreshes after every hand, once the fact row has had time to land', async () => {
    rpc.mockResolvedValue(seated({ hands: 10, vpip: 25 }));
    const { rerender } = render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    const before = rpc.mock.calls.length;
    rerender(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={6}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    expect(rpc.mock.calls.length).toBe(before);
    await act(async () => {
      vi.advanceTimersByTime(VPIP_REFRESH_DELAY_MS + 1);
      await Promise.resolve();
    });
    expect(rpc.mock.calls.length).toBe(before + 1);
    const el = screen.getByTestId('hero-vpip');
    /* No standing modifier: the wrapper is position only now, and the badge is
       forbidden from colouring itself by pass/fail (spec section 25). 25%
       against a 30% floor is a FAILING player, and the badge says so with the
       number alone - which is the whole point of the lock. */
    expect(el.className).toBe('hero-vpip');
    expect(el.textContent).toContain('MIN 30%');
    expect(el.textContent).toContain('25%');
    // ...and on the backstop, without a hand.
    await act(async () => {
      vi.advanceTimersByTime(VPIP_BACKSTOP_MS + 1);
      await Promise.resolve();
    });
    expect(rpc.mock.calls.length).toBe(before + 2);
  });

  it('renders nothing for a spectator, on a tournament, or for a table without a floor answer', async () => {
    rpc.mockResolvedValue(seated());
    const { rerender } = render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated={false}
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('hero-vpip')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    rerender(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('hero-vpip')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('draws NOTHING on a table with no floor - there is no requirement to print', async () => {
    /* The badge Dan designed is a REQUIREMENT badge: its bottom row is the
       game rule. A table that runs no VPIP rule has no rule to put there, and
       the old fallback ("3 Hands") was exactly the generic readout he asked to
       be rid of. Better to show nothing than to invent a minimum to fill the
       row - the same reasoning as section 22's `--%` over a fabricated 0%. */
    rpc.mockResolvedValue(seated({ nit_game: false, required: 0, hands: 3, vpip: 66.7 }));
    render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('hero-vpip')).toBeNull();
  });
});

describe('the regular ante reaches the felt', () => {
  const base = {
    table_id: 't',
    hand_number: 1,
    pot: 0,
    community_cards: [],
    current_bet: 0,
    current_player: null,
    dealer_seat: 1,
    stage: 'preflop',
    winners: [],
    min_raise: 0,
    last_raise: 0,
    players: [],
  } as never;

  it('maps ante and ante_mode, and reads 0 / null off an older engine', () => {
    const map = (over: Record<string, unknown>) =>
      mapEngineSnapshot({ ...(base as object), ...over } as never, 'hero', 6);
    const on = map({ ante: 1, ante_mode: 'per_player' });
    expect(on.ante).toBe(1);
    expect(on.anteMode).toBe('per_player');
    const bba = map({ ante: 2, ante_mode: 'big_blind' });
    expect(bba.anteMode).toBe('big_blind');
    const old = map({});
    expect(old.ante).toBe(0);
    expect(old.anteMode).toBeNull();
    const junk = map({ ante: -3, ante_mode: 'weird' });
    expect(junk.ante).toBe(0);
    expect(junk.anteMode).toBeNull();
  });

  /* Dan 2026-09-05: "ALL TABLES NEED TO SEE IF THEY ARE CLASSIC, ACTION OR
     MADNESS ON THEM. IF THEY HAVE AN ANTE OR VPIP REQUIREMENT THAT SHOULD ALSO
     BE ON THE TABLE. AND THE GAME NAME AND BLINDS ARE WAY TOO SMALL FONT." */
  /* RESTRUCTURED 2026-09-07. Dan, items 6 and 7A-7D, on the shipped result of
     the block above: the style had its own stacked row, the rules row repeated
     the ante and added a measurement window, a Bad Beat Jackpot figure had
     appeared between the stakes and the hand number, and the club and union
     were being ellipsized to fit the wordmark. The rows and their order are
     now his: identity, game, VPIP, hand, bomb clock. */
  it('the masthead: full club + union, then style + game + stakes on ONE line, then VPIP, then the hand', () => {
    const page = read('src/pages/TablePage.tsx');
    // The CASH masthead: the tournament branch above it uses the same row class.
    const brand = page.slice(
      page.indexOf('// Cash tables keep the two-line masthead.'),
      page.indexOf('{/* Dan 2026-08-19 item 15: the pot moved OUT of .table-surface.')
    );

    // 7B: ONE line carries style, game and stakes - "ACTION PLO4 2/5".
    expect(brand).toMatch(
      /\{tableState\.gameStyle \? `\$\{tableState\.gameStyle\} ` : ''\}\s*\n?\s*\{gameShort\} \{tableState\.blinds \|\| '1\/2'\}/
    );
    // ...with the ante appended to the STAKES, not given a row of its own.
    expect(brand).toMatch(/anteMode === 'big_blind' \? ' \+ BB Ante' : ' \+ Ante'/);
    expect(brand).not.toContain('table-brand__line--style');
    expect(brand).not.toContain('table-brand__ante');

    // 7C: the rules row is VPIP and nothing else - no ante, no hands window.
    expect(brand).toMatch(/\{tableState\.vpipFloor != null && \(/);
    expect(brand).toMatch(/VPIP \{tableState\.vpipFloor\}% Min/);
    expect(brand).not.toContain('vpipWindow');
    expect(brand).not.toContain('formatChipFigure(tableState.ante)');

    // Item 6: the jackpot figure is gone from the felt. It is still on screen
    // once, in the BAD BEAT JACKPOT pill above the table.
    expect(brand).not.toContain('table-brand__line--jackpot');
    expect(brand).not.toContain('Playing For $');

    // 7A: line 1 is the identity row, which opts out of the ellipsis.
    expect(brand).toContain('table-brand__line--identity');

    // 7D: the bomb clock is last, below everything else.
    const at = (s: string) => brand.indexOf(s);
    expect(at('table-brand__line--identity')).toBeLessThan(at('table-brand__line--level'));
    expect(at('table-brand__line--level')).toBeLessThan(at('table-brand__line--rules'));
    expect(at('table-brand__line--rules')).toBeLessThan(at('table-brand__line--hand'));
    expect(page.indexOf('table-brand__line--hand')).toBeLessThan(
      page.indexOf('table-brand__line--bomb')
    );
  });

  it('7A: a club or union name is never abbreviated, on any screen', () => {
    const css = read('src/pages/TablePage.css');
    const identity = css.slice(
      css.indexOf('.table-brand__line--identity {'),
      css.indexOf('}', css.indexOf('.table-brand__line--identity {'))
    );
    // The base row ellipsizes; this one must undo all three parts of that.
    expect(identity).toMatch(/text-overflow: clip;/);
    expect(identity).toMatch(/overflow: visible;/);
    expect(identity).toMatch(/white-space: normal;/);
    /* It stays inside the wordmark's box and wraps. See the keep-out test
       below for why the wider version was reverted. */
    expect(identity).toMatch(/max-width: 100%;/);
  });

  it('7A: the dealer button keep-out grew TALLER with the line it protects, not wider', () => {
    /* FELT_TEXT_BAND is the puck's model of this printing, so a masthead the
       geometry still thinks is two lines tall puts the puck on a club's name —
       the exact defect item 10 is about. Hence lines: 3.

       And the width is pinned at its ORIGINAL value on purpose, because the
       obvious version of this fix is wrong. Letting the identity row run to
       145% of the box (Dan: "IT CAN EXCEED THE LENGTH OF SMARTER.POKER") means
       widening this band, and this band is what the button walks around: at
       90%/377px the puck reached 0.44 of its seat's run to the middle against
       chipRail's 0.40 ceiling. Fixing 7A that way breaks 10. The name wraps
       inside the existing box instead. */
    const geom = read('src/components/table/tableGeometry.ts');
    const band = geom.slice(geom.indexOf('export const FELT_TEXT_BAND = {'));
    expect(band).toMatch(/widthOfFeltPct: 62,/);
    expect(band).toMatch(/maxWidthPx: 260,/);
    expect(band).toMatch(/lines: 3,/);
  });

  it('the VPIP floor comes off the same table columns fn_nit_evictions judges by', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/cluster_id, nit_game, maintain_percent_min, maintain_hands'/);
    expect(page).toMatch(
      /vpipFloor:\s*table\.nit_game === true && Number\(table\.maintain_percent_min\) > 0\s*\?\s*Number\(table\.maintain_percent_min\)\s*:\s*null/
    );
  });

  it('the game and blinds are twice the club line on a cash table; the style is a badge', () => {
    const css = read('src/pages/TablePage.css');
    expect(css).toMatch(/\.table-brand__line \{\s*font-size: 0\.48rem;/);
    expect(css).toMatch(
      /\.table-page:not\(\.table-page--tournament\) \.table-brand__line--level \{[^}]*font-size: clamp\(0\.6rem, 10\.5cqw, 0\.98rem\);/
    );
    expect(css).toMatch(/\.table-brand__line--rules \{[^}]*font-size: 0\.54rem;/);
    // The box is the container the big line is sized against (it ellipsized at 127px).
    expect(css).toMatch(/\.table-brand \{[^}]*container-type: inline-size;/);
  });

  it('at 375px the placard keeps its own steps instead of squashing to the 7px club line', () => {
    const css = read('src/pages/TablePage.css');
    const phone = css.slice(css.indexOf('@media (max-width: 380px) {'));
    const block = phone.slice(0, phone.indexOf('/* Fade the brand out'));
    expect(block).toMatch(/\.table-brand__line \{\s*font-size: 0\.44rem;/);
    expect(block).toMatch(
      /\.table-page:not\(\.table-page--tournament\) \.table-brand__line--level \{\s*font-size: clamp\(0\.6rem, 10\.5cqw, 0\.9rem\);/
    );
    expect(block).toMatch(/\.table-brand__line--rules \{\s*font-size: 0\.5rem;/);
    expect(block).toMatch(/\.table-brand__line--hand \{\s*font-size: 0\.4rem;/);
    // and every one of them comes AFTER the 0.44rem line, so it wins.
    expect(block.indexOf('font-size: 0.44rem')).toBeLessThan(block.indexOf('10.5cqw, 0.9rem'));
  });

  it("the table page reads the game's template through the table's cluster_id", () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/bomb_pot_min_players, bomb_pot_button_policy, cluster_id, nit_game/);
    expect(page).toMatch(
      /\.from\('cash_games'\)\s*\.select\('template_name'\)\s*\.eq\('id', table\.cluster_id\)/
    );
    expect(page).toMatch(/CASH_TEMPLATES\.find\(\(t\) => t\.id === template\)\?\.label/);
  });

  it("the tracker is mounted beside the seats, at the hero seat's point, cash only", () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(
      /<HeroVpipTracker\s+tableId=\{tableId\}\s+heroSeated=\{tableState\.heroSeat > 0\}\s+isTournament=\{tableState\.isTournament\}/
    );
    expect(page).toMatch(/seatPositions\[tableState\.heroSeat - 1\]/);
    const css = read('src/components/table/HeroVpipTracker.css');
    /* CLOSER, AND SMALLER (Dan 2026-09-05: "VPIP NEXT TO THE HERO NEEDS TO BE
       SUBSTANTIALLY SMALLER, AND CLOSER TO THE HERO"). The pin is on the
       MECHANISM - anchored at the hero's own point and pushed left by half the
       pod, so it rides with the seat at every breakpoint - not on the gap,
       which is Dan's to set. It was 10px; it is 3px. */
    expect(css).toMatch(
      /transform: translate\(calc\(-100% - var\(--sp-hero-half\) - 3px\), -50%\);/
    );
    /* And it stays small: a plaque beside the hero, not a second seat. The
       pin moved with the redesign (2026-09-07) - this file no longer draws
       anything, so there is no `__figure` font size to hold. What it still
       owns, and what still has to stay small, is the badge's ONE size input.
       Its appearance is locked inside VpipRequirementBadge (spec section 27),
       which is why nothing here may reach into it. */
    expect(css).toMatch(/--vpip-badge-size: 58px;/);
    expect(css).toMatch(/--vpip-badge-size: 40px;/);
    expect(css).not.toMatch(/\.hero-vpip__(figure|eyebrow|detail)/);
    expect(css).not.toMatch(/:hover/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE GAME LINE FITS ITS BOX (audit 2026-09-09, lane H)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rendered headless against the real stylesheet on 2026-09-09: the masthead
 * box is 154px at 375px and 178px at 393px, the game row 14.4px / 15.7px, and
 * "MADNESS NLH 1/2 + BB ANTE" ellipsized to "MADNESS NLH 1/..." on both - the
 * stakes and the ante gone on exactly the Action and Madness tables where the
 * ante is the point. The row's 10.5cqw was measured for "NLH 0.10/0.25"
 * alone, before the style went in front of it and the ante behind it (7B).
 * Fitted: 9.12px on one line at 375px, 10.66px at 393px, every character.
 */
describe('the game line fits its box (2026-09-09)', () => {
  it('the cash masthead prints line 2 through MastheadGameLine, with the same words', () => {
    const page = read('src/pages/TablePage.tsx');
    const brand = page.slice(
      page.indexOf('// Cash tables keep the two-line masthead.'),
      page.indexOf('{/* Dan 2026-08-19 item 15: the pot moved OUT of .table-surface.')
    );
    expect(brand).toMatch(
      /<span className="table-brand__line table-brand__line--level">\s*<MastheadGameLine className="table-brand__game">/
    );
    /* The tournament row above keeps its plain span: its hand number sits in
       a no-shrink sibling and the row has no room to grow (2026-09-05). */
    const tourney = page.slice(0, page.indexOf('// Cash tables keep the two-line masthead.'));
    expect(tourney).not.toContain('<MastheadGameLine');
  });

  it('scales down to fit, never up, never below the floor, and wraps only past the floor', () => {
    expect(mastheadGameFit(120, 154)).toEqual({ ratio: 1, wrap: false });
    expect(mastheadGameFit(0, 154)).toEqual({ ratio: 1, wrap: false });
    expect(mastheadGameFit(231, 154)).toEqual({ ratio: 0.667, wrap: false });
    /* 30 characters of micro-stakes Action on a 375px phone: past the floor. */
    expect(mastheadGameFit(300, 154)).toEqual({ ratio: MASTHEAD_GAME_MIN_RATIO, wrap: true });
    /* The correcting pass: measured at 0.667 the line was still 6px over. */
    expect(mastheadGameFit(160, 154, MASTHEAD_GAME_MIN_RATIO, 0.667)).toEqual({
      ratio: 0.642,
      wrap: false,
    });
    expect(MASTHEAD_GAME_MIN_RATIO).toBe(0.55);
    expect(MASTHEAD_GAME_FIT_MARGIN_PX).toBeGreaterThan(0);
  });

  it('writes --fit on the span when it overflows, and data-wrap past the floor', () => {
    /* jsdom lays nothing out, so the two widths are supplied. */
    const sw = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get');
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get');
    try {
      sw.mockReturnValue(231);
      cw.mockReturnValue(156);
      const { container, unmount } = render(
        <span className="table-brand__line table-brand__line--level">
          <MastheadGameLine className="table-brand__game">
            MADNESS NLH 1/2 + BB Ante
          </MastheadGameLine>
        </span>
      );
      const span = container.querySelector('.table-brand__game') as HTMLElement;
      expect(span.textContent).toBe('MADNESS NLH 1/2 + BB Ante');
      /* (156 - 2) / 231 = 0.667, then the second pass at the same widths
         corrects to 0.667 * 154 / 231 = 0.445 -> floored, wrapped. jsdom
         cannot shrink the measurement, so the second pass sees the same
         overflow; what is pinned is that both mechanisms fire. */
      expect(span.style.getPropertyValue('--fit')).toBe(String(MASTHEAD_GAME_MIN_RATIO));
      expect(span.getAttribute('data-wrap')).toBe('true');
      unmount();

      sw.mockReturnValue(120);
      cw.mockReturnValue(156);
      const fits = render(
        <span className="table-brand__line table-brand__line--level">
          <MastheadGameLine className="table-brand__game">NLH 1/2</MastheadGameLine>
        </span>
      );
      const short = fits.container.querySelector('.table-brand__game') as HTMLElement;
      expect(short.style.getPropertyValue('--fit')).toBe('1');
      expect(short.getAttribute('data-wrap')).toBeNull();
    } finally {
      sw.mockRestore();
      cw.mockRestore();
    }
  });

  it('the stylesheet folds --fit into the span at its own tracking, and wraps centred past the floor', () => {
    const css = read('src/pages/TablePage.css');
    expect(css).toMatch(/\.table-brand__game \{[^}]*font-size: calc\(100% \* var\(--fit, 1\)\);/);
    /* Inherited letter-spacing arrives as computed px and does not scale with
       the span; the em is handed down as a custom property instead. */
    expect(css).toMatch(/\.table-brand__game \{[^}]*letter-spacing: var\(--sp-game-ls, 0\.1em\);/);
    expect(css).toMatch(
      /\.table-page:not\(\.table-page--tournament\) \.table-brand__line--level \{[^}]*--sp-game-ls: 0\.05em;/
    );
    const wrap = css.slice(css.indexOf(".table-brand__game[data-wrap='true'] {"));
    const block = wrap.slice(0, wrap.indexOf('}'));
    expect(block).toMatch(/white-space: normal;/);
    expect(block).toMatch(/text-overflow: clip;/);
    expect(block).toMatch(/text-align: center;/);
  });
});
