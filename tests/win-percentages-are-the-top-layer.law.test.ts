/**
 * THE ALL-IN WIN PERCENTAGES ARE THE TOP LAYER OF THE FELT, AND NEVER COVER A
 * DISPLAYED CARD (Dan 2026-10-04)
 *
 * "THE '50%' TO WIN SHOULD NEVER BE 'IN THE BACKGROUND' OR HAVE ANYTHING OVER
 *  IT, THEY SHOULD ALWAYS APPEAR AS LAYER 1, NEVER LAYER 2, 3 ETC. THIS GOES
 *  FOR ALL PERCENTAGE DISPLAYS, ALWAYS LAYER ONE ON TOP, BUT CAN NEVER COVER A
 *  PLAYERS DISPLAYED CARDS."
 *
 * What he saw: a green 50% drawn BEHIND the neighbouring player's avatar and
 * name plate. Each badge was a child of its own seat wrapper, every wrapper
 * is its own stacking context, and two seats in the same runout were lifted
 * to the same z-index - so the later seat painted over the earlier seat's
 * badge. The badges are one layer above every seat now, and the placement
 * that used to be a CSS class is arithmetic that can see the cards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EQUITY_GAP,
  overlapArea,
  placeEquityBadges,
  type Box,
  type EquityBadgeRequest,
} from '../src/lib/equityBadgePlacement';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const PAGE = strip(read('src/pages/TablePage.tsx'));
const PAGE_CSS = strip(read('src/pages/TablePage.css'));
const LAYER = strip(read('src/components/table/EquityBadgeLayer.tsx'));

const SIZE = { width: 90, height: 56 };
const seatAt = (left: number, top: number): Box => ({ left, top, width: 80, height: 110 });
const req = (
  key: string,
  seat: Box,
  order: EquityBadgeRequest['order'] = ['above', 'right', 'left', 'below']
): EquityBadgeRequest => ({ key, seat, size: SIZE, order });
const boxOf = (p: { left: number; top: number }): Box => ({ ...p, ...SIZE });

describe('the badges are one layer above every seat', () => {
  it('TablePage draws no badge inside a seat wrapper; it mounts one layer after the seats', () => {
    expect(PAGE.match(/<EquityBadgeLayer/g)).toHaveLength(1);
    // The badge markup itself lives in the layer and nowhere on the page.
    expect(PAGE).not.toMatch(/className=\{?[`"'][^`"']*equity-overlay/);
    const seats = PAGE.indexOf('seatPositions.map((pos, idx) => {');
    const layer = PAGE.indexOf('<EquityBadgeLayer');
    const tracker = PAGE.indexOf('<HeroVpipTracker');
    expect(seats).toBeGreaterThan(-1);
    expect(layer).toBeGreaterThan(seats);
    // A sibling of the seats, inside the same scaler as the tracker that follows.
    expect(tracker).toBeGreaterThan(layer);
    // Every seat wrapper carries the handle the layer measures it by.
    expect(PAGE).toMatch(/data-seat-wrapper=\{seatNumber\}/);
  });

  it('the layer sits above a seat tabling its cards, the pot and every felt banner', () => {
    const rule = PAGE_CSS.slice(PAGE_CSS.indexOf('.equity-layer {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/pointer-events:\s*none/);
    const z = Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
    const showing = Number(
      /\.seat-wrapper--showing\s*\{[^}]*z-index:\s*(\d+)/.exec(
        strip(read('src/components/table/SeatSlot.css'))
      )?.[1]
    );
    expect(showing).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(showing);
    expect(z).toBeGreaterThan(60);
  });

  it('the wrapper-relative placement classes are gone, so nothing can put a badge back inside a seat', () => {
    for (const cls of [
      'equity-overlay--above',
      'equity-overlay--inboard-left',
      'equity-overlay--inboard-right',
    ]) {
      expect(PAGE_CSS, cls).not.toContain(cls);
      expect(PAGE, cls).not.toContain(cls);
    }
  });

  it('the layer measures layout size, checks every displayed card, and keeps the pop', () => {
    expect(LAYER).toMatch(/offsetWidth/);
    expect(LAYER).toMatch(/\.seat__cards--revealed \.seat__card/);
    expect(LAYER).toMatch(/\.seat__cards--hero \.seat__card/);
    expect(LAYER).toMatch(/\.community-cards__card/);
    // Animation law: each new percentage replays the pop.
    expect(LAYER).toMatch(/key=\{`eq-\$\{badge\.equity\}`\}/);
    expect(PAGE_CSS).toMatch(
      /\.equity-layer \.equity-overlay\s*\{[^}]*animation-name:\s*equityPopLayer/
    );
    expect(PAGE_CSS).toMatch(/@keyframes equityPopLayer/);
  });
});

describe('a badge never lands on a displayed card', () => {
  const layer = { width: 390 };

  it('goes above the seat when nothing is there (Dan 2026-08-28)', () => {
    const seat = seatAt(150, 300);
    const [p] = placeEquityBadges([req('1', seat)], [], layer);
    expect(p.spot).toBe('above');
    expect(p.top + SIZE.height).toBe(seat.top - EQUITY_GAP.above);
    expect(p.left + SIZE.width / 2).toBe(seat.left + seat.width / 2);
  });

  it('leaves the spot above when a tabled hand is in it, and takes the next open spot', () => {
    const seat = seatAt(150, 300);
    // A neighbour's face-up cards sitting exactly where "above" would land.
    const card: Box = { left: 160, top: 230, width: 60, height: 44 };
    const [p] = placeEquityBadges([req('1', seat)], [card], layer);
    expect(p.spot).not.toBe('above');
    expect(overlapArea(boxOf(p), card)).toBe(0);
  });

  it('covers no card when a free spot exists, whatever the order of preference', () => {
    const seat = seatAt(20, 300);
    const cards: Box[] = [
      { left: 30, top: 220, width: 60, height: 44 }, // above
      { left: 110, top: 330, width: 60, height: 44 }, // right
    ];
    const [p] = placeEquityBadges([req('1', seat)], cards, layer);
    for (const c of cards) expect(overlapArea(boxOf(p), c)).toBe(0);
  });

  it('two badges never share a spot', () => {
    // Two seats stacked on the left rail, as on a phone: the lower seat's
    // "above" is the upper seat's own airspace.
    const upper = seatAt(10, 200);
    const lower = seatAt(10, 330);
    const [a, b] = placeEquityBadges([req('1', upper), req('2', lower)], [], layer);
    expect(overlapArea(boxOf(a), boxOf(b))).toBe(0);
  });

  it('is never dropped: with every spot touching something it takes the one touching the least card', () => {
    const seat = seatAt(150, 300);
    const wall: Box[] = [
      { left: 0, top: 150, width: 390, height: 100 }, // above, fully
      { left: 236, top: 300, width: 154, height: 110 }, // right, fully
      { left: 0, top: 300, width: 144, height: 110 }, // left, fully
      { left: 150, top: 416, width: 80, height: 4 }, // below, a sliver
    ];
    const out = placeEquityBadges([req('1', seat)], wall, layer);
    expect(out).toHaveLength(1);
    expect(out[0].spot).toBe('below');
  });

  it('stays on the felt sideways', () => {
    const [p] = placeEquityBadges([req('1', seatAt(-10, 300), ['left'])], [], layer);
    expect(p.left).toBeGreaterThanOrEqual(0);
    const [q] = placeEquityBadges([req('1', seatAt(340, 300), ['right'])], [], layer);
    expect(q.left + SIZE.width).toBeLessThanOrEqual(layer.width);
  });
});
