import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      for (const method of ['in', 'or', 'order', 'limit', 'range']) {
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
        if (table === 'union_admins') {
          return Promise.resolve({
            data: mocks.adminRole ? { role: mocks.adminRole } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      return builder;
    }),
    rpc: vi.fn((name: string, args?: Record<string, unknown>) => {
      if (name === 'fn_is_union_operator') {
        const unionId = args?.p_union_id as string;
        return Promise.resolve({
          data:
            mocks.unionOwners.get(unionId) === mocks.userId || mocks.adminRole === 'union_admin',
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
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
});
