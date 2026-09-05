/**
 * CHIPS COLOUR UP TO THE FEWEST CHIPS, AND THEY ADD BACK UP TO THE BET.
 * ============================================================================
 * Dan 2026-08-23: "IF A PLAYER RAISES, OR CALLS TO 7, ONE RED AND TWO WHITE
 * CHIPS SHOULD BE ADDED IN FRONT OF THEM. IF TWO PLAYERS CALL, THERE SHOULD BE
 * 21 CHIPS IN THE POT PLUS THE BLINDS, THE POT SHOULD SHOW THE AMOUNT OF CHIPS
 * NECESSARY TO EQUAL THE TOTAL CHIPS IN THE POT... ALWAYS COLORING UP TO USE
 * THE FEWEST AMOUNT OF CHIPS IN THE POT."
 *
 * Two properties matter and they are easy to lose independently:
 *
 *   1. FEWEST. Greedy descent over a divisibility-chained ladder is provably
 *      minimal, so the brute-force cross-check below is not decoration - it is
 *      what proves the ladder still chains after anyone edits it.
 *
 *   2. EXACT. The three ladders this module replaced all clamped a stack's
 *      count for "visual clarity" and then subtracted the CLAMPED count from
 *      the remainder, so the chips drawn never summed to the bet. Every case
 *      here re-sums the breakdown against the input.
 */

import { describe, it, expect } from 'vitest';
import {
  CHIP_DENOMINATIONS,
  CHIP_DENOMINATIONS_DESC,
  breakChips,
  totalChipCount,
  chipDenominationFor,
  visualChipStacks,
  SMALLEST_CHIP,
  type ChipBreakdown,
} from '../../src/lib/chipDenominations';

/** [value, count] pairs, highest first - the shape assertions read best in. */
const pairs = (b: ChipBreakdown): [number, number][] =>
  b.chips.map(({ denom, count }) => [denom.value, count]);

/** Chip value + remainder, in cents, so float drift cannot hide a lost chip. */
const resum = (b: ChipBreakdown): number =>
  b.chips.reduce((cents, { denom, count }) => cents + denom.value * count * 100, 0) +
  Math.round(b.remainder * 100);

/**
 * Minimum chip count by exhaustive search, for amounts small enough to search.
 * Independent of the production algorithm on purpose: if greedy is ever wrong
 * for this ladder, this disagrees with it.
 */
function minimumChipsByBruteForce(whole: number): number {
  const values = CHIP_DENOMINATIONS.map((d) => d.value).filter((v) => v <= whole);
  const best = new Array<number>(whole + 1).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  for (let n = 1; n <= whole; n++) {
    for (const v of values) {
      if (v <= n && best[n - v] + 1 < best[n]) best[n] = best[n - v] + 1;
    }
  }
  return best[whole];
}

// ============================================================================
// THE LADDER ITSELF
// ============================================================================

describe('the ladder', () => {
  it('is the list Dan gave, in order, with the values he gave', () => {
    expect(CHIP_DENOMINATIONS.map((d) => d.value)).toEqual([
      1, 5, 25, 100, 500, 1000, 5000, 100000, 500000, 1000000, 5000000,
    ]);
  });

  it('keeps the colour names on the ten that were unambiguous', () => {
    const byValue = new Map(CHIP_DENOMINATIONS.map((d) => [d.value, d.colorName]));
    expect(byValue.get(1)).toBe('white');
    expect(byValue.get(5)).toBe('red');
    expect(byValue.get(25)).toBe('green');
    expect(byValue.get(100)).toBe('black');
    expect(byValue.get(500)).toBe('purple');
    expect(byValue.get(1000)).toBe('yellow');
    expect(byValue.get(5000)).toBe('orange');
    expect(byValue.get(100000)).toBe('blue');
    expect(byValue.get(500000)).toBe('pink');
    expect(byValue.get(1000000)).toBe('teal');
  });

  it('AMBIGUITY 1: purple stays on 500 and 5,000,000 gets its own colour', () => {
    // Dan's list named PURPLE twice. Purple is kept for 500 because that is
    // the chip players see constantly; 5,000,000 is the one that moves.
    const fiveHundred = CHIP_DENOMINATIONS.find((d) => d.value === 500)!;
    const fiveMillion = CHIP_DENOMINATIONS.find((d) => d.value === 5000000)!;
    expect(fiveHundred.colorName).toBe('purple');
    expect(fiveMillion.colorName).not.toBe('purple');
    expect(fiveMillion.color).not.toBe(fiveHundred.color);
  });

  it('gives every rung a colour nothing else on the ladder uses', () => {
    // A stack is read by colour before it is read by number. Two rungs sharing
    // a fill is the failure this whole module exists to prevent.
    const fills = CHIP_DENOMINATIONS.map((d) => d.color.toLowerCase());
    expect(new Set(fills).size).toBe(CHIP_DENOMINATIONS.length);
    const names = CHIP_DENOMINATIONS.map((d) => d.colorName.toLowerCase());
    expect(new Set(names).size).toBe(CHIP_DENOMINATIONS.length);
  });

  it('AMBIGUITY 2: has nothing between 5,000 and 100,000', () => {
    // Implemented exactly as given. No 10k / 25k / 50k invented here.
    const between = CHIP_DENOMINATIONS.filter((d) => d.value > 5000 && d.value < 100000);
    expect(between).toEqual([]);
  });

  it('chains by divisibility, which is what makes greedy optimal', () => {
    for (let i = 1; i < CHIP_DENOMINATIONS.length; i++) {
      const lower = CHIP_DENOMINATIONS[i - 1].value;
      const upper = CHIP_DENOMINATIONS[i].value;
      expect(upper % lower).toBe(0);
    }
  });

  it('sorts descending for greedy descent', () => {
    expect(CHIP_DENOMINATIONS_DESC.map((d) => d.value)).toEqual([
      5000000, 1000000, 500000, 100000, 5000, 1000, 500, 100, 25, 5, 1,
    ]);
  });

  it('keeps every chip face label short enough to print on a disc', () => {
    for (const d of CHIP_DENOMINATIONS) {
      expect(d.label.length).toBeLessThanOrEqual(4);
    }
  });
});

