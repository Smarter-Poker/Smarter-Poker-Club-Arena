/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE 2026-09-05 MOBILE PASS — the fixes that shipped with no test
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Four of the fixes in that batch had no test at all, and one of them turned out
 * to be defeated one render after it ran. An adversarial audit found it; this
 * file is what should have found it first.
 *
 *   1. The NLH card printed its buy-in stacked over two lines. Dan: "BUY IN
 *      SHOULD BE SIDE BY SIDE ... IT SHOULD SAY 4 - 20."
 *   2. The active table-tab pill truncated "Lobby" to "Lo...". Dan: "THE ACTION
 *      PILL SHOULD NEVER ABBRIEVATE LO.... IT NEEDS TO SAY Lobby SPELLED OUT."
 *   3. Leaving a cash game did not clear the seat on the player's OTHER device.
 *      Dan: "LEAVE TABLE OR GAME NEEDS TO BE REAL TIME."
 *
 * (1) is a render test - the honest kind. (2) and (3) are read from source,
 * because the pill is pure CSS and TablePage is a 24,000-line component whose
 * seat machinery cannot be mounted in isolation. Source pins are weaker, so each
 * one names the exact behaviour it stands in for.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';
import { NlhPremiumCard } from '../../src/components/lobby/game-cards/NlhPremiumCard';
import type {
  ArenaGameCardActions,
  ArenaGameCardData,
} from '../../src/components/lobby/game-cards/arenaGameCardTypes';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

const card = (buyIn: string): ArenaGameCardData => ({
  id: 't1',
  family: 'nlh',
  title: 'NLH .05/.10 Classic',
  subtitle: "No Limit Hold'em",
  gameType: 'NLH',
  stakes: '0.05/0.10',
  players: '50',
  buyIn,
  status: 'running',
  statusLabel: 'Running',
  rules: [],
});

const actions: ArenaGameCardActions = {
  primaryLabel: 'Join Table',
  onPrimary: () => {},
  secondaryLabel: 'View Table',
  onSecondary: () => {},
};

