import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ account: 'account-a', auth: vi.fn(), dashboard: vi.fn() }));
vi.mock('@/stores/useUserStore', () => ({
  useUserStore: Object.assign((select: any) => select({ user: { id: mock.account } }), {
    getState: () => ({ user: { id: mock.account } }),
  }),
}));
vi.mock('@/lib/supabase', () => ({ getAuthUser: mock.auth }));
vi.mock('@/services/DailyChallengeService', () => ({
  dailyChallengeService: { getDashboard: mock.dashboard },
}));
vi.mock('@/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('@/services/DailyMissionTelemetryService', () => ({
  dailyMissionReasonCode: () => 'test',
  recordDailyMissionOperation: vi.fn(),
}));
vi.mock('@/components/auth/AuthGuard', () => ({ AuthGuard: ({ children }: any) => children }));
vi.mock('@/components/common/PageErrorBoundary', () => ({
  PageErrorBoundary: ({ children }: any) => children,
}));
vi.mock('@/components/challenges/DailyChallengesRouteFallback', () => ({
  DailyChallengesAuthLoading: () => <p>Loading</p>,
  DailyChallengesCrashFallback: () => <p>Failed</p>,
}));
// Keep the actual dashboard loader and account effects; omit unrelated art/actions.
vi.mock('@/pages/DailyChallengesPage', async () => {
  const { useDailyMissionDashboard } =
    await import('@/components/challenges/dashboard/useDailyMissionDashboard');
  const { useIsMounted } = await import('@/hooks/useIsMounted');
  return {
    default: function Dashboard() {
      const state = useDailyMissionDashboard({ isMountedRef: useIsMounted() });
      return (
        <div>
          <p>{state.userId ?? 'No Account'}</p>
          <p>Balance {state.diamondBalance}</p>
          {state.loadError && <p role="alert">{state.loadError}</p>}
        </div>
      );
    },
  };
});
import DailyChallengesRoute from '@/components/challenges/DailyChallengesRoute';
function receipt(balance: number) {
  return {
    missions: [],
    periodKeys: { daily: new Date().toISOString().slice(0, 10), weekly: 'week', monthly: 'month' },
    stats: {},
    streak: {},
    diamondBalance: balance,
    vault: { count: 0, diamonds: 0, items: [], pageSize: 100, hasMore: false },
    revision: 1,
    syncedAt: new Date().toISOString(),
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  mock.account = 'account-a';
  vi.clearAllMocks();
  mock.auth.mockImplementation(async () => ({ data: { user: { id: mock.account } }, error: null }));
  mock.dashboard.mockImplementation(async (uid: string) =>
    receipt(uid === 'account-a' ? 111 : 222)
  );
});
afterEach(cleanup);
describe('Daily Challenges account route ownership', () => {
  it('switching players replaces the dashboard and its authenticated owner', async () => {
    const view = render(
      <MemoryRouter>
        <DailyChallengesRoute />
      </MemoryRouter>
    );
    await screen.findByText('Balance 111');
    mock.account = 'account-b';
    view.rerender(
      <MemoryRouter>
        <DailyChallengesRoute />
      </MemoryRouter>
    );
    await screen.findByText('Balance 222');
    expect(screen.queryByText('account-a')).toBeNull();
    expect(mock.dashboard).toHaveBeenLastCalledWith('account-b');
  });
  it('an old dashboard finishing after the switch cannot repaint the new player', async () => {
    const old = deferred<any>();
    mock.dashboard.mockReturnValueOnce(old.promise).mockResolvedValueOnce(receipt(222));
    const view = render(
      <MemoryRouter>
        <DailyChallengesRoute />
      </MemoryRouter>
    );
    await waitFor(() => expect(mock.dashboard).toHaveBeenCalledWith('account-a'));
    mock.account = 'account-b';
    view.rerender(
      <MemoryRouter>
        <DailyChallengesRoute />
      </MemoryRouter>
    );
    await screen.findByText('Balance 222');
    await act(async () => old.resolve(receipt(999)));
    expect(screen.queryByText('Balance 999')).toBeNull();
  });
  it('a mismatched secure-session response cannot install another player on the new mount', async () => {
    mock.account = 'account-b';
    mock.auth.mockResolvedValue({ data: { user: { id: 'account-a' } }, error: null });
    render(
      <MemoryRouter>
        <DailyChallengesRoute />
      </MemoryRouter>
    );
    await screen.findByRole('alert');
    expect(mock.dashboard).not.toHaveBeenCalled();
    expect(screen.queryByText('account-a')).toBeNull();
  });
});
