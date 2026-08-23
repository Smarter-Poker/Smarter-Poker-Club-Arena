/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AFTER THE WHEEL: CHIPS, THEN BUTTON, THEN CARDS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-21: "AFTER THE SPIN COMPLETES, CHIP STACKS GET ADDED, BUTTON
 * RANDOMLY ASSIGNED AND THE SPIN STARTS!"
 *
 * Two things were wrong before this.
 *
 * 1. THE STACKS ARRIVED EARLY. A seat is a reservation at zero chips until the
 *    multiplier is known — stack depth belongs to the tier, and spin tiers run
 *    300/400/500, so there is no honest number to seat someone with before the
 *    draw. But the credit ran at start, BEFORE the reveal broadcast, so the
 *    stacks landed on the felt while the wheel was still turning. The table
 *    had already answered the question the wheel was in the middle of asking.
 *
 * 2. THE BUTTON WAS NOT RANDOM. The first hand's dealer was `sortedSeats[0]`,
 *    the lowest occupied seat. On a 3-handed Spin that is a genuine positional
 *    edge, and in a seat-first format the low seat goes to whoever clicked
 *    first — so the edge was awarded for reaction time.
 *
 * The ordering is enforced by the ENGINE HOLD, not by hope: the hold now runs
 * to `spinRevealToDealMs()`, which includes the two post-reveal beats. Holding
 * only for the wheel would leave the engine free to deal in the same instant
 * the stacks are being written, and the deal wins that race.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  SPIN_REVEAL,
  spinRevealTotalMs,
  spinPostRevealMs,
  spinRevealToDealMs,
} from '../../src/config/spinSpec';

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const MANAGER = strip(read('server/src/tournament/TournamentManagerBase.ts'));
const DEALING = strip(read('server/src/engine/ServerTableEngineDealing.ts'));
const ENGINE = strip(read('server/src/engine/ServerTableEngineBase.ts'));

describe('the hold covers the whole sequence, not just the wheel', () => {
  it('deal time is the reveal PLUS the chip drop and the button draw', () => {
    expect(spinPostRevealMs()).toBe(SPIN_REVEAL.CHIP_DROP_MS + SPIN_REVEAL.BUTTON_DRAW_MS);
    expect(spinRevealToDealMs()).toBe(spinRevealTotalMs() + spinPostRevealMs());
    expect(spinRevealToDealMs()).toBeGreaterThan(spinRevealTotalMs());
  });

  it('the engine is held to the DEAL time, never merely to the wheel time', () => {
    // The distinction is the entire fix. `holdUntil = revealAt +
    // spinRevealTotalMs()` would expire the moment the wheel stops, which is
    // exactly when the chips are still being written.
    expect(MANAGER).toMatch(/const holdUntil = revealAt \+ spinRevealToDealMs\(\)/);
    expect(MANAGER).toMatch(/engine\.holdDealingUntil\(holdUntil\)/);
  });

  it('both post-reveal beats have real duration, or the order is decorative', () => {
    expect(SPIN_REVEAL.CHIP_DROP_MS).toBeGreaterThan(0);
    expect(SPIN_REVEAL.BUTTON_DRAW_MS).toBeGreaterThan(0);
  });
});

