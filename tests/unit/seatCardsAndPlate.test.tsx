/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SHOWN HAND READS LEFT TO RIGHT, THE COMMA IS NOT A DIGIT, AND THE PUCK
 *  STANDS ON FELT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three reports from Dan on 2026-08-27, pinned here because all three are the
 * kind that come back:
 *
 *  1. "cards regardless of what side of the table they are on need to be
 *     displayed left to right. These are the ONLY WAY they should be displayed
 *     at showdown, or when shown by the player. Clearly showing every single
 *     card in the hand, and allowing them to be highlighted at showdown."
 *
 *     Three separate causes underneath one sentence: the villain cluster was
 *     MIRRORED on the left half of the table (`.seat--cards-left` lays its
 *     cards out from `right:`), the revealed step tapered to 0.40 of a card
 *     width at five and six cards so most of a PLO hand was covered, and the
 *     highlight was indexed against the DRAWN order while the engine numbers
 *     cards in the DEALT order - so on any hand the display sort reordered, the
 *     gold ring was on the wrong card.
 *
 *  2. "the number fonts inside the action box look weird with the commas. 1,518
 *     looks like it has an extra space or something." A monospaced face gives
 *     the comma a full digit's advance.
 *
 *  3. "the button should never overlap the action box. Move it forward more."
 *     `dealerButtonPosition` checked a seat's box only for TOP-CAP seats.
 *
 * STYLESHEET PARTS ARE CSS-SOURCE ASSERTIONS, in the style of
 * tests/unit/bottomBarReserve.test.ts, for the reason HeroCardRowGeometry gives:
 * jsdom does not resolve custom properties or `:has()`, so a render test would
 * pass against the broken CSS. Behaviour that jsdom CAN see - which element
 * carries which class, and which card is marked as winning - is rendered for
 * real. The geometry is pure arithmetic and is run over every production ring
 * at every table size the app renders.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SeatSlot, { type SeatPlayer, type Card } from '../../src/components/table/SeatSlot';
import { displayOrderWithDealtIndex } from '../../src/lib/tableCardDisplay';
import {
  dealerButtonPositionClearOfSeat,
  overlapsSeatPlate,
  overlapsBoard,
} from '../../src/components/table/DealerButton';
import {
  dealerButtonPosition,
  seatPodPx,
  markerGapWidthPct,
  chipRestPosition,
  isOnFeltText,
  buttonRadiusWidthPct,
  feltEdgeClearanceWidthPct,
  MARKER_MIN_GAP_WIDTH_PCT,
  FELT_MARKER_MARGIN_WIDTH_PCT,
  type Pos,
  type Size,
} from '../../src/components/table/tableGeometry';
import { SEAT_LAYOUTS } from '../../src/lib/tableSeatGeometry';

const CSS = readFileSync(resolve(__dirname, '../../src/components/table/SeatSlot.css'), 'utf8');
/* The stylesheet quotes CSS at length in prose, braces included, so every
   rule-level assertion strips comments first or it matches a comment. */
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
/* `[^{}]+` before a `{` reaches back to the previous `}`, so the first rule in
   the file carries the `@import` line in front of its selector. Keeping only
   what follows the last `;` drops that without affecting any other rule. */
const RULES: { selector: string; body: string }[] = [
  ...CSS_NO_COMMENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({
  selector: m[1].split(';').pop()!.trim().replace(/\s+/g, ' '),
  body: m[2],
}));
const rulesFor = (selector: string) => RULES.filter((r) => r.selector === selector);

// ═══════════════════════════════════════════════════════════════════════════
// 1. A REVEALED HAND IS LAID OUT LEFT TO RIGHT, WHATEVER SEAT IT IS IN
// ═══════════════════════════════════════════════════════════════════════════

