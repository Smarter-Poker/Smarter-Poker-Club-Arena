/**
 * LAW: on a multi-board hand the pot ships PER BOARD, and the felt says so.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-05: "it does not ship the pot individually and is broken."
 *
 * The engine settles a run-it-twice hand in one tick and credits ONE merged
 * total per player. Everything a player sees about "which board paid me" is
 * therefore presentation, and presentation is exactly what kept regressing:
 * the chips fanned three times while the stack moved once, because the whole
 * winnings sat behind a single boolean that flipped after the LAST fan landed.
 *
 * Frame-by-frame from the reference recordings (6-10fps, per-timestamp crops
 * of every seat and the pot block):
 *
 *   RUN IT 3X, pot 8.81 - Gordo Chris steps 0 -> 2.73 at t=25.0s and
 *   2.73 -> 5.46 at t=30.5s. Two awards, two visible steps.
 *
 *   RUN IT TWICE + SPLIT POT, main 20.32 / side 1.95 - both rows stay up for
 *   the whole sequence and the 1.95 row DISAPPEARS on its own at t=26.5s, the
 *   moment that pot had paid both runs, while 20.32 stays. The counter never
 *   ticks down.
 *
 * These are source laws over TablePage because the behaviour lives inside a
 * 20k-line component driven by real timers; the arithmetic underneath is unit
 * tested in tests/unit/showdownPresentation.test.ts. What a source law can
 * still do is make the MECHANISM impossible to delete quietly - every pin
 * below is a specific thing that was broken and is now not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TABLE_PAGE = readFileSync(join(__dirname, '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');

describe('LAW: the stack rises with each board, not once at the end', () => {
  it('holds each winner by what has NOT yet been delivered to them', () => {
    // The 4th argument is the whole fix. Without it pendingStackHold falls
    // back to all-or-nothing on one boolean, which is the reported bug.
    expect(TABLE_PAGE, 'pendingStackHold must be given the per-player released ledger').toMatch(
      /pendingStackHold\([\s\S]{0,400}?stackReleasedByPlayer/
    );
  });

  it('every award group releases ITS OWN shares when its fan lands', () => {
    // Per-group, per-player. Releasing the merged total on the first fan
    // would show the whole win on board 1 - the same bug wearing a hat.
    expect(TABLE_PAGE).toMatch(/perPlayer/);
    expect(TABLE_PAGE, 'the release is scheduled per group').toMatch(/setStackReleasedByPlayer\(/);
    expect(TABLE_PAGE, 'released amounts accumulate in integer cents, never float-added').toMatch(
      /Math\.round\(\(\(next\[pid\] \?\? 0\) \+ amt\) \* 100\) \/ 100/
    );
  });

  it('the per-board release dies with its hand', () => {
    // A release timer from the previous hand firing into this one credits a
    // stack that is no longer holding anything.
    expect(TABLE_PAGE).toMatch(/stackReleaseTimersRef/);
    expect(TABLE_PAGE).toMatch(/setStackReleasedByPlayer\(\{\}\)/);
  });

  it('the global release still wins outright as the backstop', () => {
    expect(TABLE_PAGE).toMatch(/setStackHoldReleased\(true\)/);
    expect(TABLE_PAGE).toMatch(/setStackHoldReleased\(false\)/);
  });
});

describe('LAW: a pot row holds its full amount and retires when it is paid', () => {
  it('does not decrement the counter as shares leave', () => {
    // The reference counter reads 8.81 before the first ship and 8.81 after
    // it. `potShipRemaining` was one number sliding toward zero with every
    // side-pot row blanked for the duration; it is gone.
    expect(TABLE_PAGE, 'the decrementing pot counter must stay deleted').not.toMatch(
      /potShipRemaining/
    );
    expect(TABLE_PAGE).toMatch(/potShipView/);
  });

  it('retires a pot only once it has paid every run', () => {
    // The side pot vanishing while the main pot stays is the whole tell.
    expect(TABLE_PAGE).toMatch(/beatsLeftByPot/);
    expect(TABLE_PAGE, 'a pot is retired when its last beat lands').toMatch(
      /retired: \[\.\.\.prev\.retired, g\.potIndex\]/
    );
  });

  it('keeps every live side-pot row visible during the sequence', () => {
    // `sidePots={... ? [] : ...}` blanked them all for the whole award.
    expect(TABLE_PAGE, 'side pots are filtered by retirement, not emptied').toMatch(
      /potShipView\.sides\.filter\(/
    );
  });
});

describe('LAW: a board axis we cannot trust is not used to time the ships', () => {
  it('falls back to the uniform stagger when no group claims a later board', () => {
    /**
     * The board axis exists only inside `pot_awards`. Every degraded path -
     * legacy payload, pot_index-only grouping, the synthesised fallback -
     * stamps `board: 1` because it has nothing better, and against a live
     * multi-run ribbon timeline that fired EVERY group on run 1's ribbon:
     * the whole pot shipped while boards 2..N were still face down.
     */
    expect(TABLE_PAGE).toMatch(/boardAxisTrusted/);
    expect(TABLE_PAGE, 'the hold is sized off the same judgement').toMatch(/holdUsesRibbons/);
  });
});

describe('LAW: the seat names the hand it made on the run being shown', () => {
  it('prefers the featured run over the merged name', () => {
    // A player can take run 1 with Two Pair and run 3 with a Flush. One name
    // for both, beside a board row naming the other, is a mislabel.
    expect(TABLE_PAGE).toMatch(/boardHandNamesByPlayer/);
    expect(TABLE_PAGE, 'the seat reads the run currently on stage, then falls back').toMatch(
      /boardHandNamesByPlayer\?\.\[ritRevealedRuns - 1\]/
    );
  });
});

describe('LAW: the frozen pot rows are the GROSS rows the hand played for (2026-09-13)', () => {
  it('rit_result records the live pots, gross, with their eligible players', () => {
    /**
     * `state.pots` is only assigned by the single-board settlement, so a
     * multi-board hand's snapshot never carries a partition and the ship had
     * to rebuild rows from the award groups - NET shares. A 6.76 pot raked to
     * 6.05 read 6.76 all hand and 6.05 the instant the ship started, and a
     * three-way all-in with a side pot froze as ONE merged row instead of the
     * main row and the side row the reference holds up (20.32 / 1.95).
     */
    expect(TABLE_PAGE).toMatch(/const ritGrossPotsRef = useRef</);
    expect(TABLE_PAGE, 'recorded from rit_result.pots').toMatch(
      /ritGrossPotsRef\.current = rows\.length\s*\?\s*\{ handNumber: Number\(handState\.hand_number\) \|\| 0, pots: rows \}/
    );
  });

  it('the sequenced ship freezes those rows ahead of the snapshot and the net fallback', () => {
    expect(TABLE_PAGE).toMatch(/if \(ritRows && ritRows\.length > 0\) \{/);
    expect(TABLE_PAGE, 'main row is the first gross pot').toMatch(/main = ritRows\[0\]\.amount;/);
    expect(TABLE_PAGE, 'side rows keep their eligible players by name').toMatch(
      /sides = ritRows\.slice\(1\)\.map<SidePot>/
    );
  });

  it('the rows die with their hand', () => {
    expect(TABLE_PAGE).toMatch(/ritGrossPotsRef\.current = null;/);
  });
});