describe('the stacks wait for the wheel', () => {
  it('a spin with a drawn multiplier DEFERS the credit', () => {
    expect(MANAGER).toMatch(/deferStacksForSpinReveal/);
    const fn = MANAGER.slice(MANAGER.indexOf('private async deferStacksForSpinReveal'));
    expect(fn.slice(0, 700)).toMatch(/isSpin && Number\(tournament\?\.spin_multiplier\) > 0/);
  });

  it('everything else is still credited at start', () => {
    // The negation matters: a non-spin table must not sit at zero chips
    // waiting for a wheel that will never turn.
    expect(MANAGER).toMatch(
      /if \(!\(await this\.deferStacksForSpinReveal\(tournament\)\)\) \{\s*await this\.creditSeatStacks\(tournament\);/
    );
  });

  it('a spin that reached start WITHOUT a multiplier is credited immediately too', () => {
    // Same reason. A missing draw is a bug, but stranding three players on
    // zero chips forever is a worse one.
    const fn = MANAGER.slice(MANAGER.indexOf('private async deferStacksForSpinReveal'));
    expect(fn.slice(0, 700)).toMatch(/> 0/);
  });

  it('the credit is idempotent, because it runs from a timer', () => {
    // A restart between the reveal and the credit has to be recoverable by
    // simply calling it again, so it may only ever write the value start
    // already decided, and only to seats that disagree.
    //
    // 2026-08-22: "disagree" tightened from `!== target` to `< target` — the
    // credit strictly RAISES a reservation seat to the decided stack and never
    // lowers one, because an early-bird seat (starting chips + bonus) sits
    // ABOVE the plain starting stack and flattening it would destroy the
    // bonus. Idempotence is unchanged: a healthy seat still writes nothing.
    const fn = MANAGER.slice(MANAGER.indexOf('protected async creditSeatStacks'));
    const body = fn.slice(0, 1600);
    expect(body).toMatch(/Number\(r\.stack\) < target/);
    expect(body).toMatch(/if \(stale\.length === 0\) return 0;/);
    expect(body).toMatch(/\.update\(\{ stack: target \}\)/);
  });

  it('a failed credit is reported, never thrown into the start path', () => {
    const fn = MANAGER.slice(MANAGER.indexOf('protected async creditSeatStacks'));
    expect(fn.slice(0, 1800)).toMatch(/reportError/);
  });
});

describe('the three beats, in order, each announced', () => {
  it('chips land when the reveal ends', () => {
    expect(MANAGER).toMatch(/const chipsAt = revealAt \+ spinRevealTotalMs\(\)/);
    expect(MANAGER).toMatch(/type: 'spin_chips'/);
  });

  it('the button is drawn one chip-drop later', () => {
    expect(MANAGER).toMatch(/const buttonAt = chipsAt \+ SPIN_REVEAL\.CHIP_DROP_MS/);
    expect(MANAGER).toMatch(/type: 'spin_button'/);
  });

  it('the button beat carries the seat, so a client can animate it', () => {
    const block = MANAGER.slice(MANAGER.indexOf("type: 'spin_button'"));
    expect(block.slice(0, 400)).toMatch(/dealer_seat: seat/);
  });

  it('a dead tournament cannot have chips written into it seconds later', () => {
    expect(MANAGER).toMatch(/const stillLive = \(\) => this\.isRunning\(\)/);
    expect(MANAGER).toMatch(/if \(!stillLive\(\)\) return;/);
  });

  it('the timers never hold the process open for theatre', () => {
    expect(MANAGER).toMatch(/unref/);
  });

  it('a missed chip drop self-heals rather than stranding the table', () => {
    // Without this a transient DB error at beat 1 leaves every seat on zero
    // chips and NO hand can ever start — the table just sits there.
    expect(MANAGER).toMatch(/safety net/i);
    expect(MANAGER).toMatch(/buttonAt \+ SPIN_REVEAL\.BUTTON_DRAW_MS \+ \d+/);
  });
});

describe('the button is drawn, not awarded to the low seat', () => {
  it('the tournament picks uniformly from the occupied seats', () => {
    const block = MANAGER.slice(MANAGER.indexOf('const seats = engine.getOccupiedSeatNumbers()'));
    expect(block.slice(0, 800)).toMatch(
      /seats\[Math\.floor\(Math\.random\(\) \* seats\.length\)\]/
    );
    expect(block.slice(0, 800)).toMatch(/engine\.setFirstButtonSeat\(seat\)/);
  });

  it('an empty table is skipped rather than crashing the draw', () => {
    const block = MANAGER.slice(MANAGER.indexOf('const seats = engine.getOccupiedSeatNumbers()'));
    expect(block.slice(0, 300)).toMatch(/if \(seats\.length === 0\) continue;/);
  });

  it('the engine exposes the seats instead of the tournament re-querying them', () => {
    // A second query would be a second source of truth for who is sitting
    // where, and they would disagree the moment someone left.
    expect(ENGINE).toMatch(/public getOccupiedSeatNumbers\(\): number\[\]/);
  });

  it('the FIRST hand honours the draw', () => {
    expect(DEALING).toMatch(/const drawnButton = this\.forcedFirstButtonSeat;/);
    expect(DEALING).toMatch(/const dealerSeat = drawnIsSeated/);
  });

  it('it is consumed exactly once, so hand two rotates normally', () => {
    const at = DEALING.indexOf('const drawnButton = this.forcedFirstButtonSeat;');
    expect(at).toBeGreaterThan(-1);
    // Cleared immediately after being read, before anything can throw.
    expect(DEALING.slice(at, at + 200)).toMatch(/this\.forcedFirstButtonSeat = null;/);
  });

  it('a drawn seat that emptied falls back to normal rotation', () => {
    // A player can leave between the draw and the deal; the button must not
    // strand itself on an empty seat.
    expect(DEALING).toMatch(/const drawnIsSeated =[\s\S]{0,120}sortedSeats\.includes\(drawnButton\)/);
    expect(DEALING).toMatch(/: prevButtonSeat > 0/);
  });

  it('the setter rejects nonsense rather than storing it', () => {
    const fn = ENGINE.slice(ENGINE.indexOf('public setFirstButtonSeat'));
    expect(fn.slice(0, 400)).toMatch(/Number\.isFinite\(seat\) && seat > 0/);
  });
});
