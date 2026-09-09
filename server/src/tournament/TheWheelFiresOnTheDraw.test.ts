/**
 * The wheel announces the booked draw before table-building work.
 *
 * Dan, 2026-08-30: "AS SOON AS THE 3RD SEAT IS PAID FOR THE ANIMATION SHOULD
 * START AS SOON AS POSSIBLE."
 *
 * Measured after round 16, 229 spins, third paid seat to `started_at`:
 *
 *     min 1.57s   p25 2.72s   p50 3.02s   p90 4.70s
 *
 * (Round 15 was p50 5.4s, so the one-second lane took ~2.4s out of it.) What
 * remained was the START WORK, and the broadcast sat at the END of it —
 * behind settlement, the spin row write, a roster read plus a
 * per-player update per seat, the stack credit and the table build.
 *
 * NONE of that is a precondition for showing three players a spinning wheel.
 * The immutable funded receipt is. Every number the packet carries —
 * multiplier, buy-in, prize pool and locked tiers — is proven when that one
 * transaction returns. The remaining projection is a precondition for
 * DEALING, and dealing is already held by the reveal hold.
 *
 * So the reveal goes out on the draw, and the bookkeeping runs underneath it
 * inside a hold that was always there.
 *
 * THE TWO THINGS THAT MAKE THAT SAFE, both pinned below:
 *
 *   1. Once the moment is public it does not move. Three wheels are turning
 *      on those numbers; `resolveSpinReveal` is frozen by `spinRevealEmitted`
 *      so the later pass cannot re-anchor them.
 *   2. The HOLD may still be extended, because a client is allowed to finish
 *      early and wait ("faster than the budget is allowed"), but never to be
 *      dealt over. `effectiveHold` is one-sided for exactly that reason.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinRevealToDealMs, spinPostRevealMs } from '../config/spinSpec.js';

const here = new URL('.', import.meta.url).pathname;
const BASE = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
/** Executable code only — a pin must never pass on the prose above it. */
const CODE = BASE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the reveal is emitted from the immutable funded draw receipt', () => {
  it('waits for the funded receipt, then emits before presentation writes', () => {
    const emit = CODE.indexOf('spin_reveal_early_emit');
    const settle = CODE.indexOf("supabase.rpc('fn_spin_draw_and_settle_atomic'");
    const presentation = CODE.indexOf(
      ".from('tournaments')",
      CODE.indexOf('const spinPresentationPatch')
    );
    expect(emit, 'the early emit is missing').toBeGreaterThan(-1);
    expect(settle, 'the atomic settlement call moved - re-check this pin').toBeGreaterThan(-1);
    const settledGate = CODE.indexOf('if (!fundedSpin)', settle);
    expect(settledGate, 'the parsed settlement receipt gate is missing').toBeGreaterThan(settle);
    expect(settle, 'uncommitted money may never be revealed').toBeLessThan(emit);
    expect(emit, 'the wheel must name a proven settlement receipt').toBeGreaterThan(settledGate);
    expect(presentation, 'the presentation update moved').toBeGreaterThan(-1);
    expect(emit, 'the wheel must not wait on presentation decoration').toBeLessThan(presentation);
  });

  it('emits before the table build, which is the slowest step it used to wait on', () => {
    const emit = CODE.indexOf('spin_reveal_early_emit');
    const tables = CODE.indexOf('await this.createTablesAndSeatPlayers(');
    expect(tables).toBeGreaterThan(-1);
    expect(emit).toBeLessThan(tables);
  });

  it('reaches the tables the paid seats are already sitting at', () => {
    /* Read for free alongside the paid-entry roster — a seat-first player is
       on the felt before the game starts, so no extra round trip is needed to
       find them. */
    expect(CODE).toContain(".select('user_id, table_id')");
    expect(CODE).toContain('this.seatFirstTableIds = Array.from(');
    expect(CODE).toMatch(/for \(const tableId of this\.seatFirstTableIds\)/);
  });

  it('carries every field the wheel needs from the booked draw', () => {
    const emitBlock = CODE.slice(
      CODE.indexOf('if (this.seatFirstTableIds.length > 0 && spinMultiplier > 0)'),
      CODE.indexOf('spin_reveal_early_emit')
    );
    for (const field of [
      'multiplier: spinMultiplier',
      'buy_in: buyIn',
      'prize_pool: prizePool',
      'reveal_at: revealAt',
      'hold_until: holdUntil',
      /* The EARLY packet still announces the planned hold - three wheels turn
         on those numbers and moving them is worse - but its REPLAY window has
         to cover the hold the engine will actually keep, or a reconnect inside
         the extension finds the packet already dropped. Pin moved 2026-09-02
         with the fix, per §10.6. */
      'replay_until: Math.max(holdUntil, Date.now() + spinPostRevealMs())',
    ]) {
      expect(emitBlock, `${field} missing from the early packet`).toContain(field);
    }
  });
});

describe('a public moment does not move', () => {
  it('resolveSpinReveal is frozen once the reveal has gone out', () => {
    expect(CODE).toContain('protected spinRevealEmitted = false;');
    expect(CODE).toMatch(
      /if \(this\.spinRevealEmitted\) \{\s*return \{ revealAt: this\.spinRevealAt, holdUntil: this\.spinHoldUntil \};/
    );
  });

  it('the freeze is checked BEFORE the re-anchor could fire', () => {
    const freeze = CODE.indexOf('if (this.spinRevealEmitted) {');
    /* 2026-08-31 (audit part 2): the threshold moved out of an inline
       hold comparison and into spinRevealWindow, because expressing it in
       terms of a DERIVED quantity is how it silently inverted. The ordering
       this test guards is unchanged - the freeze must still be read before
       the re-anchor can fire. */
    const reanchor = CODE.indexOf('if (wouldSkipABeat) {');
    expect(freeze).toBeGreaterThan(-1);
    expect(reanchor).toBeGreaterThan(-1);
    expect(freeze, 'a freeze after the re-anchor would not freeze anything').toBeLessThan(reanchor);
  });

  it('the later pass does not re-announce a table the early pass already reached', () => {
    expect(CODE).toContain(
      'if (this.spinRevealEmitted && this.seatFirstTableIds.includes(tableId)) continue;'
    );
  });
});

describe('the deal is still held, and the hold can only grow', () => {
  it('the hold is one-sided: never shorter than the post-reveal beats', () => {
    expect(CODE).toContain(
      'const effectiveHold = Math.max(holdUntil, Date.now() + spinPostRevealMs());'
    );
  });

  it('every engine is held, whether or not it was announced to', () => {
    const loop = CODE.slice(CODE.indexOf('for (const [tableId, engine] of this.tableEngines)'));
    const hold = loop.indexOf('engine.holdDealingUntil(effectiveHold);');
    const skip = loop.indexOf('continue;');
    expect(hold).toBeGreaterThan(-1);
    expect(hold, 'the hold must be applied before the re-announce skip').toBeLessThan(skip);
  });

  it('the arithmetic still leaves the whole wheel inside the hold', () => {
    expect(spinRevealToDealMs()).toBeGreaterThan(spinPostRevealMs());
  });
});
