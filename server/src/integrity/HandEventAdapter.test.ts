import { describe, it, expect } from 'vitest';
import { fromHandHistoryRow, normalizeActionType, normalizeStreet } from './HandEventAdapter.js';

describe('HandEventAdapter', () => {
  it('normalizes a persisted hand_history row shape', () => {
    const row = {
      id: 'h1',
      table_id: 't1',
      hand_number: 42,
      game_variant: 'nlhe',
      small_blind: 5,
      big_blind: 10,
      pot_size: 300,
      rake_amount: 15,
      community_cards: ['As', 'Kd', '2c'],
      started_at: '2026-07-24T00:00:00.000Z',
      ended_at: '2026-07-24T00:01:00.000Z',
      players: [
        { userId: 'alice', seat: 0, stack: 1000, cards: ['Ah', 'Ad'] },
        { userId: 'bob', seat: 1, stack: 1000, cards: ['Kh', 'Kc'] },
      ],
      winners: [{ userId: 'bob', amount: 285 }],
      actions: [
        {
          seat: 0,
          userId: 'alice',
          action: 'small_blind',
          amount: 5,
          timestamp: 1000,
          stage: 'preflop',
        },
        {
          seat: 1,
          userId: 'bob',
          action: 'big_blind',
          amount: 10,
          timestamp: 1000,
          stage: 'preflop',
        },
        { seat: 0, userId: 'alice', action: 'call', amount: 5, timestamp: 3000, stage: 'preflop' },
        { seat: 1, userId: 'bob', action: 'raise', amount: 40, timestamp: 5500, stage: 'preflop' },
        { seat: 0, userId: 'alice', action: 'fold', amount: 0, timestamp: 9000, stage: 'preflop' },
      ],
    };
    const hand = fromHandHistoryRow(row);
    expect(hand.handId).toBe('h1');
    expect(hand.bigBlind).toBe(10);
    expect(hand.players).toHaveLength(2);
    expect(hand.winners[0]).toEqual({ userId: 'bob', amount: 285 });
    // blind posts are forced
    expect(hand.actions[0].forced).toBe(true);
    expect(hand.actions[0].action).toBe('post_blind');
    // first voluntary action has latency 0 (no prior voluntary reference)
    expect(hand.actions[2].latencyMs).toBe(0);
    // next voluntary action: 5500 - 3000 = 2500
    expect(hand.actions[3].latencyMs).toBe(2500);
    // fold: 9000 - 5500 = 3500
    expect(hand.actions[4].latencyMs).toBe(3500);
  });

  it('handles {rank,suit} card objects and missing fields defensively', () => {
    const hand = fromHandHistoryRow({
      hand_number: 7,
      players: [{ user_id: 'x', seat: 2 }],
      actions: [{ seat: 2, action: 'CHECK', stage: 'FLOP' }],
      community_cards: [{ rank: 'A', suit: 's' }],
    });
    expect(hand.handId).toBe('hand-7');
    expect(hand.players[0].userId).toBe('x');
    expect(hand.communityCards[0]).toBe('As');
    expect(hand.actions[0].action).toBe('check');
    expect(hand.actions[0].userId).toBe('x'); // resolved via seat map
    expect(hand.actions[0].street).toBe('flop');
  });

  it('alias maps', () => {
    expect(normalizeActionType('ALL-IN')).toBe('all_in');
    expect(normalizeActionType('bogus')).toBe('unknown');
    expect(normalizeStreet('pre_flop')).toBe('preflop');
    expect(normalizeStreet(undefined)).toBe('preflop');
  });
});
