/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BOARD IS AS WIDE AS THE CHIPS ALLOW, AND THE EMPTY BAR IS NOT A VOID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27, mobile pass:
 *
 *   item 2 — "the board cards need to be increased in size, you need to make
 *             it so the card size equals the entire width of the table."
 *   item 3 — "the bottom action bar should not be dark when the hero doesn't
 *             have a hand, it should just display the bottom area of the
 *             table, not a dark void."
 *   item 6 — "when a player is all in, the action bar or dark area must not
 *             display; anytime the hero's action is over, it should just
 *             display the bottom of the table."
 *
 * ─── HOW THE BOARD GOT TO 95% ──────────────────────────────────────────────
 *
 * It did not get there from the stylesheet. On 2026-08-27 this file recorded,
 * and asserted, that 68% was a CEILING and 95% was unreachable: a side seat sat
 * level with the cards on every ring — 4-max at (10.5, 45), 6/7-max at 33,
 * 8-max at 52, 9-max at 30 — and three separate things then collided with a
 * wider row. The seat's bet chips, walking one 12.5%-of-width rail straight at
 * the board. The seat's dealer button beside them. And the seat BOX: a fixed
 * 96px card of avatar and nameplate that never shrinks with the phone, reaching
 * x 24.3% of the scaler while a 95% row's left edge lands at x 15.1%.
 *
 * That third one is why no anchor and no shorter rail could ever have done it.
 * The seats moved instead (src/lib/tableSeatGeometry.ts, THE BOARD'S BAND): the
 * middle of the side rail now belongs to the cards, and every side seat sits
 * above y 26 or below y 58.
 *
 * `boardCeilingFraction()` below is the guard that made that actionable and is
 * now the guard that keeps it. It walks every production ring at every table
 * size, places both markers with the real geometry module, adds the seat's own
 * box, and returns the widest board that keeps ALL of them off the cards. The
 * assertions then say three things: the shipped width is at or below that
 * ceiling, it claims everything the ceiling offers except the daylight Dan
 * asked to keep between the outer cards and the painted rail, and the ceiling
 * itself has not silently fallen back under 95 because somebody moved a chair.
 *
 * The card size also comes from the GAPS — four of them were eating a fifth of
 * the row — which is why the gap is asserted here too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SEAT_LAYOUTS } from '../../src/lib/tableSeatGeometry';
import {
  FELT_WINDOW,
  FELT_MARKER_MARGIN_WIDTH_PCT,
  buttonRadiusWidthPct,
  chipRestPosition,
  dealerButtonPosition,
} from '../../src/components/table/tableGeometry';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TABLE_CSS = read('src/pages/TablePage.css');
const ACTION_CSS = read('src/components/table/ActionPanel.css');
const COMMUNITY_CSS = read('src/components/table/CommunityCards.css');
const TABLE_TSX = read('src/pages/TablePage.tsx');

/** The three table sizes the app actually renders, all locked at 605/1000. */
const TABLES = {
  'phone 375px': { w: 347, h: 574 },
  'tablet portrait': { w: 600, h: 992 },
  desktop: { w: 720, h: 1190 },
} as const;

/** Half a bet chip, in percent of the table's width. --cp-chip-size is 3.6%. */
const CHIP_HALF_W_PCT = 1.8;

/**
 * The villain seat's box, in CSS pixels — `.seat { width: 96px }`, SeatSlot.css.
 *
 * A FIXED pixel width at every breakpoint: the responsive blocks retune
 * `--seat-avatar-base` (84 -> 66 -> 58 -> 52) and nothing else. Treated as
 * square here, which is conservative in the axis that matters — the real
 * villain seat is about 90px tall (a 52px avatar overlapping a ~43px plate) —
 * and matches the constant tests/table-seat-ring-integrity.test.ts measures
 * seat separation with, so the two files cannot disagree about how big a seat
 * is.
 */
const SEAT_BOX_PX = 96;

/**
 * The felt Dan asked to keep between the outer cards and the painted rail, in
 * points of the felt's width — 5, which is 2.5 at each end.
 *
 * "LIKE FELT WINDOW 95%", not 100%. On a 375px phone that is 6.3px of felt
 * beyond each of the outer cards, which is what stops the board reading as if
 * the table had cropped it. It is the reason the shipped width is allowed to
 * sit below the computed ceiling, and naming it is what keeps that from
 * becoming a licence to sit anywhere below it.
 */
