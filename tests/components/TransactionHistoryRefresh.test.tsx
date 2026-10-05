import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TransactionHistoryPage from '../../src/pages/TransactionHistoryPage';

const backend = vi.hoisted(() => ({
  ranges: [] as number[][],
  refresh: () => {},
  rows: [] as unknown[],
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'viewer' } }) }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: (fn: () => void) => {
    backend.refresh = fn;
  },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({ default: () => null }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeRegisteredChannel: vi.fn(),
    subscribeDebounced: () => () => {},
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      let start = 0;
      let end = 24;
      const query = {
        select() {
          return query;
        },
        or() {
          return query;
        },
        order() {
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        gte() {
          return query;
        },
        lte() {
          return query;
        },
        range(a: number, b: number) {
          start = a;
          end = b;
          backend.ranges.push([a, b]);
          return query;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: backend.rows.slice(start, end + 1), error: null }).then(
            resolve
          );
        },
      };
      return query;
    },
  },
}));
beforeEach(() => {
  sessionStorage.clear();
  backend.ranges = [];
  backend.rows = [
    {
      id: 'latest',
      transaction_type: 'deposit',
      amount: 7,
      notes: 'Latest Deposit',
      created_at: '2026-10-05T12:00:00Z',
    },
  ];
});
afterEach(cleanup);
it('retains the latest transactions when visibility requests a fresh first page', async () => {
  render(<TransactionHistoryPage />);
  await screen.findByText('Latest Deposit');
  backend.rows.unshift({
    id: 'new',
    transaction_type: 'deposit',
    amount: 8,
    notes: 'New Deposit',
    created_at: '2026-10-05T13:00:00Z',
  });
  await act(async () => backend.refresh());
  await waitFor(() => expect(backend.ranges).toHaveLength(2));
  expect(backend.ranges).toEqual([
    [0, 24],
    [0, 24],
  ]);
  expect(await screen.findByText('New Deposit')).toBeInTheDocument();
  expect(screen.getByText('Latest Deposit')).toBeInTheDocument();
});
