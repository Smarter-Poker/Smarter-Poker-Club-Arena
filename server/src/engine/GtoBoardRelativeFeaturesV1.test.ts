import { describe, expect, it } from 'vitest';
import {
  boardRelativeFeaturesV1,
  boardRelativeFeatureKeyV1,
} from './GtoBoardRelativeFeaturesV1.js';

// Independent five-card enumeration oracle. It uses sorted rank frequency
// groups rather than the producer's full-hand aggregate category algorithm.
function fiveCardCategory(cards: string[]): number {
  const values = cards.map((card) => '23456789TJQKA'.indexOf(card[0]) + 2);
  const groups = [...new Set(values)]
    .map((rank) => values.filter((value) => value === rank).length)
    .sort((a, b) => b - a);
  const ordered = [...new Set(values)].sort((a, b) => a - b);
  const straight =
    ordered.length === 5 && (ordered[4] - ordered[0] === 4 || ordered.join(',') === '2,3,4,5,14');
  const flush = cards.every((card) => card[1] === cards[0][1]);
  if (straight && flush) return 8;
  if (groups[0] === 4) return 7;
  if (groups.join(',') === '3,2') return 6;
  if (flush) return 5;
  if (straight) return 4;
  if (groups[0] === 3) return 3;
  if (groups[0] === 2 && groups[1] === 2) return 2;
  return groups[0] === 2 ? 1 : 0;
}

function oracle(cards: string[]): number {
  let best = 0;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++)
            best = Math.max(
              best,
              fiveCardCategory([cards[a], cards[b], cards[c], cards[d], cards[e]])
            );
  return best;
}

describe('disconnected board-relative-v1 feature contract', () => {
  it('separates the actual old-key collision: AQ top pair versus ace high', () => {
    const pair = boardRelativeFeaturesV1(['Ac', 'Qd'], ['Qs', '8d', '3c']);
    const high = boardRelativeFeaturesV1(['Ac', 'Qd'], ['Ks', '9d', '4c']);
    expect(pair.madeCategory).toBe(1);
    expect(high.madeCategory).toBe(0);
    expect(pair.holeRelations).toContainEqual([0, 1, 0]);
    expect(high.holeRelations).toContainEqual([1, 0, 0]);
    expect(pair).not.toEqual(high);
  });

  it('matches an independently enumerated best-five category on every category and double trips', () => {
    const vectors = [
      ['Ac', 'Qd', 'Ks', '9d', '4c'],
      ['Ac', 'Qd', 'Qs', '8d', '3c'],
      ['Ac', 'Qd', 'As', 'Qc', '3c'],
      ['Ac', 'Ad', 'As', 'Qc', '3c'],
      ['Ac', '2d', '3s', '4c', '5h'],
      ['Ac', 'Qc', '8c', '5c', '3c'],
      ['Ac', 'Ad', 'As', 'Qc', 'Qh'],
      ['Ac', 'Ad', 'As', 'Ah', '3c'],
      ['Ac', '2c', '3c', '4c', '5c'],
      ['Ac', 'Ad', 'As', 'Qc', 'Qd', 'Qh', '3c'],
    ];
    vectors.forEach((cards, index) => {
      expect(boardRelativeFeaturesV1(cards.slice(0, 2), cards.slice(2)).madeCategory).toBe(
        oracle(cards)
      );
      if (index < 9) expect(oracle(cards)).toBe(index);
    });
  });

  it('is invariant to board order, hole order, and all 24 bijective suit permutations', () => {
    const hole = ['Ac', 'Qd'],
      board = ['Qs', '8d', '3c', '2h'];
    const expected = boardRelativeFeatureKeyV1(hole, board);
    function permutations(rest: string, prefix = ''): string[] {
      return rest.length === 0
        ? [prefix]
        : [...rest].flatMap((suit) => permutations(rest.replace(suit, ''), prefix + suit));
    }
    for (const permutation of permutations('cdhs')) {
      const remap = (card: string) => card[0] + permutation['cdhs'.indexOf(card[1])];
      expect(boardRelativeFeatureKeyV1(hole.map(remap).reverse(), board.map(remap).reverse())).toBe(
        expected
      );
    }
  });

  it('counts open-ended and wheel gutshot completion cards without calling them winning outs', () => {
    const open = boardRelativeFeaturesV1(['8c', '7d'], ['6s', '5h', 'Kc']);
    const wheel = boardRelativeFeaturesV1(['Ac', '2d'], ['3s', '4h', 'Kc']);
    expect([open.straightCompletionRanks, open.straightCompletionCards]).toEqual([2, 8]);
    expect([wheel.straightCompletionRanks, wheel.straightCompletionCards]).toEqual([1, 4]);
    expect(
      boardRelativeFeaturesV1(['Ac', '2d'], ['3s', '4h', 'Kc', '9d', 'Ts']).straightCompletionCards
    ).toBe(0);
  });

  it('retains nut versus dominated flush blocker ordinals', () => {
    const ace = boardRelativeFeaturesV1(['Ac', 'Qd'], ['Tc', '8c', '3c']);
    const king = boardRelativeFeaturesV1(['Kc', 'Qd'], ['Tc', '8c', '3c']);
    expect(ace.suitRelations).toContainEqual([3, 1, 0]);
    expect(king.suitRelations).toContainEqual([3, 1, 1]);
    expect(ace.flushCompletionCards).toBe(9);
    expect(king.flushCompletionCards).toBe(9);
  });

  it('rejects blocked cards, invalid card syntax, and unsupported cardinalities', () => {
    for (const [hole, board] of [
      [
        ['Ac', 'Ac'],
        ['Qs', '8d', '3c'],
      ],
      [
        ['Ac', 'Qd'],
        ['Ac', '8d', '3c'],
      ],
      [
        ['ac', 'Qd'],
        ['Qs', '8d', '3c'],
      ],
      [
        ['Ac', 'Qd'],
        ['Qs', '8d'],
      ],
      [
        ['Ac', 'Qd', '2h'],
        ['Qs', '8d', '3c'],
      ],
    ])
      expect(() => boardRelativeFeaturesV1(hole, board)).toThrow();
  });
});
