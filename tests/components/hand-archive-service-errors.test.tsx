import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  search: '',
  result: { data: null as unknown, error: null as unknown },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(state.search)],
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'viewer' } }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../../src/lib/supabase', () => {
  const chain = (): any =>
    new Proxy(
      {},
      {
        get: (_target, name) =>
          name === 'then'
            ? (resolve: (result: unknown) => void) => resolve(state.result)
            : () => chain(),
      }
    );
  return { supabase: { from: () => chain(), rpc: async () => state.result } };
});
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/utils/retryFetch', () => ({ retryFetch: (fn: () => unknown) => fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { subscribeDebounced: () => () => {}, subscribe: () => () => {} },
}));
vi.mock('../../src/services/HandNotesService', () => ({
  handNotesService: { listFor: async () => new Map() },
}));
vi.mock('../../src/services/HandFlagService', () => ({
  handFlagService: { mineFor: async () => new Map() },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: () => <h1>Hand Archive</h1>,
}));
import HandHistoryPage from '../../src/pages/HandHistoryPage';
import { handHistoryService } from '../../src/services/HandHistoryService';
beforeEach(() => {
  state.search = '';
  state.result = { data: null, error: { code: '42501', message: 'Read Refused' } };
  state.toast.error.mockReset();
});
describe('Archive actual service failure wiring', () => {
  it.each(['', '?arena=diamond'])(
    'shows Retry for a failed actual service read at %s',
    async (search) => {
      state.search = search;
      render(<HandHistoryPage />);
      expect(await screen.findByRole('button', { name: 'Retry', exact: true })).toBeTruthy();
      expect(screen.queryByText('No Hands Recorded Yet')).toBeNull();
      expect(state.toast.error).toHaveBeenCalledWith('Could Not Load Hand History');
    }
  );
  it('retains the existing soft-error contract for other table callers', async () => {
    expect(await handHistoryService.getPlayerHands('viewer')).toEqual([]);
  });
  it('keeps a successful empty response distinct from a failed read', async () => {
    state.result = { data: [], error: null };
    render(<HandHistoryPage />);
    expect(await screen.findByText('No Hands Recorded Yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).toBeNull();
  });
});
