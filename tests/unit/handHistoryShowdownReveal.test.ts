/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY — showdown holdings must survive the mapper
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23, with a screenshot: the Showdown section of Hand Summary and
 * Hand Detail drew two grey rectangles for villains whose cards the whole table
 * had just watched turn over.
 *
 * The cards were in the row all along. `mapHandHistoryRow` read them behind an
 * `isMe || isWinner` gate, so a player who reached showdown and LOST was
 * blanked. That gate asks the wrong question: the server writes `hole_cards`
 * for showdown-revealed holdings ONLY — mucked cards are deliberately never
 * persisted, see server/src/services/supabase/handHistory.ts — so a user id
 * appearing in that object already means the hand was public.
 *
 * Measured on production before the fix: over six hours, 9,407 of 17,025
 * stored holdings (55%) belonged to a non-winner and were therefore discarded
 * between the database and the screen.
 *
 * The fixture below is the shape production stores: camelCase JSONB keys, hole
 * cards as `{ rank, suit }` objects with the suit spelled out, and
 * `players[].cards` empty (it is empty on every row).
 */

import { describe, it, expect, vi } from 'vitest';

const WINNER = '11111111-1111-1111-1111-111111111111';
const LOSER = '22222222-2222-2222-2222-222222222222';
const FOLDER = '33333333-3333-3333-3333-333333333333';

vi.mock('../../src/lib/supabase', () => {
  const ROW = {
    id: 'hand-1',
    created_at: '2026-08-23T12:00:00.000Z',
    table_id: 'table-1',
    hand_number: 1731202,
    pot_size: 305,
    community_cards: ['Jdiamonds', '6diamonds', '4clubs', 'Ahearts', '3spades'],
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    rake_amount: 0,
    players: [
      { userId: '11111111-1111-1111-1111-111111111111', seat: 1, isButton: true, cards: [] },
      { userId: '22222222-2222-2222-2222-222222222222', seat: 2, cards: [] },
      { userId: '33333333-3333-3333-3333-333333333333', seat: 3, cards: [] },
    ],
    actions: [
      {
        userId: '33333333-3333-3333-3333-333333333333',
        action: 'fold',
        stage: 'preflop',
        timestamp: 1,
      },
      {
        userId: '22222222-2222-2222-2222-222222222222',
        action: 'call',
        amount: 100,
        stage: 'preflop',
        timestamp: 2,
      },
    ],
    winners: [
      {
        userId: '11111111-1111-1111-1111-111111111111',
        amount: 305,
        potIndex: 0,
        hand: { name: 'Two Pair' },
      },
    ],
    // Exactly two entries: the two players who turned their cards over. The
    // folder is absent, because a mucked hand is never written.
    hole_cards: {
      '11111111-1111-1111-1111-111111111111': [
        { rank: 'A', suit: 'spades' },
        { rank: '8', suit: 'hearts' },
      ],
      '22222222-2222-2222-2222-222222222222': [
        { rank: 'K', suit: 'clubs' },
        { rank: 'K', suit: 'diamonds' },
      ],
    },
  };

  /* `profiles` resolves empty so the mapper falls back to the truncated user
     id for names — this spec is about cards, not usernames. */
  const buildChain = (table: string): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () =>
            Promise.resolve({ data: table === 'hand_history' ? ROW : null, error: null });
        if (prop === 'then')
          return (resolve: (v: unknown) => void) =>
            resolve({ data: table === 'hand_history' ? [ROW] : [], error: null });
        return () => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  };

  return {
    supabase: {
      from: (table: string) => buildChain(table),
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  };
});

import { handHistoryService } from '../../src/services/HandHistoryService';

describe('showdown holdings reach the panel', () => {
  it('reveals a villain who showed down and LOST', async () => {
    // Asked for by the player who folded, so this cannot pass by way of
    // "it is my own hand" — the previous gate's only other escape.
    const hands = await handHistoryService.getPlayerHands(FOLDER, 1);
    const loser = hands[0].players.find((p) => p.user_id === LOSER);

    expect(loser?.is_winner).toBe(false);
    expect(loser?.hole_cards).toHaveLength(2);
  });

  it('still reveals the winner', async () => {
    const hands = await handHistoryService.getPlayerHands(FOLDER, 1);
    const winner = hands[0].players.find((p) => p.user_id === WINNER);

    expect(winner?.is_winner).toBe(true);
    expect(winner?.hole_cards).toHaveLength(2);
  });

  it('does NOT invent cards for a hand that folded and was never shown', async () => {
    const hands = await handHistoryService.getPlayerHands(FOLDER, 1);
    const folder = hands[0].players.find((p) => p.user_id === FOLDER);

    // The row holds nothing for this seat and never will. Showing anything
    // here would be a fabrication, and exposing an opponent's mucked range
    // afterwards is a game-integrity problem, not a feature.
    expect(folder?.hole_cards).toEqual([]);
  });
});
