import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UNION_A = '11111111-1111-4111-8111-111111111111';
const UNION_B = '22222222-2222-4222-8222-222222222222';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  unionAGate: null as null | ReturnType<typeof deferred<{ data: object; error: null }>>,
  userId: '33333333-3333-4333-8333-333333333333',
  unionOwners: new Map<string, string>(),
  adminRole: null as string | null,
  queriedTables: [] as string[],
  admins: [] as Record<string, unknown>[],
  unionClubs: [] as Record<string, unknown>[],
  updateClubCommission: vi.fn(),
  wallet: null as Record<string, unknown> | null,
  walletError: null as unknown,
  listApplications: vi.fn(),
  listLeaveRequests: vi.fn(),
}));

vi.mock('../src/services/UnionApiService', () => ({
  unionApi: {
    updateClubCommission: (...args: unknown[]) => mocks.updateClubCommission(...args),
    listApplications: (...args: unknown[]) => mocks.listApplications(...args),
    listLeaveRequests: (...args: unknown[]) => mocks.listLeaveRequests(...args),
  },
}));

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: mocks.userId } }),
}));

vi.mock('../src/hooks/useSpinsWallet', () => ({
  useSpinsWallet: () => ({
    state: null,
    loading: false,
    active: false,
    balance: 0,
    reload: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));

vi.mock('../src/core/MasterBus', () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return {
    masterBus: {
      subscribe: vi.fn(() => vi.fn()),
      subscribeDebounced: vi.fn(() => vi.fn()),
      getOrCreateChannel: vi.fn(() => channel),
      removeRegisteredChannel: vi.fn(),
      emit: vi.fn(),
    },
  };
});

vi.mock('../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('../src/components/union/UnionWalletModal', () => ({ default: () => null }));
vi.mock('../src/components/union/UnionTreasuryDetailModal', () => ({ default: () => null }));
vi.mock('../src/components/club/SpinActivationPanel', () => ({ default: () => null }));
vi.mock('../src/components/common/TransactionLedgerView', () => ({ default: () => null }));
vi.mock('../src/components/union/UnionOpsPanel', () => ({ default: () => null }));
vi.mock('../src/components/union/UnionClubGovernance', () => ({ default: () => null }));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      mocks.queriedTables.push(table);
      const filters = new Map<string, unknown>();
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = vi.fn(chain);
      builder.eq = vi.fn((column: string, value: unknown) => {
        filters.set(column, value);
        return builder;
      });
      for (const method of ['in', 'or', 'order', 'limit', 'range', 'abortSignal']) {
        builder[method] = vi.fn(chain);
      }
      builder.maybeSingle = vi.fn(() => {
        if (table === 'unions') {
          const unionId = filters.get('id');
          if (unionId === UNION_A) return mocks.unionAGate!.promise;
          return Promise.resolve({
            data: {
              id: UNION_B,
              name: 'Union Bravo',
              owner_id: mocks.unionOwners.get(UNION_B),
              created_at: '2026-08-31T00:00:00Z',
            },
            error: null,
          });
        }
        if (table === 'union_wallets')
          return Promise.resolve({ data: mocks.wallet, error: mocks.walletError });
        if (table === 'union_admins') {
          return Promise.resolve({
            data: mocks.adminRole ? { role: mocks.adminRole } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: table === 'union_clubs' ? mocks.unionClubs : [],
          error: null,
          count: 0,
        }).then(resolve);
      return builder;
    }),
    rpc: vi.fn((name: string, args?: Record<string, unknown>) => {
      if (name === 'fn_is_union_operator') {
        const unionId = args?.p_union_id as string;
        const result = Promise.resolve({
          data:
            mocks.unionOwners.get(unionId) === mocks.userId || mocks.adminRole === 'union_admin',
          error: null,
        });
        return Object.assign(result, { abortSignal: () => result });
      }
      const result = Promise.resolve({
        data: name === 'fn_union_admin_directory' ? mocks.admins : [],
        error: null,
      });
      return Object.assign(result, { abortSignal: () => result });
    }),
  },
}));

import UnionDashboardPage from '../src/pages/UnionDashboardPage';

