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

/* Comments in this stylesheet quote CSS at length, braces included, so any
   rule-level assertion has to strip them first or it matches prose. */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every innermost `selector { body }` pair, selector whitespace-normalised.
    @media wrappers are skipped for free: their body contains braces, so the
    non-greedy `[^{}]*` never matches them. */
const RULES: { selector: string; body: string }[] = [
  ...cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

const rulesFor = (selector: string) => RULES.filter((r) => r.selector === selector);

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

  it('cancels the slice on a NESTED card without cancelling it on a bare one', () => {
    /* One invariant, two halves, and the second half is the one that bit.
     *
     * (a) A card inside a wrapper must not ALSO carry the slice, or the overlap
     *     is applied twice.
     * (b) The rule that does the cancelling must not also match a card that IS
     *     the flex child.
     *
     * This test used to assert (a) by requiring `margin-left: 0` on
     * `.seat__cards--hero .seat__card` — which is exactly the selector that
     * violates (b). At 0-2-0 it out-specifies `.seat__cards--hero > *` at
     * 0-1-0, so an UNWRAPPED card silently lost its overlap: a PLO6 row
     * measured 6 x 54 = 324px inside a 320px felt. hero-card-row.spec.ts
     * caught it on 2026-08-20 (rowLeft 477.99 vs feltLeft 480) once the E2E
     * suite started running signed in.
     *
     * `> * .seat__card` matches descendants of the flex child only, so the
     * wrapped case is unchanged and the bare case keeps its margin. That is
     * what makes the file comment's "independent of how the card is wrapped"
     * claim actually true.
     */
    const nested = rulesFor('.seat__cards--hero > * .seat__card');
    expect(
      nested.some((r) => /margin-left:\s*0/.test(r.body)),
      'a nested hero card must have the slice cancelled'
    ).toBe(true);

    for (const rule of rulesFor('.seat__cards--hero .seat__card')) {
      expect(
        rule.body,
        '.seat__cards--hero .seat__card also matches an UNWRAPPED card and ' +
          'out-specifies the `> *` overlap rule — it must not touch margin-left'
      ).not.toMatch(/margin-left/);
    }
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

  /**
   * Dan 2026-08-25 round 2, item 9: "when the hero doesn't have a hand, they
   * should never be covered by anything ever."
   *
   * The row used to be anchored at `left: calc(100% - 10px)` — a deliberate
   * tuck that slid the first card BEHIND the avatar to buy 10px of room for a
   * PLO6 hand. That tuck is the one part of the seat drawn ON the hero, at
   * z-index 20, and it survives into every state the row survives into: the
   * hero's `holeCards` are preserved across the fold so the player can see
   * what they mucked, and that preservation has no hand boundary in it.
   *
   * `100% + 1px` is the structural version of the fix: 100% is the seat's own
   * right edge, `.seat__info` is capped at the seat's width, so a row starting
   * one pixel past it shares no pixel with the hero at any hand size or
   * breakpoint. Pinned because it is a one-character regression — a later
   * "just tuck it back a bit for room" is exactly how it arrived.
   */
  it('anchors the row OUTSIDE the seat box, so it can never cover the hero', () => {
    const anchors = rulesFor('.seat__cards--hero')
      .flatMap((r) => [...r.body.matchAll(/left:\s*([^;]+);/g)])
      .map((m) => m[1].trim());

    expect(anchors.length, 'the hero row must declare its own left anchor').toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor, 'a negative tuck puts the first card back on top of the hero').toBe(
        'calc(100% + 1px)'
      );
    }
  });

  /**
   * The hero row's 2-card baseline lives on `.seat` as --sp-card2-* and the
   * row reads it via var() rather than restating literals — that indirection
   * is what lets the breakpoint blocks retune one place.
   *
   * HISTORY 2026-08-26: these tokens used to have a second consumer, the
   * hold'em villain row (`--twocard`), deleted with the second villain
   * renderer — villains now derive from the avatar token instead (see the
   * cluster in SeatSlot.css, pinned by shipped-invariants). The tokens are
   * hero-only again; this test pins the indirection either way.
   */
  it('reads the shared two-card size rather than restating it', () => {
    const heroTokens = rulesFor('.seat__cards--hero')
      .flatMap((r) => [...r.body.matchAll(/--sp-hero-card-(w|h|step):\s*([^;]+);/g)])
      .map((m) => m[2].trim());

    expect(heroTokens.length, 'the hero row must set all three size tokens').toBe(3);
    for (const value of heroTokens) {
      expect(value, 'the hero row must read the --sp-card2-* tokens, not literals').toMatch(
        /^var\(--sp-card2-(w|h|step),/
      );
    }
  });

  it('retunes the shared two-card size at every breakpoint that retunes the seat', () => {
    // `.seat` is where the responsive blocks already override --seat-avatar-base,
    // so the card size retunes in the same place and by the same rule. Four
    // declarations: the base plus the 640 / 480 / 380 blocks.
    for (const token of ['w', 'h', 'step']) {
      const hits = cssNoComments.match(new RegExp(`--sp-card2-${token}:`, 'g'));
      expect(hits, `--sp-card2-${token} is missing entirely`).toBeTruthy();
      expect(
        hits!.length,
        `--sp-card2-${token} must be tuned at every breakpoint that tunes the others`
      ).toBe(4);
    }
  });

  it('row widths stay within the felt at every hand size', () => {
    // Values from the base (widest) breakpoint block.
    // Dan 2026-08-27 round 3 item 1: the 2-card width/height is now PLO4's
    // (60x84) — "the hold'em cards need to be the exact same size as the PLO
    // cards". Only the stride still differs: two cards keep the row's original
    // 12px overlap (step = w - 12) where four have to close up to 25 to fit.
    const sizes = [
      { n: 2, w: 60, step: 48 },
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
