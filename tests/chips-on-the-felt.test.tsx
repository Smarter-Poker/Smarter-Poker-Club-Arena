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
import { ChipPhysics } from '../src/components/table/ChipPhysics';
import { PotDisplay } from '../src/components/table/PotDisplay';
import { CHIP_DENOMINATIONS } from '../src/lib/chipDenominations';

afterEach(cleanup);

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

  it('draws a partial sliver, not a white chip, for a 0.5 small blind', () => {
    // Stakes run 0.25/0.5 and nothing on the ladder is smaller than the white
    // 1. A full white chip here would claim twice the value that is out.
    const { container } = render(<ChipPhysics amount={0.5} compact />);
    const chips = container.querySelectorAll('.cp-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].className).toContain('cp-chip--partial');
    expect(container.querySelector('.cp-amount')?.textContent).toBe('0.50');
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
