import { it, expect } from 'vitest';
import { diamondCashJackpotVerdict } from './diamondCashJackpot.js';
const input = {
  schedule: {
    enabled: true,
    drop: 1,
    minDealtIn: 3,
    minPot: 200,
    excludedVariants: [],
    qualifyingHands: { nlh: 'AAAJJ' },
    miniEnabled: true,
    miniAmount: 700,
    miniReserveFloor: 5000,
  },
  facts: { pot: 1000, dealtIn: 3, sawFlop: true, variant: 'nlh', doubleBoard: false },
  bigBlind: 20,
  showdown: [],
  winnerIds: ['winner'],
  dealtUserIds: ['loser', 'winner', 'other'],
};
it.each([
  ['Ahearts', 'Jdiamonds', '2clubs'],
  ['Ahearts', 'Jdiamonds', '2clubs', '3spades'],
  ['Ahearts', 'Jdiamonds', '2clubs', '3spades', '4clubs'],
])('an ordinary folded hand has no jackpot verdict', (...communityCards) => {
  expect(diamondCashJackpotVerdict({ ...input, communityCards })).toMatchObject({
    kind: 'none',
    pot: 1000,
    dealt: 3,
  });
});
it('a real complete showdown reaches the maintained both-cards Main detector', () => {
  const communityCards = ['Ahearts', 'Jhearts', 'Jdiamonds', '2clubs', '3spades'];
  const showdown = [
    {
      userId: 'loser',
      handRanking: 7,
      handName: 'Aces Full Of Jacks',
      kickers: [14, 14, 14, 11, 11],
      holeCards: [
        { rank: 'A', suit: 'clubs' },
        { rank: 'A', suit: 'diamonds' },
      ],
    },
    {
      userId: 'winner',
      handRanking: 8,
      handName: 'Four Jacks',
      kickers: [11, 11, 11, 11, 14],
      holeCards: [
        { rank: 'J', suit: 'clubs' },
        { rank: 'J', suit: 'spades' },
      ],
    },
  ];
  expect(diamondCashJackpotVerdict({ ...input, communityCards, showdown })).toMatchObject({
    kind: 'main',
    loser_user_id: 'loser',
    winner_user_id: 'winner',
  });
  expect(
    diamondCashJackpotVerdict({
      ...input,
      communityCards,
      showdown,
      facts: { ...input.facts, pot: 200 },
    }).kind
  ).toBe('none');
  expect(
    diamondCashJackpotVerdict({
      ...input,
      communityCards,
      showdown,
      facts: { ...input.facts, doubleBoard: true },
    }).kind
  ).toBe('none');
});
