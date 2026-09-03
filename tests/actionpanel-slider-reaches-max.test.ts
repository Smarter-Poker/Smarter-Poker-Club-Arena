/**
 * The bet slider could not reach its own maximum — you could not shove with it.
 *
 * `<input type="range">` only emits values on the grid `min + n*step`. The
 * raise slider is `min={minRaise} max={maxRaise} step={bigBlind}`, so unless
 * `maxRaise - minRaise` is an exact multiple of the big blind, dragging fully
 * right stops SHORT and the browser never produces maxRaise. A stack is only an
 * exact multiple of the blind before the first hand, so in practice hero could
 * never slide to all-in — or, in pot-limit, to the pot cap. The `+` button and
 * the presets could still get there, which is exactly why it survived: the
 * panel looked like it worked, and the vertical slider even printed a top cap
 * label its own control could not produce.
 *
 * The same grid bug is in the buy-in slider (max is clamped to what the player
 * can afford, which is rarely a round number of blinds) and the insurance
 * coverage slider (step is derived as max/100).
 */
import { describe, it, expect } from 'vitest';

/** What a browser actually emits when a range input is dragged fully right. */
function rangeMaxReachable(min: number, max: number, step: number): number {
  if (step <= 0) return max;
  const n = Math.floor((max - min) / step);
  return Math.round((min + n * step) * 1e6) / 1e6;
}

/** The production rule, mirrored: the last grid stop means "all the way". */
function gridMax(min: number, max: number, step: number): number {
  if (!(max > min)) return max;
  const steps = Math.floor((max - min) / step);
  return Math.round((min + steps * step) * 100) / 100;
}

function sliderResolves(raw: number, min: number, max: number, step: number): number {
  return raw >= gridMax(min, max, step) ? max : raw;
}

const TABLES = [
  { name: 'NLH 1/2, stack exactly 200', bb: 2, min: 12, max: 200 },
  { name: 'NLH 1/2, stack 187.50', bb: 2, min: 12, max: 187.5 },
  { name: 'NLH 5/10, stack 431', bb: 10, min: 60, max: 431 },
  { name: 'PLO 1/2, pot cap 47', bb: 2, min: 12, max: 47 },
  { name: 'NLH 0.5/1, stack 63.25', bb: 1, min: 3, max: 63.25 },
  { name: 'NLH 25/50, stack 4137', bb: 50, min: 150, max: 4137 },
];

describe('the raise slider can be dragged to the maximum', () => {
  it('DEMONSTRATES the bug: the raw grid falls short on real stacks', () => {
    const short = TABLES.filter((t) => rangeMaxReachable(t.min, t.max, t.bb) < t.max);
    // Five of six realistic tables. Only the contrived round stack lands on it.
    expect(short.length).toBeGreaterThanOrEqual(4);
  });

  for (const t of TABLES) {
    it(`reaches the top on ${t.name}`, () => {
      const dragged = rangeMaxReachable(t.min, t.max, t.bb);
      expect(sliderResolves(dragged, t.min, t.max, t.bb)).toBe(t.max);
    });

    it(`does not distort any position below the top on ${t.name}`, () => {
      // Every lower grid stop must still mean exactly itself — the fix must not
      // drag nearby values up to the maximum.
      const top = gridMax(t.min, t.max, t.bb);
      for (let v = t.min; v < top; v += t.bb) {
        const value = Math.round(v * 100) / 100;
        expect(sliderResolves(value, t.min, t.max, t.bb)).toBe(value);
      }
    });
  }

  it('is a no-op when there is no raise room at all', () => {
    expect(sliderResolves(50, 50, 50, 2)).toBe(50);
  });
});

describe('the buy-in slider can be dragged to the maximum', () => {
  // maxBuyIn is clamped to the player's balance, so it is rarely a round
  // number of blinds even though the table's own min/max are.
  const CASES = [
    { bb: 2, min: 40, max: 400 },
    { bb: 2, min: 40, max: 137.5 },
    { bb: 10, min: 200, max: 1234 },
    { bb: 1, min: 20, max: 63.25 },
  ];
  for (const c of CASES) {
    it(`reaches ${c.max} at ${c.bb} BB`, () => {
      const dragged = rangeMaxReachable(c.min, c.max, c.bb);
      expect(sliderResolves(dragged, c.min, c.max, c.bb)).toBe(c.max);
    });
  }
});

describe('the insurance coverage slider can be dragged to full coverage', () => {
  const COVERAGES = [250, 199, 1055, 1050, 7, 100_000];
  for (const max of COVERAGES) {
    it(`reaches full coverage of ${max}`, () => {
      const step = Math.max(1, Math.floor(max / 100));
      const dragged = rangeMaxReachable(0, max, step);
      const resolved = dragged >= Math.floor(max / step) * step ? max : dragged;
      expect(resolved).toBe(max);
    });
  }
});
