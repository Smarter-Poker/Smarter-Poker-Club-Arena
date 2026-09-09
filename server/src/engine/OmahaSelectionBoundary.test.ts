import { expect, it } from 'vitest';
import { evaluateOmahaHand, evaluateOmahaLowHand } from './PokerEngine.js';
import type { Card } from '../types.js';
const cards = (s: string): Card[] => s.split(' ').map((c) => ({ rank: c[0], suit: c[1] }) as Card);

it('two supplied Omaha holes cannot play a royal flush on the board', () => {
  const hole = cards('2c 3d');
  const result = evaluateOmahaHand(hole, cards('As Ks Qs Js Ts'));
  expect(result.name).toBe('High Card');
  expect(result.cards.filter((c) => hole.includes(c))).toHaveLength(2);
  expect(result.cards).toHaveLength(5);
});

it('three supplied Omaha holes still enumerate every two-hole choice', () => {
  const hole = cards('2c As Ah');
  const result = evaluateOmahaHand(hole, cards('Ac Ad Kc Qs Jh'));
  expect(result.name).toBe('Four of a Kind');
  expect(result.cards.filter((c) => hole.includes(c))).toEqual(hole.slice(1));
});

it('high and low use the same two-plus-three selection boundary', () => {
  const hole = cards('As 2c');
  const result = evaluateOmahaLowHand(hole, cards('3d 4h 5s Kc Qd'));
  expect(result?.kickers).toEqual([5, 4, 3, 2, 1]);
  expect(result?.cards.filter((c) => hole.includes(c))).toHaveLength(2);
});

it.each([
  ['As', '2c 3d 4h 5s 6c'],
  ['As Kd', '2c 3d'],
])('no five-card hand exists with holes %s and board %s', (hole, board) => {
  expect(evaluateOmahaHand(cards(hole), cards(board))).toMatchObject({
    ranking: 0,
    name: 'No Hand',
  });
  expect(evaluateOmahaLowHand(cards(hole), cards(board))).toBeNull();
});
