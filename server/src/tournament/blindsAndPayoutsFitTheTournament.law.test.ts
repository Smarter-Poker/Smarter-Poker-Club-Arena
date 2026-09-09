/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BLINDS AND THE PAYOUTS MUST FIT THE TOURNAMENT (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every pin here is a defect measured on production across 579 completed MTTs:
 *
 *   95.7% of events ran past the end of their own blind structure
 *   38.1% finished with all chips in play worth under 3 big blinds
 *   12.4% finished with a big blind larger than every chip in the event
 *    7.1% pinned the big blind at the DECIMAL(10,2) ceiling of 10,000,000
 *   a 334-runner field paid 8.9 places — 2.7% of the field
 *
 * If a change turns one of these red, it is re-shipping one of those.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERFLOW_RATIO,
  LADDER_CYCLES,
  MAX_OVERFLOW_RATIO,
  MIN_OVERFLOW_RATIO,
  buildLadder,
  observedStepRatio,
} from './blindLadder.js';
import {
  MAX_BLIND_VALUE,
  MIN_TOTAL_BB_IN_PLAY,
  capLevelToChipsInPlay,
  escalationFactor,
} from './blindEscalation.js';
import { MIN_PAID_PLACES, paidPlacesForField, payoutStructureForField } from './payoutStructure.js';
import { SCHEDULE_BLIND_PRESETS } from '../services/ScheduledTournamentService.js';
import { BLIND_STRUCTURES as RECURRING_BLIND_STRUCTURES } from '../services/TournamentRecurringService.js';

const STANDARD_40 = () =>
  buildLadder({
    startBigBlind: 50,
    speed: 'STANDARD',
    levels: 40,
    openingMinutes: 10,
    floorMinutes: 5,
  });

describe('blind ladders are deep enough for the tournament actually played', () => {
  it('every speed reaches at least 25 levels - events reach level 14 on average, 124 at worst', () => {
    for (const speed of Object.keys(LADDER_CYCLES) as Array<keyof typeof LADDER_CYCLES>) {
      const ladder = buildLadder({
        startBigBlind: 50,
        speed,
        levels: 30,
        openingMinutes: 8,
        floorMinutes: 3,
      });
      expect(ladder.length, `${speed} depth`).toBe(30);
    }
  });

  it('level 1 is exactly the advertised big blind, so lobby copy stays true', () => {
    const ladder = STANDARD_40();
    expect(ladder[0].bigBlind).toBe(50);
    expect(ladder[0].smallBlind).toBe(25);
  });

  it('is strictly increasing, and never doubles per level', () => {
    const ladder = STANDARD_40();
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1].bigBlind;
      const cur = ladder[i].bigBlind;
      expect(cur, `level ${i + 1} must exceed level ${i}`).toBeGreaterThan(prev);
      // The whole defect was a 2.0 ratio. A real ladder never gets near it.
      expect(cur / prev, `level ${i + 1} step`).toBeLessThan(1.75);
    }
  });

  it('every value is a whole chip and inside the DECIMAL(10,2) ceiling', () => {
    for (const l of STANDARD_40()) {
      expect(Number.isInteger(l.bigBlind), `bb ${l.bigBlind} whole`).toBe(true);
      expect(Number.isInteger(l.smallBlind), `sb ${l.smallBlind} whole`).toBe(true);
      expect(Number.isInteger(l.ante), `ante ${l.ante} whole`).toBe(true);
      expect(l.bigBlind).toBeLessThanOrEqual(MAX_BLIND_VALUE);
      expect(l.smallBlind).toBeGreaterThan(0);
    }
  });

  it('a 40-level STANDARD ladder never reaches the blind ceiling', () => {
    const ladder = STANDARD_40();
    expect(ladder[ladder.length - 1].bigBlind).toBeLessThan(MAX_BLIND_VALUE);
  });

  /**
   * THE PRESETS THAT ACTUALLY SHIP, not a sample.
   *
   * The first draft of this work passed every other pin in this file and still
   * generated a 25,000,000 big blind at TURBO level 30 — over MAX_BLIND_VALUE —
   * because only STANDARD was checked. A generator is only as safe as the
   * deepest ladder anybody actually configures, so both preset maps are
   * asserted directly.
   */
  it('every SHIPPED preset stays inside the blind ceiling at its full depth', () => {
    const presets = {
      ...SCHEDULE_BLIND_PRESETS,
      ...RECURRING_BLIND_STRUCTURES,
    } as Record<string, Array<{ bigBlind: number; smallBlind: number }>>;

    const names = Object.keys(presets);
    expect(names.length, 'presets found').toBeGreaterThan(3);

    for (const name of names) {
      const ladder = presets[name];
      expect(Array.isArray(ladder) && ladder.length > 0, `${name} is a real ladder`).toBe(true);
      const top = ladder[ladder.length - 1];
      expect(top.bigBlind, `${name} deepest level ${top.bigBlind} <= ceiling`).toBeLessThanOrEqual(
        MAX_BLIND_VALUE
      );
      for (const l of ladder) {
        expect(Number.isInteger(l.bigBlind), `${name} bb whole`).toBe(true);
        expect(l.bigBlind, `${name} bb positive`).toBeGreaterThan(0);
      }
    }
  });

  it('every SHIPPED preset is deep enough to cover the level events actually reach', () => {
    // Production reached level 14 on average. A ladder shallower than that puts
    // the median event back on the overflow path this work exists to retire.
    for (const [name, ladder] of Object.entries(SCHEDULE_BLIND_PRESETS)) {
      expect(ladder.length, `${name} depth`).toBeGreaterThanOrEqual(16);
    }
  });

  it('durations taper but never below the floor', () => {
    const ladder = STANDARD_40();
    expect(ladder[0].durationMinutes).toBe(10);
    for (const l of ladder) expect(l.durationMinutes).toBeGreaterThanOrEqual(5);
    expect(ladder[ladder.length - 1].durationMinutes).toBeLessThanOrEqual(10);
  });
});

