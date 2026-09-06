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
      pots: [{ index: 0, amount: 432.9 }],
      perPotAwards: [
        {
          userId: 'human-winner',
          potIndex: 0,
          amount: 432.9,
          low: false,
          hand: { ranking: 7 },
        },
      ],
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
        values: { big_pots: [432.9], strong_hands: [7] },
      },
      { user_id: 'human-fold', amounts: { hands_played: 1 }, magnitudes: {}, values: {} },
      { user_id: 'horse', amounts: { hands_played: 1 }, magnitudes: {}, values: {} },
    ]);
  });

  it('keeps exact gross values when one player wins mixed main and side pots', () => {
    const [event] = buildDailyMissionHandEvents({
      dealtPlayerIds: ['winner'],
      roster: [{ userId: 'winner', isHorse: false }],
      winners: [{ userId: 'winner', amount: 1_900 }],
      showdownResults: [{ userId: 'winner', handRanking: 4 }],
      pots: [
        { index: 0, amount: 1_500 },
        { index: 1, amount: 400 },
      ],
      perPotAwards: [
        { userId: 'winner', potIndex: 0, amount: 1_500, low: false, hand: { ranking: 4 } },
        { userId: 'winner', potIndex: 1, amount: 400, low: false, hand: { ranking: 4 } },
      ],
    });

    expect(event.amounts.big_pots).toBe(2);
    expect(event.magnitudes.big_pots).toBe(1_500);
    expect(event.values.big_pots).toEqual([1_500, 400]);
    expect(event.amounts.strong_hands).toBe(1);
    expect(event.values.strong_hands).toEqual([4]);
  });

  it('gives every chopped winner the gross pot value without multiplying the pot layer', () => {
    const events = buildDailyMissionHandEvents({
      dealtPlayerIds: ['left', 'right'],
      roster: [
        { userId: 'left', isHorse: false },
        { userId: 'right', isHorse: false },
      ],
      winners: [
        { userId: 'left', amount: 600 },
        { userId: 'right', amount: 600 },
      ],
      showdownResults: [
        { userId: 'left', handRanking: 5 },
        { userId: 'right', handRanking: 5 },
      ],
      pots: [{ index: 0, amount: 1_200 }],
      perPotAwards: [
        { userId: 'left', potIndex: 0, amount: 600, low: false, hand: { ranking: 5 } },
        { userId: 'right', potIndex: 0, amount: 600, low: false, hand: { ranking: 5 } },
      ],
    });

    expect(events.map((event) => event.amounts.big_pots)).toEqual([1, 1]);
    expect(events.map((event) => event.values.big_pots)).toEqual([[1_200], [1_200]]);
  });

  it('deduplicates a multi-board pot and derives strength only from winning high awards', () => {
    const events = buildDailyMissionHandEvents({
      dealtPlayerIds: ['scooper', 'low-only'],
      roster: [
        { userId: 'scooper', isHorse: false },
        { userId: 'low-only', isHorse: false },
      ],
      winners: [
        { userId: 'scooper', amount: 2_000 },
        { userId: 'low-only', amount: 1_000 },
      ],
      // These ranks describe a generic showdown view and deliberately disagree
      // with the actual awards. They must not drive strong-hand progress.
      showdownResults: [
        { userId: 'scooper', handRanking: 9 },
        { userId: 'low-only', handRanking: 8 },
      ],
      pots: [{ index: 0, amount: 3_000 }],
      perPotAwards: [
        {
          userId: 'scooper',
          potIndex: 0,
          board: 1,
          amount: 1_000,
          low: false,
          hand: { ranking: 6 },
        },
        {
          userId: 'scooper',
          potIndex: 0,
          board: 2,
          amount: 1_000,
          low: false,
          hand: { ranking: 2 },
        },
        {
          userId: 'low-only',
          potIndex: 0,
          board: 2,
          amount: 1_000,
          low: true,
          hand: { ranking: 8 },
        },
      ],
    });

    const [scooper, lowOnly] = events;
    expect(scooper.amounts.big_pots).toBe(1);
    expect(scooper.values.big_pots).toEqual([3_000]);
    expect(scooper.amounts.strong_hands).toBe(1);
    expect(scooper.magnitudes.strong_hands).toBe(6);
    expect(scooper.values.strong_hands).toEqual([6]);

    expect(lowOnly.amounts.big_pots).toBe(1);
    expect(lowOnly.values.big_pots).toEqual([3_000]);
    expect(lowOnly.amounts.strong_hands).toBeUndefined();
    expect(lowOnly.magnitudes.strong_hands).toBeUndefined();
    expect(lowOnly.values.strong_hands).toBeUndefined();
  });

  it('uses named hand classes when Short Deck swaps evaluator ranking order', () => {
    const events = buildDailyMissionHandEvents({
      dealtPlayerIds: ['full-house-winner', 'flush-winner'],
      roster: [
        { userId: 'full-house-winner', isHorse: false },
        { userId: 'flush-winner', isHorse: false },
      ],
      winners: [
        { userId: 'full-house-winner', amount: 500 },
        { userId: 'flush-winner', amount: 500 },
      ],
      showdownResults: [
        { userId: 'full-house-winner', handRanking: 6 },
        { userId: 'flush-winner', handRanking: 7 },
      ],
      pots: [
        { index: 0, amount: 500 },
        { index: 1, amount: 500 },
      ],
      perPotAwards: [
        {
          userId: 'full-house-winner',
          potIndex: 0,
          amount: 500,
          low: false,
          hand: { name: 'Full House', ranking: 6 },
        },
        {
          userId: 'flush-winner',
          potIndex: 1,
          amount: 500,
          low: false,
          hand: { name: 'Flush', ranking: 7 },
        },
      ],
    });

    expect(events[0].values.strong_hands).toEqual([7]);
    expect(events[1].values.strong_hands).toEqual([6]);
  });
});
