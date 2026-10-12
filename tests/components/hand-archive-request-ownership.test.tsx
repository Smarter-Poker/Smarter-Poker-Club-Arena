import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  userId: 'a',
  search: '',
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
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribeDebounced: () => () => {} } }));
vi.mock('../../src/services/HandHistoryService', () => ({
  handHistoryService: {
    getPlayerHands: (...args: unknown[]) => state.getHands(...args),
    getHand: (...args: unknown[]) => state.getHand(...args),
  },
}));
vi.mock('../../src/services/HandNotesService', () => ({
  handNotesService: { listFor: async () => new Map() },
}));
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
vi.mock('../../src/lib/handHistoryAdapter', () => ({
  adaptServiceHandToPanel: (row: { id: string; hand_number: number }) => ({
    id: row.id,
    handNumber: row.hand_number,
    timestamp: Date.now(),
    players: [],
    replay: { players: [], boards: [], gameVariant: 'NLH', potTotal: 0 },
    rake: 0,
  }),
  panelHandToShareable: vi.fn(),
}));
vi.mock('../../src/components/handdetail/HandDetailView', () => ({
  default: () => <div>Hand Details</div>,
}));
import HandHistoryPage from '../../src/pages/HandHistoryPage';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function rows(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    hand_number: i + 1,
    replay: { gameVariant: 'NLH' },
    played_at: '2026-10-12',
  }));
}
beforeEach(() => {
  state.userId = 'a';
  state.search = '';
  state.getHand.mockReset();
  state.getHands.mockReset();
  state.toast.error.mockReset();
});
describe('Hand archive request ownership', () => {
  it('shows a linked hand even when the archive list fails, without repeated lookups', async () => {
    state.search = '?hand=linked-0';
    state.getHands.mockRejectedValue(new Error('Archive Unavailable'));
    state.getHand.mockResolvedValue(rows('linked', 1)[0]);
    render(<HandHistoryPage />);
    await waitFor(() => expect(document.getElementById('hand-linked-0')).toBeTruthy());
    expect(state.getHand).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });
  it('ignores an older failed first page after a newer account succeeded', async () => {
    const old = deferred<unknown[]>();
    state.getHands.mockImplementation((id: string) =>
      id === 'a' ? old.promise : Promise.resolve([])
    );
    const view = render(<HandHistoryPage />);
    await waitFor(() => expect(state.getHands).toHaveBeenCalled());
    state.userId = 'b';
    view.rerender(<HandHistoryPage />);
    await waitFor(() => expect(state.getHands).toHaveBeenCalledWith('b', 25, expect.anything()));
    await act(async () => old.reject(new Error('Old Account Read Failed')));
    expect(state.toast.error).not.toHaveBeenCalled();
    expect(screen.queryByText('Could Not Load Hand History')).toBeNull();
  });
  it('rejects a previous account pagination response after the new account loaded', async () => {
    const more = deferred<unknown[]>();
    state.getHands.mockImplementation((id: string, _size: number, options: { offset?: number }) =>
      id === 'b'
        ? Promise.resolve(rows('b', 1))
        : options.offset
          ? more.promise
          : Promise.resolve(rows('a', 25))
    );
    const view = render(<HandHistoryPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load More Hands' }));
    state.userId = 'b';
    view.rerender(<HandHistoryPage />);
    await waitFor(() => expect(document.getElementById('hand-b-0')).toBeTruthy());
    await act(async () => more.resolve(rows('old-more', 1)));
    expect(document.getElementById('hand-old-more-0')).toBeNull();
    expect(document.getElementById('hand-a-0')).toBeNull();
    expect(document.getElementById('hand-b-0')).toBeTruthy();
  });
});
