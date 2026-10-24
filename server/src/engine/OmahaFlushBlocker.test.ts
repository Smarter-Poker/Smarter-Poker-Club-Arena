import { describe, expect, it } from 'vitest';
import type { Card, CardRank, CardSuit } from '../types.js';
import { evaluateOmahaHand, compareHands } from './PokerEngine.js';
import { omahaFlushBlocker } from './OmahaFlushBlocker.js';
const c = (rank: CardRank, suit: CardSuit): Card => ({ rank, suit });
const d = (rank: CardRank) => c(rank, 'diamonds');
const board = [d('K'), d('9'), d('6'), d('2'), c('4', 'clubs')];
const base = [d('A'), c('K', 'clubs'), c('Q', 'hearts'), c('J', 'spades')];
const extend = (hole: Card[], count: number): Card[] => [
  ...hole,
  ...[c('T', 'clubs'), c('8', 'hearts')].slice(0, count - 4),
];

describe('Omaha physical nut-flush blockers', () => {
  it.each([
    ['plo4', 4],
    ['plo5', 5],
    ['plo6', 6],
    ['plo8', 4],
  ] as const)('%s: single ace on four diamonds blocks nuts without making a flush', (_, count) => {
    expect(omahaFlushBlocker(extend(base, count), board, count)).toMatchObject({
      status: 'available',
      nutRank: 'A',
      madeFlush: false,
      nutFlushPairs: 8,
      survivingNutFlushPairs: 0,
      blocksNutFlush: true,
      straightFlushPossible: false,
    });
  });
  it('does not grant nut-blocker credit to king-only while ace-X survives', () => {
    expect(
      omahaFlushBlocker(
        [d('K'), c('A', 'clubs'), c('Q', 'hearts'), c('J', 'spades')],
        [d('Q'), d('9'), d('6'), c('2', 'clubs'), c('4', 'hearts')],
        4
      )
    ).toMatchObject({
      nutRank: 'A',
      madeFlush: false,
      nutFlushPairs: 9,
      survivingNutFlushPairs: 8,
      blocksNutFlush: false,
    });
  });
  it('when ace is on board, king blocks the highest available flush class', () => {
    expect(
      omahaFlushBlocker(
        [d('K'), c('A', 'clubs'), c('Q', 'hearts'), c('J', 'spades')],
        [d('A'), d('9'), d('6'), c('2', 'clubs'), c('4', 'hearts')],
        4
      )
    ).toMatchObject({
      nutRank: 'K',
      madeFlush: false,
      blocksNutFlush: true,
      survivingNutFlushPairs: 0,
    });
  });
  it('on ace-king-six diamonds the queen blocks the physical nut flush', () => {
    expect(
      omahaFlushBlocker(
        [d('Q'), c('A', 'clubs'), c('K', 'hearts'), c('J', 'spades')],
        [d('A'), d('K'), d('6'), c('2', 'clubs'), c('4', 'hearts')],
        4
      )
    ).toMatchObject({ nutRank: 'Q', blocksNutFlush: true, straightFlushPossible: false });
  });
  it('a made flush is value rather than an air-blocker bluff', () => {
    expect(
      omahaFlushBlocker([d('A'), d('Q'), c('K', 'clubs'), c('J', 'hearts')], board, 4)
    ).toMatchObject({ madeFlush: true, blocksNutFlush: false, survivingNutFlushPairs: 0 });
  });
  it('a two-suited board has no made flush threat yet', () => {
    expect(
      omahaFlushBlocker(base, [d('K'), d('9'), c('6', 'hearts'), c('2', 'clubs')], 4).status
    ).toBe('no_flush_threat');
  });
  it('a jack blocks the actual royal-flush nut pair on ace-king-queen diamonds', () => {
    const royalBoard = [d('A'), d('K'), d('Q'), c('2', 'clubs'), c('3', 'hearts')];
    const fact = omahaFlushBlocker(
      [d('J'), c('A', 'clubs'), c('K', 'hearts'), c('Q', 'spades')],
      royalBoard,
      4
    );
    expect(fact).toMatchObject({
      straightFlushPossible: true,
      bestSuitedPairs: 1,
      survivingBestSuitedPairs: 0,
      blocksNutFlush: true,
    });
    expect(Math.floor(fact.bestSuitedScore / 0x100000)).toBeGreaterThanOrEqual(9);
  });
  it('does not confuse an ace-flush blocker with unblocked straight-flush nuts', () => {
    const fact = omahaFlushBlocker(
      base,
      [d('9'), d('8'), d('7'), c('2', 'clubs'), c('4', 'hearts')],
      4
    );
    expect(fact).toMatchObject({
      straightFlushPossible: true,
      survivingNutFlushPairs: 0,
      survivingBestSuitedPairs: 1,
      blocksNutFlush: false,
    });
  });
  it('a paired board cannot claim boats and quads are blocked by a flush ace', () => {
    const paired = [d('Q'), c('Q', 'clubs'), d('6'), d('2'), c('4', 'clubs')];
    const fact = omahaFlushBlocker(base, paired, 4);
    expect(fact).toMatchObject({ boardPaired: true, blocksNutFlush: false });
    expect(
      compareHands(
        evaluateOmahaHand([c('Q', 'hearts'), c('Q', 'spades')], paired),
        evaluateOmahaHand([d('A'), d('K')], paired)
      )
    ).toBeGreaterThan(0);
  });
  it('rejects duplicate, malformed and mismatched physical card inputs', () => {
    const cases: Array<[Card[], Card[], number]> = [
      [[...base.slice(0, 3), base[0]], board, 4],
      [[d('K'), ...base.slice(1)], board, 4],
      [[{ rank: '10', suit: 'diamonds' } as unknown as Card, ...base.slice(1)], board, 4],
      [[{ rank: 'A', suit: 'bogus' } as unknown as Card, ...base.slice(1)], board, 4],
      [base, board, 5],
      [base, board, 3],
      [base, board.slice(0, 2), 4],
    ];
    for (const [hole, b, count] of cases)
      expect(omahaFlushBlocker(hole, b, count)).toMatchObject({
        status: 'invalid',
        blocksNutFlush: false,
      });
  });
  it('matches the independent full-high evaluator on every physical suited pair', () => {
    const royalBoard = [d('A'), d('K'), d('Q'), c('2', 'clubs'), c('3', 'hearts')];
    const hero = [d('J'), c('A', 'clubs'), c('K', 'hearts'), c('Q', 'spades')];
    const allRanks: CardRank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const available = allRanks.filter(
      (rank) => !royalBoard.some((card) => card.suit === 'diamonds' && card.rank === rank)
    );
    const pairs = available.flatMap((rank, i) =>
      available.slice(i + 1).map((second) => [d(rank), d(second)])
    );
    const scored = pairs.map((pair) => ({ pair, value: evaluateOmahaHand(pair, royalBoard) }));
    const ordered = [...scored].sort((a, b) => compareHands(b.value, a.value));
    const best = scored.filter((row) => compareHands(row.value, ordered[0].value) === 0);
    const survives = (pair: Card[]) =>
      !pair.some((card) => hero.some((h) => h.rank === card.rank && h.suit === card.suit));
    const fact = omahaFlushBlocker(hero, royalBoard, 4);
    expect(best.map((row) => row.pair.map((card) => card.rank).sort())).toEqual([['J', 'T']]);
    expect(fact.bestSuitedPairs).toBe(best.length);
    expect(fact.survivingBestSuitedPairs).toBe(best.filter((row) => survives(row.pair)).length);
  });
});