// ============================================================================
// DAN'S TWO WORKED EXAMPLES
// ============================================================================

describe('the worked examples', () => {
  it('7 is one red and two white', () => {
    const b = breakChips(7);
    expect(pairs(b)).toEqual([
      [5, 1],
      [1, 2],
    ]);
    expect(b.totalChips).toBe(3);
    expect(b.remainder).toBe(0);
  });

  it('names those chips red and white', () => {
    expect(breakChips(7).chips.map((c) => c.denom.colorName)).toEqual(['red', 'white']);
  });

  it('three players in for 7 makes a 21 pot of four red and one white', () => {
    // "IF TWO PLAYERS CALL, THERE SHOULD BE 21 CHIPS IN THE POT" - 21 is the
    // VALUE (three players at 7). The pot then colours up to the fewest chips
    // that equal it, which is five, not fifteen.
    const b = breakChips(7 * 3);
    expect(b.amount).toBe(21);
    expect(pairs(b)).toEqual([
      [5, 4],
      [1, 1],
    ]);
    expect(b.totalChips).toBe(5);
  });

  it('adds the blinds on top and still colours up to the fewest', () => {
    // 21 called plus a 1/2 blind pair: a 24 pot.
    const b = breakChips(24);
    expect(pairs(b)).toEqual([
      [5, 4],
      [1, 4],
    ]);
    expect(b.totalChips).toBe(8);
  });
});

// ============================================================================
// FEWEST CHIPS
// ============================================================================

describe('fewest chips', () => {
  it('never leaves enough of one chip to colour up to the next', () => {
    // Five 1s is a 5; five 5s is a 25; four 25s is a 100; five 100s is a 500.
    for (let n = 1; n <= 2000; n++) {
      const b = breakChips(n);
      for (const { denom, count } of b.chips) {
        const nextUp = CHIP_DENOMINATIONS.find((d) => d.value > denom.value);
        if (!nextUp) continue;
        expect(count * denom.value).toBeLessThan(nextUp.value);
      }
    }
  });

  it('matches an exhaustive minimum-chip search over 1..3000', () => {
    for (let n = 1; n <= 3000; n++) {
      expect(totalChipCount(n)).toBe(minimumChipsByBruteForce(n));
    }
  });

  it('colours up a big round number instead of stacking small chips', () => {
    // 1,000,000 is one teal chip, not a thousand yellows.
    const b = breakChips(1000000);
    expect(pairs(b)).toEqual([[1000000, 1]]);
    expect(b.totalChips).toBe(1);
  });
});

// ============================================================================
// EXACT BOUNDARIES
// ============================================================================

