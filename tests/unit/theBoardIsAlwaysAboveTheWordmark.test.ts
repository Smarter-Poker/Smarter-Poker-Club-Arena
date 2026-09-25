/**
 * THE BOARD IS ALWAYS ABOVE THE WORDMARK (Dan 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "THE BOARD CARDS SHOULD NEVER EVER BE OVERLAPPING 'SMARTER.POKER' ON THE
 * FELT, ALWAYS ABOVE, SHIFT EVERYTHING DOWN OR INCREASE THE LENGTH OF THE
 * TABLE."
 *
 * His screenshot: a 2/5 table whose masthead had six rows under the wordmark
 * (a wrapped club name, the game line, the VPIP rule, the hand number and a
 * bomb-pot clock) and the board's bottom edge across the wordmark. The
 * masthead was CENTRED on --sp-brand-top, so every extra row pushed the
 * wordmark half a row up, into the board. It is anchored by its TOP edge now
 * and only ever grows downward.
 *
 * This recomputes the board's bottom edge from the shipped stylesheet on the
 * phone where the cards are largest relative to the felt, and checks the
 * anchor clears it - and that the anchor really is a top edge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FELT_WINDOW } from '../../src/components/table/tableGeometry';

const CSS = readFileSync(resolve(__dirname, '../../src/pages/TablePage.css'), 'utf8');
const decls = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const at = decls.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return decls.slice(at, decls.indexOf('}', at));
};
const pct = (text: string, prop: string) => {
  const m = new RegExp(`${prop}:\\s*([\\d.]+)%`).exec(text);
  expect(m, `${prop} in ${text.slice(0, 40)}`).not.toBeNull();
  return Number(m![1]);
};

/** The board's bottom edge as a % of the felt window, on a phone this wide. */
function boardBottomPct(scalerWidthPx: number, canvasH: number) {
  const feltW = (FELT_WINDOW.width / 100) * scalerWidthPx;
  const feltH = (FELT_WINDOW.height / 100) * ((scalerWidthPx * canvasH) / 605);
  const rowW = (pct(rule('.table-surface .community-area'), 'width') / 100) * feltW;
  const gap = 2; // --cc-card-gap on the felt container
  const cardW = (rowW - 4 * gap) / 5;
  const cardH = cardW * (92 / 64);
  const centre = pct(rule('.community-area'), 'top');
  return centre + (cardH / 2 / feltH) * 100;
}

describe('the anchor is the top edge, and it clears the board', () => {
  const brandTop = pct(rule('.table-surface'), '--sp-brand-top');

  it('.table-brand hangs from its top: it translates on X only', () => {
    const brand = rule('.table-brand');
    expect(brand).toMatch(/top:\s*var\(--sp-brand-top,\s*56%\)/);
    expect(brand).toMatch(/transform:\s*translate\(-50%,\s*0\)/);
  });

  for (const [label, w, canvasH] of [
    ['375px phone, 9-max canvas', 375, 1000],
    ['375px phone, 6-max canvas', 375, 960],
    ['390px phone, 6-max canvas', 390, 960],
    ['430px phone, 6-max canvas', 430, 960],
  ] as const) {
    it(`${label}: the wordmark's top is below the board's bottom, with felt between`, () => {
      const bottom = boardBottomPct(w, canvasH);
      expect(bottom).toBeLessThan(brandTop);
      // at least a card's shadow of daylight, in felt-window points
      expect(brandTop - bottom).toBeGreaterThanOrEqual(5);
    });
  }

  it('the multi-board anchors clear their stacks the same way', () => {
    // The stack is at 68% width, 40% of its own height above the 40% line.
    const feltW = (FELT_WINDOW.width / 100) * 375;
    const feltH = (FELT_WINDOW.height / 100) * (375 * (1000 / 605));
    const cardH = ((0.68 * feltW - 4 * 2) / 5) * (92 / 64);
    const stackBottom = (n: number) => {
      const stackH = n * cardH + (n - 1) * 6;
      return 40 + ((0.6 * stackH) / feltH) * 100;
    };
    const two = pct(rule(".table-page[data-boards='2'] .table-surface"), '--sp-brand-top');
    const three = pct(rule(".table-page[data-boards='3'] .table-surface"), '--sp-brand-top');
    expect(stackBottom(2)).toBeLessThan(two);
    expect(stackBottom(3)).toBeLessThan(three);
    expect(two).toBeGreaterThan(brandTop);
    expect(three).toBeGreaterThan(two);
  });
});
