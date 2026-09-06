/**
 * THE REPLAYER'S RABBIT HUNT ACTUALLY RENDERS (P5 audit, 2026-09-05)
 *
 * `rabbitHuntFromTheReplayer.test.tsx` pins the RULE and drives the PURCHASE,
 * but it never rendered the modal - so it could not have caught the block
 * failing to appear at all: a prop not threaded, the boards read off the
 * wrong shape, a timestamp in the wrong unit. This renders the real
 * HandDetailModal with real adapted hands and looks for the control.
 *
 * The fixture is the one the sheet tests already use, so the record is built
 * by the same `adaptServiceHandToPanel` the table uses in production rather
 * than hand-shaped to suit the test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { HandDetailModal } from '@/components/table/HandDetailModal';
import { adaptServiceHandToPanel } from '@/lib/handHistoryAdapter';

vi.mock('@/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));

const HERO = '11111111-2222-4333-8444-555555555555';
const VILLAIN = '22222222-3333-4444-8555-666666666666';

/** A hand that ended on the FLOP - two cards unseen behind it. */
function serviceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'h-1',
    serial_number: '3046089',
    table_id: 't-1',
    table_name: 'Midway 1/2',
    played_at: new Date().toISOString(),
    hand_number: 3046089,
    total_hands: 0,
    main_pot: 100,
    side_pots: [],
    community_cards: ['7clubs', '2clubs', '9hearts'],
    players: [
      {
        seat: 1,
        user_id: HERO,
        username: 'kingfish',
        avatar_url: null,
        position: 'BTN',
        hole_cards: [
          { rank: 'A', suit: 'spades' },
          { rank: 'A', suit: 'hearts' },
        ],
        result: 50,
        is_winner: true,
        showdown_reveal: { reveal_order: 1, mucked: false, hand_name: 'Pair' },
      },
      {
        seat: 2,
        user_id: VILLAIN,
        username: 'Emerson Blackwell',
        avatar_url: null,
        position: 'BB',
        hole_cards: [],
        result: -50,
        is_winner: false,
      },
    ],
    actions: [
      { player_id: HERO, action: 'raise', amount: 6, street: 'preflop', timestamp: 1 },
      { player_id: VILLAIN, action: 'fold', amount: 0, street: 'flop', timestamp: 2 },
    ],
    winners: [{ user_id: HERO, amount: 100, pot_index: 0, hand_name: 'Pair' }],
    winners_by_board: [],
    rake: 0,
    bbj_fee: 0,
    game_type: 'NLH',
    stakes: '1/2',
    ...over,
  } as unknown as Parameters<typeof adaptServiceHandToPanel>[0];
}

const record = (over: Record<string, unknown> = {}) =>
  adaptServiceHandToPanel(serviceRow(over), HERO);

afterEach(cleanup);

describe('the replayer offers the hunt on a hand that still qualifies', () => {
  it('renders the control for a fresh hand that ended on the flop', () => {
    const { getByRole, getByText } = render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record()]}
        heroId={HERO}
        onRabbitHunt={vi.fn()}
        rabbitUserId={HERO}
      />
    );
    expect(getByRole('button', { name: /Show What Would Have Come/i })).toBeTruthy();
    expect(getByText(/2 Cards Unseen/i), 'the turn and the river').toBeTruthy();
  });

  it('buys for the hand on screen and paints what would have come', async () => {
    const onRabbitHunt = vi.fn().mockResolvedValue({
      success: true,
      cards: [
        { rank: 'K', suit: 'd' },
        { rank: '4', suit: 's' },
      ],
      diamondsSpent: 5,
    });
    const { getByRole, getByText, container } = render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record()]}
        heroId={HERO}
        onRabbitHunt={onRabbitHunt}
        rabbitUserId={HERO}
      />
    );
    fireEvent.click(getByRole('button', { name: /Show What Would Have Come/i }));
    await waitFor(() => expect(onRabbitHunt).toHaveBeenCalledWith(3046089));
    await waitFor(() => expect(getByText(/Would Have Come/i)).toBeTruthy());
    // The bought cards are marked apart from the board that really ran.
    await waitFor(() => expect(container.querySelectorAll('.hdm-card--rabbit').length).toBe(2));
  });

  it('does NOT offer it on a hand whose board already ran out', () => {
    const { queryByRole } = render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[
          record({ community_cards: ['7clubs', '2clubs', '9hearts', 'Kdiamonds', 'Tclubs'] }),
        ]}
        heroId={HERO}
        onRabbitHunt={vi.fn()}
        rabbitUserId={HERO}
      />
    );
    expect(queryByRole('button', { name: /Show What Would Have Come/i })).toBeNull();
  });

  it('does NOT offer it on a hand older than the engine window', () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const { queryByRole } = render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[record({ played_at: old })]}
        heroId={HERO}
        onRabbitHunt={vi.fn()}
        rabbitUserId={HERO}
      />
    );
    expect(queryByRole('button', { name: /Show What Would Have Come/i })).toBeNull();
  });

  it('does NOT render at all where there is no table to ask (no handler)', () => {
    const { queryByRole } = render(
      <HandDetailModal isOpen onClose={() => {}} hands={[record()]} heroId={HERO} />
    );
    expect(queryByRole('button', { name: /Show What Would Have Come/i })).toBeNull();
  });
});
