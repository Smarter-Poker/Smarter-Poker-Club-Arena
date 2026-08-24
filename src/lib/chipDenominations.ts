/**
 * =============================================================================
 *  CHIP DENOMINATIONS — Dan's ladder, and the fewest-chips breakdown
 * =============================================================================
 *
 * Dan 2026-08-23, binding, verbatim:
 *
 *   "5, CHIPS AND POTS. WHITE = 1 CHIP, 5 = RED CHIPS, GREEN = 25 CHIP,
 *    BLACK = 100 CHIP, PURPLE = 500 CHIP, YELLOW = 1000 CHIP,
 *    ORANGE = 5,000 CHIP, BLUE = 100,000 CHIP, PINK = 500,000 CHIP
 *    TEAL = MILLION CHIP, PURPLE = 5 MILLION CHIP... IF A PLAYER RAISES, OR
 *    CALLS TO 7, ONE RED AND TWO WHITE CHIPS SHOULD BE ADDED IN FRONT OF THEM.
 *    IF TWO PLAYERS CALL, THERE SHOULD BE 21 CHIPS IN THE POT PLUS THE BLINDS,
 *    THE POT SHOULD SHOW THE AMOUNT OF CHIPS NECESSARY TO EQUAL THE TOTAL CHIPS
 *    IN THE POT, AND THATS HOW IT SHOULD LOOK WHEN ITS CALCULATED... ALWAYS
 *    COLORING UP TO USE THE FEWEST AMOUNT OF CHIPS IN THE POT."
 *
 * This module is the ONE place the ladder lives. Before it, three separate
 * components each carried their own partial copy that stopped at 5,000
 * (table/ChipStack.tsx, table/ChipPhysics.tsx, table/ChipAnimation.tsx), and
 * every one of them capped the per-denomination count for "visual clarity"
 * while still subtracting the capped count from the remainder — so the chips
 * drawn never summed to the bet. A 7 bet drew one chip. Dan asked for three.
 *
 * -----------------------------------------------------------------------------
 * WHY GREEDY IS OPTIMAL HERE (this is not an approximation)
 * -----------------------------------------------------------------------------
 * Every rung of this ladder divides evenly into the next one:
 *   1|5, 5|25, 25|100, 100|500, 500|1000, 1000|5000, 5000|100000 (x20),
 *   100000|500000, 500000|1000000, 1000000|5000000.
 * For a canonical (divisibility-chained) system, taking as many of the largest
 * chip as possible is provably the minimum-count representation. So "always
 * coloring up to use the fewest amount of chips" IS plain greedy descent —
 * no dynamic programming needed, and no case where it can be beaten.
 *
 * -----------------------------------------------------------------------------
 * AMBIGUITY 1 — PURPLE IS LISTED TWICE (500 AND 5,000,000)
 * -----------------------------------------------------------------------------
 * Dan's list assigns PURPLE to both the 500 chip and the 5,000,000 chip. Two
 * denominations cannot share a colour: the whole point of the ladder is that
 * a player reads the stack by colour without reading the numbers, and a purple
 * disc that might be 500 or might be 5,000,000 is worse than no colour at all.
 *
 * RESOLVED: purple stays on 500, and 5,000,000 gets MAROON (a deep wine red,
 * clearly darker and less saturated than the 5 chip's bright red, and the only
 * hue region left unused by the other ten).
 *
 * Chosen this way because 500 is the chip players see constantly — it is in
 * range at ordinary stakes, it is on the felt in almost every big pot, and its
 * colour is the one muscle memory is built on. 5,000,000 appears in high-roller
 * chip-ups and essentially nowhere else, so it is the one that can afford to
 * move. If Dan wants the pairing the other way round, swap the `colorName`,
 * `color` and `accent` fields of the two rungs below and nothing else changes.
 *
 * -----------------------------------------------------------------------------
 * AMBIGUITY 2 — THE LADDER JUMPS 5,000 -> 100,000
 * -----------------------------------------------------------------------------
 * There is nothing between the orange 5,000 and the blue 100,000, a 20x step
 * where every other step is 2x, 4x or 5x. The ladder is implemented EXACTLY as
 * Dan gave it; no 10,000 / 25,000 / 50,000 chips have been invented here.
 *
 * The visible consequence: 60,000 colours up to TWELVE orange 5,000 chips,
 * because twelve is genuinely the fewest chips this ladder can make 60,000
 * from. That is correct against the spec as written, and it is a tall stack.
 * Adding intermediate denominations is Dan's call, not this module's. If he
 * wants them, add the rungs to CHIP_DENOMINATIONS and every consumer and test
 * follows automatically — but keep the divisibility chain intact or greedy
 * stops being optimal (10,000 and 50,000 both chain cleanly; adding 10,000 and
 * 25,000 together does not, because 10,000 does not divide 25,000).
 *
 * -----------------------------------------------------------------------------
 * FRACTIONAL AND SUB-1 AMOUNTS
 * -----------------------------------------------------------------------------
 * Real stakes here are 2/4, 1/2 and 0.25/0.5, so amounts of 0.5, 7.5 and 12.25
 * genuinely occur (small blinds, all-in splits, odd-chip rounding).
 *
 * The smallest chip on Dan's list is the white 1. Nothing on the ladder can
 * represent 0.5, and inventing a "half chip" would be exactly the thing
 * Ambiguity 2 says not to do. So:
 *
 *   - breakChips() breaks out the WHOLE-CHIP part and returns whatever is left
 *     under 1 in `remainder`. It never invents a chip and never silently drops
 *     value: chip value + remainder always re-sums to the input, exactly.
 *   - 7.5 -> one red + two white, remainder 0.5.
 *   - 0.5 -> no chips at all, remainder 0.5.
 *   - Renderers show the whole chips plus the exact numeric label, which
 *     already prints two decimals below 1. For 0 < amount < 1 they draw ONE
 *     `partial` disc (see visualChipStacks) so a 0.5 small blind is not
 *     invisible on the felt — styled as a sliver, not as a white 1 chip,
 *     because drawing a full white chip for 0.5 would be a lie about value.
 *
 * Arithmetic runs in integer cents throughout. Floating-point descent gets
 * this wrong in practice: 0.1 + 0.2 style drift turns a clean 7.5 into
 * 7.499999999999999 and the last white chip vanishes.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ChipDenomination {
  /** Face value, in chips. */
  value: number;
  /** The colour name as Dan named it (see the ambiguity notes above). */
  colorName: string;
  /** Face fill colour. */
  color: string;
  /** Rim / gradient-end colour, used for the 3D edge. */
  accent: string;
  /** Ink colour for the value printed on the face (contrast against `color`). */
  ink: string;
  /** Short label printed on the chip face. Never more than 4 characters. */
  label: string;
}

