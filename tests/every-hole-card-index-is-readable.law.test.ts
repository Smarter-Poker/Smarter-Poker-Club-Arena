/**
 * EVERY HOLE CARD'S RANK AND SUIT IS READABLE (Dan 2026-10-22, binding).
 *
 * "look at the hero cards how they are laid out, they are terrible, you need
 * to be able to see the full card and suit without it being cut off. look at
 * the way the villains cards are displayed. thats trash! they need to be the
 * same size as the board cards, overlapped but not covered so all cards are
 * CLEARLY READABLE!"
 *
 * The deck art's corner index (rank over suit) reaches 30% of a card for a 6
 * and 38% for a 10. A card that steps less than 0.42 of its own width over the
 * one before it cuts that index. The PLO6 hero row stepped 0.30.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { boardCardWidthPx } from '../src/components/table/tableGeometry';

const css = readFileSync(join(__dirname, '..', 'src', 'components', 'table', 'SeatSlot.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const INDEX_FRACTION = 0.42;

function ruleBody(selector: string): string {
  const at = css.lastIndexOf(`\n${selector} {`);
  expect(at, `${selector} is missing`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

const factor = (body: string, token: string): number => {
  const value = new RegExp(`--sp-hero-card-${token}:\\s*([^;]+);`).exec(body)![1];
  const m = /\*\s*([\d.]+)/.exec(value);
  return m ? Number(m[1]) : 1;
};

describe("the hero's private PLO row", () => {
  for (const n of [4, 5, 6]) {
    it(`PLO${n} steps at least ${INDEX_FRACTION} of its own card`, () => {
      const body = ruleBody(`.seat__cards--hero:has(> *:nth-child(${n}))`);
      const visible = factor(body, 'step') / factor(body, 'w');
      expect(visible, `PLO${n} shows ${(visible * 100).toFixed(0)}% of each covered card`).toBeGreaterThanOrEqual(
        INDEX_FRACTION
      );
      // and the row stays within the lane beside the hero
      expect(factor(body, 'w') + (n - 1) * factor(body, 'step')).toBeLessThanOrEqual(2.4);
    });
  }
});

describe('a shown villain hand', () => {
  it('is drawn at the board card size', () => {
    const body = ruleBody('.seat .seat__cards--opponent.seat__cards--revealed');
    expect(body).toMatch(/--vh-card-w:\s*var\(\s*--sp-board-card-w/);
  });

  it('overlaps but leaves every corner index whole', () => {
    const body = ruleBody('.seat__cards--opponent.seat__cards--revealed');
    const step = Number(/--vh-step-f:\s*([\d.]+)/.exec(body)![1]);
    expect(step).toBeGreaterThanOrEqual(INDEX_FRACTION);
    expect(step).toBeLessThan(1);
  });

  it('paints each card over the one to its left, so the left corner is what shows', () => {
    const body = ruleBody('.seat .seat__cards--opponent.seat__cards--revealed .seat__card');
    expect(body).toMatch(/z-index:\s*calc\(1 \+ var\(--vh-i, 0\)\)/);
  });

  it('the published board card width follows the felt', () => {
    // 375px portrait phone, 374px scaler: the board's ~44px card.
    expect(boardCardWidthPx(374, 375, true)).toBeGreaterThan(40);
    expect(boardCardWidthPx(374, 375, true)).toBeLessThan(50);
    expect(boardCardWidthPx(0, 375, true)).toBe(0);
    // a wider felt gives a wider card
    expect(boardCardWidthPx(700, 1280, false)).toBeGreaterThan(boardCardWidthPx(374, 375, true));
  });

  it('the table publishes it', () => {
    const page = readFileSync(join(__dirname, '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');
    expect(page).toMatch(/'--sp-board-card-w': `\$\{boardCardWidthPx\(/);
  });
});
