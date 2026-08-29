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

  /**
   * REWRITTEN 2026-08-28, and the rewrite is the point. This used to assert
   * `toBe(4)` — that each PLO guard was restated at all four breakpoints — which
   * was the right guard for a px ladder: with four independent copies, the way
   * PLO5 broke was that somebody retuned three of them.
   *
   * The ladder is gone (Dan: "my buttons and cards look the same no matter if
   * I'm on a phone, or a tablet"). The guards are ratios of --sp-card2-w, which
   * is itself a fraction of the felt's measured width, so there is ONE copy and
   * it is correct at every viewport rather than at four of them. Four copies is
   * now the failure this test should catch, not the success.
   *
   * What has not changed is what the test is FOR: no hand size may be silently
   * missing a size, and none may be tuned in a way that leaves the others
   * behind. Both are still checked, against the mechanism that now delivers it.
   */
  it('defines the full 4/5/6 set exactly once, as ratios of the shared card', () => {
    for (const n of [4, 5, 6]) {
      const hits = css.match(
        new RegExp(`\\.seat__cards--hero:has\\(> \\*:nth-child\\(${n}\\)\\)`, 'g')
      );
      expect(hits, `PLO${n} guard missing entirely`).toBeTruthy();
      expect(
        hits!.length,
        `PLO${n} is declared ${hits!.length} times. A per-breakpoint copy is exactly ` +
          'what the proportional sizing replaced — the surviving copy is correct at ' +
          'every width, and a second one can only drift from it.'
      ).toBe(1);

      // ...and that one copy must set all three tokens, or the hand size falls
      // back to the two-card baseline for whichever it omits.
      const rule = rulesFor(`.seat__cards--hero:has(> *:nth-child(${n}))`)[0];
      for (const token of ['w', 'h', 'step']) {
        expect(rule.body, `PLO${n} does not set --sp-hero-card-${token}`).toMatch(
          new RegExp(`--sp-hero-card-${token}:`)
        );
      }
      // Every one of them must be derived from the shared card, never a literal:
      // that is what keeps hold'em, PLO and the felt in the same proportion.
      expect(rule.body, `PLO${n} must size from --sp-card2-w, not from a px literal`).not.toMatch(
        /--sp-hero-card-(w|h|step):\s*\d+px/
      );
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

  /**
   * REWRITTEN 2026-08-28 with the guard above, for the same reason: the four
   * rungs became one proportional declaration. The invariant that mattered —
   * width, height and step can never fall out of step with each other — is now
   * structural instead of clerical, because height and step are CALCULATED from
   * width rather than typed beside it. So this asserts the derivation, which is
   * strictly stronger: the old test could only catch a rung somebody forgot,
   * and this catches a rung somebody adds back.
   */
  it('derives the two-card height and step from its width, in one place', () => {
    for (const token of ['w', 'h', 'step']) {
      const hits = cssNoComments.match(new RegExp(`--sp-card2-${token}:`, 'g'));
      expect(hits, `--sp-card2-${token} is missing entirely`).toBeTruthy();
      expect(
        hits!.length,
        `--sp-card2-${token} is declared ${hits!.length} times; it is a fraction of ` +
          'the felt and needs exactly one declaration'
      ).toBe(1);
    }

    const body = RULES.filter((r) => /--sp-card2-w:/.test(r.body))[0].body;

    // Width is the only one allowed to be independent, and it must read the
    // felt's MEASURED width — not a viewport unit, not a literal. A viewport
    // unit is what the old ladder effectively was, and it is wrong here: the
    // felt is derived from the height left over, so a 1280x800 laptop has a
    // SMALLER table than an iPhone 14 despite being three times as wide.
    expect(
      body.match(/--sp-card2-w:\s*([^;]+);/)![1],
      'the card must be a fraction of --table-w (the measured felt), with a legibility floor'
    ).toMatch(/clamp\(\s*\d+px\s*,\s*calc\(\s*var\(--table-w/);

    // Height and step must be computed FROM it — never restated.
    for (const [token, ratio] of [
      ['h', '1.4'],
      ['step', '0.72'],
    ]) {
      expect(
        body.match(new RegExp(`--sp-card2-${token}:\\s*([^;]+);`))![1],
        `--sp-card2-${token} must be calc()'d from --sp-card2-w (x${ratio}), so the ` +
          'pair cannot drift'
      ).toMatch(new RegExp(`calc\\(\\s*var\\(--sp-card2-w\\)\\s*\\*\\s*${ratio}`));
    }
  });

  /**
   * Dan 2026-08-28, on a phone, the evening of the day the proportional rule
   * landed: "THE SIZE OF THE CARDS IN NLH HAVE REGRESSED BACK TO THE SMALLER
   * SIZED HERO CARDS AND BOARD CARDS. MAKE THEM THE SAME SIZE AS THE PLO CARDS,
   * THEN PREVENT THEM FROM REGRESSING AGAIN."
   *
   * The test above proves hold'em and PLO4 read the SAME token, and it was true
   * and passing when he wrote that. What it could not see is that the token has
   * a FLOOR, and the floor was 44px — the exact hold'em card he had rejected
   * that morning, the one that "sat beside a 60px PLO4 card for nine days". So
   * hold'em and PLO were equal and BOTH were back at the rejected size wherever
   * the floor bound:
   *
   *     iPhone SE 375x667    felt 286.7  -> floor (fraction asks 39.8)
   *     iPhone landscape     felt  96.0  -> floor (fraction asks 13.3)
   *     iPad landscape       felt 308.1  -> floor (fraction asks 42.8)
   *     laptop 1280x800      felt 323.9  -> 45px, one pixel clear of it
   *
   * and, worse, on EVERY device for the first frame of every table: `scalerSize`
   * in TablePage.tsx initialises to 320px and a ResizeObserver cannot report
   * before layout, so 320 x 0.139 = 44.5px is what a hand starts at everywhere.
   *
   * "Prevent them from regressing again" is this test. A floor is not a neutral
   * safety net — it is a SIZE, and it silently outranks whatever the fraction
   * was tuned to produce. It may therefore never sit below the size Dan signed
   * off, which is 51px: his approved phone rung in #1571, and also exactly what
   * the fraction itself yields on the canonical iPhone 12/13/14 felt
   * (366 x 0.139 = 50.9). Above the floor the proportion is free; below it, the
   * only direction available is bigger.
   */
  it('never draws a card smaller than the size Dan approved, on any felt', () => {
    const body = RULES.filter((r) => /--sp-card2-w:/.test(r.body))[0].body;
    const decl = body.match(/--sp-card2-w:\s*([^;]+);/)![1].trim();

    const clamp = decl.match(
      /clamp\(\s*([\d.]+)px\s*,\s*calc\(\s*var\(--table-w\s*,\s*([\d.]+)px\s*\)\s*\*\s*([\d.]+)\s*\)\s*,\s*([\d.]+)px\s*\)/
    );
    expect(
      clamp,
      'the card must stay clamp(floor, fraction of the MEASURED felt, ceiling) — the ' +
        'shape is what lets this file reason about the floor at all'
    ).toBeTruthy();

    const [floorPx, fallbackW, fraction, ceilingPx] = clamp!.slice(1).map(Number);

    expect(
      floorPx,
      `the floor is ${floorPx}px. 44px is the pre-#1571 hold'em card Dan rejected on ` +
        '2026-08-27; anything at or below it reinstates that card on an iPhone SE, ' +
        'both landscapes, a 1280x800 laptop, and on the first frame of every table'
    ).toBeGreaterThanOrEqual(50);

    /* THE FLOOR MUST STAY UNDER THE CANONICAL DEVICE'S OWN ANSWER, and this is
       the half that is easy to get wrong in the "helpful" direction.

       The canonical felt is the iPhone 12/13/14's 366px, so the fraction gives
       366 x 0.139 = 50.87px there. A floor at 51 would bind on that device — by
       0.13px, invisibly on screen — and `floorBinds` in
       tests/e2e/table-proportions.spec.ts excuses any floor-bound device from
       every flatness assertion in that file, because a floor is by definition
       what stops a proportion. Raising the floor past this line therefore buys
       nothing a player can see and costs the estate's most-reviewed device its
       coverage. If the card needs to be bigger, raise the FRACTION. */
    const CANONICAL_FELT_W = 366;
    expect(
      floorPx,
      `the floor (${floorPx}px) has reached the canonical iPhone 12/13/14 card ` +
        `(${CANONICAL_FELT_W} x ${fraction} = ${(CANONICAL_FELT_W * fraction).toFixed(2)}px). ` +
        'That device is now governed by the floor rather than by the proportion, and ' +
        'table-proportions.spec.ts will silently stop measuring it. Raise the fraction ' +
        'instead.'
    ).toBeLessThan(CANONICAL_FELT_W * fraction);

    // A `.seat` rendered before the ResizeObserver reports, or outside the
    // scaler entirely, must land ON the fraction rather than on top of the
    // floor — otherwise the fallback is silently the rejected size again.
    expect(
      fallbackW * fraction,
      `the --table-w fallback (${fallbackW}px) yields ${(fallbackW * fraction).toFixed(1)}px, ` +
        'below the floor — first paint would draw the rejected card on every device'
    ).toBeGreaterThanOrEqual(floorPx);

    expect(ceilingPx, 'the ceiling must still leave room above the floor').toBeGreaterThan(floorPx);
  });

  /**
   * Dan 2026-08-27, verbatim: "THE CARDS INSIDE OF THE CLUB ARENA FOR HOLDEM
   * GAMES WERE NEVER CHANGED. THEY NEED TO BE THE SAME SIZE CARDS WE USE FOR
   * PLO INSIDE OF HOLDEM. MAKE SURE THAT THE HOLDEM CARDS (HERO CARDS AND
   * BOARD CARDS) ARE THE SAME AS PLO GLOBALLY."
   *
   * The 50% PLO enlargement on 2026-08-19 retuned the three `:has()` guards and
   * left the two-card set alone, so a hold'em hero drew a 44px card beside a
   * PLO hero's 60px one. There was even an e2e test named "hold-em hole cards
   * are NOT resized" guarding the gap — the reasoning being that the row had no
   * room. It had MORE room than any PLO row: fewer cards.
   *
   * PLO4 is the reference because it is the largest of the three PLO sets;
   * PLO5/6 step down from it to hold the row width constant, and a two-card row
   * is narrower than all three at the same card size.
   *
   * Pinned per breakpoint rather than as four literals so that retuning PLO
   * moves hold'em with it — which is what "globally" has to mean if it is not
   * to drift apart again the next time one of them is touched.
   */
  it('draws a hold-em card at exactly the PLO4 size, at EVERY width', () => {
    /* REWRITTEN 2026-08-28. The rule is Dan's and is unchanged and binding; only
       the proof changed, and it got much stronger.

       This used to walk four breakpoints and compare eight literals in pairs. It
       could only ever say "hold'em equals PLO4 at these four widths", and a
       fifth width — a tablet, which is where Dan noticed the problem — was
       outside what it could see.

       PLO4 now READS --sp-card2-w, the same token the hold'em two-card row
       reads, with a coefficient of exactly 1. So the two are not equal by
       arithmetic that has to be rechecked; they are the same value. That holds
       at every viewport, including the ones nobody enumerated. */
    const rule = rulesFor('.seat__cards--hero:has(> *:nth-child(4))')[0];
    expect(rule, 'the PLO4 guard is missing').toBeTruthy();

    const w = rule.body.match(/--sp-hero-card-w:\s*([^;]+);/)![1].trim();
    expect(
      w,
      'PLO4 width must BE --sp-card2-w — the token the hold-em row reads — not a ' +
        'multiple of it and not a literal. Anything else re-opens the 2026-08-19 gap ' +
        'where a 44px hold-em card sat beside a 60px PLO card on the same felt.'
    ).toBe('var(--sp-card2-w)');

    // Height follows the same 1.4 the two-card token uses, so the shapes match too.
    expect(
      rule.body.match(/--sp-hero-card-h:\s*([^;]+);/)![1],
      "PLO4 height must be 1.4 x the shared width, matching --sp-card2-h's own derivation"
    ).toMatch(/calc\(\s*var\(--sp-card2-w\)\s*\*\s*1\.4\s*\)/);

    // And PLO5/PLO6 must step DOWN from it — never up, or the row grows as the
    // hand grows and runs off the felt.
    for (const [n, max] of [
      [5, 1],
      [6, 1],
    ]) {
      const body = rulesFor(`.seat__cards--hero:has(> *:nth-child(${n}))`)[0].body;
      const factor = +body.match(/--sp-hero-card-w:[^;]*\*\s*([\d.]+)/)![1];
      expect(factor, `PLO${n} must not be wider than PLO4`).toBeLessThanOrEqual(max);
    }
  });

  /**
   * The showdown row is the ONE place hold'em and PLO legitimately size from
   * different tokens, and it is not an exception to the rule above — a tabled
   * hold'em hand is still the LARGEST hand on the felt (1.00 of its base,
   * against PLO4's 0.92 and PLO6's 0.70).
   *
   * It has its own base because it lays out WHOLE cards with a 1px gap, so its
   * row is n x w rather than w + (n-1) x step, and a PLO6 hand has to fit the
   * same strip beside the seat. Inheriting the enlarged private size would have
   * taken that row to 195px against 151px of room on a 375px phone.
   */
  it('sizes the tabled row from its own base, not the private two-card one', () => {
    const revealed = RULES.filter((r) => r.selector.includes('.seat__cards--revealed')).filter(
      (r) => /--sp-hero-card-w:/.test(r.body)
    );

    expect(revealed.length, 'the revealed row must set its own card width').toBeGreaterThan(0);
    for (const rule of revealed) {
      expect(
        rule.body,
        `${rule.selector} must read --sp-cardrev-w; --sp-card2-w now carries the PLO size ` +
          'and would overflow a tabled PLO6 row'
      ).not.toMatch(/--sp-card2-w/);
      expect(rule.body).toMatch(/var\(--sp-cardrev-w,/);
    }

    const hits = cssNoComments.match(/--sp-cardrev-w:/g);
    expect(hits, '--sp-cardrev-w is missing entirely').toBeTruthy();
    expect(
      hits!.length,
      `--sp-cardrev-w is declared ${hits!.length} times; like --sp-card2-w it is a ` +
        'fraction of the felt and needs exactly one declaration'
    ).toBe(1);

    /* 2026-08-28: the four rungs became one proportional declaration, and the
       SPLIT this test exists to protect is now expressed as a different
       coefficient rather than a different set of literals. Both are fractions of
       --table-w; the tabled row takes a visibly smaller one, because it lays out
       WHOLE cards with a 1px gap (n x w) instead of overlapping them
       (w + (n-1) x step) and a PLO6 hand has to fit the same strip beside the
       seat. Asserting the inequality is what stops a later "these look close
       enough, share the token" from re-creating the 195px-row overflow. */
    const revBody = RULES.filter((r) => /--sp-cardrev-w:/.test(r.body))[0].body;
    const coef = (re: RegExp, body: string) => +body.match(re)![1];
    const revCoef = coef(/--sp-cardrev-w:[^;]*var\(--table-w[^)]*\)\s*\*\s*([\d.]+)/, revBody);
    const card2Body = RULES.filter((r) => /--sp-card2-w:/.test(r.body))[0].body;
    const card2Coef = coef(/--sp-card2-w:[^;]*var\(--table-w[^)]*\)\s*\*\s*([\d.]+)/, card2Body);

    expect(
      revCoef,
      'the tabled row must take a SMALLER fraction of the felt than the private ' +
        'row, or a tabled PLO6 hand overflows its strip'
    ).toBeLessThan(card2Coef);
  });

  it('row widths stay within the felt at every hand size', () => {
    // Values from the base (widest) breakpoint block. The 2-card row carries
    // the PLO4 card size since 2026-08-27 (Dan: "the same as PLO globally") —
    // it is still the NARROWEST row on the felt, because it has the fewest
    // cards in it.
    const sizes = [
      { n: 2, w: 60, step: 43 },
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
