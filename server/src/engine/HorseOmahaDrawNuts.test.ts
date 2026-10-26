import { describe, expect, it } from 'vitest';
import { omahaDrawQuality, scoreOmahaHiPartial } from './HorseEval.js';
import type { Card } from '../types.js';

const suits: Record<string, Card['suit']> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};
const cards = (text: string): Card[] =>
  text.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: suits[c[1]],
  }));

describe('Omaha flush draws respect board blockers', () => {
  for (const extra of ['', ' 5c', ' 5c 6d']) {
    it(`recognises the queen-high nut draw with ace and king on board (${4 + extra.split(' ').filter(Boolean).length} hole cards)`, () => {
      const hole = cards(`Qs Js 3h 4c${extra}`);
      const board = cards('As Ks 2d');
      expect(omahaDrawQuality(hole, board)).toMatchObject({
        nutFlushDraw: true,
        dominatedFlushDraw: false,
        nutty: true,
      });
      // Independent physical witness: no legal opposing suited pair beats
      // hero's flush on a blank suited completion.
      const river = [...board, ...cards('7s 8d')];
      const hero = scoreOmahaHiPartial(hole, river);
      for (const pair of ['Ts 9s', '9s 8s', '6s 5s']) {
        expect(hero).toBeGreaterThan(scoreOmahaHiPartial(cards(`${pair} 9h Td`), river));
      }
    });
  }
  it('keeps a live higher suited rank dominated', () => {
    expect(omahaDrawQuality(cards('Js Ts 3h 4c'), cards('As Ks 2d'))).toMatchObject({
      nutFlushDraw: false,
      dominatedFlushDraw: true,
    });
  });
  it('requires two hole cards of the suit even when hero holds the highest rank', () => {
    expect(omahaDrawQuality(cards('Qs Jh 3h 4c'), cards('As Ks 2d'))).toMatchObject({
      nutFlushDraw: false,
      dominatedFlushDraw: false,
    });
  });
  it('retains the ace-high and ace-on-board king-high nut draws', () => {
    expect(omahaDrawQuality(cards('As Js 3h 4c'), cards('Ks 9s 2d')).nutFlushDraw).toBe(true);
    expect(omahaDrawQuality(cards('Ks Js 3h 4c'), cards('As 9s 2d')).nutFlushDraw).toBe(true);
  });
});