describe('a revealed hand reads left to right at every seat', () => {
  /** Every rule that positions a card inside a REVEALED opponent cluster. */
  const revealedCardRules = () =>
    RULES.filter(
      (r) =>
        r.selector.includes('seat__cards--revealed') &&
        r.selector.trim().endsWith('.seat__card') &&
        /(^|[^-])\b(left|right):/.test(r.body)
    );

  it('positions every revealed card from its LEFT edge, on both table sides', () => {
    for (const side of ['left', 'right'] as const) {
      const hits = revealedCardRules().filter((r) => r.selector.includes(`.seat--cards-${side}`));
      expect(
        hits.length,
        `a .seat--cards-${side} seat must have a rule placing its REVEALED cards`
      ).toBeGreaterThan(0);
      for (const rule of hits) {
        expect(
          rule.body,
          `.seat--cards-${side} revealed cards must be laid out from left:`
        ).toMatch(/left:\s*calc\(var\(--vh-i[^)]*\)\s*\*\s*var\(--vh-step\)\)/);
      }
    }
  });

  it('no revealed card is ever positioned from its RIGHT edge', () => {
    // The mirroring itself: `right: calc(--vh-i * --vh-step)` is what reversed
    // a left-hand seat's hand. `right: auto` is the cancellation of it and is
    // required, not forbidden.
    for (const rule of revealedCardRules()) {
      expect(
        rule.body,
        `${rule.selector} still lays a revealed card out from the right - that is the mirror`
      ).not.toMatch(/right:\s*calc\(/);
      expect(rule.body, `${rule.selector} must cancel any inherited right anchor`).toMatch(
        /right:\s*auto/
      );
    }
  });

  it('the un-mirroring is keyed on --revealed, so a face-down rosette still mirrors', () => {
    // The resting cluster's mirroring is deliberate (it is what makes both
    // rails look symmetrical). Only the SHOWN hand is straightened.
    const restingLeft = rulesFor('.seat--cards-left .seat__cards--opponent .seat__card');
    expect(restingLeft.length, 'the face-down left-hand cluster rule went missing').toBe(1);
    expect(restingLeft[0].body, 'the face-down cluster must keep its mirror').toMatch(
      /right:\s*calc\(/
    );
  });

  it('flattens the splay at showdown, so a shown hand is not read on a tilt', () => {
    const revealed = rulesFor('.seat__cards--opponent.seat__cards--revealed');
    expect(revealed.length, 'the revealed cluster rule went missing').toBe(1);
    expect(revealed[0].body, '--vh-rot-scale must be 0 while the faces are up').toMatch(
      /--vh-rot-scale:\s*0\s*;/
    );
  });

  it('shows every card whole - the step never tapers by card count', () => {
    // The regression: 1.06 for a pair but 0.48 at 3-4 cards and 0.40 at 5-6,
    // which covers 52-60% of every card after the first. Dan asked for "every
    // single card in the hand" to be clearly shown, so the step is one number.
    const revealed = rulesFor('.seat__cards--opponent.seat__cards--revealed');
    const step = /--vh-step-f:\s*([\d.]+)/.exec(revealed[0].body);
    expect(step, 'the revealed cluster must set its own step').toBeTruthy();
    expect(
      Number(step![1]),
      'a step under 1 means one card covers part of the next'
    ).toBeGreaterThanOrEqual(1);

    const taperers = RULES.filter(
      (r) =>
        r.selector.startsWith('.seat__cards--opponent.seat__cards--revealed:has') &&
        /--vh-step-f:/.test(r.body)
    );
    expect(
      taperers.map((r) => r.selector),
      'no :has() count guard may reduce the revealed step again'
    ).toEqual([]);
  });

  it('the top-cap seats keep their own left-to-right rule', () => {
    const top = rulesFor('.seat-wrapper--top .seat .seat__cards--revealed .seat__card');
    expect(top.length, 'the top-cap reveal rule went missing').toBe(1);
    expect(top[0].body).toMatch(/left:\s*calc\(/);
    expect(top[0].body).toMatch(/right:\s*auto/);
  });

  /**
   * Dan 2026-08-28, verbatim: "THE SHOW DOWN CARDS MUST ALWAYS BE ON TOP OF THE
   * AVATAR, NEVER BELOW, THE TOP VILLAINS CARDS ARE COVERING THE POT."
   *
   * The top-cap rule used to read `top: auto; bottom: calc(-1 * var(--vh-card-h)
   * - 6px)`, dropping a tabled hand a full card height below its own nameplate
   * and onto the felt — where the pot lives, and where `.seat-wrapper--showing`
   * at z-index 30 paints over the pot's 20.
   *
   * Pinned as a SHAPE rather than as pixel values: whatever the numbers become,
   * the revealed cluster must be anchored from its `top` edge and pulled up by
   * translateY(-100%), which is what makes it grow upward over the avatar. A
   * `bottom:` anchor on any revealed villain cluster is the regression itself.
   */
  it('never anchors a revealed villain row from its BOTTOM edge - that is the one that ate the pot', () => {
    const revealedClusters = RULES.filter(
      (r) =>
        r.selector.includes('seat__cards--opponent') &&
        r.selector.includes('seat__cards--revealed') &&
        // The CLUSTER, not the cards inside it. `.seat__card` is a prefix of
        // `.seat__cards`, so a plain `includes` here matches everything and the
        // loop below silently checks nothing.
        !/\.seat__card(?!s)/.test(r.selector)
    );
    expect(
      revealedClusters.length,
      'the revealed villain cluster rules went missing'
    ).toBeGreaterThan(0);

    for (const rule of revealedClusters) {
      const bottom = rule.body.match(/(?:^|[;{]|\s)bottom:\s*([^;]+);/);
      if (bottom) {
        expect(
          bottom[1].trim(),
          `${rule.selector} anchors the tabled hand from its bottom edge, which grows it ` +
            'DOWNWARD off the seat and onto the pot'
        ).toBe('auto');
      }
    }
  });

  it('grows the top-cap tabled hand UP over the avatar, from the same edge as every other seat', () => {
    const top = rulesFor('.seat-wrapper--top .seat .seat__cards--opponent.seat__cards--revealed');
    expect(top.length, 'the top-cap reveal anchor went missing').toBe(1);
    const body = top[0].body;

    // The base cluster's anchor: bottom edge 1px above the nameplate.
    expect(body, 'must anchor from `top`, like the base cluster does').toMatch(
      /top:\s*calc\(var\(--seat-avatar-size/
    );
    expect(body, 'a `bottom` anchor is what put the row on the pot').toMatch(/bottom:\s*auto/);

    /* The transform is ONE property. Centring with a bare translateX(-50%)
       silently drops the translateY(-100%) the base rule relies on, which puts
       the row back across the nameplate — so both parts must be restated here. */
    const transform = body.match(/transform:\s*([^;]+);/);
    expect(transform, 'the top-cap reveal must declare its transform').toBeTruthy();
    expect(transform![1], 'centring must not drop the bottom-edge anchoring').toMatch(
      /translate\(\s*-50%\s*,\s*-100%\s*\)/
    );
  });
});

describe('the hero row opens out when the hand is shown, and only then', () => {
  it('a revealed hero row has zero overlap: step is the card width plus a hairline', () => {
    // `.seat__cards--hero > *` applies `margin-left: calc(step - w)`. Making
    // step exceed w turns that negative slice into a gap without a second
    // margin rule that could fall out of step with the first.
    const base = rulesFor('.seat__cards--hero.seat__cards--revealed');
    expect(base.length, 'the revealed hero rule went missing').toBe(1);
    expect(base[0].body, 'step must be the card width plus a gap, never less').toMatch(
      /--sp-hero-card-step:\s*calc\(var\(--sp-hero-card-w\)\s*\+\s*1px\)/
    );
  });

  it('a revealed hero row is FLAT - the held-hand arc is cancelled', () => {
    const flat = RULES.filter(
      (r) =>
        r.selector.includes('.seat__cards--hero.seat__cards--revealed') &&
        r.selector.trim().endsWith('> *') &&
        /transform:\s*none/.test(r.body)
    );
    expect(
      flat.length,
      'the revealed hero row must reset the transform on the flex child'
    ).toBeGreaterThan(0);
    // One of them has to out-specify the 0-3-0 arc rule, which is written
    // `.seat__cards--hero:has(> :nth-child(4)) > *:not(...)`. A bare
    // `.seat__cards--hero.seat__cards--revealed > *` is 0-2-0 and loses.
    expect(
      flat.some((r) => r.selector.includes(':has(')),
      'a reset that cannot beat the PLO arc rule does not flatten a PLO hand'
    ).toBe(true);
  });

  it('scales the revealed card off --sp-cardrev-w, so it retunes at every breakpoint', () => {
    // --sp-cardrev-* is retuned in all four responsive blocks on `.seat`
    // (pinned by HeroCardRowGeometry). Deriving from it means the revealed row
    // needs no breakpoint block of its own - and cannot acquire three copies
    // of the same number.
    //
    // IT WAS --sp-card2-w UNTIL 2026-08-27, and the split is the point of this
    // beat now. Dan asked for hold-em hole cards to be the same size as PLO's,
    // so --sp-card2-* took the PLO4 numbers - a 36% jump. The tabled row lays
    // out WHOLE cards with a 1px gap rather than overlapping them, so the same
    // jump there would have taken a tabled PLO6 hand on a 375px phone from
    // 137px to 195px against 151px of room: the row would run off the screen
    // at exactly the moment other players are trying to read it.
    for (const n of [4, 5, 6]) {
      const rule = rulesFor(`.seat__cards--hero.seat__cards--revealed:has(> :nth-child(${n}))`);
      expect(rule.length, `the revealed hero size for ${n} cards is missing`).toBe(1);
      expect(rule[0].body, `${n}-card revealed width must derive from --sp-cardrev-w`).toMatch(
        /--sp-hero-card-w:\s*calc\(var\(--sp-cardrev-w[^)]*\)\s*\*\s*0?\.\d+\)/
      );
      expect(
        rule[0].body,
        `${n}-card revealed width must NOT read the private two-card token`
      ).not.toMatch(/--sp-card2-w/);
    }
  });

  it('does not disturb the private row that HeroCardRowGeometry pins', () => {
    // Those tests count `.seat__cards--hero:has(> *:nth-child(N))` and require
    // exactly four (one per breakpoint). The revealed guards are written with a
    // second class in front and without the `*`, so they cannot be miscounted
    // as a fifth tuning of the private row.
    for (const n of [4, 5, 6]) {
      const hits = CSS.match(
        new RegExp(`\\.seat__cards--hero:has\\(> \\*:nth-child\\(${n}\\)\\)`, 'g')
      );
      /* 2026-08-28: was `toBe(4)`, one per breakpoint. The private row's sizes
         are ratios of --sp-card2-w now — itself a fraction of the felt's
         measured width — so there is one guard per hand size and it is correct
         at every viewport rather than at four of them. What this beat is FOR is
         unchanged and is the reason it still counts: the revealed guards below
         are written with a second class in front and without the `*`, and if
         either of those slipped they would be counted here as an extra tuning
         of the private row. The number moved; the trap it watches did not. */
      expect(
        hits!.length,
        `PLO${n} private size guards must number exactly 1 — a revealed guard has ` +
          'been miscounted as a private one, or a per-breakpoint copy came back'
      ).toBe(1);
    }
    // And the private row's own token rule must still read the shared tokens.
    const heroTokens = rulesFor('.seat__cards--hero')
      .flatMap((r) => [...r.body.matchAll(/--sp-hero-card-(w|h|step):\s*([^;]+);/g)])
      .map((m) => m[2].trim());
    expect(heroTokens.length).toBe(3);
    for (const v of heroTokens) expect(v).toMatch(/^var\(--sp-card2-(w|h|step),/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE HIGHLIGHT LANDS ON THE CARD THE ENGINE MEANT
// ═══════════════════════════════════════════════════════════════════════════

const villain = (over: Partial<SeatPlayer> = {}): SeatPlayer => ({
  id: 'v1',
  name: 'VILLAIN',
  stack: 1518,
  status: 'active',
  showCards: true,
  isHero: false,
  ...over,
});

/** Dealt 6h As 9c Ad - a hand the display sort genuinely reorders. */
const DEALT: Card[] = [
  { rank: '6', suit: 'h' },
  { rank: 'A', suit: 's' },
  { rank: '9', suit: 'c' },
  { rank: 'A', suit: 'd' },
];

describe('the showdown highlight follows the card, not the slot', () => {
  it('the display order is high to low and every card keeps its dealt index', () => {
    const shown = displayOrderWithDealtIndex(DEALT);
    expect(shown.map((c) => c.card!.rank)).toEqual(['A', 'A', '9', '6']);
    // The two aces keep their relative dealt order (a stable sort), and every
    // index still points at the card the engine numbered.
    for (const { card, dealtIndex } of shown) {
      expect(card).toEqual(DEALT[dealtIndex]);
    }
  });

  /**
   * UPDATED WITH THE BEHAVIOUR, IN THE SAME COMMIT (round 17, CLAUDE.md §8).
   *
   * This used to require the WHOLE hand to stay in dealt order the moment any
   * slot was null. Dan, 2026-08-30, with a screenshot of his own PLO6 hand
   * reading J-8-4-7-7-4: "PLO HANDS NEED TO BE ORGANIZED... HIGHEST CARDS TO
   * LOWEST, LEFT TO RIGHT AS WELL."
   *
   * The half of the old rule that was right is kept and still pinned below: a
   * null is the per-card show picker holding a card face down, so its SLOT
   * must not move. The half that was wrong is that one face-down card
   * scrambled every other card in the hand.
   */
  it('a null keeps its slot, and the cards around it still sort high to low', () => {
    // DEALT is 6h As 9c Ad; hide the ace of spades in slot 1.
    const withHidden = [DEALT[0], null, DEALT[2], DEALT[3]];
    const shown = displayOrderWithDealtIndex(withHidden);

    // The hidden slot has not moved.
    expect(shown[1].card).toBeNull();
    expect(shown[1].dealtIndex).toBe(1);

    // The three visible cards fill the remaining slots in rank order: Ad 9c 6h.
    const visible = shown.filter((c) => c.card != null);
    expect(visible.map((c) => c.card!.rank)).toEqual(['A', '9', '6']);

    // And every one still points at the card the ENGINE numbered, which is the
    // invariant the showdown highlight depends on.
    for (const { card, dealtIndex } of shown) {
      expect(card).toEqual(withHidden[dealtIndex]);
    }
  });

  it('lights the ace of spades when the engine says index 1, not the ace of diamonds', () => {
    // THE BUG, stated as a render. Dealt index 1 is As. Drawn, the row is
    // As Ad 9c 6h, so drawn index 1 is Ad. Indexing the highlight by the drawn
    // position lit the wrong ace.
    const { container } = render(
      <SeatSlot
        seatNumber={3}
        player={villain({ holeCards: DEALT })}
        position={null}
        isActive={false}
        lastAction={null}
        isWinner
        winnerDisplayActive
        winningHoleCardIndexes={[1]}
      />
    );
    const cards = [...container.querySelectorAll('.seat__cards--opponent .seat__card')];
    expect(cards).toHaveLength(4);
    // Exactly one winner, and it is the FIRST card in the row (As sorts first).
    const winners = cards.filter((c) => c.classList.contains('seat__card--winner'));
    expect(winners).toHaveLength(1);
    expect(cards.indexOf(winners[0]), 'As is drawn first, so the ring belongs on card 0').toBe(0);
    // And every other card dims, which is the other half of the same index.
    expect(cards.filter((c) => c.classList.contains('seat__card--dimmed'))).toHaveLength(3);
  });

  it('lays the row out with --vh-i running 0..n-1 in DRAWN order', () => {
    // --vh-i is what the CSS multiplies by --vh-step, so it has to follow the
    // row as drawn even though the highlight follows the deal.
    const { container } = render(
      <SeatSlot
        seatNumber={3}
        player={villain({ holeCards: DEALT })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    const idx = [
      ...container.querySelectorAll<HTMLElement>('.seat__cards--opponent .seat__card'),
    ].map((c) => c.style.getPropertyValue('--vh-i'));
    expect(idx).toEqual(['0', '1', '2', '3']);
  });

  it('marks the cluster revealed only while the seat is actually showing', () => {
    const shown = render(
      <SeatSlot
        seatNumber={3}
        player={villain({ holeCards: DEALT })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    expect(shown.container.querySelector('.seat__cards--revealed')).not.toBeNull();

    const hidden = render(
      <SeatSlot
        seatNumber={4}
        player={villain({ id: 'v2', showCards: false, holeCards: undefined })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    expect(hidden.container.querySelector('.seat__cards--revealed')).toBeNull();
  });
});

describe("the hero's row opens out only when the table can see it", () => {
  const hero = (over: Partial<SeatPlayer> = {}): SeatPlayer => ({
    id: 'h1',
    name: 'HERO',
    stack: 1518,
    status: 'active',
    showCards: true,
    isHero: true,
    holeCards: DEALT,
    ...over,
  });

  const renderHero = (props: Record<string, unknown> = {}, over: Partial<SeatPlayer> = {}) =>
    render(
      <SeatSlot
        seatNumber={1}
        player={hero(over)}
        position={null}
        isActive={false}
        lastAction={null}
        {...props}
      />
    );

  it('stays compact and arced while the hand is private', () => {
    const { container } = renderHero();
    expect(container.querySelector('.seat__cards--hero')).not.toBeNull();
    expect(
      container.querySelector('.seat__cards--hero.seat__cards--revealed'),
      'a private hero hand must not fan itself open'
    ).toBeNull();
  });

  it('opens out when the hero wins the pot', () => {
    const { container } = renderHero({ isWinner: true, winnerDisplayActive: true });
    expect(container.querySelector('.seat__cards--hero.seat__cards--revealed')).not.toBeNull();
  });

  it('opens out on an all-in runout, when the cards go face up to the table', () => {
    const { container } = renderHero({}, { status: 'all_in' });
    expect(container.querySelector('.seat__cards--hero.seat__cards--revealed')).not.toBeNull();
  });

  it('stays compact for a hero who folded - the muck view is private', () => {
    // TablePage keeps the hero's last hand on screen after a fold on purpose,
    // so this row renders during somebody else's showdown. It must not open.
    const { container } = renderHero({ winnerDisplayActive: true }, { status: 'folded' });
    expect(container.querySelector('.seat__cards--hero.seat__cards--revealed')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE COMMA
// ═══════════════════════════════════════════════════════════════════════════

describe('a thousands separator does not sit in a digit-wide hole', () => {
  it('declares one amount font for the whole seat', () => {
    const seat = rulesFor('.seat');
    const decl = seat.flatMap((r) => [...r.body.matchAll(/--sp-amount-font:\s*([^;]+);/g)]);
    expect(decl.length, '--sp-amount-font is read but never declared').toBe(1);
    expect(decl[0][1], 'the amount font must be the proportional UI face').toMatch(
      /var\(--font-sans/
    );
  });

  /* Each of these is declared once at the base and re-declared in the
     responsive blocks (font-size only), so every rule for the selector is
     checked rather than just the first. */
  const AMOUNTS = ['.seat__stack', '.seat__stack-delta', '.seat__bounty-val'];

  it('no formatted amount on the seat asks for a monospaced face any more', () => {
    // The cause: in a monospaced font every glyph shares one advance, so the
    // comma - which is a quarter of that box of ink - is drawn with a digit's
    // worth of air around it. `1,518` reads as `1, 518`.
    for (const selector of AMOUNTS) {
      const rules = rulesFor(selector);
      expect(rules.length, `${selector} went missing`).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.body, `${selector} must not be monospaced at any breakpoint`).not.toMatch(
          /monospace/
        );
      }
      expect(
        rules.some((r) => /font-family:\s*var\(--sp-amount-font\)/.test(r.body)),
        `${selector} must read the shared amount font`
      ).toBe(true);
    }
  });

  it('keeps the DIGITS tabular, so a changing stack does not jitter', () => {
    // Losing the monospaced face naively also loses equal digit advances, and a
    // number that re-flows on every pot is worse than a wide comma.
    // `tabular-nums` asks for uniform figures while punctuation keeps its own
    // natural width - which is the whole fix.
    for (const selector of AMOUNTS) {
      expect(
        rulesFor(selector).some((r) => /font-variant-numeric:\s*tabular-nums/.test(r.body)),
        `${selector} lost its tabular figures`
      ).toBe(true);
    }
  });

  it('renders a four-figure stack with a plain comma and no padding', () => {
    const { container } = render(
      <SeatSlot
        seatNumber={3}
        player={villain({ stack: 1518 })}
        position={null}
        isActive={false}
        lastAction={null}
      />
    );
    // `.toLocaleString()`, never `.padStart()` - the repo rule, and the reason
    // there is no whitespace in the string to begin with.
    expect(container.querySelector('.seat__stack')?.textContent).toBe('1,518');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE DEALER BUTTON
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The three table sizes the app renders plus the 480px rung, as measured pixel
 * boxes - the same set tests/table-seat-ring-integrity.test.ts uses, with the
 * extra rung because `seatPodPx` is keyed off the VIEWPORT and the plate is a
 * different size on each.
 */
const TABLES: Array<{ label: string; vw: number; size: Size }> = [
  { label: 'phone 375px', vw: 375, size: { w: 347, h: 574 } },
  { label: 'phone 480px', vw: 480, size: { w: 452, h: 747 } },
  { label: 'tablet portrait', vw: 600, size: { w: 600, h: 992 } },
  { label: 'desktop', vw: 720, size: { w: 720, h: 1190 } },
];
const RINGS = [2, 3, 4, 5, 6, 7, 8, 9] as const;

const sq = (p: Pos, size: Size): Pos => ({ x: p.x, y: (p.y * size.h) / size.w });
const podFor = (vw: number, seat: Pos) => seatPodPx(vw, seat.y >= 100 && seat.x === 50);

describe('the dealer button never stands on a name plate', () => {
  it('the defect is real: the module on its own puts 56 pucks on a plate', () => {
    // Stated as a measurement rather than prose so that folding this back into
    // tableGeometry.ts (see the note at the top of DealerButton.tsx) fails HERE
    // with a number, rather than leaving a test that quietly stops meaning
    // anything. When `dealerButtonPosition` grows the seat-plate check itself,
    // this expectation becomes 0 and the wrapper can be deleted.
    let overlapping = 0;
    for (const { vw, size } of TABLES) {
      for (const n of RINGS) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const pod = podFor(vw, seat);
          if (overlapsSeatPlate(dealerButtonPosition(seat, size, pod), seat, size, pod)) {
            overlapping++;
          }
        }
      }
    }
    // 36 with the 4.9%-wide puck; 56 since 2026-09-04, when the puck became
    // twice the chip (7.2% of the table - Dan: "double the size as the chips in
    // pot"). A bigger disc stands on more plates from the same centre; the
    // three `no seat ... on its own plate` cases below are the ones that ship.
    expect(overlapping).toBe(56);
  });

  for (const { label, vw, size } of TABLES) {
    it(`${label}: no seat on any ring puts its puck on its own plate`, () => {
      for (const n of RINGS) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const pod = podFor(vw, seat);
          const b = dealerButtonPositionClearOfSeat(seat, size, pod);
          expect(
            overlapsSeatPlate(b, seat, size, pod),
            `${n}-max ${label}: seat ${JSON.stringify(seat)} put its button at ` +
              `${b.x.toFixed(1)},${b.y.toFixed(1)} - on its own name plate`
          ).toBe(false);
        }
      }
    });

    it(`${label}: and none of them lands on the community board instead`, () => {
      // The space is tight - the board is 95% of the felt's width - so a fix
      // that pushes the puck off a plate has somewhere very specific to go
      // wrong. This is the same board rectangle
      // tests/table-seat-ring-integrity.test.ts measures, re-run against the
      // position that actually SHIPS.
      for (const n of RINGS) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const b = dealerButtonPositionClearOfSeat(seat, size, podFor(vw, seat));
          expect(
            overlapsBoard(b, size),
            `${n}-max ${label}: seat ${JSON.stringify(seat)} put its button at ` +
              `${b.x.toFixed(1)},${b.y.toFixed(1)} - on the cards`
          ).toBe(false);
        }
      }
    });

    it(`${label}: keeps every guarantee the geometry module already made`, () => {
      // A refinement, not a second opinion. Whatever the swing does, the puck
      // is still clear of its own chips, off the printed masthead and wholly on
      // the felt.
      for (const n of RINGS) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const pod = podFor(vw, seat);
          const b = dealerButtonPositionClearOfSeat(seat, size, pod);
          const chips = chipRestPosition(seat, size, pod);
          const where = `${n}-max ${label} seat ${JSON.stringify(seat)}`;
          expect(
            markerGapWidthPct(b, chips, size),
            `${where}: puck is standing in its own chips`
          ).toBeGreaterThanOrEqual(MARKER_MIN_GAP_WIDTH_PCT - 1e-9);
          expect(
            isOnFeltText(b, size, buttonRadiusWidthPct(size)),
            `${where}: puck is on the printed masthead`
          ).toBe(false);
          expect(
            feltEdgeClearanceWidthPct(b, size),
            `${where}: puck is overhanging the painted rail`
          ).toBeGreaterThanOrEqual(FELT_MARKER_MARGIN_WIDTH_PCT - 1e-9);
        }
      }
    });

    it(`${label}: the puck still belongs to its own chair`, () => {
      // The invariant tests/unit/chipRail.test.ts protects: pushing a puck off
      // one plate must never walk it nearer a neighbour's, or the table now
      // says the wrong player is the dealer.
      for (const n of RINGS) {
        const ring = SEAT_LAYOUTS[n];
        for (const seat of ring) {
          const b = sq(dealerButtonPositionClearOfSeat(seat, size, podFor(vw, seat)), size);
          const own = Math.hypot(b.x - sq(seat, size).x, b.y - sq(seat, size).y);
          for (const other of ring) {
            if (other === seat) continue;
            const o = sq(other, size);
            expect(
              Math.hypot(b.x - o.x, b.y - o.y),
              `${n}-max ${label}: the button for ${JSON.stringify(seat)} is nearer ` +
                `${JSON.stringify(other)}`
            ).toBeGreaterThan(own);
          }
        }
      }
    });
  }

  it('leaves a puck that was already clear exactly where it was', () => {
    // The wrapper may only ever move a button that is demonstrably standing on
    // something. Anything else is a silent relayout of the whole table.
    let moved = 0;
    for (const { vw, size } of TABLES) {
      for (const n of RINGS) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const pod = podFor(vw, seat);
          const before = dealerButtonPosition(seat, size, pod);
          const after = dealerButtonPositionClearOfSeat(seat, size, pod);
          const same = before.x === after.x && before.y === after.y;
          if (!same) {
            moved++;
            expect(
              overlapsSeatPlate(before, seat, size, pod) || overlapsBoard(before, size),
              `seat ${JSON.stringify(seat)} was moved without being on anything`
            ).toBe(true);
          }
        }
      }
    }
    // 36 before 2026-09-04; 56 with the doubled puck - all of them plate
    // overlaps, because the board keep-out now lives in dealerButtonPosition
    // itself (tableGeometry.overlapsBoard) and the module never hands the
    // wrapper a puck on the cards to move.
    expect(moved, 'exactly the 56 measured overlaps move, and nothing else').toBe(56);
  });
});
