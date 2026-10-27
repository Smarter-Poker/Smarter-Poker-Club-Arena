import { describe, expect, it } from 'vitest';
import { publicHandStatsFrame } from './publicHandStats.js';
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
