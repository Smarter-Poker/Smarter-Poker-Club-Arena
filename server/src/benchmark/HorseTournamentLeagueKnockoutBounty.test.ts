import { describe, expect, it } from 'vitest';
import { knockoutBountyShares, tournamentLeagueEntrants } from './HorseTournamentLeague.js';
import { attributeKnockout } from '../tournament/knockoutAttribution.js';

/*
 * Mystery seed 8102203 stopped at pair 36 with a conservation error on both
 * sides: one hand busted two short stacks whose last pots were chopped by the
 * same two players, and the league paid the full 1000 chest to EACH tied
 * winner. Seventeen knockouts paid 19000 from an 18000 pool, so the champion's
 * residual was -1000. The engine pays one chest per knockout, split by claim
 * weight. This fixture reproduces the same hand shape without solver stores.
 */
const choppedSidePotHand = {
  // Short all in for 300, middle all in for 600, two deep stacks chop the board.
  pots: [
    { amount: 1200, eligiblePlayers: ['short', 'middle', 'deep-a', 'deep-b'] },
    { amount: 900, eligiblePlayers: ['middle', 'deep-a', 'deep-b'] },
    { amount: 800, eligiblePlayers: ['deep-a', 'deep-b'] },
  ],
  winners: [
    { userId: 'deep-a', amount: 600, potIndex: 0 },
    { userId: 'deep-b', amount: 600, potIndex: 0 },
    { userId: 'deep-a', amount: 450, potIndex: 1 },
    { userId: 'deep-b', amount: 450, potIndex: 1 },
    { userId: 'deep-a', amount: 400, potIndex: 2 },
    { userId: 'deep-b', amount: 400, potIndex: 2 },
  ],
};

describe('tournament league knockout bounty conservation', () => {
  it('pays one mystery chest per chopped knockout, shared by the tied winners', () => {
    for (const busted of ['short', 'middle']) {
      const attribution = attributeKnockout(choppedSidePotHand, busted);
      expect(attribution.claimants.map((c) => c.userId)).toEqual(['deep-a', 'deep-b']);
      const shares = knockoutBountyShares(1000, attribution.claimants);
      expect(shares).toEqual([
        { userId: 'deep-a', amount: 500 },
        { userId: 'deep-b', amount: 500 },
      ]);
    }
  });

  it('keeps an 18-entrant mystery pool non-negative when two knockouts are chopped', () => {
    const entrants = tournamentLeagueEntrants('mystery');
    const bountyPool = entrants * 1000;
    let paid = 0;
    // Seventeen knockouts: two chopped in one hand, the rest single winners.
    for (let knockout = 0; knockout < entrants - 1; knockout++) {
      const claimants =
        knockout === 7 || knockout === 8
          ? attributeKnockout(choppedSidePotHand, knockout === 7 ? 'short' : 'middle').claimants
          : [{ userId: `winner-${knockout}`, weight: 1 }];
      for (const share of knockoutBountyShares(1000, claimants)) paid += share.amount;
    }
    expect(paid).toBe(17000);
    expect(bountyPool - paid).toBe(1000);
  });

  it('splits a chopped PKO head once, so cash plus head growth equals the head', () => {
    const shares = knockoutBountyShares(
      1500,
      attributeKnockout(choppedSidePotHand, 'short').claimants
    );
    expect(shares).toEqual([
      { userId: 'deep-a', amount: 750 },
      { userId: 'deep-b', amount: 750 },
    ]);
    // The league pays half of each share in cash and adds half to the winner's head.
    const cash = shares.map((share) => share.amount * 0.5);
    expect(cash).toEqual([375, 375]);
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1500);
  });

  it('splits by claim weight with shares summing exactly to the bounty', () => {
    const shares = knockoutBountyShares(1000, [
      { userId: 'a', weight: 1 },
      { userId: 'b', weight: 1 },
      { userId: 'c', weight: 1 },
    ]);
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1000);
    expect(
      knockoutBountyShares(900, [
        { userId: 'a', weight: 2 },
        { userId: 'b', weight: 1 },
      ])
    ).toEqual([
      { userId: 'a', amount: 600 },
      { userId: 'b', amount: 300 },
    ]);
  });

  it('keeps a knockout with no payable claimant a conservation error', () => {
    expect(knockoutBountyShares(1000, [])).toEqual([]);
    expect(knockoutBountyShares(1000, [{ userId: 'a', weight: 0 }])).toEqual([]);
    expect(attributeKnockout({ pots: [], winners: [] }, 'short').claimants).toEqual([]);
  });
});