describe('overflow past a structure follows the ladder, not a doubling', () => {
  it('escalationFactor defaults to 1.4, never 2', () => {
    // index === persistedLength is the first overflow level: exponent 1.
    expect(escalationFactor(10, 10)).toBeCloseTo(1.4, 5);
    expect(escalationFactor(10, 10)).not.toBeCloseTo(2, 5);
  });

  it('a supplied ratio is used, and a nonsense ratio falls back to 1.4', () => {
    expect(escalationFactor(10, 10, 1.25)).toBeCloseTo(1.25, 5);
    expect(escalationFactor(10, 10, 0)).toBeCloseTo(1.4, 5);
    expect(escalationFactor(10, 10, Number.NaN)).toBeCloseTo(1.4, 5);
  });

  it('is still anchored to the PERSISTED length - the same answer after a restart', () => {
    // The 2026-08-26 defect: a mutating anchor compounded the factor.
    expect(escalationFactor(13, 10, 1.4)).toBeCloseTo(Math.pow(1.4, 4), 5);
    expect(escalationFactor(14, 10, 1.4)).toBeCloseTo(Math.pow(1.4, 5), 5);
  });

  it('observedStepRatio reads a real ladder and stays inside its clamp', () => {
    const ratio = observedStepRatio(STANDARD_40().map((l) => l.bigBlind));
    expect(ratio).toBeGreaterThanOrEqual(MIN_OVERFLOW_RATIO);
    expect(ratio).toBeLessThanOrEqual(MAX_OVERFLOW_RATIO);
    expect(ratio).toBeLessThan(2);
  });

  it('a degenerate structure cannot hand the overflow a runaway ratio', () => {
    expect(observedStepRatio([100, 100_000_000])).toBeLessThanOrEqual(MAX_OVERFLOW_RATIO);
    expect(observedStepRatio([])).toBe(DEFAULT_OVERFLOW_RATIO);
    expect(observedStepRatio([50])).toBe(DEFAULT_OVERFLOW_RATIO);
    expect(observedStepRatio([50, 50, 50])).toBe(DEFAULT_OVERFLOW_RATIO);
  });
});

