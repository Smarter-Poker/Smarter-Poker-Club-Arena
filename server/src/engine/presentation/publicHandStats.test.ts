import { describe, expect, it } from 'vitest';
import { publicHandStatsFrame } from './publicHandStats.js';
import recordedBookkeeping from './publicHandStats.bookkeeping-fixture.json';
const input = {
  tableId: 'table',
  handNumber: 1,
  handId: 'hand',
  timestamp: 12,
  facts: [
    {
      hand_id: 'hand',
      user_id: 'a',
      vpip: true,
      pfr: false,
      returned: 10,
      hole_cards: ['Ah', 'Ad'],
      net: -15,
      rake_paid: 1,
      opponent_ids: ['b'],
    },
  ],
};
describe('committed public tendency frame', () => {
  it.each(['pineapple_discard', 'flop', 'turn', 'river'])(
    'ignores zero-chip Pineapple discard at %s',
    (stage) => {
      const frame = publicHandStatsFrame({
        ...input,
        actions: [
          { action: 'bet', userId: 'a', stage: 'flop', amount: 2 },
          { action: 'discard', userId: 'a', stage, amount: 0 },
          { action: 'call', userId: 'a', stage: 'turn', amount: 2 },
        ],
      })!;
      expect(frame.players).toEqual([
        { user_id: 'a', vpip: true, pfr: false, won: true, aggressive_actions: 1, call_actions: 1 },
      ]);
    }
  );
  it.each([
    { stage: 'preflop', amount: 0 },
    { stage: 'pineapple_discard', amount: 1 },
  ])('rejects malformed discard $stage/$amount', (discard) => {
    const frame = publicHandStatsFrame({
      ...input,
      actions: [
        { action: 'call', userId: 'a', stage: 'flop', amount: 2 },
        { action: 'discard', userId: 'a', ...discard },
      ],
    })!;
    expect(frame.players).toEqual([{ user_id: 'a', vpip: true, pfr: false, won: true }]);
  });
  it.each(recordedBookkeeping)(
    'preserves anonymized recorded public history: $name',
    (recorded) => {
      const frame = publicHandStatsFrame({
        ...input,
        facts: [{ ...input.facts[0], user_id: recorded.hero }],
        bigBlind: recorded.bigBlind,
        actions: recorded.actions,
      })!;
      expect(frame.players).toEqual([
        {
          user_id: recorded.hero,
          vpip: true,
          pfr: false,
          won: true,
          aggressive_actions: recorded.aggressive,
          call_actions: recorded.calls,
        },
      ]);
      expect(JSON.stringify(frame)).not.toMatch(/rit_board|Jhearts|system|sourceHand/);
    }
  );
  it.each([
    {
      action: 'rit_board_2:Jhearts,9clubs,Qdiamonds,7diamonds,9hearts',
      userId: 'system',
      seat: 0,
      stage: 'river',
      timestamp: 123,
    },
    {
      action: 'rit_board_3:Ahearts,8spades,8hearts,8clubs,3spades',
      userId: 'system',
      seat: 0,
      stage: 'river',
      timestamp: 124,
    },
    {
      action: 'bomb_ante',
      userId: 'a',
      seat: 3,
      stage: 'preflop',
      amount: 2,
      origin: 'forced',
      dead: true,
    },
  ])('keeps actual public bookkeeping out of action counts: $action', (bookkeeping) => {
    const frame = publicHandStatsFrame({
      ...input,
      actions: [
        { action: 'bet', userId: 'a', stage: 'flop', amount: 5 },
        { action: 'call', userId: 'a', stage: 'turn', amount: 5 },
        bookkeeping,
      ],
    })!;
    expect(frame.players).toEqual([
      { user_id: 'a', vpip: true, pfr: false, won: true, aggressive_actions: 1, call_actions: 1 },
    ]);
    expect(JSON.stringify(frame)).not.toMatch(/Jhearts|rit_board|system|bomb_ante/);
  });
  it.each([
    {
      action: 'rit_board_2:Jhearts,9clubs,Qdiamonds,7diamonds,9hearts',
      userId: 'a',
      seat: 0,
      stage: 'river',
      timestamp: 123,
    },
    {
      action: 'rit_board_4:Jhearts,9clubs,Qdiamonds,7diamonds,9hearts',
      userId: 'system',
      seat: 0,
      stage: 'river',
      timestamp: 123,
    },
    {
      action: 'rit_board_2:Jhearts,9clubs,Qdiamonds,7diamonds,Jhearts',
      userId: 'system',
      seat: 0,
      stage: 'river',
      timestamp: 123,
    },
    {
      action: 'rit_board_2:Jh,9c,Qd,7d,9h',
      userId: 'system',
      seat: 0,
      stage: 'river',
      timestamp: 123,
    },
    { action: 'bomb_ante', userId: 'a', stage: 'preflop', amount: 2 },
    {
      action: 'bomb_ante',
      userId: 'a',
      stage: 'preflop',
      amount: -2,
      origin: 'forced',
      dead: true,
    },
  ])('refuses malformed bookkeeping: $action', (bookkeeping) => {
    const frame = publicHandStatsFrame({
      ...input,
      actions: [{ action: 'bet', userId: 'a', stage: 'flop', amount: 5 }, bookkeeping],
    })!;
    expect(frame.players).toEqual([{ user_id: 'a', vpip: true, pfr: false, won: true }]);
  });
  it('ignores an uncalled-bet return without discarding measured aggression', () => {
    const frame = publicHandStatsFrame({
      ...input,
      facts: [{ ...input.facts[0], pfr: true }],
      bigBlind: 2,
      actions: [
        { action: 'raise', userId: 'a', stage: 'preflop', amount: 6 },
        { action: 'fold', userId: 'b', stage: 'preflop', amount: 0 },
        { action: 'return', userId: 'a', stage: 'preflop', amount: 4 },
      ],
    })!;
    expect(frame.players).toEqual([
      { user_id: 'a', vpip: true, pfr: true, won: true, aggressive_actions: 1, call_actions: 0 },
    ]);
  });
  it('allows only public tendency booleans and counts a side-pot award as a win', () => {
    const frame = publicHandStatsFrame(input)!;
    expect(frame).toEqual({
      type: 'hand_public_stats',
      table_id: 'table',
      hand_number: 1,
      hand_id: 'hand',
      public_stats_version: 1,
      players: [{ user_id: 'a', vpip: true, pfr: false, won: true }],
      timestamp: 12,
    });
    expect(JSON.stringify(frame)).not.toMatch(/hole_cards|Ah|Ad|rake_paid|opponent_ids|net/);
  });
  it('does not certify aggression from unknown or incomplete public actions', () => {
    for (const actions of [
      [{ action: 'mystery', userId: 'a', stage: 'flop' }],
      [{ action: 'call', amount: 2 }],
    ]) {
      const frame = publicHandStatsFrame({ ...input, actions })!;
      expect(frame.players).toEqual([{ user_id: 'a', vpip: true, pfr: false, won: true }]);
    }
  });
  it('refuses mismatched receipts, duplicate players and unavailable facts', () => {
    expect(publicHandStatsFrame({ ...input, handId: 'different' })).toBeNull();
    expect(publicHandStatsFrame({ ...input, facts: null })).toBeNull();
    expect(publicHandStatsFrame({ ...input, facts: [...input.facts, ...input.facts] })).toBeNull();
    expect(
      publicHandStatsFrame({ ...input, facts: [{ ...input.facts[0], vpip: false, pfr: true }] })
    ).toBeNull();
  });
});