const BOARD_RAIL_DAYLIGHT_PCT = 5;

/* ═══════════════════════════════════════════════════════════════════════════
   THE BOARD RECTANGLE, AS THE STYLESHEET ACTUALLY DRAWS IT
   ═══════════════════════════════════════════════════════════════════════════ */

/** The felt's midline — where `.community-area { left: 50% }` actually lands. */
const BOARD_CENTRE_X = FELT_WINDOW.left + FELT_WINDOW.width / 2;

/**
 * Where the five cards sit, in scaler percentages, for a given felt-width
 * fraction and gap.
 *
 * `.community-area` is `left: 50%; translate(-50%)` and BOTH that offset and
 * its width resolve against `.table-surface`, so the row is centred on the
 * FELT's midline (49.9), not the scaler's. Every card is `flex: 1 1 0` with
 * `aspect-ratio: 64/92`, so the height follows from the width the five of them
 * share once the four gaps are taken out.
 */
function boardRect(fraction: number, gapPx: number, table: { w: number; h: number }) {
  const gapPct = (gapPx / table.w) * 100;
  const rowW = fraction * FELT_WINDOW.width;
  const cardW = (rowW - 4 * gapPct) / 5;
  // A width percentage is not a height percentage: 1% across is w/100 px and
  // 1% down is h/100 px, so the aspect conversion carries w/h with it.
  const cardH = cardW * (92 / 64) * (table.w / table.h);
  return { halfW: rowW / 2, halfH: cardH / 2, cardW, cardH };
}

/** True when a disc of radius `rWidthPct` centred at `p` touches the board. */
function markerOnBoard(
  p: { x: number; y: number },
  rWidthPct: number,
  anchorY: number,
  rect: ReturnType<typeof boardRect>,
  table: { w: number; h: number }
) {
  const onX = Math.abs(p.x - BOARD_CENTRE_X) < rect.halfW + rWidthPct;
  const onY = Math.abs(p.y - anchorY) < rect.halfH + rWidthPct * (table.w / table.h);
  return onX && onY;
}

/** True when the seat's own 96px box overlaps the board rectangle. */
function seatBoxOnBoard(
  seat: { x: number; y: number },
  anchorY: number,
  rect: ReturnType<typeof boardRect>,
  table: { w: number; h: number }
) {
  const onX = Math.abs(seat.x - BOARD_CENTRE_X) < rect.halfW + (SEAT_BOX_PX / 2 / table.w) * 100;
  const onY = Math.abs(seat.y - anchorY) < rect.halfH + (SEAT_BOX_PX / 2 / table.h) * 100;
  return onX && onY;
}

/**
 * The widest board, as a fraction of the felt window, that keeps every seat's
 * chips, every seat's dealer button AND every seat's own 96px box off the
 * cards — on every ring from 2-max to 9-max, at every table size.
 *
 * The seat box is the term that was missing while the board was pinned at 68%,
 * and it is the term that decides the answer above ~70%: a seat's markers can
 * be steered by the rail, but the nameplate under the avatar is where it is.
 *
 * Searched rather than solved because the two markers are placed by a
 * projection onto a stadium and a swing around it (see tableGeometry.ts);
 * there is no closed form to restate here, and restating one is how a
 * derivation goes stale.
 */
