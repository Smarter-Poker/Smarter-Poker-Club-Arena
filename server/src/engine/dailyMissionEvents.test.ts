import { describe, expect, it } from 'vitest';
import { buildDailyMissionHandEvents } from './dailyMissionEvents.js';

describe('buildDailyMissionHandEvents', () => {
  it('emits exact facts for every dealt player, including horses, but not observers', () => {
    const events = buildDailyMissionHandEvents({
      dealtPlayerIds: ['human-winner', 'human-fold', 'horse'],
      roster: [
        { userId: 'human-winner', isHorse: false },
        { userId: 'human-fold', isHorse: false },
        { userId: 'horse', isHorse: true },
        { userId: 'observer', isHorse: false },
      ],
      winners: [{ userId: 'human-winner', amount: 432.9 }],
      showdownResults: [{ userId: 'human-winner', handRanking: 7 }],
    });

    expect(events).toEqual([
      {
        user_id: 'human-winner',
        amounts: {
          hands_played: 1,
          hands_won: 1,
          chips_won: 432,
          big_pots: 1,
          showdowns: 1,
          showdowns_won: 1,
          strong_hands: 1,
        },
        magnitudes: { big_pots: 432, strong_hands: 7 },
      },
      { user_id: 'human-fold', amounts: { hands_played: 1 }, magnitudes: {} },
      { user_id: 'horse', amounts: { hands_played: 1 }, magnitudes: {} },
    ]);
  });
});