function RouteControls() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/unions/${UNION_B}/operations`)}>
      Open Union B
    </button>
  );
}

function DashboardAuthHarness({ revision }: { revision: number }) {
  void revision;
  return (
    <Routes>
      <Route path="/unions/:unionId/operations" element={<UnionDashboardPage />} />
    </Routes>
  );
}

describe('UnionDashboardPage route ownership', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.unionAGate = deferred();
    mocks.userId = '33333333-3333-4333-8333-333333333333';
    mocks.unionOwners = new Map([
      [UNION_A, mocks.userId],
      [UNION_B, mocks.userId],
    ]);
    mocks.adminRole = null;
    mocks.queriedTables = [];
    mocks.admins = [];
    mocks.unionClubs = [];
    mocks.updateClubCommission.mockReset();
    mocks.wallet = {
      id: 'wallet-id',
      union_id: UNION_B,
      chip_balance: 100,
      rake_wallet: 0,
      bbj_wallet: 0,
      promo_wallet: 0,
      insurance_wallet: 0,
      spin_reserve_wallet: 0,
      total_rake_collected: 0,
      total_settlements: 0,
      created_at: '2026-09-01',
    };
    mocks.walletError = null;
    mocks.listApplications.mockReset().mockResolvedValue({ success: true, applications: [] });
    mocks.listLeaveRequests.mockReset().mockResolvedValue({ success: true, leaveRequests: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not let a slower previous-union response overwrite the current route', async () => {
    render(
      <MemoryRouter initialEntries={[`/unions/${UNION_A}/operations`]}>
        <RouteControls />
        <Routes>
          <Route path="/unions/:unionId/operations" element={<UnionDashboardPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Union B' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Union Bravo' })).toBeVisible());

    await act(async () => {
      mocks.unionAGate!.resolve({
        data: {
          id: UNION_A,
          name: 'Union Alpha',
          owner_id: mocks.userId,
          created_at: '2026-08-31T00:00:00Z',
        },
        error: null,
      });
      await mocks.unionAGate!.promise;
    });

    expect(screen.getByRole('heading', { name: 'Union Bravo' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Union Alpha' })).not.toBeInTheDocument();
  });

  it('establishes a fresh routed owner as union lead before showing the wallet controls', async () => {
    render(
      <MemoryRouter initialEntries={[`/unions/${UNION_B}/operations?tab=wallet`]}>
        <Routes>
          <Route path="/unions/:unionId/operations" element={<UnionDashboardPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Union Bravo' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Deposit To Union Bank' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Wallet' })).toHaveAttribute('aria-selected', 'true');
  });

  it('admits an appointed union admin without granting owner-only treasury controls', async () => {
    mocks.unionOwners.set(UNION_B, '44444444-4444-4444-8444-444444444444');
    mocks.adminRole = 'union_admin';

    render(
      <MemoryRouter initialEntries={[`/unions/${UNION_B}/operations?tab=wallet`]}>
        <Routes>
          <Route path="/unions/:unionId/operations" element={<UnionDashboardPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Union Bravo' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Deposit To Union Bank' })
    ).not.toBeInTheDocument();
  });

  it('rejects an unrelated authenticated deep link before any wallet data is queried', async () => {
    mocks.unionOwners.set(UNION_B, '44444444-4444-4444-8444-444444444444');

    render(
      <MemoryRouter initialEntries={[`/unions/${UNION_B}/operations?tab=wallet`]}>
        <Routes>
          <Route path="/unions/:unionId/operations" element={<UnionDashboardPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('No Union Workspace Is Available')).toBeVisible();
    expect(mocks.queriedTables).not.toContain('union_wallets');
    expect(screen.queryByRole('tablist', { name: 'Union Operations' })).not.toBeInTheDocument();
  });

  it('hides the previous account scope immediately and reauthorizes before protected reads', async () => {
    const view = (revision: number) => (
      <MemoryRouter initialEntries={[`/unions/${UNION_B}/operations?tab=wallet`]}>
        <DashboardAuthHarness revision={revision} />
      </MemoryRouter>
    );
    const rendered = render(view(0));

    expect(await screen.findByRole('heading', { name: 'Union Bravo' })).toBeVisible();
    mocks.queriedTables = [];
    mocks.userId = '55555555-5555-4555-8555-555555555555';

    rendered.rerender(view(1));

    expect(screen.queryByRole('heading', { name: 'Union Bravo' })).not.toBeInTheDocument();
    expect(await screen.findByText('No Union Workspace Is Available')).toBeVisible();
    expect(mocks.queriedTables).not.toContain('union_wallets');
  });
  const application = (id: string, status = 'pending', union = UNION_B) => ({
    id,
    union_id: union,
    club_id: 'club-id',
    club_name: id,
    applicant_user_id: 'applicant-id',
    status,
    message: null,
    applied_at: '2026-09-01',
  });
  const mountTab = async (tab: string) => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <MemoryRouter initialEntries={[`/unions/${UNION_B}/operations?tab=${tab}`]}>
          <DashboardAuthHarness revision={0} />
        </MemoryRouter>
      );
    });
    return view;
  };

  it('refreshes the actual external application list while the tab stays open', async () => {
    vi.useFakeTimers();
    mocks.listApplications.mockResolvedValue({
      success: true,
      applications: [application('First Club')],
    });
    await mountTab('applications');
    expect(screen.getByText('First Club')).toBeVisible();
    mocks.listApplications.mockResolvedValue({
      success: true,
      applications: [application('Second Club')],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText('Second Club')).toBeVisible();
    expect(screen.queryByText('First Club')).not.toBeInTheDocument();
    expect(mocks.listApplications).toHaveBeenCalledTimes(2);
    expect(mocks.listApplications.mock.calls[1][2]).toBeInstanceOf(AbortSignal);
  });

  it('retains known applications on read failure and refreshes both application lists manually', async () => {
    vi.useFakeTimers();
    mocks.listApplications.mockResolvedValue({
      success: true,
      applications: [application('Known Club')],
    });
    await mountTab('applications');
    mocks.listApplications.mockRejectedValue(new Error('Read unavailable'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText('Known Club')).toBeVisible();
    expect(
      screen.getByText('Applications Could Not Be Refreshed. Please Try Again.')
    ).toBeVisible();
    mocks.listApplications.mockResolvedValue({ success: true, applications: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
    });
    expect(screen.queryByText('Known Club')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Applications Could Not Be Refreshed. Please Try Again.')
    ).not.toBeInTheDocument();
    expect(mocks.listLeaveRequests).toHaveBeenCalledTimes(3);
  });

  it('rejects a delayed response from the previous filter even when transport ignores abort', async () => {
    vi.useFakeTimers();
    const old = deferred<{ success: boolean; applications: object[] }>();
    mocks.listApplications.mockReturnValueOnce(old.promise).mockResolvedValue({
      success: true,
      applications: [application('Approved Club', 'approved')],
    });
    await mountTab('applications');
    const oldSignal = mocks.listApplications.mock.calls[0][2] as AbortSignal;
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'approved' } });
    });
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByText('Approved Club')).toBeVisible();
    await act(async () => {
      old.resolve({ success: true, applications: [application('Stale Pending')] });
    });
    expect(screen.queryByText('Stale Pending')).not.toBeInTheDocument();
    expect(screen.getByText('Approved Club')).toBeVisible();
  });

  it('discards delayed application and leave results after the rendered account changes', async () => {
    vi.useFakeTimers();
    const oldApps = deferred<{ success: boolean; applications: object[] }>();
    const oldLeave = deferred<{ success: boolean; leaveRequests: object[] }>();
    mocks.listApplications.mockReturnValue(oldApps.promise);
    mocks.listLeaveRequests.mockReturnValue(oldLeave.promise);
    const view = await mountTab('applications');
    mocks.userId = '55555555-5555-4555-8555-555555555555';
    await act(async () => {
      view.rerender(
        <MemoryRouter initialEntries={[`/unions/${UNION_B}/operations?tab=applications`]}>
          <DashboardAuthHarness revision={1} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      oldApps.resolve({ success: true, applications: [application('Prior Account')] });
      oldLeave.resolve({
        success: true,
        leaveRequests: [
          { id: 'old', union_id: UNION_B, club_name: 'Prior Leave', requested_at: '2026-09-01' },
        ],
      });
    });
    expect(screen.getByText('No Union Workspace Is Available')).toBeVisible();
    expect(screen.queryByText('Prior Account')).not.toBeInTheDocument();
    expect(screen.queryByText('Prior Leave')).not.toBeInTheDocument();
  });

  it('updates the administrator roster and removes the workspace when its authority is revoked', async () => {
    vi.useFakeTimers();
    mocks.unionOwners.set(UNION_B, '44444444-4444-4444-8444-444444444444');
    mocks.adminRole = 'union_admin';
    const admin = (name: string) => ({
      user_id: name,
      union_id: UNION_B,
      role: 'union_admin',
      created_at: '2026-09-01',
      display_name: name,
      username: name,
      avatar_url: null,
    });
    mocks.admins = [admin('First Admin')];
    await mountTab('settings');
    expect(screen.getByText('First Admin')).toBeVisible();
    mocks.admins = [admin('Second Admin')];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText('Second Admin')).toBeVisible();
    expect(screen.queryByText('First Admin')).not.toBeInTheDocument();
    mocks.adminRole = null;
    mocks.queriedTables = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText('No Union Workspace Is Available')).toBeVisible();
    expect(mocks.queriedTables).not.toContain('union_wallets');
    expect(screen.queryByText('Second Admin')).not.toBeInTheDocument();
  });

  it('preserves an authoritative zero commission in display and prefill without widening valid writes', async () => {
    mocks.unionClubs = [
      {
        club_id: '66666666-6666-4666-8666-666666666666',
        club_commission_rate: 0,
        clubs: {
          id: '66666666-6666-4666-8666-666666666666',
          name: 'Zero Rate Club',
          club_id: 123,
          member_count: 0,
          active_tables: 0,
          total_rake: 0,
        },
      },
    ];
    await mountTab('clubs');
    expect(screen.getByText('0.0% Comm')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Rate', exact: true }));
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveValue(0);
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '100');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(screen.getByText('Rate must be 1-100%')).toBeVisible();
    expect(mocks.updateClubCommission).not.toHaveBeenCalled();
  });

  it('refreshes external wallet balances and retains them on malformed or failed reads', async () => {
    vi.useFakeTimers();
    await mountTab('wallet');
    const balance = () =>
      screen.getByRole('button', { name: 'Open Chip Balance' }).querySelector('.admin-stat-value')!
        .textContent;
    expect(balance()).toBe('100');
    mocks.wallet = { ...mocks.wallet!, chip_balance: 275 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(balance()).toBe('275');
    mocks.wallet = { ...mocks.wallet, chip_balance: null };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(balance()).toBe('275');
    expect(screen.getByRole('alert')).toHaveTextContent('Last Known Values Are Shown');
    mocks.walletError = new Error('Wallet unavailable');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(balance()).toBe('275');
    mocks.walletError = null;
    mocks.wallet = { ...mocks.wallet, chip_balance: 0 };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
    });
    expect(balance()).toBe('0');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not observe dashboard or application data while hidden or offline', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    try {
      await mountTab('applications');
      const originalReads = mocks.queriedTables.length;
      visibility.mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(mocks.queriedTables.length).toBe(originalReads);
      expect(mocks.listApplications).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue('visible');
      online.mockReturnValue(false);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.queriedTables.length).toBe(originalReads);
      expect(mocks.listLeaveRequests).toHaveBeenCalledTimes(1);
      online.mockReturnValue(true);
      await act(async () => window.dispatchEvent(new Event('online')));
      expect(mocks.queriedTables.length).toBeGreaterThan(originalReads);
      expect(mocks.listApplications).toHaveBeenCalledTimes(2);
      expect(mocks.listLeaveRequests).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
      online.mockRestore();
    }
  });

  it('discards pending applications and leave requests when the union route changes', async () => {
    vi.useFakeTimers();
    const oldApps = deferred<{ success: boolean; applications: object[] }>();
    const oldLeave = deferred<{ success: boolean; leaveRequests: object[] }>();
    mocks.listApplications.mockImplementation((id) =>
      id === UNION_A
        ? oldApps.promise
        : Promise.resolve({ success: true, applications: [application('Current Union Club')] })
    );
    mocks.listLeaveRequests.mockImplementation((id) =>
      id === UNION_A ? oldLeave.promise : Promise.resolve({ success: true, leaveRequests: [] })
    );
    mocks.wallet = { ...mocks.wallet!, union_id: UNION_A };
    mocks.unionAGate!.resolve({
      data: { id: UNION_A, name: 'Union Alpha', owner_id: mocks.userId, created_at: '2026-09-01' },
      error: null,
    });
    await act(async () => {
      render(
        <MemoryRouter initialEntries={[`/unions/${UNION_A}/operations?tab=applications`]}>
          <RouteControls />
          <DashboardAuthHarness revision={0} />
        </MemoryRouter>
      );
    });
    expect(mocks.listApplications).toHaveBeenCalledTimes(1);
    const oldSignal = mocks.listApplications.mock.calls[0][2] as AbortSignal;
    mocks.wallet = { ...mocks.wallet, union_id: UNION_B };
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Union B' })));
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: /Applications/ })));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      oldApps.resolve({
        success: true,
        applications: [application('Prior Union Club', 'pending', UNION_A)],
      });
      oldLeave.resolve({
        success: true,
        leaveRequests: [
          {
            id: 'old',
            union_id: UNION_A,
            club_name: 'Prior Union Leave',
            requested_at: '2026-09-01',
          },
        ],
      });
    });
    expect(screen.getByText('Current Union Club')).toBeVisible();
    expect(screen.queryByText('Prior Union Club')).not.toBeInTheDocument();
    expect(screen.queryByText('Prior Union Leave')).not.toBeInTheDocument();
  });
});