describe('boundaries', () => {
  it('renders each denomination as exactly one of itself', () => {
    for (const d of CHIP_DENOMINATIONS) {
      const b = breakChips(d.value);
      expect(pairs(b)).toEqual([[d.value, 1]]);
      expect(b.totalChips).toBe(1);
    }
  });

  it('one under a denomination falls back to the rungs below', () => {
    expect(pairs(breakChips(4))).toEqual([[1, 4]]);
    expect(pairs(breakChips(99))).toEqual([
      [25, 3],
      [5, 4],
      [1, 4],
    ]);
    expect(pairs(breakChips(499))).toEqual([
      [100, 4],
      [25, 3],
      [5, 4],
      [1, 4],
    ]);
    expect(pairs(breakChips(999))).toEqual([
      [500, 1],
      [100, 4],
      [25, 3],
      [5, 4],
      [1, 4],
    ]);
  });

  it('one over a denomination is that chip plus a white', () => {
    expect(pairs(breakChips(101))).toEqual([
      [100, 1],
      [1, 1],
    ]);
    expect(pairs(breakChips(5001))).toEqual([
      [5000, 1],
      [1, 1],
    ]);
    expect(pairs(breakChips(100001))).toEqual([
      [100000, 1],
      [1, 1],
    ]);
  });

  it('AMBIGUITY 2: 60,000 is twelve orange 5,000 chips', () => {
    // The ladder has nothing between 5,000 and 100,000, exactly as Dan wrote
    // it, so twelve really is the fewest chips this ladder can make 60,000
    // from. Adding intermediate denominations is Dan's call, not this
    // module's - if this assertion ever changes, it changed because he asked.
    const b = breakChips(60000);
    expect(pairs(b)).toEqual([[5000, 12]]);
    expect(b.totalChips).toBe(12);
    expect(b.chips[0].denom.colorName).toBe('orange');
  });

  it('AMBIGUITY 2: 99,999 stacks nineteen oranges before a blue is reachable', () => {
    const b = breakChips(99999);
    expect(b.chips[0].denom.value).toBe(5000);
    expect(b.chips[0].count).toBe(19);
    expect(resum(b)).toBe(9999900);
  });
});

// ============================================================================
// LARGE AMOUNTS
// ============================================================================

describe('large amounts', () => {
  it('uses every rung of the ladder when the amount needs all of them', () => {
    const amount = 5000000 + 1000000 + 500000 + 100000 + 5000 + 1000 + 500 + 100 + 25 + 5 + 1;
    const b = breakChips(amount);
    expect(b.chips).toHaveLength(CHIP_DENOMINATIONS.length);
    expect(b.totalChips).toBe(CHIP_DENOMINATIONS.length);
    expect(resum(b)).toBe(amount * 100);
  });

  it('handles a pot past the top of the ladder by stacking maroons', () => {
    expect(pairs(breakChips(20000000))).toEqual([[5000000, 4]]);
    expect(pairs(breakChips(26000000))).toEqual([
      [5000000, 5],
      [1000000, 1],
    ]);
  });

  it('always re-sums to the input across the whole range', () => {
    const amounts = [1, 7, 21, 99, 1234, 60000, 99999, 250000, 7654321, 5000000, 12345678];
    for (const a of amounts) {
      expect(resum(breakChips(a))).toBe(a * 100);
    }
  });
});

// ============================================================================
// ZERO AND JUNK
// ============================================================================

