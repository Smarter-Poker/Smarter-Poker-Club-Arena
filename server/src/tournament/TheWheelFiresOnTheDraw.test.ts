/**
 * The wheel announces the booked draw before table-building work.
 *
 * Dan's animation should start as soon as possible after the third paid seat.
 * Phase 3 S06 requires the announced result to be durable first. The old
 * pre-settlement source pin admitted a 2x announcement followed by a booked
 * 10x prize, or an announcement whose settlement failed entirely.
 * SpinRevealSettlementBoundary.test.ts reproduces both with production code.
 * The reserve receipt is therefore a reveal precondition; the row projection,
 * roster updates and table build still run underneath the existing hold.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinRevealToDealMs, spinPostRevealMs } from '../config/spinSpec.js';

const here = new URL('.', import.meta.url).pathname;
const BASE = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
/** Executable code only — a pin must never pass on the prose above it. */
const CODE = BASE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the reveal is emitted on the booked draw', () => {
  it('emits after settlement has confirmed the booked draw', () => {
    const emit = CODE.indexOf('spin_reveal_early_emit');
    const settle = CODE.indexOf("supabase.rpc('fn_spin_draw_and_settle_atomic'");
    expect(emit, 'the early emit is missing').toBeGreaterThan(-1);
    expect(settle, 'the settle call moved - re-check this pin').toBeGreaterThan(-1);
    expect(emit, 'the wheel must name the confirmed settlement result').toBeGreaterThan(settle);
    const settledGate = CODE.indexOf('if (!fundedSpin)', settle);
    expect(settledGate).toBeGreaterThan(settle);
    expect(emit).toBeGreaterThan(settledGate);
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
