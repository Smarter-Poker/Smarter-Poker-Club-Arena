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
    const { container } = render(<PotDisplay mainPot={21} />);
    const colors = chipColors(container, POT_CHIP, '--pile-chip-color');

    // 21 = 4 x 5 (red) + 1 x 1 (white)
    expect(colors).toEqual([
      byValue(5).color,
      byValue(5).color,
      byValue(5).color,
      byValue(5).color,
      byValue(1).color,
    ]);
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

    expect(potColors).toHaveLength(seatColors.length);
    expect(seatColors[0]).toEqual(potColors[0]);
  });
});