describe('a big blind may never exceed the chips that exist', () => {
  // The measured production shape: 500 entrants x 12,000 chips = 6,000,000
  // total, and the event finished with a big blind of 10,000,000.
  const TOTAL = 500 * 12_000;

  it('caps the exact production case', () => {
    const capped = capLevelToChipsInPlay(
      { smallBlind: 5_000_000, bigBlind: 10_000_000, ante: 1_000_000 },
      TOTAL
    );
    expect(capped.capped).toBe(true);
    expect(capped.bigBlind).toBeLessThanOrEqual(TOTAL / MIN_TOTAL_BB_IN_PLAY);
    // And what is left is a playable game, not a lottery.
    expect(TOTAL / capped.bigBlind).toBeGreaterThanOrEqual(MIN_TOTAL_BB_IN_PLAY - 1);
    expect(capped.smallBlind).toBeLessThan(capped.bigBlind);
  });

  it('a shared ceiling cannot survive as an equal small and big blind', () => {
    const capped = capLevelToChipsInPlay(
      { smallBlind: MAX_BLIND_VALUE, bigBlind: MAX_BLIND_VALUE, ante: MAX_BLIND_VALUE },
      TOTAL
    );
    expect(capped.bigBlind).toBe(300_000);
    expect(capped.smallBlind).toBe(150_000);
    expect(capped.smallBlind).toBeLessThan(capped.bigBlind);
  });

  it('leaves a healthy level completely untouched', () => {
    const capped = capLevelToChipsInPlay({ smallBlind: 100, bigBlind: 200, ante: 25 }, TOTAL);
    expect(capped.capped).toBe(false);
    expect(capped.bigBlind).toBe(200);
    expect(capped.smallBlind).toBe(100);
    expect(capped.ante).toBe(25);
  });

  it('preserves the shape of the level it caps', () => {
    const capped = capLevelToChipsInPlay(
      { smallBlind: 500_000, bigBlind: 1_000_000, ante: 125_000 },
      TOTAL
    );
    expect(capped.capped).toBe(true);
    // sb ~ bb/2 and ante ~ bb/8 survive the scaling.
    expect(capped.smallBlind / capped.bigBlind).toBeCloseTo(0.5, 1);
    expect(capped.ante / capped.bigBlind).toBeCloseTo(0.125, 1);
  });

  it('an unknown chip total caps NOTHING - never guess a supply', () => {
    for (const bad of [null, undefined, 0, -1, Number.NaN]) {
      const capped = capLevelToChipsInPlay(
        { smallBlind: 5e6, bigBlind: 1e7, ante: 0 },
        bad as never
      );
      expect(capped.capped, `total ${String(bad)}`).toBe(false);
      expect(capped.bigBlind).toBe(1e7);
    }
  });

  it('never caps below a postable blind', () => {
    const capped = capLevelToChipsInPlay({ smallBlind: 50, bigBlind: 100, ante: 10 }, 20);
    expect(capped.bigBlind).toBeGreaterThanOrEqual(2);
    expect(capped.smallBlind).toBeGreaterThanOrEqual(1);
  });
});

describe('payout depth scales with the field', () => {
  it('a 334-runner field pays far more than the 8.9 places it used to', () => {
    expect(paidPlacesForField(334)).toBeGreaterThanOrEqual(45);
  });

  it('roughly 15% of the field, across the measured buckets', () => {
    expect(paidPlacesForField(20)).toBe(3);
    expect(paidPlacesForField(40)).toBe(6);
    expect(paidPlacesForField(100)).toBe(15);
    expect(paidPlacesForField(500)).toBe(75);
    expect(paidPlacesForField(1000)).toBe(150);
  });

  it('never pays fewer than the minimum, nor every player in the field', () => {
    for (const field of [1, 2, 3, 4, 5, 6, 9, 10, 11, 50, 333, 1000]) {
      const places = paidPlacesForField(field);
      expect(places, `field ${field} min`).toBeGreaterThanOrEqual(Math.min(MIN_PAID_PLACES, field));
      expect(places, `field ${field} never every player`).toBeLessThanOrEqual(field);
    }
  });

  it('percentages always sum to exactly 100, at every depth', () => {
    for (const field of [6, 20, 47, 100, 334, 500, 1000]) {
      const s = payoutStructureForField(field);
      const total = s.reduce((acc, p) => acc + p.percentage, 0);
      expect(Math.round(total * 100) / 100, `field ${field} sums to 100`).toBe(100);
    }
  });

  it('is monotonically decreasing - a later place never out-earns an earlier one', () => {
    const s = payoutStructureForField(334);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].percentage, `place ${i + 1} <= place ${i}`).toBeLessThanOrEqual(
        s[i - 1].percentage
      );
    }
  });

  it('places are 1..n with no gap and no duplicate', () => {
    const s = payoutStructureForField(334);
    expect(s.map((p) => p.place)).toEqual(s.map((_, i) => i + 1));
  });

  it('every place pays something - a 0% paid place is not a paid place', () => {
    for (const field of [20, 100, 500, 1000]) {
      for (const p of payoutStructureForField(field)) {
        expect(p.percentage, `field ${field} place ${p.place}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the familiar shape at nine places (close to the old NINE preset)', () => {
    const s = payoutStructureForField(60); // 15% of 60 = 9
    expect(s.length).toBe(9);
    // First place near 30%, as the long-standing preset had it.
    expect(s[0].percentage).toBeGreaterThan(25);
    expect(s[0].percentage).toBeLessThan(36);
  });
});