function boardCeilingFraction(anchorY: number, gapPx: number, step = 0.001): number {
  let best = 0;
  // Counted rather than accumulated: `f += step` drifts, and the last value it
  // reaches is 1.0000000000000007, which then reads as a ceiling ABOVE the felt.
  for (let i = 1; i <= Math.round(1 / step); i++) {
    const f = Math.min(1, i * step);
    let clean = true;
    for (const table of Object.values(TABLES)) {
      const rect = boardRect(f, gapPx, table);
      for (const ring of Object.values(SEAT_LAYOUTS)) {
        for (const seat of ring) {
          if (markerOnBoard(chipRestPosition(seat, table), CHIP_HALF_W_PCT, anchorY, rect, table)) {
            clean = false;
          }
          if (
            markerOnBoard(
              dealerButtonPosition(seat, table),
              FELT_MARKER_MARGIN_WIDTH_PCT,
              anchorY,
              rect,
              table
            )
          ) {
            clean = false;
          }
          if (seatBoxOnBoard(seat, anchorY, rect, table)) clean = false;
        }
      }
    }
    if (clean) best = f;
    else if (best > 0) break; // the feasible set is an interval; stop at its top
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════════════════════
   READING THE STYLESHEET
   ═══════════════════════════════════════════════════════════════════════════ */

/** Every `width: N%` declared on the FELT board row. */
function feltBoardWidths(): number[] {
  const out: number[] = [];
  const re = /(?:^|\n)\.table-surface\s+\.community-area\s*\{([\s\S]*?)\n\}/g;
  for (const m of TABLE_CSS.matchAll(re)) {
    for (const w of m[1].matchAll(/(?:^|[;{\s])width:\s*([\d.]+)%/g)) out.push(Number(w[1]));
  }
  return out;
}

/** Every `width: N%` declared on the MULTI-BOARD (run-it-twice) stack. */
function stackedBoardWidths(): number[] {
  const out: number[] = [];
  const re = /(?:^|\n)\.table-page\[data-boards\]\s+\.community-area\s*\{([\s\S]*?)\n\}/g;
  for (const m of TABLE_CSS.matchAll(re)) {
    for (const w of m[1].matchAll(/(?:^|[;{\s])width:\s*([\d.]+)%/g)) out.push(Number(w[1]));
  }
  return out;
}

/** Every `--cc-card-gap` declared on the FELT board row, in px. */
function feltBoardGaps(): number[] {
  const out: number[] = [];
  const re = /\.table-surface\s+\.community-cards__container\s*\{([\s\S]*?)\n\}/g;
  for (const m of TABLE_CSS.matchAll(re)) {
    for (const g of m[1].matchAll(/--cc-card-gap:\s*([\d.]+)px/g)) out.push(Number(g[1]));
  }
  return out;
}

/**
 * The `.community-area` vertical anchor, in percent of the SCALER.
 *
 * The stylesheet's `top` is a percentage of `.table-surface` — the element is
 * a child of the felt — while every seat, chip and puck on this page is a
 * percentage of the scaler. Converting is not decoration: at `top: 42.5%` the
 * two readings are 42.5 and 43.03, and the board is 11.7 points tall, so
 * treating one as the other silently slides the whole rectangle half a card.
 */
function boardAnchorY(): number {
  const m = TABLE_CSS.match(/\n\.community-area\s*\{[\s\S]*?\n\s*top:\s*([\d.]+)%/);
  expect(m, '.community-area declares no top').not.toBeNull();
  return FELT_WINDOW.top + (Number(m![1]) / 100) * FELT_WINDOW.height;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ITEM 2 — THE BOARD
   ═══════════════════════════════════════════════════════════════════════════ */

describe('item 2 - the felt board is as wide as the bet chips allow', () => {
  const widths = feltBoardWidths();
  const gaps = feltBoardGaps();
  const anchor = boardAnchorY();
  const phoneGap = Math.min(...gaps);
  // This exhaustive geometry search is deterministic and both invariants use
  // the same inputs. Computing it once during suite setup avoids paying the
  // ~2s search twice; under the full parallel corpus the duplicate pass could
  // exceed Vitest's per-test timeout even though the geometry was correct.
  const boardCeilingPct = boardCeilingFraction(anchor, phoneGap) * 100;

  it('sizes the board off the felt in ONE place, at one width', () => {
    // A second `width` on this rule - in a breakpoint, say - is a board that is
    // one size in Dan's hand and another in the test's. The row is a
    // PERCENTAGE of the felt precisely so no breakpoint needs its own copy.
    expect(widths, '.table-surface .community-area declares no width').toHaveLength(1);
  });

  it('no marker lands on the cards, at any ring, at any table size', () => {
    const rects = Object.entries(TABLES).map(
      ([label, t]) => [label, t, boardRect(widths[0] / 100, phoneGap, t)] as const
    );
    for (const [label, table, rect] of rects) {
      for (const [n, ring] of Object.entries(SEAT_LAYOUTS)) {
        for (const seat of ring) {
          const chips = chipRestPosition(seat, table);
          expect(
            markerOnBoard(chips, CHIP_HALF_W_PCT, anchor, rect, table),
            `${n}-max ${label}: seat ${JSON.stringify(seat)} put chips at ` +
              `${chips.x.toFixed(1)},${chips.y.toFixed(1)} - on the board`
          ).toBe(false);
          const btn = dealerButtonPosition(seat, table);
          expect(
            markerOnBoard(btn, buttonRadiusWidthPct(table), anchor, rect, table),
            `${n}-max ${label}: seat ${JSON.stringify(seat)} put its button at ` +
              `${btn.x.toFixed(1)},${btn.y.toFixed(1)} - on the board`
          ).toBe(false);
        }
      }
    }
  });

  it('no seat BOX lands on the cards either - the seats are above and below', () => {
    /* The assertion the 68% ceiling was hiding behind. A seat's markers can be
       steered by the length of the chip rail; the 96px nameplate box under the
       avatar cannot be steered by anything. On a 375px phone a side seat at
       x 10.5% reaches x 24.3% of the scaler while this row's left edge lands at
       x 15.1%, so at 95% NO seat can clear the board horizontally - every one
       of them has to clear it vertically instead.

       That is what Dan's reference looks like: the seats sit above and below
       the band of cards, not beside it. If a future ring nudge puts a chair
       back in the middle of the side rail, this is the test that says so. */
    for (const [label, table] of Object.entries(TABLES)) {
      const rect = boardRect(widths[0] / 100, phoneGap, table);
      for (const [n, ring] of Object.entries(SEAT_LAYOUTS)) {
        for (const seat of ring) {
          expect(
            seatBoxOnBoard(seat, anchor, rect, table),
            `${n}-max ${label}: seat ${JSON.stringify(seat)} has its 96px box over a board ` +
              `spanning x ${(BOARD_CENTRE_X - rect.halfW).toFixed(1)}..` +
              `${(BOARD_CENTRE_X + rect.halfW).toFixed(1)}, ` +
              `y ${(anchor - rect.halfH).toFixed(1)}..${(anchor + rect.halfH).toFixed(1)}`
          ).toBe(false);
        }
      }
    }
  });

  it('takes every point of the ceiling except the daylight Dan asked to keep', () => {
    /* The other half of the two tests above, and the half that makes item 2
       actionable. Passing "nothing is on the cards" is trivial for a board of
       any width you like below the ceiling, so on its own it would let the
       board quietly shrink back to 68% and nobody would hear about it. This one
       says the board is TAKING the width that exists.

       It was the tripwire that got us here: while the rings still put a seat at
       the board's own height the ceiling was 69.3%, and the note in this place
       said that moving those seats would move the ceiling and make this test
       demand the new width. That is exactly what happened on 2026-08-27.

       WHAT THE TWO BOUNDS MEAN NOW. The ceiling is what the seats allow. The
       board may never exceed it - that is the first assertion, and it is the
       one that fails if somebody puts a chair back in the middle of the rail.
       The board also may not fall more than BOARD_RAIL_DAYLIGHT_PCT below it -
       that is the second, and the gap is not slack: it is the 5 points of felt
       ("FELT WINDOW 95%") Dan asked to keep between the outer cards and the
       painted rail, 6.3px at each end on a 375px phone.

       The two older suites - tests/table-geometry-chips.test.ts and
       tests/table-seat-ring-integrity.test.ts - used to model this rectangle
       about 2.7x too tall (they converted between the axes by (1000/605) where
       it should be (605/1000)) and hung it on the felt's centre rather than on
       `.community-area`'s anchor, which is why this test used to allow a point
       and a half of slop. Both are fixed in the same commit as this change, all
       three files now draw the same rectangle, and the slop is gone. */
    const ceiling = boardCeilingPct;
    expect(
      widths[0],
      `the board is wider than the ${ceiling.toFixed(1)}% the seats leave clean`
    ).toBeLessThanOrEqual(ceiling);
    expect(
      widths[0],
      `the board is ${widths[0]}% of the felt but ${ceiling.toFixed(1)}% is clean - take the width`
    ).toBeGreaterThanOrEqual(ceiling - BOARD_RAIL_DAYLIGHT_PCT);
  });

  it('the ceiling has not quietly fallen back under the shipped width', () => {
    /* The seat move is the whole reason this board is wide, and it lives in a
       different file. Stated as its own assertion so that a ring change which
       re-narrows the ceiling fails with the number, rather than only showing up
       as "the board is wider than the ceiling" and reading like a CSS mistake. */
    const ceiling = boardCeilingPct;
    expect(
      ceiling,
      `the seat rings in src/lib/tableSeatGeometry.ts only leave ${ceiling.toFixed(1)}% clean; ` +
        `a chair has moved back into the board's band`
    ).toBeGreaterThanOrEqual(95);
  });

  it('a run-it-twice STACK keeps the narrower width, because it is tall', () => {
    /* One board is 95% because it lives in a band nothing else is in - y 37.2
       to 48.9% of the scaler. A stack of two or three cannot make that promise:
       with their headers it is ~190px and ~284px tall on a 375px phone, roughly
       y 20..70%, straight through both rows of side seats whatever their y.

       So a stack has to clear the seats on X the way the single board used to,
       and the cap for that is the seat box's inner edge: x 24.3% on a phone,
       which puts the widest safe row at 69.9% of the felt. 68% is that cap with
       margin, and it is what shipped before today - a run-it-twice board is
       pixel-for-pixel what it always was. */
    const stacked = stackedBoardWidths();
    expect(
      stacked,
      '.table-page[data-boards] .community-area declares no width, so a stack would take the 95%'
    ).toHaveLength(1);
    expect(stacked[0], 'a stack is not narrower than the single board').toBeLessThan(widths[0]);

    /* And it clears the side rail, which is the reason for the number. The
       binding seat is the one whose box reaches furthest in while sitting
       inside the stack's vertical band: a side seat at x 10.5/89.5, whose box
       ends 13.8 points from its centre on a 375px phone. */
    const phone = TABLES['phone 375px'];
    const seatHalfX = (SEAT_BOX_PX / 2 / phone.w) * 100;
    const sideSeatX = 10.5;
    const cap =
      ((2 * (Math.abs(sideSeatX - BOARD_CENTRE_X) - seatHalfX)) / FELT_WINDOW.width) * 100;
    expect(
      stacked[0],
      `a ${stacked[0]}% stack runs under the side seats; ${cap.toFixed(1)}% is the widest clean row`
    ).toBeLessThanOrEqual(cap);
    // Every ring really does put its side seats there, so `cap` is the estate's
    // number and not one layout's.
    for (const [n, ring] of Object.entries(SEAT_LAYOUTS)) {
      for (const seat of ring) {
        expect(
          Math.abs(seat.x - BOARD_CENTRE_X) >= Math.abs(sideSeatX - BOARD_CENTRE_X) - 1e-9 ||
            seat.y + (SEAT_BOX_PX / 2 / phone.h) * 100 <= 30 ||
            seat.y - (SEAT_BOX_PX / 2 / phone.h) * 100 >= 75,
          `${n}-max: seat ${JSON.stringify(seat)} is further in than the side rail and inside ` +
            `the run-it-twice stack's band`
        ).toBe(true);
      }
    }
  });

  it('holds for the run-it-twice stack too, which is taller and sits higher', () => {
    /* The tests above measure ONE board at `.community-area`'s single-board
       anchor. Run it twice or three times and the stack moves to top 40% / 36%
       and grows a whole board plus a header per extra run, so a guarantee that
       leans on the board's HEIGHT quietly lapses on exactly the hands with the
       most on the felt.

       So the stack does not get to lean on the height: it keeps the NARROWER
       68% row (see the previous test) and clears every seat on X instead. That
       row spans x 25.0..74.8% of the scaler; the nearest marker any side seat
       produces is at x 22.9% and the nearest seat box edge is at x 24.3%. The
       only things under the row's x-band are the two seats on the table's
       midline - the hero at (50, 100) and the top-centre villain at (50, 5) -
       and both are the length of the felt away from any board.

       Each marker and each seat box therefore has to clear one axis outright,
       and this says which: if it fails, the stack has grown into a width that
       is only safe because of where it happens to sit vertically today. */
    const STACK_TOP = 30; // the 3-board anchor (36%) with headroom
    const STACK_BOTTOM = 75; // three boards plus headers, grown downward
    const stackWidth = stackedBoardWidths()[0];
    for (const [label, table] of Object.entries(TABLES)) {
      const { halfW } = boardRect(stackWidth / 100, phoneGap, table);
      for (const [n, ring] of Object.entries(SEAT_LAYOUTS)) {
        for (const seat of ring) {
          const markers: Array<[string, { x: number; y: number }, number]> = [
            ['chips', chipRestPosition(seat, table), CHIP_HALF_W_PCT],
            ['button', dealerButtonPosition(seat, table), buttonRadiusWidthPct(table)],
            ['seat box', seat, (SEAT_BOX_PX / 2 / table.w) * 100],
          ];
          for (const [what, p, r] of markers) {
            const clearsX = Math.abs(p.x - BOARD_CENTRE_X) >= halfW + r;
            const rY = r * (table.w / table.h);
            const clearsY = p.y + rY <= STACK_TOP || p.y - rY >= STACK_BOTTOM;
            expect(
              clearsX || clearsY,
              `${n}-max ${label}: seat ${JSON.stringify(seat)} ${what} at ` +
                `${p.x.toFixed(2)},${p.y.toFixed(2)} clears neither the ` +
                `${(halfW * 2).toFixed(1)}%-wide row nor the ${STACK_TOP}-${STACK_BOTTOM}% stack band`
            ).toBe(true);
          }
        }
      }
    }
  });

  it('CONTROL - the ring this replaced really could not have carried 95%', () => {
    /* Dan asked for the cards to span the table and the answer, for a month,
       was no. This is that no, kept and re-measured on every run so the reason
       for the seat move cannot be forgotten and quietly undone.

       These are the EXACT seats the rings shipped before 2026-08-27. Every one
       of them sat level with the cards, and at 95% each of the three things a
       seat puts on the felt lands on the board for at least one of them:

         its BET CHIPS, because the one 12.5%-of-width rail walks them straight
           at the cards from a seat at the board's own height (4-max's (10.5,45)
           rested at x 22.8%, the collision that pinned the board at 68%);
         its DEALER BUTTON, projected onto the felt's arc beside them - the seat
           at y 30 clears the cards with its chips and not with its puck;
         its 96px NAMEPLATE BOX, which on a 375px phone reaches x 24.3% of the
           scaler while the row's left edge lands at x 15.1%.

       The last one is the one no stylesheet could have solved: a fixed pixel
       box does not care about the chip rail or the vertical anchor. Only moving
       the seat does, which is what happened.

       DIRTY AT ANY ONE TABLE SIZE IS DIRTY, which is the same rule
       boardCeilingFraction() above applies: a width is clean only if it is
       clean at EVERY size, so a seat that collides at ONE size is a seat the
       board cannot be widened past. Stated that way rather than per size,
       because the three obstacles do not all bind on the same screen. The seat
       BOX is a fixed 96 CSS pixels, so it covers a larger share of a 347px
       phone than of a 720px desktop, and 9-max's retired (10.5, 30) is caught
       by its box on the phone alone — puck and chips clear the cards there at
       every size. The phone is the binding screen for exactly that reason, and
       it is the screen Dan reviews on. */
    const OLD_BAND_SEATS = [
      { x: 10.5, y: 45 }, // 4-max, the binding one: dead on the board's midline
      { x: 89.5, y: 45 },
      { x: 10.5, y: 33 }, // 6-max and 7-max
      { x: 10.5, y: 52 }, // 8-max
      { x: 10.5, y: 30 }, // 9-max — the seat box on the phone, nothing else
    ];
    for (const seat of OLD_BAND_SEATS) {
      const dirtyAt: string[] = [];
      for (const [label, table] of Object.entries(TABLES)) {
        const rect = boardRect(0.95, phoneGap, table);
        const onCards =
          markerOnBoard(chipRestPosition(seat, table), CHIP_HALF_W_PCT, anchor, rect, table) ||
          markerOnBoard(
            dealerButtonPosition(seat, table),
            FELT_MARKER_MARGIN_WIDTH_PCT,
            anchor,
            rect,
            table
          ) ||
          seatBoxOnBoard(seat, anchor, rect, table);
        if (onCards) dirtyAt.push(label);
      }
      expect(
        dirtyAt.length,
        `the retired seat ${JSON.stringify(seat)} would have been clean at 95% on every table size`
      ).toBeGreaterThan(0);
    }

    // And the rings really did retire them - none of these coordinates is still
    // in production, or the seat move was only half done.
    for (const [n, ring] of Object.entries(SEAT_LAYOUTS)) {
      for (const seat of ring) {
        for (const old of OLD_BAND_SEATS) {
          expect(
            seat.x === old.x && seat.y === old.y,
            `${n}-max still seats a player at ${JSON.stringify(old)}, inside the board's band`
          ).toBe(false);
        }
      }
    }
  });

  it('the cards grow from the gap, and the gap is set on the row - never on :root', () => {
    // CommunityCards.css owns --cc-card-gap on :root inside four viewport
    // breakpoints, and those still size the OFF-felt board. Setting the felt's
    // gap there instead would be overridden by whichever of them matched, so
    // it is declared on the element that reads it.
    expect(gaps.length, 'the felt row declares no --cc-card-gap').toBeGreaterThan(0);
    expect(phoneGap, 'the felt gap is back to the inherited 8px').toBeLessThanOrEqual(4);

    // And the :root blocks are untouched, so nothing off the felt shrank.
    expect(COMMUNITY_CSS).toMatch(/:root\s*\{[\s\S]*?--cc-card-gap:\s*8px/);
    for (const bp of ['768px', '640px', '480px', '380px']) {
      expect(COMMUNITY_CSS, `the ${bp} :root block lost its gap`).toContain(`max-width: ${bp}`);
    }
  });

  it('buys the card Dan is actually looking at, in pixels, on a 375px phone', () => {
    /* The number item 2 is about. The felt is 254.0px wide inside a 347px
       table, so:

         68% row + 8px gaps  (before any of this)   28.1 x 40.5px card
         68% row + 2px gaps  (the gap pass)         33.0 x 47.4px
         95% row + 2px gaps  (the seat move)        46.7 x 67.1px

       — 66% bigger on each edge than where item 2 started, and 2.7x the card
       area. Asserted in PIXELS rather than as a ratio because "the card size
       equals the entire width of the table" is a thing you hold in your hand,
       and a ratio would go on passing if both sides shrank. */
    const phone = TABLES['phone 375px'];
    const wpx = (f: number, gap: number) => (boardRect(f, gap, phone).cardW / 100) * phone.w;
    const hpx = (f: number, gap: number) => (wpx(f, gap) * 92) / 64;
    expect(wpx(0.68, 8)).toBeCloseTo(28.1, 0);
    expect(wpx(0.68, 2)).toBeCloseTo(33.0, 0);

    const w = wpx(widths[0] / 100, phoneGap);
    const h = hpx(widths[0] / 100, phoneGap);
    expect(w, `card is ${w.toFixed(1)} x ${h.toFixed(1)}px`).toBeCloseTo(46.7, 0);
    expect(h, `card is ${w.toFixed(1)} x ${h.toFixed(1)}px`).toBeCloseTo(67.1, 0);

    // Five cards and four gaps really do fill the row they were given.
    const row = 5 * w + 4 * phoneGap;
    expect(row).toBeCloseTo((widths[0] / 100) * ((FELT_WINDOW.width / 100) * phone.w), 1);
  });

  it('the flop and turn separators still fall between the right cards', () => {
    /* Their positions are fractions of the ROW, so they depend on the card-to-
       gap ratio and not on the row's width at all:
           flop = (3w + 2.5g) / (5w + 4g)   turn = (4w + 3.5g) / (5w + 4g)
       At the old 8px gap that is 60.5% / 81.4%; at the shipped gap it is
       60.1% / 80.3%. 60% and 80% serve both, which is why they did not move
       when the gap did - and this checks that rather than trusting it. */
    const phone = TABLES['phone 375px'];
    const { cardW } = boardRect(widths[0] / 100, phoneGap, phone);
    const g = (phoneGap / phone.w) * 100;
    const row = 5 * cardW + 4 * g;
    const flop = ((3 * cardW + 2.5 * g) / row) * 100;
    const turn = ((4 * cardW + 3.5 * g) / row) * 100;

    const declared = (name: string) => {
      const m = TABLE_CSS.match(
        new RegExp(
          `\\.table-surface \\.community-cards__separator--${name}\\s*\\{[^}]*left:\\s*([\\d.]+)%`
        )
      );
      expect(m, `no left declared for the ${name} separator`).not.toBeNull();
      return Number(m![1]);
    };

    expect(
      Math.abs(declared('flop') - flop),
      `flop divider wants ${flop.toFixed(1)}%`
    ).toBeLessThan(2);
    expect(
      Math.abs(declared('turn') - turn),
      `turn divider wants ${turn.toFixed(1)}%`
    ).toBeLessThan(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ITEMS 3 AND 6 — THE DARK VOID
   ═══════════════════════════════════════════════════════════════════════════ */

/** The body of the rule that collapses an empty action-panel wrapper. */
const COLLAPSE_RULE = ACTION_CSS.match(
  /\.table-page\[data-hero-action='none'\]\s+\.action-panel-wrapper([^{]*)\{([\s\S]*?)\n\}/
);

describe('items 3 and 6 - an empty bottom bar is the table, not a black band', () => {
  it('collapses the wrapper when the hero has no action', () => {
    expect(
      COLLAPSE_RULE,
      "ActionPanel.css has no [data-hero-action='none'] collapse"
    ).not.toBeNull();
    const body = COLLAPSE_RULE![2];
    expect(body, 'the gradient is still painted').toMatch(/background:\s*none/);
    expect(body, 'the border-top is still drawn').toMatch(/border-top:\s*none/);
  });

  it('is scoped so a visible footer bar keeps its ground', () => {
    /* "none" also covers Spectating / Registered / Seat Reserved / Sitting Out,
       and two of those hold a button. Collapsing on the attribute alone would
       leave a CTA floating on the felt with nothing behind it, so the rule has
       to ask whether the wrapper is actually EMPTY. */
    const guard = COLLAPSE_RULE![1];
    expect(guard, 'the collapse is not gated on the wrapper being empty').toMatch(
      /:not\(\s*:has\(\s*\*\s*\)\s*\)/
    );
  });

  it('collapses the PAINT and never the felt', () => {
    /* 2026-08-27, and this is the assertion that changed. This rule used to
       claim the space as well as the paint: --sp-action-h was the wrapper's
       measured height, so collapsing the box grew the felt by ~90px — and the
       hero's next turn shrank it again, every hand, on every table. Dan: "the
       screen is moving in and out constantly ... that should never be
       happening."

       The felt's reserve is a declared constant now (--sp-action-reserve), so
       this rule may hide the bar and may not resize anything. The min-height is
       still small and non-zero, but for a different reason: a full-width fixed
       box swallows taps over the hero's seat for every pixel it keeps. */
    const body = COLLAPSE_RULE![2];
    const m = body.match(/min-height:\s*([\d.]+)px/);
    expect(m, 'the collapsed wrapper declares no min-height').not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(2);
    // Nothing about the felt's size may be derived from this box any more.
    expect(TABLE_TSX, 'a measurement of the bottom chrome is back').not.toContain(
      "setProperty('--sp-action-h'"
    );
    expect(TABLE_CSS, 'the felt reserve reads a measurement again').not.toContain(
      'var(--sp-action-h'
    );
  });

  it('does not swallow taps in a strip it is no longer painting', () => {
    // A fixed, invisible, full-width box at z-index 60 sits directly over the
    // hero's seat. It must stop being a target when it stops being a bar.
    expect(COLLAPSE_RULE![2]).toMatch(/pointer-events:\s*none/);
  });

  it('leaves the hero strip alone - it is not the bar', () => {
    /* --sp-hero-clear holds the hero's name plate, hole cards and the
       bottom-corner HUD stack, all of which are on screen in every state this
       rule fires in. The bar's own reserve does not shrink with it, and since
       2026-08-27 that is deliberate: a reserve that comes and goes with the bar
       is a table that resizes twice a hand. */
    expect(COLLAPSE_RULE![2]).not.toMatch(/--sp-hero-clear/);
    const declared = TABLE_CSS.split('\n').filter((l) => /^\s*--sp-hero-clear\s*:/.test(l));
    expect(declared.length, '--sp-hero-clear is read but never declared').toBeGreaterThan(0);
  });

  it('the spectator collapse it is modelled on is still there', () => {
    // The seated rule is the twin of this one. If a future edit merges them,
    // the spectator's single-line footer loses its own tuning.
    expect(ACTION_CSS).toMatch(/\.table-page\[data-hero='false'\]\s+\.action-panel-wrapper/);
  });

  it('the attribute it keys on is the contract TablePage publishes', () => {
    // Renaming either the attribute or the value silently turns this whole
    // stylesheet rule into a no-op, which looks exactly like the bug it fixed.
    expect(TABLE_TSX).toContain('data-hero-action={heroActionState}');
    expect(TABLE_TSX).toMatch(/'none'\s*\|\s*'waiting'\s*\|\s*'active'/);
    // All-in is one of the states "none" has to describe, or item 6 is unfixed.
    expect(TABLE_TSX).toMatch(/heroStatus\s*!==\s*'all_in'/);
  });
});
