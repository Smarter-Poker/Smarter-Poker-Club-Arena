import { describe, expect, it } from 'vitest';
import { leaderboardDisplayName } from '../../src/utils/leaderboardDisplayName';

describe('leaderboard display names', () => {
  it('capitalizes each underscore-delimited name while preserving its identifier shape', () => {
    expect(leaderboardDisplayName('crazy_latte')).toBe('Crazy_Latte');
    expect(leaderboardDisplayName('crazy__latte')).toBe('Crazy__Latte');
    expect(leaderboardDisplayName('crazy-latte')).toBe('Crazy-Latte');
  });

  it('preserves known acronyms and safely handles missing names', () => {
    expect(leaderboardDisplayName('mtt_wizard')).toBe('MTT_Wizard');
    expect(leaderboardDisplayName('')).toBe('');
    expect(leaderboardDisplayName(null)).toBe('');
    expect(leaderboardDisplayName(undefined)).toBe('');
  });
});
