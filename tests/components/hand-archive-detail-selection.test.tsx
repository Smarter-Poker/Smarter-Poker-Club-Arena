import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  userId: 'a',
  search: '',
  refresh: null as null | (() => void),
  getHand: vi.fn(),
  getHands: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(state.search)],
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: state.userId } }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/utils/retryFetch', () => ({ retryFetch: (fn: () => unknown) => fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: () => () => {},
    subscribeDebounced: (event: string, callback: () => void) => {
      if (event === 'HAND_COMPLETED') state.refresh = callback;
      return () => {};
    },
  },
}));
vi.mock('../../src/lib/authUtils', async (original) => ({
  ...(await original<typeof import('../../src/lib/authUtils')>()),
  readLocalSession: () => ({ userId: state.userId }),
}));
vi.mock('../../src/services/HandHistoryService', () => ({
  handHistoryService: {
    getPlayerHands: (...args: unknown[]) => state.getHands(...args),
    getHand: (...args: unknown[]) => state.getHand(...args),
  },
}));
vi.mock('../../src/services/HandNotesService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/HandNotesService')>();
  return {
    ...actual,
    handNotesService: {
      ...actual.handNotesService,
      listFor: async () => new Map(),
      getOne: async () => ({ ok: true, note: null }),
    },
  };
});
vi.mock('../../src/services/HandFlagService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/HandFlagService')>();
  return {
    ...actual,
    handFlagService: { ...actual.handFlagService, mineFor: async () => new Map() },
  };
});
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: () => <h1>Hand Archive</h1>,
}));
vi.mock('../../src/lib/handSearch', () => ({
  filterBySubjects: (rows: unknown[]) => rows,
  handSearchSubject: () => ({}),
}));
vi.mock('../../src/components/handdetail/HandFlagControl', () => ({
  default: () => <div>Hand Flag</div>,
}));
vi.mock('../../src/components/handdetail/HandNoteEditor', () => ({
  default: () => <div>Hand Note</div>,
}));
vi.mock('../../src/components/replay/HandReplay', () => ({
  default: ({ handId, onClose }: { handId: string; onClose: () => void }) => (
    <div>
      Replay {handId}
      <button onClick={onClose}>Close Replay</button>
    </div>
  ),
}));
import HandHistoryPage from '../../src/pages/HandHistoryPage';
import { replayFromServiceRecord } from '../../src/lib/handHistoryAdapter';
import type { HandRecord } from '../../src/services/HandHistoryService';

function stored(id = 'selected', number = 100): HandRecord {
  const hand = {
    id,
    serial_number: id,
    table_id: 'table',
    table_name: 'Recorded Table',
    played_at: '2026-10-26T23:00:00Z',
    hand_number: number,
    total_hands: 1,
    main_pot: 3,
    side_pots: [],
    community_cards: [],
    players: [
      {
        user_id: 'a',
        username: 'Hero',
        seat: 1,
        position: 'SB',
        hole_cards: [],
        private_hole_cards: [
          { rank: 'A', suit: 'spades' },
          { rank: 'K', suit: 'hearts' },
        ],
        result: -1,
        is_winner: false,
      },
      {
        user_id: 'other',
        username: 'Other',
        seat: 2,
        position: 'BB',
        hole_cards: [],
        result: 1,
        is_winner: true,
      },
    ],
    actions: [{ player_id: 'a', action: 'fold', street: 'preflop', timestamp: 1 }],
    winners: [{ user_id: 'other', amount: 3, pot_index: 0 }],
    winners_by_board: [],
    game_type: 'NLH',
    stakes: '1/2',
    rake: 0,
    bbj_fee: 0,
  } as unknown as HandRecord;
  hand.replay = replayFromServiceRecord(hand);
  return hand;
}
beforeEach(() => {
  state.userId = 'a';
  state.search = '?hand=selected';
  state.refresh = null;
  state.getHand.mockReset().mockResolvedValue(stored());
  state.getHands.mockReset().mockResolvedValue([stored()]);
});
it('opens the exact archived hand in Summary and Detail and replays it after a newer page arrives', async () => {
  const view = render(<HandHistoryPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Hand Detail' }));
  const dialog = screen.getByRole('dialog', { name: 'Hand Detail' });
  expect(view.container.contains(dialog)).toBe(false);
  expect(dialog.closest('.hdm-overlay')?.parentElement).toBe(document.body);
  expect(within(dialog).getByRole('tab', { name: 'Hand Summary' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(within(dialog).getByRole('region', { name: 'Your Cards' }).textContent).toContain('Hero');
  expect(within(dialog).getByAltText('Ace Of Spades')).toBeTruthy();
  state.getHands.mockResolvedValue([stored('newer', 101)]);
  await act(async () => state.refresh?.());
  expect(dialog.textContent).toContain('#100');
  expect(dialog.textContent).not.toContain('#101');
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Hand Detail' }));
  expect(within(dialog).getByRole('tab', { name: 'Hand Detail' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Video Replay' }));
  expect(screen.queryByRole('dialog', { name: 'Hand Detail' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Hand Replay' }).textContent).toContain(
    'Replay selected'
  );
});
