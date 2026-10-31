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

describe('raw wraps are distinct from usable nut straight draws', () => {
  for (const extra of ['', ' Ac', ' Ac Kd']) {
    it(`does not promote a monotone-board wrap to nut quality (${4 + extra.split(' ').filter(Boolean).length} cards)`, () => {
      const hole = cards(`4h 5c 6s 7d${extra}`);
      const board = cards('8h 9h 2h');
      const draw = omahaDrawQuality(hole, board);
      expect(draw.straightOuts).toBe(13);
      expect(draw.bigWrap).toBe(true);
      // Concrete legal opposing flush beats a representative straight hit;
      // this is a physical witness, not a claim about an opponent's cards.
      const completed = [...board, ...cards('5d')];
      expect(scoreOmahaHiPartial(cards('Ah Kh Qc Jd'), completed)).toBeGreaterThan(
        scoreOmahaHiPartial(hole, completed)
      );
      expect(draw.nutty).toBe(false);
      expect(draw.nutStraightOuts).toBe(0);
    });
    it(`retains a clean high wrap and rejects paired-board/low-wrap nut claims (${extra.length})`, () => {
      const high = cards(`9c Td Jh Qs${extra}`);
      expect(omahaDrawQuality(high, cards('8s 7d 2c'))).toMatchObject({
        bigWrap: true,
        nutty: true,
      });
      expect(omahaDrawQuality(high, cards('8s 7d 2c 2s'))).toMatchObject({
        bigWrap: true,
        nutStraightOuts: 0,
        nutty: false,
      });
      const pairedHit = cards('8s 7d 2c 2s 6c');
      expect(scoreOmahaHiPartial(cards('2h 2d 4c 5h'), pairedHit)).toBeGreaterThan(
        scoreOmahaHiPartial(high, pairedHit)
      );
      const low = cards(`4h 5c 6s 7d${extra}`);
      expect(omahaDrawQuality(low, cards('8h 9d 2c'))).toMatchObject({
        bigWrap: true,
        nutty: false,
      });
      const completed = cards('8h 9d 2c Tc');
      expect(scoreOmahaHiPartial(cards('Jh Qh 3c 4d'), completed)).toBeGreaterThan(
        scoreOmahaHiPartial(low, completed)
      );
    });
  }
});

it('grades the shown aces flop as one pair with a four-out nut gutshot, not a wrap', () => {
  const hole = cards('Ac As Td 8h 7c');
  const board = cards('3s Jh Kd');
  expect(Math.floor(scoreOmahaHiPartial(hole, board) / 0x100000)).toBe(2);
  expect(omahaDrawQuality(hole, board)).toMatchObject({
    straightOuts: 4,
    nutStraightOuts: 4,
    bigWrap: false,
    nutty: false,
    nutFlushDraw: false,
    dominatedFlushDraw: false,
  });
});
