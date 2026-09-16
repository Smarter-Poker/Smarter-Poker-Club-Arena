/**
 * THE CHIPS DAN ASKED FOR ARE ACTUALLY ON THE FELT.
 * ============================================================================
 * tests/unit/chipDenominations.test.ts proves the ARITHMETIC. This proves the
 * PIXELS: that the components which draw a seat's bet and the pot really put
 * those chips on screen.
 *
 * That gap is the whole reason this task existed. The breakdown function was
 * not the broken part - ChipPhysics had a working-ish one and rendered ONE
 * CHIP anyway, because compact mode short-circuited before reaching it. A unit
 * test on the maths alone would have stayed green through all of it.
 *
 * Dan 2026-08-23: "IF A PLAYER RAISES, OR CALLS TO 7, ONE RED AND TWO WHITE
 * CHIPS SHOULD BE ADDED IN FRONT OF THEM... THE POT SHOULD SHOW THE AMOUNT OF
 * CHIPS NECESSARY TO EQUAL THE TOTAL CHIPS IN THE POT."
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChipPhysics } from '../src/components/table/ChipPhysics';
import { PotDisplay } from '../src/components/table/PotDisplay';
import { CHIP_DENOMINATIONS } from '../src/lib/chipDenominations';

afterEach(cleanup);

const readSrc = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const byValue = (v: number) => CHIP_DENOMINATIONS.find((d) => d.value === v)!;

const POT_CHIP = '.pot-display__pile--pot .pot-display__pile-chip';
const STREET_CHIP = '.pot-display__pile--street .pot-display__pile-chip';

/**
 * The fill colours of the discs actually painted, in DOM order.
 *
 * Reads the inline custom property rather than a class name, because the
 * colour is what a player sees and a class name can drift away from it.
 */
function chipColors(root: HTMLElement, selector: string, prop: string): string[] {
  return Array.from(root.querySelectorAll(selector)).map((el) =>
    (el as HTMLElement).style.getPropertyValue(prop).trim()
  );
}

// ============================================================================
// IN FRONT OF THE PLAYER  (ChipPhysics compact — what SeatSlot renders)
// ============================================================================

