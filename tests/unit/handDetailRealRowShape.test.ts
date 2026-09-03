import { describe, it, expect } from 'vitest';
import { adaptServiceHandToPanel } from '@/lib/handHistoryAdapter';
import type { HandRecord } from '@/services/HandHistoryService';

/**
 * Dan 2026-08-23: Hand Detail showed "UNDEFINE" where every board card should
 * be, and two grey backs at showdown.
 *
 * The fixtures the adapter was tested against used clean `{ rank, suit }`
 * objects. Production does not. This row is copied from a real `hand_history`
 * row read out of the live database on the day of the fix — full suit words,
 * as strings — so the shape that actually broke is the shape under test.
 */
const REAL_ROW = {
  id: 'h1',
  serial_number: 'h1',
  table_id: 't1',
  table_name: 'Table',
  played_at: new Date().toISOString(),
  hand_number: 1731202,
  total_hands: 1,
  main_pot: 305,
  side_pots: [],
  // Exactly as stored: strings, suit spelled out.
  community_cards: ['Jdiamonds', '6diamonds', '4clubs', 'Ahearts', '3spades'],
  players: [
    {
      seat: 1,
      user_id: 'hero',
      username: 'kingfish',
      avatar_url: null,
      position: 'BTN',
      // The hole_cards column is objects with the full suit word.
      hole_cards: [
        { rank: 'A', suit: 'spades' },
        { rank: '8', suit: 'hearts' },
      ],
      result: 144,
      is_winner: true,
    },
  ],
  actions: [],
  game_type: 'NLH',
  stakes: '1/2',
} as unknown as HandRecord;

describe('hand detail renders the row shape production actually stores', () => {
  const panel = adaptServiceHandToPanel(REAL_ROW, 'hero');

  it('never emits the string that rendered as UNDEFINE', () => {
    const everyCard = [
      ...panel.streets.flatMap((s) => s.cards ?? []),
      ...panel.players.flatMap((p) => p.holeCards ?? []),
    ];
    expect(everyCard.length).toBeGreaterThan(0);
    for (const c of everyCard) {
      expect(c).not.toMatch(/undefined/i);
      expect(c).toHaveLength(2);
    }
  });

  it('keeps the real suit — a jack of diamonds is not a spade', () => {
    const flop = panel.streets.find((s) => s.name === 'flop');
    expect(flop?.cards).toEqual(['Jd', '6d', '4c']);
    expect(panel.streets.find((s) => s.name === 'turn')?.cards).toEqual(['Ah']);
    expect(panel.streets.find((s) => s.name === 'river')?.cards).toEqual(['3s']);
  });

  it('shows the hero their own hole cards instead of two blank backs', () => {
    expect(panel.players[0].holeCards).toEqual(['As', '8h']);
  });
});