export interface ChipCount {
  denom: ChipDenomination;
  /** How many chips of this denomination. Always at least 1. */
  count: number;
}

export interface ChipBreakdown {
  /** Denominations present, HIGHEST first. Empty when amount is under 1. */
  chips: ChipCount[];
  /** Total physical chips. This is the number Dan means by "fewest chips". */
  totalChips: number;
  /**
   * Value under 1 that no chip on the ladder can represent, 0 to 0.99.
   * Chip value + remainder is the input amount, to the cent.
   */
  remainder: number;
  /** The input, normalised to the cent. */
  amount: number;
}

// =============================================================================
// THE LADDER
// =============================================================================

/**
 * Dan's ladder, ascending. Ascending because that is the order it was dictated
 * in and the order a rack is stacked; breakChips walks it backwards.
 */
export const CHIP_DENOMINATIONS: readonly ChipDenomination[] = [
  { value: 1, colorName: 'white', color: '#f2f3f5', accent: '#b3b7c0', ink: '#1a1a2e', label: '1' },
  { value: 5, colorName: 'red', color: '#ef4444', accent: '#991b1b', ink: '#ffffff', label: '5' },
  {
    value: 25,
    colorName: 'green',
    color: '#22c55e',
    accent: '#15803d',
    ink: '#ffffff',
    label: '25',
  },
  {
    value: 100,
    colorName: 'black',
    color: '#1c1c2e',
    accent: '#08080f',
    ink: '#ffffff',
    label: '100',
  },
  {
    value: 500,
    colorName: 'purple',
    color: '#7c3aed',
    accent: '#4c1d95',
    ink: '#ffffff',
    label: '500',
  },
  {
    value: 1000,
    colorName: 'yellow',
    color: '#facc15',
    accent: '#ca8a04',
    ink: '#1a1a2e',
    label: '1K',
  },
  {
    value: 5000,
    colorName: 'orange',
    color: '#f97316',
    accent: '#c2410c',
    ink: '#ffffff',
    label: '5K',
  },
  {
    value: 100000,
    colorName: 'blue',
    color: '#2563eb',
    accent: '#1e3a8a',
    ink: '#ffffff',
    label: '100K',
  },
  {
    value: 500000,
    colorName: 'pink',
    color: '#ec4899',
    accent: '#9d174d',
    ink: '#ffffff',
    label: '500K',
  },
  {
    value: 1000000,
    colorName: 'teal',
    color: '#14b8a6',
    accent: '#0f766e',
    ink: '#ffffff',
    label: '1M',
  },
  // AMBIGUITY 1: Dan's list says PURPLE here as well as at 500. Purple keeps
  // the 500 (the chip players actually see); this one is maroon. Full
  // reasoning in the file header.
  {
    value: 5000000,
    colorName: 'maroon',
    color: '#7f1d2e',
    accent: '#450a14',
    ink: '#ffffff',
    label: '5M',
  },
];

