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
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const BASE = fs
  .readFileSync(path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const fn = sliceMethod(BASE, 'protected async creditSeatStacks(');

describe('creditSeatStacks', () => {
  it('asks whether play has started before deciding what is stale', () => {
    // The whole defect was asking `stack < target` unconditionally.
    expect(fn).toMatch(/from\(\s*'hand_history'\s*\)/);
    expect(fn).toMatch(/playUnderWay/);
  });

  it('never tops a seat up to the target once a hand has been dealt', () => {
    // Post-deal the only fundable seat is one still sitting on zero: a losing
    // stack is a real stack and must be left alone.
    expect(fn).toMatch(/playUnderWay\s*\?\s*Number\(r\.stack\)\s*<=\s*0/);
  });

  it('still funds anything short of the target before the first hand', () => {
    // The pre-deal behaviour is the one legitimate use and must not change:
    // a reservation seat holds 0 until the wheel has finished asking.
    expect(fn).toMatch(/:\s*Number\(r\.stack\)\s*<\s*target/);
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
