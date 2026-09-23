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

/**
 * What the pile in the middle is WORTH, read the way a player reads it.
 *
 * Every disc counts as its denomination, except a denomination that printed a
 * count badge - there the badge's number is the truth and the discs drawn for
 * it are only a token. That is the pile's whole honesty contract, so this is
 * the function the contract is tested through.
 */
function potPileValue(container: HTMLElement): number {
  const byValue = new Map<number, number>();
  const denomOf = (color: string) => {
    const d = CHIP_DENOMINATIONS.find((x) => x.color === color);
    if (!d) throw new Error(`a disc was painted an off-ladder colour: ${color || '(none)'}`);
    return d;
  };

  for (const el of Array.from(container.querySelectorAll<HTMLElement>(POT_CHIP))) {
    const d = denomOf(el.style.getPropertyValue('--pile-chip-color').trim());
    byValue.set(d.value, (byValue.get(d.value) ?? 0) + 1);
  }
  for (const badge of Array.from(
    container.querySelectorAll<HTMLElement>('.pot-display__pile-multi')
  )) {
    const d = denomOf(badge.style.getPropertyValue('--pile-chip-color').trim());
    byValue.set(d.value, Number((badge.textContent ?? '').replace(/[^0-9]/g, '')));
  }
  return Array.from(byValue).reduce((sum, [value, n]) => sum + value * n, 0);
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

// ============================================================================
// THE PILE ADDS UP TO THE POT — EVERY POT, NOT JUST THE EASY ONES
// ============================================================================

/**
 * Dan 2026-09-14: "BOMB POTS CHIPS DON'T UPDATE TO DISPLAY THE ACTUAL AMOUNT
 * IN THE POTS."
 *
 * The collapsed-CSS bug was one half of that. This is the other half, and it
 * was never the CSS: `visualChipStacks` takes `maxStacks`, which SLICES the
 * breakdown - `chips.slice(0, maxStacks)` - and a sliced group takes its value
 * with it. The pot asked for six. Dan's ladder has eleven denominations, and a
 * pot that mixes big and small chips routinely breaks into seven or eight.
 *
 * Swept across every integer pot from 1 to 200,000, six stacks drew a pile
 * that did not add up on 64,000 of them. One pot in three. The pill said
 * 18,888 and the chips under it were 18,885, on a table where those chips are
 * what a player checks the pill against.
 *
 * `maxTotal` is the cap that belongs here - it clamps the DISCS and prints the
 * true count for what it trimmed, which is the module's documented contract.
 * `maxStacks` gets the whole ladder, so no denomination is ever dropped.
 */
describe('the pot draws every denomination it holds', () => {
  // Chosen from the failure class above plus the three pots in Dan's
  // screenshots: 30 (green + red), 74 (2 green, 4 red, 4 white), 144.
  const POTS = [
    30, 74, 144, 21, 175, 555, 1234, 2468, 3777, 8888, 18888, 60000, 76543, 97531, 131313, 250000,
    432100, 987654,
  ];

  it.each(POTS)('a pot of %i is drawn as chips that add up to it', (pot) => {
    const { container } = render(<PotDisplay mainPot={pot} />);
    expect(potPileValue(container)).toBe(pot);
  });

  it('keeps the spread inside its width budget while it does it', () => {
    // The fix must not buy honesty with a pile that runs off the felt: the
    // disc budget is what bounds the width, and it is unchanged at ten.
    for (const pot of POTS) {
      const { container } = render(<PotDisplay mainPot={pot} />);
      expect(container.querySelectorAll(POT_CHIP).length).toBeLessThanOrEqual(10);
      cleanup();
    }
  });

  it('never paints a disc in a colour that is not on the ladder', () => {
    const { container } = render(<PotDisplay mainPot={131313} />);
    const ladder = new Set(CHIP_DENOMINATIONS.map((d) => d.color));
    const painted = chipColors(container, POT_CHIP, '--pile-chip-color');
    expect(painted.length).toBeGreaterThan(0);
    for (const c of painted) expect(ladder.has(c)).toBe(true);
  });
});

// ============================================================================
// SEVERAL CLAMPED DENOMINATIONS STAY READABLE
// ============================================================================

describe('the true counts', () => {
  // 131,313 clamps four denominations at once; 987,654 clamps five.
  it('gives every clamped denomination its own badge', () => {
    const { container } = render(<PotDisplay mainPot={131313} />);
    const badges = container.querySelectorAll('.pot-display__pile-multi');
    expect(badges.length).toBeGreaterThan(1);
  });

  it('puts them in one row instead of stacking them on the discs', () => {
    // The old badge hung off its own disc, absolutely positioned and centred
    // on it. Groups trimmed to a single disc sit half a chip apart, so four of
    // those badges landed on top of each other. A row cannot collide.
    const { container } = render(<PotDisplay mainPot={131313} />);
    const row = container.querySelector('.pot-display__pile-counts');
    expect(row).not.toBeNull();
    for (const badge of Array.from(container.querySelectorAll('.pot-display__pile-multi'))) {
      expect(badge.parentElement).toBe(row);
      expect(badge.closest('.pot-display__pile-chip')).toBeNull();
    }
  });

  it('names the chip each count belongs to, by colour', () => {
    const { container } = render(<PotDisplay mainPot={131313} />);
    const colors = Array.from(
      container.querySelectorAll<HTMLElement>('.pot-display__pile-multi')
    ).map((b) => b.style.getPropertyValue('--pile-chip-color').trim());
    expect(colors.every(Boolean)).toBe(true);
    // One badge per denomination, never two for the same chip.
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('carries the colour on the badge rather than tinting the number', () => {
    // The 100 chip is #1c1c2e. Tinted text in that colour is invisible on the
    // felt, so the number stays gold and a rimmed dot carries the identity.
    const css = readSrc('src/components/table/PotDisplay.css');
    const badge = css.slice(css.indexOf('.pot-display__pile-multi {'));
    expect(badge).toMatch(/color:\s*var\(--pd-gold/);
    expect(css).toMatch(/\.pot-display__pile-multi::before[\s\S]*?--pile-chip-color/);
  });
});

// ============================================================================
// THE MEMO COMPARATOR CANNOT SWALLOW THE PROPS THE POT IS DRAWN FROM
// ============================================================================

/**
 * PotDisplay is `memo`'d with a hand-written comparator, and the file already
 * carries a comment about `collectTo` having been left out of it - "a collectTo
 * change alone reported props equal, so the pot-push slide could silently never
 * render". Two more props were still missing, and each one defeats a fix that
 * lives in this same component.
 *
 * The pile is drawn from `displayPot`, so a comparator that swallows these is a
 * pot showing the wrong chips, not just the wrong digits.
 */
describe('the pot re-renders for every prop it is drawn from', () => {
  const PUSH = { dx: 0, dy: 0 };
  const potSays = (c: HTMLElement) =>
    c.querySelector('.pot-display')?.getAttribute('aria-label') ?? '';

  it('shows the awarded amount when awardedPot is the only prop that moved', () => {
    // A fold-around: the blinds sit in front of the seats all hand, so
    // mainPot === streetBets and the running total is 0 throughout. awardedPot
    // flips from 0 to the won amount the instant the winner band opens - and
    // that is frequently the ONLY prop changing in that commit.
    const { container, rerender } = render(
      <PotDisplay mainPot={10} streetBets={10} collectTo={PUSH} awardedPot={0} handNumber={7} />
    );
    expect(potSays(container)).toContain('Pot: 0');

    rerender(
      <PotDisplay mainPot={10} streetBets={10} collectTo={PUSH} awardedPot={15} handNumber={7} />
    );
    expect(potSays(container)).toContain('Pot: 15');
  });

  it('expires the carried pot when handNumber is the only prop that moved', () => {
    // Hand N takes 100. Hand N+1 must not push hand N's amount to its winner.
    const { container, rerender } = render(
      <PotDisplay mainPot={100} streetBets={0} handNumber={1} />
    );
    rerender(<PotDisplay mainPot={100} streetBets={100} collectTo={PUSH} handNumber={1} />);
    expect(potSays(container)).toContain('Pot: 100');

    rerender(<PotDisplay mainPot={100} streetBets={100} collectTo={PUSH} handNumber={2} />);
    expect(potSays(container)).not.toContain('Pot: 100');
  });

  it('drops the pile when showChipAnimation is the only prop that moved', () => {
    const { container, rerender } = render(<PotDisplay mainPot={21} showChipAnimation />);
    expect(container.querySelectorAll(POT_CHIP).length).toBeGreaterThan(0);

    rerender(<PotDisplay mainPot={21} showChipAnimation={false} />);
    expect(container.querySelectorAll(POT_CHIP).length).toBe(0);
  });
});
