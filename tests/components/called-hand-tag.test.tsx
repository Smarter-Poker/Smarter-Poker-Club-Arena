/**
 * Dan 2026-10-25: a hand mucked at the table whose cards are shown because it
 * CALLED the river carries a "Called" tag on the hand detail, so nobody reads
 * it as a hand the player chose to show. A shown hand carries no tag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HandDetailView } from '@/components/handdetail/HandDetailView';
import { buildReplay, replayInputFromRow } from '@/utils/handReplay';
import { withCalledRiverMucks } from '@/services/HandHistoryService';

afterEach(cleanup);

const BETTOR = 'a6cd08f3-d81f-4d69-a4bb-42e869393a9d';
const CALLER = 'a7d90ad1-1f5f-49dc-958a-051ad859d20d';

function model(withCalled: boolean) {
  const act = (userId: string, seat: number, stage: string, action: string, amount = 0) => ({
    userId,
    seat,
    stage,
    action,
    amount,
    timestamp: 1,
  });
  const row = {
    id: 'h',
    table_id: 't',
    hand_number: 1,
    game_variant: 'nlh',
    small_blind: 0.25,
    big_blind: 0.5,
    pot_size: 4,
    button_seat: 4,
    community_cards: ['5d', '7h', '3s', 'Ah', 'Qh'],
    players: [
      { userId: BETTOR, seat: 4, stack: 20, username: 'Bettor' },
      { userId: CALLER, seat: 6, stack: 20, username: 'Caller' },
    ],
    winners: [{ userId: BETTOR, amount: 4, hand: { name: 'Pair' } }],
    actions: [
      act(BETTOR, 4, 'preflop', 'sb', 0.25),
      act(CALLER, 6, 'preflop', 'bb', 0.5),
      act(BETTOR, 4, 'preflop', 'call', 0.25),
      act(CALLER, 6, 'preflop', 'check'),
      act(CALLER, 6, 'river', 'check'),
      act(BETTOR, 4, 'river', 'bet', 1),
      act(CALLER, 6, 'river', 'call', 1),
    ],
    hole_cards: {
      [BETTOR]: [
        { rank: 'A', suit: 'diamonds' },
        { rank: 'J', suit: 'hearts' },
      ],
    },
    showdown: [
      { user_id: BETTOR, seat: 4, reveal_order: 0, mucked: false, hand_name: 'Pair' },
      { user_id: CALLER, seat: 6, reveal_order: 1, mucked: true },
    ],
  };
  const merged = withCalled
    ? withCalledRiverMucks(
        row,
        new Map([
          [
            CALLER,
            [
              { rank: 'K', suit: 'hearts' },
              { rank: 'Q', suit: 'clubs' },
            ] as any,
          ],
        ])
      )
    : row;
  return buildReplay(replayInputFromRow(merged as any));
}

describe('the hand detail tags a called muck', () => {
  it('shows CALLED on the caller and nowhere else', () => {
    render(<HandDetailView model={model(true)} currentUserId={BETTOR} />);
    expect(screen.getAllByText('CALLED')).toHaveLength(1);
  });

  it('shows no tag when the called cards are not on record', () => {
    render(<HandDetailView model={model(false)} currentUserId={BETTOR} />);
    expect(screen.queryByText('CALLED')).toBeNull();
  });
});
