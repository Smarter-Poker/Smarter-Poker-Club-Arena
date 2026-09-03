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
}));

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: '33333333-3333-4333-8333-333333333333' } }),
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
              owner_id: '33333333-3333-4333-8333-333333333333',
              created_at: '2026-08-31T00:00:00Z',
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      return builder;
    }),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
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

describe('UnionDashboardPage route ownership', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.unionAGate = deferred();
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
          owner_id: '33333333-3333-4333-8333-333333333333',
          created_at: '2026-08-31T00:00:00Z',
        },
        error: null,
      });
      await mocks.unionAGate!.promise;
    });

    expect(screen.getByRole('heading', { name: 'Union Bravo' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Union Alpha' })).not.toBeInTheDocument();
  });
});
