/**
 * The label under the hero's seat names the best hand they hold right now.
 * Dan 2026-10-25: "IT MUST 100% OF THE TIME DISPLAY THE BEST CURRENT HAND."
 * Rules and their history: src/lib/heroHandLabel.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heroHandLabel, startingHandLabel } from '../../src/lib/heroHandLabel';

const c = (code: string) => ({ rank: code.slice(0, -1), suit: code.slice(-1) });
const cs = (codes: string) => codes.split(' ').map(c);
/** The engine's spelling, so every case also crosses the two dialects. */
const words = (codes: string) =>
  codes.split(' ').map((x) => ({
    rank: x.slice(0, -1),
    suit: { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' }[x.slice(-1)]!,
  }));

describe('before the flop the best hand is a pair', () => {
  it('Omaha trips and quads preflop are a pair, never more', () => {
    expect(heroHandLabel(cs('As Ac Ad Kh'), [], 'plo4')).toBe('Pair');
    expect(heroHandLabel(cs('As Ac Ad Ah'), [], 'plo4')).toBe('Pair');
    expect(heroHandLabel(cs('9s 9c 9d 2h 2s 5c'), [], 'plo6')).toBe('Pair');
  });

  it('Pineapple trips preflop are a pair', () => {
    expect(heroHandLabel(cs('9h 9d 9s'), [], 'pineapple')).toBe('Pair');
  });

  it("Hold'em pairs and high cards read as before", () => {
    expect(heroHandLabel(cs('Kh Kd'), [], 'nlh')).toBe('Pair');
    expect(heroHandLabel(cs('As 7d'), [], 'nlh')).toBe('Ace High');
    expect(startingHandLabel(cs('Th 4d'))).toBe('Ten High');
    expect(startingHandLabel([{ rank: '10', suit: 'hearts' }, c('4d')])).toBe('Ten High');
  });
});

describe('after the flop it is the best legal hand', () => {
  it('the reported hand is a Flush', () => {
    expect(heroHandLabel(cs('Ks Kc Qs Jc 3d'), [words('8d 9c 8c Tc')], 'plo5')).toBe('Flush');
  });

  it('Omaha still plays exactly two from the hand', () => {
    expect(heroHandLabel(cs('Ac Kd Qs Jh'), [cs('2c 5c 9c Tc')], 'plo4')).not.toBe('Flush');
  });
});

describe('hi-lo names both halves', () => {
  it('adds a qualifying low', () => {
    expect(heroHandLabel(cs('Ac 2c Kd Qs'), [cs('3c 7c 8c')], 'plo8')).toBe('Flush · 8-7 Low');
    expect(heroHandLabel(cs('As 2d Kh Kc'), [cs('3c 4h 5s')], 'flo8')).toBe('Straight · 5-4 Low');
  });

  it('names the high alone when no low qualifies', () => {
    expect(heroHandLabel(cs('Ac 2c Kd Qs'), [cs('9c Tc Jh')], 'plo8')).toBe('Straight');
  });

  it('a high-only game never shows a low', () => {
    expect(heroHandLabel(cs('Ac 2c Kd Qs'), [cs('3c 7c 8c')], 'plo4')).toBe('Flush');
  });
});

describe('every board counts', () => {
  it('names the hand on each board in order', () => {
    expect(heroHandLabel(cs('Kc Jc 2d 3s'), [cs('9c 8c Tc'), cs('Kd Js 4h')], 'plo4')).toBe(
      'Flush / Two Pair'
    );
  });

  it('a board not yet dealt is left out', () => {
    expect(heroHandLabel(cs('Kh Kd'), [cs('Ks 7d 2c'), [], []], 'nlh')).toBe('Three of a Kind');
  });
});

describe('it never names a hand from cards it cannot read', () => {
  it('placeholders and nulls are ignored', () => {
    expect(heroHandLabel([null, { rank: '?', suit: '?' }], [], 'nlh')).toBeNull();
    expect(heroHandLabel([c('Ah'), null], [], 'nlh')).toBeNull();
  });
});

describe('the table uses it', () => {
  it('TablePage names the hero hand through heroHandLabel with every board', () => {
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(page).toContain("from '../lib/heroHandLabel'");
    expect(page).toMatch(
      /heroHandLabel\(\s*heroCardsRef\.current\.hole,\s*heroCardsRef\.current\.boards,/
    );
    expect(page).not.toContain('const holdable =');
  });
});
