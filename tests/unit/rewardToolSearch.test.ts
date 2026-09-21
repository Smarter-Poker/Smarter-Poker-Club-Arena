import { describe, expect, it } from 'vitest';
import {
  REWARD_TOOL_SEARCH_WORDS,
  rewardToolMatchesSearch,
} from '../../src/components/navigation/rewardToolSearch';

describe('rewardToolMatchesSearch', () => {
  it('keeps the owner tools when nothing is typed', () => {
    expect(rewardToolMatchesSearch('')).toBe(true);
    expect(rewardToolMatchesSearch('   ')).toBe(true);
  });

  it.each([
    'leaderboard',
    'Leaderboards',
    'lead',
    'prizes',
    'PRIZE SETUP',
    'set up',
    'setup prize',
    'promo wallet',
    'owner rewards',
    'plan',
    '  program  ',
  ])('finds the tools for "%s"', (query) => {
    expect(rewardToolMatchesSearch(query)).toBe(true);
  });

  it.each(['a', 'e', 'ward', 'romo', 'lan', 'rd', 'xyz', 'prize xyz', 'cashier', 'tables'])(
    'does not reveal the tools for the stray fragment "%s"',
    (query) => {
      expect(rewardToolMatchesSearch(query)).toBe(false);
    }
  );

  it('keeps the vocabulary lower case so the lower-cased query can match it', () => {
    for (const word of REWARD_TOOL_SEARCH_WORDS) {
      expect(word).toBe(word.toLowerCase());
    }
  });
});