describe('the NLH card prints its buy-in side by side', () => {
  it('renders the range on ONE line as "4 - 20", not stacked', () => {
    render(<NlhPremiumCard data={card('4 - 20')} actions={actions} />);
    const bay = document.querySelector('[data-zone="buyIn"]');
    expect(bay, 'the buy-in bay has moved or gone').not.toBeNull();

    /* The whole point: one text node reading "4 - 20". The stack rendered two
       separate elements ("4" over "20") and no dash at all, so a single node
       whose text carries the dash is exactly what distinguishes them. */
    expect(bay!.textContent?.replace(/\s+/g, ' ').trim()).toBe('4 - 20');
    expect(bay!.querySelectorAll('.arena-premium-text')).toHaveLength(1);
  });

  it('leaves a single figure alone', () => {
    render(<NlhPremiumCard data={card('50')} actions={actions} />);
    const bay = document.querySelector('[data-zone="buyIn"]');
    expect(bay!.textContent?.trim()).toBe('50');
  });

  it('keeps the other bays intact', () => {
    render(<NlhPremiumCard data={card('4 - 20')} actions={actions} />);
    expect(document.querySelector('[data-zone="stakes"]')?.textContent).toContain('0.05/0.10');
    expect(document.querySelector('[data-zone="players"]')?.textContent).toContain('50');
    expect(screen.getByLabelText('Join Table')).toBeTruthy();
  });

  it('carries no stacked-buy-in class or rule any more', () => {
    /* Dead-code guard: the class and its stylesheet rule went together. If one
       comes back without the other the card silently loses its typography. */
    expect(read('src/components/lobby/game-cards/NlhPremiumCard.tsx')).not.toContain(
      'buy-in-stack'
    );
    expect(read('src/components/lobby/game-cards/NlhPremiumCard.css')).not.toContain(
      'buy-in-stack'
    );
  });

  it('shrinks a long range to the bay instead of clipping it', () => {
    /* One line is wider than two, so the bay is fitted by measurement. `--fit`
       is written by useFitText onto the text element, and the stylesheet has to
       be reading it or the widest real range ("2,000 - 10,000") is clipped at
       the zone edge. Both halves are pinned because either alone is useless. */
    expect(read('src/components/lobby/game-cards/NlhPremiumCard.tsx')).toMatch(
      /useFitText<HTMLElement>\(line, BUY_IN_SCALE_X/
    );
    expect(read('src/components/lobby/game-cards/NlhPremiumCard.css')).toMatch(
      /--buy-in \.arena-premium-text \{[\s\S]*?font-size: calc\(6\.15cqw \* var\(--fit, 1\)\)/
    );
  });
});

describe('the active table-tab pill spells "Lobby" out', () => {
  const CSS = read('src/components/table/TableTabBar.css');
  const rule = CSS.slice(
    CSS.indexOf('.table-tab-bar__tab--active:not(.table-tab-bar__tab--cards)'),
    CSS.indexOf('.table-tab-bar__tab-sub')
  );

  it('reserves no horizontal padding on the active pill', () => {
    /* THE BUG: 13px each side was reserved to clear an inline close disc that
       was deleted on 2026-08-26. At the 375px cap (55.25px) that left 27.25px
       for a word needing ~30px, so "Lobby" ellipsised to "Lo...". */
    expect(rule, 'the active-pill rule has moved or gone').not.toBe('');
    expect(rule).not.toMatch(/padding-left:/);
    expect(rule).not.toMatch(/padding-right:/);
    expect(rule).not.toMatch(/padding-inline:/);
    expect(rule).not.toMatch(/\bpadding:/);
  });

  it('keeps the min-width that guarantees the game code its own room', () => {
    expect(rule).toMatch(/min-width: 55px/);
  });

  it('has no inline × to reserve space for', () => {
    /* The reserve is only ever justified again if that control comes back. */
    const TSX = read('src/components/table/TableTabBar.tsx');
    expect(TSX).toMatch(/the action pills carry NO × off-button|handleClose removed/);
  });
});

describe('a seat this device has left is never re-adopted', () => {
  const PAGE = read('src/pages/TablePage.tsx');

  /*
   * THE BUG THIS CATCHES, and it is the one the first attempt shipped with.
   *
   * `left_at` is stamped only when the cash-out lands, so between the leave and
   * settlement the row is still live and the engine still carries the player in
   * its roster. Guarding ONLY the mount restore was useless: the
   * players[]/heroSeat invariant finds `p.id === userId` on the very next render
   * and hands the seat straight back, and `heroSeat > 0` is the single predicate
   * behind the fabricated "0.00 / SITTING OUT" hero and the "Seat Reserved,
   * You'll Be Dealt In Next Hand" footer Dan photographed.
   *
   * So the latch has to exist AND every claim path has to consult it. Counting
   * the consultations is the point: several sites, not one.
   */
  it('holds one latch that every seat-claiming path consults', () => {
    expect(PAGE).toMatch(/const leftSeatPendingRef = useRef\(false\)/);

    // Set: our own row observed leaving, and any seat_left naming us.
    expect(PAGE).toMatch(/leftSeatPendingRef\.current = true/);

    const reads = PAGE.match(/leftSeatPendingRef\.current(?!\s*=)/g) || [];
    expect(
      reads.length,
      'the invariant, the GAME_START resync and the poll/announce paths must all read it'
    ).toBeGreaterThanOrEqual(4);

    /* The players[]/heroSeat invariant — the one that defeated the first fix.
       Bounded by the effect's own block, never by a byte count: a fixed window
       drifts off the code it guards as comments are added, silently
       (tests/unit/noFixedSizeSourceWindows.test.ts). */
    const invariant = sliceEnclosingBlock(
      PAGE,
      'const idx = tableState.players.findIndex((p) => p && p.id === userId)'
    );
    expect(invariant, 'the seat invariant has moved or gone').not.toBe('');
    expect(invariant, 'the invariant must bail out on a seat we have left').toMatch(
      /if \(leftSeatPendingRef\.current\) return;/
    );

    // The GAME_START resync must not re-adopt from the engine roster either.
    expect(PAGE).toMatch(/if \(leftSeatPendingRef\.current\) syncedHeroSeat = 0;/);
  });

  it('clears the latch only by taking a seat again', () => {
    /* A latch that nothing clears would lock a player out of a seat they have
       just bought. Seat-first confirmation and a newly confirmed cash purchase
       clear it. A replayed historical receipt must not undo an explicit leave. */
    const clears = PAGE.match(/leftSeatPendingRef\.current = false/g) || [];
    expect(clears.length, 'both confirmed seat-taking paths must clear it').toBe(2);
  });

  it('reads leave_pending everywhere it decides what a seat means', () => {
    // The mount restore and the ten-second poll are the two reads of the row.
    expect(PAGE).toMatch(
      /seat_number, user_id, stack, status, horse_id, is_sitting_out, leave_pending/
    );
    expect(PAGE).toMatch(/'user_id, is_sitting_out, sit_out_at, leave_pending'/);
  });

  it('never paints a departing seat as "sitting out"', () => {
    /* The engine now writes is_sitting_out on a leave_pending row so the sit-out
       trigger and the restart restore can see it. Left unqualified here, that
       turns the second device's felt into "You Are Sitting Out" with an I'm Back
       button and a five-minute eviction clock, over a seat already left. */
    expect(PAGE).toMatch(/if \(row\.is_sitting_out && !heroFreshJoin && !row\.leave_pending\)/);
  });

  it('does not tell a player who left that they "were removed"', () => {
    /* Both recovery paths clear the seat; only an involuntary removal speaks. */
    expect(PAGE).toMatch(/applySeatRemoved\(reason, \{ announce: Boolean\(reason\) \}\)/);
    expect(PAGE).toMatch(
      /applySeatRemoved\(evictionReasonRef\.current, \{[\s\S]{0,120}announce: !leftSeatPendingRef\.current,/
    );
  });

  it('does not wipe a real eviction reason with a voluntary leave', () => {
    /* This block now runs for voluntary leaves too, which carry no reason. */
    expect(PAGE).toMatch(/if \(reason\) evictionReasonRef\.current = reason;/);
  });
});