/** The same ladder, highest first. This is the order greedy descent needs. */
export const CHIP_DENOMINATIONS_DESC: readonly ChipDenomination[] = [...CHIP_DENOMINATIONS].sort(
  (a, b) => b.value - a.value
);

/** The white 1, referenced by name so a ladder edit cannot silently move it. */
export const SMALLEST_CHIP: ChipDenomination = CHIP_DENOMINATIONS[0];

// =============================================================================
// BREAKDOWN
// =============================================================================

const EMPTY_BREAKDOWN: ChipBreakdown = Object.freeze({
  chips: [] as ChipCount[],
  totalChips: 0,
  remainder: 0,
  amount: 0,
});

/**
 * Break `amount` into the FEWEST chips on Dan's ladder.
 *
 * Greedy descent, which is exact here because the ladder is divisibility-
 * chained (see the file header). Runs in integer cents so a 7.5 bet cannot
 * lose its last white chip to binary-float drift.
 *
 * Non-finite, zero and negative inputs return an empty breakdown rather than
 * throwing: this is called from render paths, and a NaN pot reaching the felt
 * must draw nothing, not crash the table.
 */
export function breakChips(amount: number): ChipBreakdown {
  if (!Number.isFinite(amount) || amount <= 0) return EMPTY_BREAKDOWN;

  let cents = Math.round(amount * 100);
  const chips: ChipCount[] = [];
  let totalChips = 0;

  for (const denom of CHIP_DENOMINATIONS_DESC) {
    const denomCents = denom.value * 100;
    if (cents < denomCents) continue;
    const count = Math.floor(cents / denomCents);
    cents -= count * denomCents;
    chips.push({ denom, count });
    totalChips += count;
  }

  return {
    chips,
    totalChips,
    remainder: cents / 100,
    amount: Math.round(amount * 100) / 100,
  };
}

/** The "fewest chips" count on its own, for tests and chip-count captions. */
export function totalChipCount(amount: number): number {
  return breakChips(amount).totalChips;
}

/**
 * The single denomination that best represents `amount` — the largest chip
 * that fits inside it, falling back to the white 1.
 *
 * For single-chip contexts ONLY (a chip in flight, a legend swatch). Anywhere
 * that draws a pile must use breakChips, or the pile lies about the amount.
 */
export function chipDenominationFor(amount: number): ChipDenomination {
  if (!Number.isFinite(amount) || amount <= 0) return SMALLEST_CHIP;
  for (const denom of CHIP_DENOMINATIONS_DESC) {
    if (amount >= denom.value) return denom;
  }
  return SMALLEST_CHIP;
}

