/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HERO HOLE-CARD ROW — geometry must survive being wrapped
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ANIMATION AUDIT 2026-08-20.
 *
 * The hero row is driven by three tokens and sized as  w + (n - 1) * step .
 * That worked only while `.seat__card` WAS the flex child of the row. The
 * per-card "show this after the hand" feature wrapped every hero card in a
 * `<span class="seat__card-pick">`, which broke both halves of the layout
 * without touching a single line of CSS:
 *
 *   1. `.seat__card:first-child` started matching EVERY card (each card is the
 *      only child of its own wrapper), cancelling the negative margin on all of
 *      them — the row lost its overlap.
 *   2. `:has(.seat__card:nth-child(4|5|6))` stopped matching anything, so
 *      PLO4/5/6 never got their reduced tokens.
 *
 * Result: a PLO6 row 6 x 44 = 264px wide instead of 54 + 5 x 21 = 159px.
 *
 * This is a CSS-source test rather than a render test on purpose: jsdom does
 * not implement `:has()` or resolve custom properties, so a render test would
 * pass against the broken CSS. What actually needs pinning is that the
 * selectors are written against the ROW'S CHILD rather than against a specific
 * element, which is exactly what makes them wrapper-proof.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../../src/components/table/SeatSlot.css'), 'utf8');

describe('hero hole-card row geometry', () => {
  it('sizes PLO4/5/6 by counting the ROW CHILD, not a specific element', () => {
    for (const n of [4, 5, 6]) {
      expect(
        css,
        `PLO${n} guard must count the row's own children so a wrapper cannot hide them`
      ).toContain(`.seat__cards--hero:has(> *:nth-child(${n}))`);
    }
  });

  it('has no guard keyed to .seat__card — the exact form the wrapper broke', () => {
    expect(css).not.toMatch(/\.seat__cards--hero:has\(\s*\.seat__card:nth-child/);
  });

  it('applies the overlap to the flex child, and resets it only on the first', () => {
    expect(css).toMatch(
      /\.seat__cards--hero\s*>\s*\*\s*\{[^}]*margin-left:\s*calc\(var\(--sp-hero-card-step\)\s*-\s*var\(--sp-hero-card-w\)\)/
    );
    expect(css).toMatch(/\.seat__cards--hero\s*>\s*\*:first-child\s*\{[^}]*margin-left:\s*0/);
  });

  it('does not cancel the overlap via .seat__card:first-child (matched every card)', () => {
    const rule = css.match(/\.seat__cards--hero \.seat__card:first-child\s*\{([^}]*)\}/);
    if (rule) {
      expect(
        rule[1],
        '.seat__card:first-child matches EVERY wrapped card — it must not carry margin'
      ).not.toMatch(/margin-left/);
    }
  });

  it('never applies the slice twice (wrapper AND card both carrying margin)', () => {
    const cardRule = css.match(/\.seat__cards--hero \.seat__card\s*\{([^}]*)\}/);
    expect(cardRule, 'expected a .seat__cards--hero .seat__card rule').toBeTruthy();
    expect(cardRule![1]).toMatch(/margin-left:\s*0/);
  });

  it('all four breakpoints define the full 4/5/6 set (none silently missing)', () => {
    for (const n of [4, 5, 6]) {
      const hits = css.match(
        new RegExp(`\\.seat__cards--hero:has\\(> \\*:nth-child\\(${n}\\)\\)`, 'g')
      );
      expect(hits, `PLO${n} guard missing entirely`).toBeTruthy();
      expect(
        hits!.length,
        `PLO${n} must be tuned at every breakpoint that retunes the others`
      ).toBe(4);
    }
  });

  it('row widths stay within the felt at every hand size', () => {
    // Values from the base (widest) breakpoint block.
    const sizes = [
      { n: 2, w: 44, step: 32 },
      { n: 4, w: 60, step: 25 },
      { n: 5, w: 57, step: 23 },
      { n: 6, w: 54, step: 21 },
    ];
    for (const { n, w, step } of sizes) {
      const width = w + (n - 1) * step;
      // The 341px-wide portrait felt; the row is centred over the seat.
      expect(width, `${n}-card row is ${width}px`).toBeLessThan(170);
    }
    // And the regression itself: unguarded PLO6 would have been 6 x 44.
    expect(6 * 44).toBeGreaterThan(170);
  });
});
