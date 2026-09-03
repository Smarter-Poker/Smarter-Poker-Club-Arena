/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CREDIT MAY FUND AN EMPTY SEAT. IT MAY NOT RESCUE A LOSING ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `creditSeatStacks` raised every seated player below the starting stack back
 * up to it, with no check that a hand had been dealt. Every losing player is
 * below the starting stack by definition, so once play was under way this
 * minted the difference onto the felt.
 *
 * Measured on production 2026-08-31, spins completed in 24 hours:
 *
 *     2,168 games at a 300 stack    418 drifted, worst +470
 *       305 games at a 1,000 stack   84 drifted, worst +1,603
 *
 * and NOT ONE of the 502 exceeded twice the starting stack - exactly the
 * ceiling of topping up the two players who can be behind. Nothing else in the
 * engine has that signature.
 *
 * A Spin's prize is buy_in x multiplier, so no money was created directly.
 * What was created is a different WINNER: the engine decides on chips, and a
 * player who was busting got their stack back.
 *
 * Source-level because creditSeatStacks is a live-Supabase method: what is
 * being pinned is the SHAPE of the question it asks.
 *
 * MOVED PINS (chip-std Lane F, 2026-09-02). The in-play branch this file
 * pinned (`playUnderWay ? stack <= 0 : stack < target`) was itself the next
 * mint: a seat at 0 during play is a busted player whose elimination the
 * restart interrupted, and a lost hand_history row made a running game look
 * pre-deal (docs/changelog/2026-09-02-chip-std-spin-chips.md). The decision
 * now lives in `selectSeatsToFund` (seatStackCredit.ts), where the production
 * games are fixtures, and `TournamentChipsAreConserved.law.test.ts` pins the
 * stricter rule: once play is under way NOTHING is funded. The pins below
 * keep this file's original intent against the new mechanism.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { selectSeatsToFund } from './seatStackCredit.js';

const BASE = fs
  .readFileSync(path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const fn = sliceMethod(BASE, 'protected async creditSeatStacks(');

describe('creditSeatStacks', () => {
  it('asks whether play has started before deciding what is stale', () => {
    // The whole defect was asking `stack < target` unconditionally.
    expect(fn).toMatch(/from\(\s*'hand_history'\s*\)/);
    expect(fn).toMatch(/handRecorded/);
    expect(fn).toMatch(/selectSeatsToFund\(/);
  });

  it('never tops a seat up to the target once a hand has been dealt', () => {
    // Post-deal NO seat is fundable: a losing stack is a real stack, and a
    // zero stack is a bust for the elimination sweep to finish.
    const d = selectSeatsToFund({
      seats: [
        { id: 'losing', stack: 120 },
        { id: 'busted', stack: 0 },
        { id: 'winning', stack: 780 },
      ],
      target: 300,
      handRecorded: true,
      chipSupply: null,
    });
    expect(d.fund).toEqual([]);
  });

  it('still funds anything short of the target before the first hand', () => {
    // The pre-deal behaviour is the one legitimate use and must not change:
    // a reservation seat holds 0 until the wheel has finished asking.
    const d = selectSeatsToFund({
      seats: [
        { id: 'a', stack: 0 },
        { id: 'b', stack: 0 },
        { id: 'c', stack: 0 },
      ],
      target: 300,
      handRecorded: false,
      chipSupply: 900,
    });
    expect(d.fund).toEqual(['a', 'b', 'c']);
  });

  it('takes the conservative branch when it cannot tell', () => {
    // A failed probe must not be read as "no hands yet" - that is the branch
    // that mints. It must also not go silent: the 2026-08-28 lesson on this
    // same function was a discarded read error that stranded a table at zero.
    expect(fn).toMatch(/dealtErr\s*\?\s*true/);
    expect(fn).toMatch(/seat_stack_dealt_probe_failed/);
  });

  it('still refuses to lower a stack', () => {
    // An early-bird seat sits ABOVE the plain starting stack and flattening it
    // would destroy the bonus. Nothing here may write a stack downward.
    expect(fn).not.toMatch(/Number\(r\.stack\)\s*>\s*target/);
    expect(fn).toMatch(/\.update\(\{\s*stack:\s*target\s*\}\)/);
  });
});