// =============================================================================
// RENDERING HELPER
// =============================================================================

export interface ChipStackVisual {
  denom: ChipDenomination;
  /** The TRUE number of chips of this denomination. Never capped. */
  count: number;
  /** How many discs to actually draw. Never more than `count`. */
  drawn: number;
  /** True when drawn is less than count, so the caller prints an "x12" tag. */
  truncated: boolean;
  /**
   * True only for the placeholder disc standing in for a sub-1 remainder (see
   * FRACTIONAL AND SUB-1 AMOUNTS). Renderers style it as a sliver so it is
   * never mistaken for a real white 1 chip.
   */
  partial: boolean;
}

export interface VisualChipOptions {
  /** Denomination groups to draw, highest first. */
  maxStacks?: number;
  /** Discs to draw per group before switching to an "xN" multiplier. */
  maxPerStack?: number;
  /**
   * Discs to draw across ALL groups combined, before switching to "xN".
   *
   * Dan 2026-08-24: "chips entering the pot should be stacked and slightly
   * offset so you can see them all, highest denomination on the bottom, but
   * not right next to each other."
   *
   * That is ONE tower, not a row of towers - and a single tower has a single
   * height. `maxPerStack` alone cannot bound it: six groups of ten is sixty
   * discs, which at any offset legible enough to count is taller than the
   * felt. This caps the tower itself, spending the budget from the BOTTOM of
   * the tower upward (largest denomination first), because the big chips are
   * the ones carrying the value a player is trying to read.
   *
   * Like every other cap in this module it clamps the DISCS DRAWN and never
   * the value: a group it shortens reports `truncated` and keeps its true
   * `count`, so the pile still adds up to the amount.
   */
  maxTotal?: number;
}

/**
 * breakChips, shaped for a renderer.
 *
 * The count is never lied about: if a stack is taller than `maxPerStack` the
 * disc count is clamped for layout and `truncated` is set so the component can
 * print the real number beside it. This is precisely the bug the old
 * per-component breakdowns had — they clamped the count AND subtracted the
 * clamped count, so the value simply evaporated.
 */
export function visualChipStacks(
  amount: number,
  { maxStacks = 5, maxPerStack = 8, maxTotal = Infinity }: VisualChipOptions = {}
): ChipStackVisual[] {
  const { chips, remainder } = breakChips(amount);

  // Sub-1 amount (a 0.5 small blind): no chip on the ladder represents it, but
  // bare felt in front of a player who has money out is worse than a sliver,
  // so draw one disc marked partial.
  if (chips.length === 0) {
    if (remainder <= 0) return [];
    return [{ denom: SMALLEST_CHIP, count: 1, drawn: 1, truncated: false, partial: true }];
  }

  // A sub-1 residue riding along with real chips (7.5 -> red + 2 white + 0.5)
  // is carried by the numeric label, not by another disc. A sliver here would
  // put a fourth chip in front of a player Dan said should have three.
  const groups = chips.slice(0, Math.max(1, maxStacks)).map(({ denom, count }) => ({
    denom,
    count,
    drawn: Math.max(1, Math.min(count, maxPerStack)),
    truncated: count > maxPerStack,
    partial: false,
  }));

  // Tower budget, spent bottom-up. `chips` is already highest-denomination
  // first, so walking it in order hands the budget to the big chips and lets
  // the small ones fall back to an "xN" tag - the same trade a dealer makes
  // when they colour up. Every group keeps at least one disc: a denomination
  // that is in the pot but drawn nowhere is a chip the player cannot see.
  if (Number.isFinite(maxTotal) && groups.length > 0) {
    const budget = Math.max(groups.length, Math.floor(maxTotal));
    let spent = groups.reduce((n, g) => n + g.drawn, 0);
    for (let i = groups.length - 1; i >= 0 && spent > budget; i--) {
      const g = groups[i];
      const give = Math.min(g.drawn - 1, spent - budget);
      if (give <= 0) continue;
      g.drawn -= give;
      g.truncated = g.count > g.drawn;
      spent -= give;
    }
  }

  return groups;
}
