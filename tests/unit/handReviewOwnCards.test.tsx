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

describe('opening a recorded hand preserves the requested subject', () => {
  it('opens the older requested hand in Summary, Detail and selected Replay', () => {
    const replay = vi.fn();
    render(
      <HandDetailModal
        isOpen
        onClose={() => {}}
        hands={[panel('one', true), panel('two', true)]}
        initialHandId="two"
        heroId="hero"
        onReplay={replay}
      />
    );
    expect(screen.getByRole('button', { name: 'Copy Hand Number 2' })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Your Cards' })).getAllByRole('img')
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Hand Detail' }));
    expect(screen.getByRole('button', { name: 'Copy Hand Number 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Video Replay' }));
    expect(replay.mock.calls[0][0].id).toBe('two');
  });

  it('reopens on the requested hand after the reader navigated elsewhere', () => {
    const hands = [panel('one', true), panel('two', true)];
    const props = { onClose: () => {}, hands, heroId: 'hero', initialHandId: 'two' };
    const view = render(<HandDetailModal {...props} isOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Newer Hand' }));
    expect(screen.getByRole('button', { name: 'Copy Hand Number 1' })).toBeTruthy();
    view.rerender(<HandDetailModal {...props} isOpen={false} />);
    view.rerender(<HandDetailModal {...props} isOpen />);
    expect(screen.getByRole('button', { name: 'Copy Hand Number 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Hand Summary' }).getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('keeps the requested hand pinned when a newer hand arrives', () => {
    const hands = [panel('one', true), panel('two', true)];
    const props = { onClose: () => {}, heroId: 'hero', initialHandId: 'two', isOpen: true };
    const view = render(<HandDetailModal {...props} hands={hands} />);
    view.rerender(<HandDetailModal {...props} hands={[panel('three', true), ...hands]} />);
    expect(screen.getByRole('button', { name: 'Copy Hand Number 2' })).toBeTruthy();
    const replay = vi.fn();
    view.rerender(
      <HandDetailModal {...props} hands={[panel('three', true), ...hands]} onReplay={replay} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Video Replay' }));
    expect(replay.mock.calls[0][0].id).toBe('two');
  });
});

const VARIANT_HOLDINGS = [
  ['NLH', 2],
  ['SHORT_DECK', 2],
  ['PINEAPPLE', 2],
  ['CRAZY_PINEAPPLE', 2],
  ['PLO4', 4],
  ['PLO5', 5],
  ['PLO6', 6],
  ['PLO8', 4],
  ['FLH', 2],
  ['FLO8', 4],
] as const;

describe('the same private hand survives every review game family', () => {
  it.each(VARIANT_HOLDINGS)(
    '%s preserves all %i retained cards in Summary, Detail and Replay',
    (variant, count) => {
      const row = stored('one', true);
      row.game_type = variant;
      const ranks = ['A', 'K', 'Q', 'J', 'T', '9'];
      row.players[0].private_hole_cards = ranks
        .slice(0, count)
        .map((rank) => ({ rank, suit: 'spades' }));
      row.main_pot = 12;
      row.side_pots = [8];
      row.players[0].result = -10;
      row.players[1].result = 10;
      row.winners = [
        { user_id: 'villain', amount: 12, pot_index: 0 },
        { user_id: 'villain', amount: 8, pot_index: 1 },
      ];
      row.actions = [
        { player_id: 'hero', action: 'sb', amount: 1, street: 'preflop', timestamp: 1 },
        { player_id: 'villain', action: 'bb', amount: 2, street: 'preflop', timestamp: 2 },
        { player_id: 'villain', action: 'raise', amount: 10, street: 'preflop', timestamp: 3 },
        { player_id: 'hero', action: 'call', amount: 9, street: 'preflop', timestamp: 4 },
        { player_id: 'hero', action: 'fold', street: 'flop', timestamp: 5 },
      ];
      const hand = adaptServiceHandToPanel(row, 'hero');
      expect(hand.replay.reconciles).toBe(true);
      const replay = vi.fn();
      render(
        <HandDetailModal isOpen onClose={() => {}} hands={[hand]} heroId="hero" onReplay={replay} />
      );
      const own = screen.getByRole('region', { name: 'Your Cards' });
      const names = within(own)
        .getAllByRole('img')
        .map((image) => image.getAttribute('alt'));
      expect(names).toHaveLength(count);
      expect(new Set(names).size).toBe(count);
      expect(own.textContent).toContain('-10.00');
      expect(hand.potTotal).toBe(20);
      expect(hand.winners[0].amount).toBe(20);
      fireEvent.click(screen.getByRole('tab', { name: 'Hand Detail' }));
      expect(
        within(screen.getByRole('region', { name: 'Your Cards' }))
          .getAllByRole('img')
          .map((image) => image.getAttribute('alt'))
      ).toEqual(names);
      fireEvent.click(screen.getByRole('button', { name: 'Video Replay' }));
      const selected = replay.mock.calls[0][0];
      expect(selected.id).toBe(row.id);
      expect(
        selected.replay.players.find((p: any) => p.userId === 'hero').privateHole
      ).toHaveLength(count);
      expect(selected.replay.players.find((p: any) => p.userId === 'hero').invested).toBe(10);
      expect(mocks.getHand).not.toHaveBeenCalled();
    }
  );
});

describe('forced money and multiple boards keep the viewer and the exact pot', () => {
  it.each(['tournament', 'bomb', 'rit'] as const)(
    '%s retains cards and results through both tabs and selected replay',
    (mode) => {
      const row = stored('one', true);
      row.game_type = mode === 'tournament' ? 'NLH' : 'PLO5';
      row.table_name = mode === 'tournament' ? 'Tournament Table 1' : 'Omaha';
      row.stakes = mode === 'tournament' ? '300/600' : '1/2';
      row.players[0].private_hole_cards = ['A', 'K', 'Q', 'J', 'T']
        .slice(0, mode === 'tournament' ? 2 : 5)
        .map((rank) => ({ rank, suit: 'spades' }));
      row.main_pot = 1100;
      row.side_pots = [];
      row.players[0].result = -400;
      row.players[1].result = 400;
      row.winners = [{ user_id: 'villain', amount: 1100, pot_index: 0 }];
      row.actions = [
        { player_id: 'hero', action: 'ante', amount: 100, street: 'preflop', timestamp: 1 },
        { player_id: 'villain', action: 'ante', amount: 100, street: 'preflop', timestamp: 2 },
        { player_id: 'hero', action: 'sb', amount: 300, street: 'preflop', timestamp: 3 },
        { player_id: 'villain', action: 'bb', amount: 600, street: 'preflop', timestamp: 4 },
        { player_id: 'hero', action: 'fold', street: 'preflop', timestamp: 5 },
      ];
      if (mode !== 'tournament') {
        row.community_cards = ['2diamonds', '3diamonds', '4clubs', '5hearts', '6clubs'] as any;
        const second = ['7diamonds', '8diamonds', '9clubs', 'Thearts', 'Jclubs'] as any;
        if (mode === 'bomb') {
          row.bomb_pot = { ante_amount: 550, board_count: 2, variant: 'PLO5' };
          row.community_cards2 = second;
          row.actions = [
            { player_id: 'hero', action: 'bomb_ante', amount: 550, street: 'flop', timestamp: 1 },
            {
              player_id: 'villain',
              action: 'bomb_ante',
              amount: 550,
              street: 'flop',
              timestamp: 2,
            },
            { player_id: 'hero', action: 'fold', street: 'flop', timestamp: 3 },
          ];
          row.players[0].result = -550;
          row.players[1].result = 550;
        } else {
          row.rit_boards = [second];
          row.actions = [
            { player_id: 'hero', action: 'sb', amount: 1, street: 'preflop', timestamp: 1 },
            { player_id: 'villain', action: 'bb', amount: 2, street: 'preflop', timestamp: 2 },
            { player_id: 'hero', action: 'all_in', amount: 550, street: 'preflop', timestamp: 3 },
            { player_id: 'villain', action: 'call', amount: 548, street: 'preflop', timestamp: 4 },
          ];
          row.players[0].showdown_reveal = { mucked: true };
          row.players[0].result = -550;
          row.players[1].result = 550;
        }
        row.winners_by_board = [1, 2].map((board) => ({ board, user_id: 'villain', amount: 550 }));
      }
      const hand = adaptServiceHandToPanel(row, 'hero');
      expect(hand.replay.reconciles).toBe(true);
      const replay = vi.fn();
      render(
        <HandDetailModal isOpen onClose={() => {}} hands={[hand]} heroId="hero" onReplay={replay} />
      );
      expect(screen.getByRole('region', { name: 'Your Cards' }).textContent).toContain(
        mode === 'tournament' ? '-400.00' : '-550.00'
      );
      expect(
        within(screen.getByRole('region', { name: 'Your Cards' })).getAllByRole('img')
      ).toHaveLength(mode === 'tournament' ? 2 : 5);
      expect(document.querySelector('.hdm-potline')?.textContent).toContain('1,100.00');
      if (mode !== 'tournament') expect(hand.replay.boards).toHaveLength(2);
      fireEvent.click(screen.getByRole('tab', { name: 'Hand Detail' }));
      expect(
        within(screen.getByRole('region', { name: 'Your Cards' })).getAllByRole('img')
      ).toHaveLength(mode === 'tournament' ? 2 : 5);
      fireEvent.click(screen.getByRole('button', { name: 'Video Replay' }));
      expect(
        replay.mock.calls[0][0].replay.pots.reduce(
          (total: number, pot: any) => total + pot.amount,
          0
        )
      ).toBe(1100);
      expect(replay.mock.calls[0][0].heroResult).toBe(mode === 'tournament' ? -400 : -550);
    }
  );
});
