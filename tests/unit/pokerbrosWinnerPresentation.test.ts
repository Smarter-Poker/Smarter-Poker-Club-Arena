/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POKERBROS WINNER PRESENTATION — the 2026-08-26 frame-by-frame parity passes
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan supplied a screen recording of the reference client's showdown (26 Aug,
 * PLO5 "Flush" hand) and asked for a 1:1 clone. Round 1 eyeballed the frames;
 * round 2 MEASURED them (pixel sampling across the 30fps sequence). The
 * numbers this file pins all come from those measurements:
 *
 *  1. THE WHOLE SCENE DIMS. At the winner cut the reference multiplies the
 *     entire scene by ~0.73 — felt art, center brand block, pot, every name
 *     plate including the WINNER's (measured 0.67-0.72) — in one frame.
 *
 *  2. LOSING CARDS DROP TO 0.28. Every card outside the winning five reads
 *     0.28 of its pre-showdown brightness, channel-neutral (measured r/g/b
 *     ratios 0.284/0.282/0.280 — a pure darken, no desaturation).
 *
 *  3. WINNING CARDS HOLD FULL BRIGHTNESS (measured 0.95/0.91/0.83 — a
 *     slight warm cast from the halo) behind a STEADY thin warm-gold ring
 *     (ring samples up to rgb(232,194,115)). Nothing pulses, lifts, pops,
 *     shakes or sparkles — the reference has zero motion at the cut.
 *
 *  4. THE STATE IS A ONE-FRAME CUT. Highlight, dim, banner and scene-dim
 *     land together between two adjacent 30fps frames. Transitions here are
 *     capped at 90-120ms; anything slower is visibly not the reference.
 *
 *  5. THE BANNER hugs the board (band top ~2px under the cards), spans the
 *     table as a translucent dark strip, carries the hand name in light
 *     gold (measured stroke core #ffe39c, glyph height ~0.33x card height)
 *     over an orange lens-flare streak along the band's lower edge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock, sliceCssRule, sliceBetween } from '../helpers/sourceWindow';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const BOARD = strip(read('src/components/table/CommunityCards.tsx'));
const BOARD_CSS = read('src/components/table/CommunityCards.css');
const SEAT = strip(read('src/components/table/SeatSlot.tsx'));
const SEAT_CSS = read('src/components/table/SeatSlot.css');
const CARD_CSS = read('src/components/table/CardImage.css');
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));
const TABLE_CSS = read('src/pages/TablePage.css');

describe('the whole scene steps back behind the winner (measured 0.73)', () => {
  it('felt art, brand block and pot dim under the winner-flash class', () => {
    for (const sel of ['table-art', 'table-brand', 'pot-area']) {
      expect(TABLE_CSS, `${sel} must dim`).toMatch(
        new RegExp(`\\.table-page--winner-flash[^{]*\\.${sel}`)
      );
    }
    const at = TABLE_CSS.indexOf('.table-page--winner-flash .table-art');
    expect(sliceCssRule(TABLE_CSS, '.table-page--winner-flash .table-art')).toMatch(
      /brightness\(0\.73\)/
    );
  });

  it('every seat chrome element dims — cards, +N float and sparkles excluded', () => {
    const at = SEAT_CSS.indexOf('.table-page--winner-flash');
    expect(at, 'seat chrome dim rule missing').toBeGreaterThan(-1);
    const rule = SEAT_CSS.slice(at, SEAT_CSS.indexOf('}', at));
    expect(rule).toMatch(/:not\(\[class\*='seat__cards'\]\)/);
    expect(rule).toMatch(/:not\(\.seat__net-win\)/);
    expect(rule).toMatch(/:not\(\.seat__win-sparkles\)/);
    expect(rule).toMatch(/brightness\(0\.73\)/);
  });

  it('the page backdrop and the dealer button dim with the scene', () => {
    expect(TABLE_CSS).toMatch(/\.table-page--winner-flash::before/);
    const at = TABLE_CSS.indexOf('.table-page--winner-flash::before');
    expect(sliceCssRule(TABLE_CSS, '.table-page--winner-flash::before')).toMatch(
      /rgba\(0,\s*0,\s*0,\s*0\.27\)/
    );
    expect(TABLE_CSS).toMatch(/\.table-page--winner-flash \.dealer-button/);
  });

  it('the old golden table flash is gone — the reference has no flash', () => {
    // Strip comments first: the dim block's own comment names the retired
    // keyframe when explaining why it is gone.
    const cssNoComments = TABLE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(cssNoComments).not.toMatch(/winnerTableFlash/);
  });
});