describe('zero and junk input', () => {
  it('draws nothing for zero', () => {
    const b = breakChips(0);
    expect(b.chips).toEqual([]);
    expect(b.totalChips).toBe(0);
    expect(b.remainder).toBe(0);
    expect(b.amount).toBe(0);
  });

  it('draws nothing for a negative amount', () => {
    expect(breakChips(-50).chips).toEqual([]);
    expect(breakChips(-50).totalChips).toBe(0);
  });

  it('draws nothing for NaN or Infinity rather than throwing', () => {
    // These come off the wire. A bad snapshot must show an empty patch of
    // felt, not take the whole table down inside a render.
    expect(() => breakChips(Number.NaN)).not.toThrow();
    expect(breakChips(Number.NaN).chips).toEqual([]);
    expect(breakChips(Number.POSITIVE_INFINITY).chips).toEqual([]);
    expect(breakChips(Number.NEGATIVE_INFINITY).chips).toEqual([]);
  });

  it('freezes the shared empty breakdown so no caller can corrupt it', () => {
    const a = breakChips(0);
    const b = breakChips(0);
    expect(a.chips).toEqual([]);
    expect(b.chips).toEqual([]);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

// ============================================================================
// FRACTIONS
// ============================================================================

describe('fractions', () => {
  it('carries a 0.5 small blind as remainder, with no chip invented for it', () => {
    // Stakes here run 0.25/0.5. Nothing on Dan's ladder is smaller than the
    // white 1, so the half is reported, not rounded away and not faked.
    const b = breakChips(0.5);
    expect(b.chips).toEqual([]);
    expect(b.totalChips).toBe(0);
    expect(b.remainder).toBe(0.5);
    expect(resum(b)).toBe(50);
  });

  it('breaks 7.5 into one red, two white and half a chip left over', () => {
    const b = breakChips(7.5);
    expect(pairs(b)).toEqual([
      [5, 1],
      [1, 2],
    ]);
    expect(b.totalChips).toBe(3);
    expect(b.remainder).toBe(0.5);
  });

  it('survives binary-float drift that would eat the last white chip', () => {
    // 0.1 + 0.2 is 0.30000000000000004; subtraction upstream produces
    // 6.999999999999999, which a naive float descent renders as two chips
    // instead of three. Cents arithmetic does not.
    expect(totalChipCount(0.1 + 0.2 + 6.7)).toBe(3);
    expect(pairs(breakChips(6.999999999999999))).toEqual([
      [5, 1],
      [1, 2],
    ]);
  });

  it('handles a 0.25 odd-chip split off an all-in', () => {
    const b = breakChips(12.25);
    expect(pairs(b)).toEqual([
      [5, 2],
      [1, 2],
    ]);
    expect(b.remainder).toBe(0.25);
    expect(resum(b)).toBe(1225);
  });

  it('rounds a sub-cent residue away rather than leaving a phantom chip', () => {
    // Engine amounts occasionally carry more precision than a cent. Rounding
    // at the cent is the same rule the pot label already uses.
    const b = breakChips(5.004);
    expect(pairs(b)).toEqual([[5, 1]]);
    expect(b.remainder).toBe(0);
  });
});

// ============================================================================
// SINGLE-CHIP HELPER
// ============================================================================

describe('chipDenominationFor', () => {
  it('picks the largest chip that fits inside the amount', () => {
    expect(chipDenominationFor(1).value).toBe(1);
    expect(chipDenominationFor(4).value).toBe(1);
    expect(chipDenominationFor(5).value).toBe(5);
    expect(chipDenominationFor(7).value).toBe(5);
    expect(chipDenominationFor(99).value).toBe(25);
    expect(chipDenominationFor(60000).value).toBe(5000);
    expect(chipDenominationFor(9999999).value).toBe(5000000);
  });

  it('falls back to the white 1 for junk instead of returning undefined', () => {
    expect(chipDenominationFor(0)).toBe(SMALLEST_CHIP);
    expect(chipDenominationFor(-5)).toBe(SMALLEST_CHIP);
    expect(chipDenominationFor(0.5)).toBe(SMALLEST_CHIP);
    expect(chipDenominationFor(Number.NaN)).toBe(SMALLEST_CHIP);
  });
});

// ============================================================================
// RENDER SHAPE
// ============================================================================

describe('visualChipStacks', () => {
  it('draws all three chips of a 7 bet', () => {
    const v = visualChipStacks(7);
    expect(v.map((s) => [s.denom.value, s.drawn])).toEqual([
      [5, 1],
      [1, 2],
    ]);
    expect(v.every((s) => !s.truncated)).toBe(true);
  });

  it('clamps a tall stack for layout but still reports the true count', () => {
    // The bug this replaces: the old breakdowns clamped the count AND
    // subtracted the clamped count, so the drawn chips did not add up to the
    // bet. Here `count` stays honest and `truncated` tells the renderer to
    // print it.
    const v = visualChipStacks(60000, { maxPerStack: 5 });
    expect(v).toHaveLength(1);
    expect(v[0].count).toBe(12);
    expect(v[0].drawn).toBe(5);
    expect(v[0].truncated).toBe(true);
  });

  it('keeps the highest denominations when there are more groups than room', () => {
    const amount = 500 + 100 + 25 + 5 + 1;
    const v = visualChipStacks(amount, { maxStacks: 2 });
    expect(v.map((s) => s.denom.value)).toEqual([500, 100]);
  });

  it('draws one partial white disc for a sub-1 amount so it is not invisible', () => {
    const v = visualChipStacks(0.5);
    expect(v).toHaveLength(1);
    expect(v[0].partial).toBe(true);
    expect(v[0].denom.value).toBe(1);
  });

  it('does not add a fourth disc for the half chip riding along with a 7.5', () => {
    // Dan asked for three chips in front of a player at 7. The 0.5 is carried
    // by the numeric label, not by an extra disc.
    const v = visualChipStacks(7.5);
    expect(v.reduce((n, s) => n + s.drawn, 0)).toBe(3);
    expect(v.some((s) => s.partial)).toBe(false);
  });

  it('draws nothing at all for zero', () => {
    expect(visualChipStacks(0)).toEqual([]);
    expect(visualChipStacks(Number.NaN)).toEqual([]);
  });

  it('never draws more discs than the chips that are actually there', () => {
    for (const a of [1, 3, 7, 21, 99, 1234, 60000, 250000]) {
      for (const s of visualChipStacks(a)) {
        expect(s.drawn).toBeLessThanOrEqual(s.count);
        expect(s.drawn).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
