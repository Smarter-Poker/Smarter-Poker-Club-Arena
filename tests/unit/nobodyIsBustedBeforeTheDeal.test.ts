/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SEAT-FIRST SEAT HOLDS ZERO CHIPS. THAT IS NOT BUSTED. (round 17)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, live 2026-08-30: "AS SOON AS THE ANIMATION FINISHED, I GOT KICKED OFF
 * THE TABLE AGAIN" — with a ranking card reading Finished, Total Payout 0.00,
 * HANDS 0. And two minutes later, the proof that the seat was real:
 *
 *     "You Are Being Blinded Off — Your Seat Is Posting Blinds Without You
 *      And You Have 225 Chips Left. Take Your Seat Now To Stop Losing Chips."
 *
 * He had been thrown off a LIVE seat and the game went on blinding him down.
 *
 * THE MECHANISM, and it is one line of arithmetic:
 *
 *   - `fn_take_seat_and_buy_in` inserts the seat with `stack = 0`, because a
 *     seat-first seat is a RESERVATION until the draw resolves;
 *   - the engine's `deferStacksForSpinReveal` withholds the credit until the
 *     wheel has landed, on purpose, so the stacks arrive as part of the show;
 *   - so for the ~15 seconds of the reveal, EVERY seat reads zero;
 *   - and the tournament bust watcher reads zero as BUSTED. No rebuy exists on
 *     a Spin, so it released the hold and `exitIfBusted` ejected him.
 *
 * Silent by construction — an ordinary path, nothing thrown — which is why
 * Sentry showed zero events for the incident and why the first pass at this
 * bug found "nothing wrong".
 *
 * Verified against production, tournament c53bd1f6 ("1 Chip Spin PLO6"):
 * status RUNNING, Dan still in seat 3 holding 270 chips, two hands dealt
 * AFTER the card told him he was finished. The card was fiction.
 *
 * `playHasBegun` is the latch this page already keeps for the distinction
 * (dealer drawn, a hand started, or any seat holding chips). Before it,
 * "busted" is not a state a player can be in — there is nothing to have lost.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const PAGE = readFileSync(join(root, 'src', 'pages', 'TablePage.tsx'), 'utf8');
/** Executable code only — never let a pin pass on the prose above it. */
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/* The bust watcher, anchored on a line unique to it. `heroPlayer` and
   `tableState.players[` both occur earlier in this 20k-line file, so anchoring
   on those picked up a different effect entirely — the first draft of this pin
   failed for that reason, which is the sort of thing a source pin has to be
   written around rather than through. */
const WATCHER = sliceEnclosingBlock(CODE, 'const eliminationSignalled =', 0, 1);

describe('the bust watcher waits for the game to deal', () => {
  it('returns before it can read a stack, when play has not begun', () => {
    expect(WATCHER).toContain('if (!playHasBegun) return;');
  });

  it('the guard sits BEFORE the hero stack is read', () => {
    const guard = WATCHER.indexOf('if (!playHasBegun) return;');
    const read = WATCHER.indexOf('const heroPlayer = tableState.players[');
    expect(guard, 'the guard is missing from the watcher').toBeGreaterThan(-1);
    expect(read, 'the stack read is missing — this pin is on the wrong block').toBeGreaterThan(-1);
    expect(guard, 'a guard after the read is not a guard').toBeLessThan(read);
  });
});

describe('and the exit itself carries the same guard', () => {
  it('exitIfBusted refuses before the deal, from any of its three callers', () => {
    /* The watcher is one caller. The two rebuy-decline paths reach
       `exitIfBusted` directly, so the guard has to live on the function too. */
    const exit = sliceEnclosingBlock(CODE, 'exitIfBustedRef.current = () => {', 0, 1);
    expect(exit).toContain('if (!playHasBegunRef.current) return;');
  });

  it('it reads a REF, because it runs from a timer where state is stale', () => {
    expect(CODE).toContain('const playHasBegunRef = useRef(false);');
    const exit = sliceEnclosingBlock(CODE, 'exitIfBustedRef.current = () => {', 0, 1);
    expect(exit).not.toMatch(/if \(!playHasBegun\) return;/);
  });

  it('the ref is set synchronously with the latch, not a render later', () => {
    const latch = sliceEnclosingBlock(CODE, 'if (begun) {', 0, 1);
    expect(latch).toContain('playHasBegunRef.current = true;');
    expect(latch).toContain('setPlayHasBegun(true);');
    expect(
      latch.indexOf('playHasBegunRef.current = true;'),
      'the ref must be written first — the timer reads it, not the state'
    ).toBeLessThan(latch.indexOf('setPlayHasBegun(true);'));
  });
});

describe('what the latch actually means', () => {
  it('play has begun when a dealer is drawn, a hand starts, or chips land', () => {
    const latch = sliceEnclosingBlock(CODE, 'const begun =', 0, 1);
    expect(latch).toContain('tableState.dealerSeat > 0');
    expect(latch).toContain('(tableState.handNumber ?? 0) > 0');
    expect(latch).toMatch(/players\.some\(\(p\) => p && Number\(p\.stack \?\? 0\) > 0\)/);
  });
});