describe('cards outside the winning five drop to 0.28 (measured, channel-neutral)', () => {
  it('the board derives a dim state from the highlight set', () => {
    expect(BOARD).toMatch(/isDimmed:\s*highlightedIndices\.length\s*>\s*0/);
    expect(BOARD).toMatch(/!highlightedIndices\.includes\(i\)/);
  });

  it('board and seat dim rules use the measured 0.28, with no desaturation', () => {
    for (const [css, sel] of [
      [BOARD_CSS, '.community-cards__card--dimmed'],
      [SEAT_CSS, '.seat__card--dimmed'],
    ] as const) {
      const at = css.indexOf(sel);
      expect(at, `${sel} missing`).toBeGreaterThan(-1);
      const body = css.slice(at, css.indexOf('}', at));
      expect(body).toMatch(/brightness\(0\.28\)/);
      expect(body).not.toMatch(/saturate/);
    }
  });

  it('SeatSlot dims non-winning face-up cards at every seat while a winner shows', () => {
    expect(SEAT).toMatch(/winnerDisplayActive\?:\s*boolean/);
    const uses = SEAT.match(/isDimmed=\{\s*winnerDisplayActive\s*&&/g) || [];
    expect(uses.length, 'villain row AND hero row must both dim').toBeGreaterThanOrEqual(2);
    expect(SEAT).toMatch(/prev\.winnerDisplayActive\s*!==\s*next\.winnerDisplayActive/);
    /* The table-wide dim is still driven from winnerInfo - that is what this
       spec is about and it is unchanged. The expression gained a second clause
       on 2026-08-27 (Dan: "cards dim like you folded even though you are live
       in a hand"): the winners must also belong to the hand ON THE FELT. A
       POT_WIN for hand N arriving after hand N+1 started used to merge into the
       fresh hand and dim the hero's brand-new hole cards.

       PIN MOVED 2026-09-06. That expression was written out inline here AND
       again for the board band, and the second copy is how the board kept
       lighting up after the seats had gone quiet. It is one const now,
       `winnerBandActive`, declared above the derivations that consume it. Both
       halves of the rule are still required - they are just required in one
       place - and the pin below proves every winner surface reads it. */
    expect(TABLE_PAGE).toMatch(/winnerDisplayActive=\{winnerBandActive\}/);
    expect(TABLE_PAGE).toMatch(/const winnerBandActive =\s*winnerInfo\.playerIds\.length > 0 &&/);
    expect(TABLE_PAGE).toMatch(/winnerInfo\.handNumber === \(tableState\.handNumber \?\? 0\)/);
  });

  /**
   * ONE FENCE, EVERY WINNER SURFACE (2026-09-06).
   *
   * The 2026-09-05 pass fenced the board band's TEXT and left the card
   * highlight, the felt-wide flash, the pot award and the seat's own winner
   * props reading `winnerInfo` raw. A stale pot_win therefore still lit the
   * live board's winning five, still dimmed every other face-up card, still
   * flashed the felt and still popped a seat - with the sentence above them
   * correctly silent. Half a fence is a bug with extra steps, so this pins the
   * whole set by name.
   */
  it('every winner surface is fenced on the hand being played, not just the label', () => {
    for (const [surface, re] of [
      ['felt flash', /\$\{winnerBandActive \? ' table-page--winner-flash' : ''\}/],
      [
        'board 1 highlight',
        /highlightedIndices=\{winnerBandActive \? winnerInfo\.cardIndices : \[\]\}/,
      ],
      ['pot award', /awardedPot=\{\s*winnerBandActive/],
      ['seat isWinner', /isWinner=\{\s*winnerBandActive && player/],
      ['seat hand name', /winnerBandActive && player && winnerInfo\.playerIds\.includes/],
    ] as const) {
      expect(TABLE_PAGE, `${surface} must be fenced on winnerBandActive`).toMatch(re);
    }
    /* Boards 2 and 3 are fenced at the source, inside the memos that derive
       their highlights, so no caller can forget. */
    expect(
      (TABLE_PAGE.match(/if \(!winnerBandActive\) return \[\];/g) ?? []).length,
      'board 2 and board 3 highlight memos both bail when the winner is not this hand'
    ).toBe(2);
  });
});

describe('the highlight is STEADY — zero motion at the cut', () => {
  it('no infinite pulse loops on winner styling', () => {
    for (const css of [BOARD_CSS, SEAT_CSS, CARD_CSS]) {
      expect(css).not.toMatch(/ccHighlightPulse\s+[^;]*infinite/);
      expect(css).not.toMatch(/winnerCardPulse\s+[^;]*infinite/);
      expect(css).not.toMatch(/ccGlowPulse\s+[^;]*infinite/);
    }
  });

  it('the highlight-pop state machine is gone from the board component', () => {
    expect(BOARD).not.toMatch(/highlightPop/);
    expect(BOARD_CSS).not.toMatch(/@keyframes\s+ccHighlightPop/);
  });

  it('showdown fires no screen shake and no particle burst', () => {
    expect(BOARD).not.toMatch(/triggerScreenShake|ParticleSystem/);
  });

  it('the showdown-wide golden ambient on every board card is gone', () => {
    expect(BOARD_CSS).not.toMatch(/--showdown \.community-cards__card\s*\{/);
  });

  it('the specular sheen pauses on winning and dimmed cards alike', () => {
    for (const sel of [
      '.community-cards__card--highlighted::after',
      '.community-cards__card--dimmed::after',
    ]) {
      const at = BOARD_CSS.indexOf(sel);
      expect(at, `${sel} missing`).toBeGreaterThan(-1);
      expect(BOARD_CSS.slice(at, BOARD_CSS.indexOf('}', at))).toMatch(/animation:\s*none/);
    }
  });

  // This used to assert that `.community-cards__card--dimmed:hover` and
  // `--highlighted:hover` EXISTED. They were counter-rules: a base
  // `.community-cards__card:hover` lifted a board card, and during the winner
  // tableau a lifted losing card or a bobbing winner is motion the reference
  // does not have, so those two rules cancelled the lift back out.
  //
  // Hover was removed estate-wide on 2026-08-29, base rule included, so there
  // is nothing left to cancel and the counter-rules went with it. The property
  // the test was protecting has not changed -- a pointer must not disturb the
  // tableau -- so it is pinned against the new mechanism instead, and pinned
  // more strictly than before: not "the lift is frozen for these two states"
  // but "no pointer state moves a board card at all, in any state".
  it('no pointer state disturbs the winner tableau, because none exists', () => {
    const withoutComments = BOARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toContain(':hover');
  });

  it('CardImage no longer lifts a highlighted card off its slot', () => {
    const at = CARD_CSS.indexOf('.card-image--highlighted');
    expect(at).toBeGreaterThan(-1);
    const body = CARD_CSS.slice(at, CARD_CSS.indexOf('}', at));
    expect(body).not.toMatch(/translateY|[^a-z]scale\(/);
  });
});

describe('the state lands as a CUT — nothing slower than 120ms', () => {
  it('board and seat dim transitions are within 3 frames at 30fps', () => {
    for (const [css, sel] of [
      [BOARD_CSS, '.community-cards__card--dimmed'],
      [SEAT_CSS, '.seat__card--dimmed'],
    ] as const) {
      const at = css.indexOf(sel);
      const body = css.slice(at, css.indexOf('}', at));
      const ms = body.match(/transition:\s*filter\s+0\.(\d+)s/);
      expect(ms, `${sel} transition missing`).not.toBeNull();
      expect(Number(`0.${ms![1]}`)).toBeLessThanOrEqual(0.12);
    }
  });

  it('the banner enters as a hard cut, not a spring', () => {
    expect(BOARD_CSS).toMatch(/ccBannerCut/);
    expect(BOARD_CSS).not.toMatch(/ccHandNameShimmer/);
    const at = BOARD_CSS.indexOf('animation: ccBannerCut');
    expect(sliceBetween(BOARD_CSS, 'animation: ccBannerCut', ';')).toMatch(
      /0\.0?9\d*s|0\.1[0-2]?s/
    );
  });

  it('the seat chrome dim carries no transition — filters snap', () => {
    const at = SEAT_CSS.indexOf('.table-page--winner-flash');
    const body = SEAT_CSS.slice(at, SEAT_CSS.indexOf('}', at));
    expect(body).not.toMatch(/transition/);
  });
});

describe('the winner sequence details match the reference', () => {
  /* ── ONE COLOUR FOR THE WHOLE +N STORY, AND IT IS NO LONGER YELLOW ────────
     These two pinned #ffe94a, sampled off the PokerBros reference, at the two
     places the winning amount appears: above the seat and riding the pot.
     Dan 2026-09-07, item 8: "WE DON'T USE YELLOW, CHANGE ALL THE YELLOW FONTS
     TO SMARTER.POKER COLOR SCHEMAS."

     The INVARIANT these tests exist for is unchanged and is the thing worth
     keeping: the two floats are the same colour as each other (they are one
     story told in two places, and they drifted apart once before — the second
     test's name still records the cyan), and neither is the felt's own text
     grey. Only the constant moves, from a sampled hex to the house token. */
  it('the +N float is the house bright, and rides above the dim', () => {
    const at = SEAT_CSS.indexOf('.seat__net-win {');
    expect(at).toBeGreaterThan(-1);
    expect(SEAT_CSS.slice(at, SEAT_CSS.indexOf('}', at))).toMatch(
      /color:\s*var\(--sp-text-bright\)/
    );
  });

  it('the riding pot-win amount is the SAME house bright, not cyan', () => {
    const at = TABLE_CSS.indexOf('.pot-win-float {');
    expect(at).toBeGreaterThan(-1);
    const body = TABLE_CSS.slice(at, TABLE_CSS.indexOf('}', at));
    expect(body).toMatch(/color:\s*var\(--sp-text-bright\)/);
    expect(body).not.toMatch(/#00d4ff/i);
    expect(body).not.toMatch(/#ffe94a/i);
  });

  it('four-point star sparkles render over a positive win, and only a positive one', () => {
    expect(SEAT).toMatch(/seat__win-sparkles/);
    expect(SEAT).toMatch(/netWinAmount\s*>\s*0\s*&&\s*\(/);
    const at = SEAT_CSS.indexOf('.seat__win-sparkle {');
    expect(at, 'sparkle rule missing').toBeGreaterThan(-1);
    const body = SEAT_CSS.slice(at, SEAT_CSS.indexOf('}', at));
    expect(body).toMatch(/clip-path/);
    expect(SEAT_CSS).toMatch(/seatWinSparkleTwinkle/);
  });

  it('the double-board bomb pot lights and dims board 2 like board 1', () => {
    expect(TABLE_PAGE).toMatch(/board2HighlightedIndices/);
    expect(TABLE_PAGE).toMatch(/highlightedIndices=\{board2HighlightedIndices\}/);
  });
});

describe('multi-board and chopped pots get the same winner display', () => {
  it('each winner carries their OWN hand name, and every seat reads its own', () => {
    expect(TABLE_PAGE).toMatch(/handNames:\s*Record<string,\s*string>/);
    expect(TABLE_PAGE).toMatch(/winnerInfo\.handNames\[player\.id\]\s*\|\|\s*winnerInfo\.handName/);
  });

  it('per-pot POT_WIN events MERGE — earlier pot winners stay lit on split/side pots', () => {
    expect(TABLE_PAGE).toMatch(/new Set\(\[\.\.\.prevWin\.playerIds,\s*\.\.\.winnerIds\]\)/);
    expect(TABLE_PAGE).toMatch(
      /handNames:\s*\{\s*\.\.\.prevWin\.handNames,\s*\.\.\.handNamesNow\s*\}/
    );
  });

  it('a user winning several pots SUMS their shares, never overwrites them', () => {
    expect(TABLE_PAGE).toMatch(
      /mergedAmounts\[uid\]\s*=\s*\(mergedAmounts\[uid\]\s*\?\?\s*0\)\s*\+/
    );
    expect(TABLE_PAGE).toMatch(/amounts:\s*mergedAmounts/);
  });

  it('handNames resets with the rest of winnerInfo at hand start', () => {
    const clears = TABLE_PAGE.match(/handNames:\s*\{\}/g) || [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
  });

  it('every RIT board derives its winning five AND its winner hole cards', () => {
    expect(TABLE_PAGE).toMatch(/winnerHoleIndices/);
    expect(TABLE_PAGE).toMatch(/holeIndices:\s*revealed\s*\?\s*winnerHoleIndices\s*:\s*\{\}/);
    expect(TABLE_PAGE).toMatch(/ritWinnerHoleIndices/);
  });

  it('a multi-run winner lights the union of every board\u2019s winning hole cards', () => {
    expect(TABLE_PAGE).toMatch(/ritWinnerHoleIndices\[player\.id\]/);
  });

  it('stacked boards render the banner in-flow so every board names its hand', () => {
    const at = BOARD_CSS.indexOf('.table-page[data-boards] .community-cards__hand-name');
    expect(at, 'multi-board banner rule missing').toBeGreaterThan(-1);
    const body = BOARD_CSS.slice(at, BOARD_CSS.indexOf('}', at));
    expect(body).toMatch(/position:\s*static/);
  });

  it('board 2 of a double-board hand still gets the highlight+dim treatment', () => {
    expect(TABLE_PAGE).toMatch(/highlightedIndices=\{board2HighlightedIndices\}/);
  });
});

describe('the banner is the reference banner (measured geometry)', () => {
  it('hugs the board from below', () => {
    const at = BOARD_CSS.indexOf('.community-cards__hand-name {');
    expect(at).toBeGreaterThan(-1);
    expect(sliceCssRule(BOARD_CSS, '.community-cards__hand-name {')).toMatch(
      /top:\s*calc\(100%\s*\+\s*4px\)/
    );
  });

  it('the hand name is a gradient-gold span over the band, sized off the card height', () => {
    expect(BOARD).toMatch(/community-cards__hand-name-text/);
    const at = BOARD_CSS.indexOf('.community-cards__hand-name-text {');
    expect(at, 'gradient span rule missing').toBeGreaterThan(-1);
    const body = BOARD_CSS.slice(at, BOARD_CSS.indexOf('}', at));
    expect(body).toMatch(/background-clip:\s*text/);
    expect(body).toMatch(/#ffe097/i);
    const nameAt = BOARD_CSS.indexOf('.community-cards__hand-name {');
    expect(sliceCssRule(BOARD_CSS, '.community-cards__hand-name {')).toMatch(
      /font-size:\s*clamp\([^;]*--cc-card-h[^;]*0\.33/
    );
  });

  it('the orange lens-flare streak rides the band bottom', () => {
    const flareAt = BOARD_CSS.indexOf('.community-cards__hand-name::before');
    const body = sliceCssRule(BOARD_CSS, '.community-cards__hand-name::before');
    expect(body).toMatch(/bottom:\s*2px/);
    expect(body).toMatch(/255,\s*158,\s*64/);
  });
});