describe('a bet in front of a seat', () => {
  it('draws one red and two white chips for a bet of 7', () => {
    const { container } = render(<ChipPhysics amount={7} compact />);
    const colors = chipColors(container, '.cp-chip', '--chip-color');

    expect(colors).toHaveLength(3);
    expect(colors).toEqual([byValue(5).color, byValue(1).color, byValue(1).color]);
  });

  it('groups them into a single stack', () => {
    const { container } = render(<ChipPhysics amount={7} compact />);
    const stacks = container.querySelectorAll('.cp-stack');
    expect(stacks).toHaveLength(1);
    expect(stacks[0].querySelectorAll('.cp-chip')).toHaveLength(3); // 1 red 5 + 2 white 1s
  });

  it('no longer collapses every bet to a single chip', () => {
    // The regression this task fixed: compact mode drew exactly one disc for
    // any amount whatsoever. If that ever comes back, these all become 1.
    const counts = [7, 21, 175].map((amount) => {
      const { container } = render(<ChipPhysics amount={amount} compact />);
      return container.querySelectorAll('.cp-chip').length;
    });
    // 7 = 5+1+1 | 21 = 5,5,5,5+1 | 175 = 100+25,25,25
    expect(counts).toEqual([3, 5, 4]);
  });

  it('still prints the exact amount beside the chips', () => {
    const { container } = render(<ChipPhysics amount={7} compact />);
    expect(container.querySelector('.cp-amount')?.textContent).toBe('7');
  });

  it('draws nothing at all when there is no bet', () => {
    const { container } = render(<ChipPhysics amount={0} compact />);
    expect(container.querySelectorAll('.cp-chip')).toHaveLength(0);
  });

  it('draws one white disc, with the exact amount beside it, for a 0.5 small blind', () => {
    // Stakes run 0.25/0.5 and nothing on the ladder is smaller than the white
    // 1. The disc is still tagged `partial` (that is what stops 7.5 drawing a
    // fourth chip) and the label is what carries the value.
    const { container } = render(<ChipPhysics amount={0.5} compact />);
    const chips = container.querySelectorAll('.cp-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].className).toContain('cp-chip--partial');
    expect((chips[0] as HTMLElement).style.getPropertyValue('--chip-color').trim()).toBe(
      byValue(1).color
    );
    expect(container.querySelector('.cp-amount')?.textContent).toBe('0.50');
  });

  it('draws the sub-1 disc as a full circle, on the seat and in the pot', () => {
    // Dan 2026-09-04: "WHY ARE THE CHIPS OVAL SHAPED NOW PREFLOP INSTEAD OF
    // CIRCLES? THEY APPEAR NORMAL ON ALL OTHER STREETS... FIX THIS BUG."
    //
    // The partial disc used to be squashed to 55% height (37.5% in the pot),
    // dashed and faded. At 0.10/0.25 every preflop bet is under 1, so EVERY
    // chip on the felt was an oval until the flop. jsdom does not lay out
    // CSS, so this reads the stylesheets: the partial rule may only restate
    // the chip's own height, and may not touch its rim or opacity.
    const partialRule = (css: string, selector: string) => {
      const m = css.match(new RegExp(`${selector.replace(/[.-]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
      expect(m, `${selector} rule missing`).not.toBeNull();
      return m![1];
    };
    const seat = partialRule(readSrc('src/components/table/ChipPhysics.css'), '.cp-chip--partial');
    expect(seat).toMatch(/height:\s*var\(--cp-chip-size\)\s*;/);
    expect(seat).not.toMatch(/\*\s*0?\.\d+/); // no fraction of the chip
    expect(seat).not.toMatch(/opacity|dashed/);

    const pot = partialRule(
      readSrc('src/components/table/PotDisplay.css'),
      '.pot-display__pile-chip--partial'
    );
    expect(pot).toMatch(/height:\s*var\(--cp-chip-size(,\s*24px)?\)\s*;/);
    expect(pot).not.toMatch(/\*\s*0?\.\d+/);
    expect(pot).not.toMatch(/opacity|dashed/);
  });

  it('caps a tall stack but prints its true count', () => {
    // AMBIGUITY 2: nothing exists between 5,000 and 100,000, so 60,000 really
    // is twelve orange chips. Twelve do not fit in front of a seat; the badge
    // is how the pile stays honest about what it is not drawing.
    const { container } = render(<ChipPhysics amount={60000} compact />);
    expect(container.querySelectorAll('.cp-chip').length).toBeLessThan(12);
    // Multiplication sign, not a lowercase 'x'. check-title-case.mjs enforces
    // that every word on a forward-facing surface starts with a capital, and it
    // rejected 'x12' on all five chip surfaces. The correct glyph for "twelve of
    // these" was never the letter anyway.
    expect(container.querySelector('.cp-stack__multi')?.textContent).toBe('\u00d712');
  });
});

// ============================================================================
// IN THE MIDDLE  (PotDisplay)
// ============================================================================

describe('the pot', () => {
  it('shows MULTIPLE chips, correctly representing a 21 pot', () => {
    // Dan 2026-08-24 (Update): "AND THE 'POT' ISN'T DISPLAYING MULTIPLE CHIPS AS IT SHOULD BE EITHER..."
    //
    // The ORDER is deliberately not asserted here any more - Dan 2026-09-14,
    // the pot's chips "should appear 'in a pot' mixed together" rather than in
    // number order. What must hold is the multiset: 21 = 4 x 5 + 1 x 1.
    const { container } = render(<PotDisplay mainPot={21} />);
    const colors = chipColors(container, POT_CHIP, '--pile-chip-color');

    expect([...colors].sort()).toEqual(
      [
        byValue(5).color,
        byValue(5).color,
        byValue(5).color,
        byValue(5).color,
        byValue(1).color,
      ].sort()
    );
  });

  it('still reads the amount', () => {
    const { container } = render(<PotDisplay mainPot={21} />);
    expect(container.querySelector('.pot-display__amount')?.textContent).toContain('21');
  });

  it('reads the TRUE amount at small stakes, never a rounded one (Dan 2026-09-04)', () => {
    // "FOR ALL SMALL STAKES GAMES .50/1 AND LESS THE POT SHOULD SHOW TRUE
    // AMOUNTS... NOT ROUNDED UP. POT SHOULD SHOW 3.50 OR 6.80 OR WHAT EVER
    // THE TRUE NUMBER IS." The pill used to Math.round anything from 1 up,
    // so 5.10 of antes read "5" and 1.50 read "2". Two places, always, at a
    // big blind of 1 or under - 3.50, not 3.5, so the pill does not jitter.
    const text = (pot: number, bb: number) => {
      const { container } = render(<PotDisplay mainPot={pot} bigBlind={bb} />);
      const t = container.querySelector('.pot-display__amount')?.textContent ?? '';
      cleanup();
      return t;
    };
    expect(text(3.5, 0.25)).toContain('3.50');
    expect(text(6.8, 1)).toContain('6.80');
    expect(text(5.1, 0.25)).toContain('5.10');
    expect(text(1.5, 0.1)).toContain('1.50');
    // A whole-chip pot at small stakes still reads to the penny.
    expect(text(5, 0.5)).toContain('5.00');
    // Above small stakes: integers clean, a real fraction kept, never rounded.
    expect(text(1250, 25)).toContain('1,250');
    expect(text(7.5, 2)).toContain('7.5');
    expect(text(7.5, 2)).not.toContain('8');
  });

  it('colours a million-chip pot teal instead of a heap of oranges', () => {
    // The old local ladders stopped at 5,000, so everything above it drew
    // orange: blue, pink, teal and maroon simply did not exist.
    const { container } = render(<PotDisplay mainPot={1000000} />);
    expect(chipColors(container, POT_CHIP, '--pile-chip-color')).toEqual([byValue(1000000).color]);
  });

  it('does not draw live street bets under or in the pot until the street is over', () => {
    // Dan 2026-08-24: "AND THE CHIPS FROM THE FUTURE ROUNDS SHOULD NOT APPEAR
    // 'UNDER OR IN THE POT' UNTIL THE STREET IS OVER."
    const { container } = render(<PotDisplay mainPot={30} streetBets={7} />);
    expect(container.querySelectorAll('.pot-display__street')).toHaveLength(0);
    expect(container.querySelectorAll(STREET_CHIP)).toHaveLength(0);
  });

  it('keeps the chips out of the POT pill itself', () => {
    // The pile is absolutely positioned above the pill on purpose:
    // tests/e2e/pot-above-chips.spec.ts pins that pill's box against a
    // checked-in stylesheet at four widths, and chips in the column flow
    // would push it down.
    const { container } = render(<PotDisplay mainPot={21} />);
    const pill = container.querySelector('.pot-display__main')!;
    expect(pill.querySelectorAll('.pot-display__pile-chip')).toHaveLength(0);
  });

  it('draws no pile when there is no pot', () => {
    const { container } = render(<PotDisplay mainPot={0} />);
    expect(container.querySelectorAll('.pot-display__pile-chip')).toHaveLength(0);
  });

  it('prints the true count for a pot stack clamped to fit', () => {
    // AMBIGUITY 2 in chipDenominations.ts: nothing exists between the orange
    // 5,000 and the blue 100,000, so 60,000 really is twelve orange chips.
    // The tower is capped at ten discs; the badge is how it stays honest
    // about the two it is not drawing. The seat chips have had this since
    // 2026-08-23 - the pot had the STYLESHEET for it and rendered no badge.
    const { container } = render(<PotDisplay mainPot={60000} />);
    expect(container.querySelectorAll(POT_CHIP).length).toBeLessThan(12);
    expect(container.querySelector('.pot-display__pile-multi')?.textContent).toBe('\u00d712');
  });

  it('does not print a count for a stack it draws in full', () => {
    const { container } = render(<PotDisplay mainPot={21} />);
    expect(container.querySelector('.pot-display__pile-multi')).toBeNull();
  });
});

// ============================================================================
// THE POT'S CHIPS ARE NOT ALL PAINTED IN ONE PLACE
// ============================================================================

describe('the pot is a spread of chips, mixed, laid out horizontally', () => {
  /**
   * Dan 2026-09-14, in order:
   *
   *   "BOMB POTS CHIPS DON'T UPDATE TO DISPLAY THE ACTUAL AMOUNT IN THE
   *    POTS... IT SHOULD SHOW MULTIPLE CHIPS AS WELL."
   *   "CHIPS SHOULD ALWAYS BE LAYING HORIZONTALLY UNDER THE POT, NEVER
   *    STACKED VERTICALLY."
   *   "AND SHOULDN'T ALWAYS APPEAR IN NUMBER ORDER HIGH TO LOW OR LOW TO
   *    HIGH... THEY SHOULD APPEAR 'IN A POT' MIXED TOGETHER."
   *
   * Every test above this one was GREEN while the pot drew a single disc for
   * any amount, because every one of them asks the DOM what is there and the
   * DOM was always right. The discs were all painted in the SAME CELL: #771
   * put `display: grid` on the pile and `grid-area: 1 / 1` on the stack AND
   * on each chip, so ten chips landed inside a 3px band and a player saw the
   * last one - the LOWEST denomination in the pot, on its own. A 30 pot
   * (green 25 + red 5) showed one red chip; a 74 pot (2 green, 4 red, 4
   * white) showed one white chip.
   *
   * jsdom does not lay out CSS, so the layout half of this reads the
   * stylesheet, exactly as the sub-1 oval-disc guard above does.
   */
  const potCss = readSrc('src/components/table/PotDisplay.css');

  /** The declaration block of `selector`, matched as a WHOLE selector. */
  const rule = (css: string, selector: string) => {
    const m = css.match(
      new RegExp(
        `(?:^|\\})\\s*${selector.replace(/[.+\-*\\/[\]{}()?^$|]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
        'm'
      )
    );
    expect(m, `${selector} rule missing`).not.toBeNull();
    return m![1];
  };

  const denomByColor = (color: string) => CHIP_DENOMINATIONS.find((d) => d.color === color)!.value;

  it('lays the discs along the row, and never back into one grid cell', () => {
    // The exact shape of the regression: `grid-area: 1 / 1` on a chip or on
    // the stack means "every one of you occupies this single cell".
    expect(rule(potCss, '.pot-display__pile-chip')).not.toMatch(/grid-area/);
    expect(rule(potCss, '.pot-display__pile-stack')).not.toMatch(/grid-area/);

    const spaced = rule(potCss, '.pot-display__pile-chip + .pot-display__pile-chip');
    expect(spaced).toMatch(/margin-left:\s*var\(--pd-pile-overlap\)/);
    // A vertical stack is what Dan ruled out; margin-bottom is how one is built.
    expect(spaced).not.toMatch(/margin-bottom/);
  });

  it('never stacks them vertically', () => {
    expect(rule(potCss, '.pot-display__pile')).toMatch(/flex-direction:\s*row\s*;/);
    expect(rule(potCss, '.pot-display__pile-stack')).toMatch(/flex-direction:\s*row\s*;/);
    expect(rule(potCss, '.pot-display__pile')).not.toMatch(/column/);
    expect(rule(potCss, '.pot-display__pile-stack')).not.toMatch(/column/);
  });

  it('derives the overlap from the one chip token, so the discs cannot drift', () => {
    // --cp-chip-size is the single chip token (TableVisualHotfix.css). A pot
    // that spaced itself by a number of its own would stop matching the chip
    // it is spacing the moment the table changed width.
    const pile = rule(potCss, '.pot-display__pile');
    expect(pile).toMatch(/--pd-pile-show:\s*calc\(var\(--cp-chip-size/);
    expect(pile).toMatch(
      /--pd-pile-overlap:\s*calc\(var\(--pd-pile-show\)\s*-\s*var\(--cp-chip-size/
    );
  });

  it('still adds up to the pot, whatever order it deals them in', () => {
    for (const pot of [21, 30, 74, 144, 175]) {
      const { container } = render(<PotDisplay mainPot={pot} />);
      const drawn = chipColors(container, POT_CHIP, '--pile-chip-color');
      expect(
        drawn.reduce((n, c) => n + denomByColor(c), 0),
        `pot ${pot}`
      ).toBe(pot);
      cleanup();
    }
  });

  it('mixes the denominations instead of running them high to low', () => {
    // A sorted pile has exactly one run per denomination. A mixed one has
    // more. 74 is 2 green, 4 red and 4 white - three denominations.
    for (const pot of [74, 144]) {
      const { container } = render(<PotDisplay mainPot={pot} />);
      const drawn = chipColors(container, POT_CHIP, '--pile-chip-color');
      const runs = drawn.filter((c, i) => c !== drawn[i - 1]).length;
      expect(new Set(drawn).size, `pot ${pot} should hold several denominations`).toBeGreaterThan(
        2
      );
      expect(runs, `pot ${pot} is still in denomination order`).toBeGreaterThan(
        new Set(drawn).size
      );
      cleanup();
    }
  });

  it('deals the same pot the same way every time', () => {
    // The mix is keyed on (denomination, ordinal), not on Math.random(), so a
    // re-render for an unrelated prop cannot re-deal the chips on the felt.
    const once = (() => {
      const { container } = render(<PotDisplay mainPot={144} />);
      const c = chipColors(container, POT_CHIP, '--pile-chip-color');
      cleanup();
      return c;
    })();
    const twice = (() => {
      const { container } = render(<PotDisplay mainPot={144} />);
      const c = chipColors(container, POT_CHIP, '--pile-chip-color');
      cleanup();
      return c;
    })();
    expect(twice).toEqual(once);
  });
});

// ============================================================================
// THE SEAT AND THE POT AGREE
// ============================================================================

describe('the felt is internally consistent', () => {
  it('paints the pot chip in the same ladder colour a seat bet would lead with', () => {
    // One ladder everywhere: the pot's single chip must be the same colour as
    // the highest-denomination chip a seat bet of that amount leads with.
    const bet = render(<ChipPhysics amount={175} compact />);
    const seatColors = chipColors(bet.container, '.cp-chip', '--chip-color');

    const pot = render(<PotDisplay mainPot={175} />);
    const potColors = chipColors(pot.container, POT_CHIP, '--pile-chip-color');

    // Same chips, in whatever order the pot deals them - the seat's stack is
    // ordered by denomination, the pot's spread is mixed on purpose.
    expect(potColors).toHaveLength(seatColors.length);
    expect([...potColors].sort()).toEqual([...seatColors].sort());
  });
});
