/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SHINE IS AN "ON THE CLOCK" CUE, NOT AMBIENT LIFE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding: "THE 'SHINE EFFECT' THAT GOES OVER EVERY PLAYER,
 * EVERY COUPLE OF SECONDS ... SHOULD ONLY APPEAR WHEN IT'S A PLAYER'S TURN, AND
 * THEY HAVE BEEN ON THE CLOCK FOR AT LEAST 3 SECONDS. IT SHOULD NEVER APPEAR ON
 * IDLE PLAYERS, OR PLAYERS IF THE ACTION ISN'T ON THEM."
 *
 * The holo scan line (`.seat__avatar--holo::after`) used to run on every VIP
 * seat forever, phased per seat by breathingStyle(), which is exactly what made
 * "every player, every couple of seconds". These pins hold the three facts that
 * together make it a cue:
 *
 *   1. The class is only applied when the seat is acting (`showHolo` requires
 *      `holoOnClockDelayMs !== null`, which is only non-null for `isActingNow`).
 *   2. The first sweep waits three seconds on the clock, measured on the
 *      engine's clock and frozen once per turn so a shrinking value cannot
 *      re-time the running animation.
 *   3. breathingStyle() no longer hands the shine an idle phase.
 *
 * Source pins, bounded by structure (tests/helpers/sourceWindow.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankNonCode, sliceCssRule, sliceMethod } from '../helpers/sourceWindow';

const SEAT_SLOT = readFileSync(
  resolve(__dirname, '../../src/components/table/SeatSlot.tsx'),
  'utf8'
);
const CODE = blankNonCode(SEAT_SLOT);
const CSS = readFileSync(
  resolve(__dirname, '../../src/components/table/avatarChoreography.css'),
  'utf8'
);

describe('the shine only appears on the seat whose turn it is', () => {
  it('waits three seconds on the clock before the first sweep', () => {
    expect(CODE).toMatch(/const HOLO_ON_CLOCK_MS = 3_000;/);
  });

  it('is armed only for the acting seat - null for everyone else', () => {
    expect(CODE).toMatch(
      /let holoOnClockDelayMs: number \| null = isActingNow \? HOLO_ON_CLOCK_MS : null;/
    );
  });

  it('the class needs eligible art AND a seat on the clock', () => {
    expect(CODE).toMatch(/const showHolo = holoEligible && holoOnClockDelayMs !== null;/);
    // The class name itself must still hang off showHolo, not off VIP status.
    expect(SEAT_SLOT).toMatch(/showHolo \? ' seat__avatar--holo' : ''/);
    expect(SEAT_SLOT).not.toMatch(/isVipBust \? ' seat__avatar--holo'/);
  });

  it('the delay is frozen once per turn, on the same anchor as the countdown ring', () => {
    // A value that shrinks with every tick re-times the running animation and
    // brings the sweep forward of three seconds. It is computed when the
    // turn's paint anchor is created and read back from it afterwards.
    expect(CODE).toMatch(
      /holoDelayMs: Math\.max\(0, HOLO_ON_CLOCK_MS - \(rawElapsedMs - baseAtFirstPaint\)\)/
    );
    expect(CODE).toMatch(/holoOnClockDelayMs = turnPaintAnchorRef\.current\.holoDelayMs;/);
    expect(CODE).not.toMatch(/holoOnClockDelayMs = Math\.max\(0, HOLO_ON_CLOCK_MS - elapsedMs\)/);
  });

  it('breathingStyle no longer spreads an idle shine phase round the table', () => {
    const breathing = blankNonCode(sliceMethod(SEAT_SLOT, 'function breathingStyle('));
    expect(breathing).not.toMatch(/sp-holo-delay/);
    expect(CODE).not.toMatch(/HOLO_CYCLE_S/);
  });

  it('the CSS sweep takes its delay from the seat, defaulting to three seconds', () => {
    const rule = sliceCssRule(CSS, '.seat__avatar--holo::after {');
    expect(rule).toMatch(/animation-delay: var\(--sp-holo-delay, 3s\);/);
    expect(rule).toMatch(/spAvatarHolo/);
  });
});
