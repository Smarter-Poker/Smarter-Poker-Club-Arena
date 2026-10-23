import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HandDetailModal } from '@/components/table/HandDetailModal';
import { adaptServiceHandToPanel } from '@/lib/handHistoryAdapter';
import type { HandRecord } from '@/services/HandHistoryService';

const mocks = vi.hoisted(() => ({ getHand: vi.fn(), viewer: 'hero' }));
vi.mock('@/services/HandHistoryService', () => ({
  handHistoryService: { getHand: mocks.getHand },
}));
vi.mock('@/lib/authUtils', async (original) => ({
  ...(await original<typeof import('@/lib/authUtils')>()),
  readLocalSession: () => ({ userId: mocks.viewer }),
}));

function stored(id = 'one', cards = false): HandRecord {
  return {
    id,
    serial_number: id,
    table_id: 'table',
    table_name: 'Table',
    played_at: '2026-10-22T23:43:33Z',
    hand_number: id === 'one' ? 1 : 2,
    total_hands: 2,
    main_pot: 3,
    side_pots: [],
    community_cards: [],
    players: [
      {
        user_id: 'hero',
        username: 'Hero',
        seat: 1,
        position: 'SB',
        hole_cards: [],
        private_hole_cards: cards
          ? [
              { rank: 'A', suit: 'spades' },
              { rank: 'K', suit: 'hearts' },
            ]
          : undefined,
        result: -1,
        is_winner: false,
      },
      {
        user_id: 'villain',
        username: 'Villain',
        seat: 2,
        position: 'BB',
        hole_cards: [],
        result: 1,
        is_winner: true,
      },
    ],
    actions: [{ player_id: 'hero', action: 'fold', street: 'preflop', timestamp: 1 }],
    winners: [{ user_id: 'villain', amount: 3, pot_index: 0 }],
    winners_by_board: [],
    game_type: 'NLH',
    stakes: '1/2',
    rake: 0,
    bbj_fee: 0,
  } as unknown as HandRecord;
}
const panel = (id = 'one', cards = false) => adaptServiceHandToPanel(stored(id, cards), 'hero');
afterEach(cleanup);
beforeEach(() => {
  mocks.viewer = 'hero';
  mocks.getHand.mockReset();
});

describe('review keeps the viewer in the hand even outside showdown', () => {
  it('shows the folded participant while cards are unavailable instead of omitting them', async () => {
    mocks.getHand.mockResolvedValue(stored());
    render(<HandDetailModal isOpen onClose={() => {}} hands={[panel()]} heroId="hero" />);
    const own = screen.getByRole('region', { name: 'Your Cards' });
    expect(own.textContent).toContain('Hero');
    await waitFor(() => expect(own.textContent).toContain('No Cards Available In This Record'));
    expect(mocks.getHand).toHaveBeenCalledTimes(1);
  });

  it('refreshes a cached hand missing private facts and shares that model with Detail and Replay', async () => {
    mocks.getHand.mockResolvedValue(stored('one', true));
    const replay = vi.fn();
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[panel()]}
        heroId="hero"
        onReplay={replay}
      />
    );
    const own = await screen.findByRole('region', { name: 'Your Cards' });
    await within(own).findByRole('img', { name: 'Ace Of Spades' });
    expect(within(own).getByRole('img', { name: 'King Of Hearts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Hand Detail' }));
    expect(
      within(screen.getByRole('region', { name: 'Your Cards' })).getByRole('img', {
        name: 'Ace Of Spades',
      })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Video Replay' }));
    expect(
      replay.mock.calls[0][0].replay.players.find((p: any) => p.userId === 'hero').privateHole
    ).toHaveLength(2);
  });

  it('shows failure and permits an explicit refresh without a repair loop', async () => {
    mocks.getHand
      .mockRejectedValueOnce(new Error('private read denied'))
      .mockResolvedValueOnce(stored('one', true));
    render(<HandDetailModal isOpen onClose={() => {}} hands={[panel()]} heroId="hero" />);
    await screen.findByText('Could Not Load Your Cards');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Your Cards' }));
    await within(screen.getByRole('region', { name: 'Your Cards' })).findByRole('img', {
      name: 'Ace Of Spades',
    });
    expect(mocks.getHand).toHaveBeenCalledTimes(2);
  });

  it('ignores a late response after selecting another hand', async () => {
    let finish!: (value: HandRecord) => void;
    mocks.getHand.mockReturnValue(
      new Promise<HandRecord>((resolve) => {
        finish = resolve;
      })
    );
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[panel(), panel('two', true)]}
        heroId="hero"
      />
    );
    await waitFor(() => expect(mocks.getHand).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Older Hand' }));
    finish(stored('one', true));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy Hand Number 2' })).toBeTruthy()
    );
    expect(mocks.getHand).toHaveBeenCalledTimes(1);
  });

  it('keeps a shown hand at the top as well as in the full showdown breakdown', () => {
    const row = stored('one', true);
    row.players[0].hole_cards = row.players[0].private_hole_cards!;
    row.players[0].private_hole_cards = undefined;
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[adaptServiceHandToPanel(row, 'hero')]}
        heroId="hero"
      />
    );
    const own = screen.getByRole('region', { name: 'Your Cards' });
    expect(within(own).getByRole('img', { name: 'Ace Of Spades' })).toBeTruthy();
    expect(own.textContent).toContain('Shown');
    expect(document.querySelector('.hdm-body')?.firstElementChild).toBe(own);
    expect(mocks.getHand).not.toHaveBeenCalled();
  });

  it('does not refetch already available cards or show another participant private cards', () => {
    render(
      <HandDetailModal isOpen onClose={() => {}} hands={[panel('one', true)]} heroId="hero" />
    );
    expect(mocks.getHand).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Your Cards' }).textContent).toContain('Hero');
    expect(screen.getByRole('region', { name: 'Your Cards' }).textContent).not.toContain('Villain');
  });
});
