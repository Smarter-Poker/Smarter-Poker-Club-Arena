import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TransactionHistory from '../../src/components/wallet/TransactionHistory';

const m = vi.hoisted(() => ({
  user: { id: 'fixture-a' } as { id: string } | null,
  queries: [] as Array<{ resolve: (value: unknown) => void }>,
  toast: { error: vi.fn() },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: m.user }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => m.toast }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscriptions: vi.fn() }));
vi.mock('../../src/hooks/useStaggerAnimation', () => ({
  useStaggerAnimation: () => ({ style: () => ({}) }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise((finish) => {
        resolve = finish;
      });
      m.queries.push({ resolve });
      const query: any = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range: () => query,
        then: (yes: (value: unknown) => void, no: (reason: unknown) => void) =>
          promise.then(yes, no),
      };
      return query;
    },
  },
}));

const row = (id: string, description: string) => ({
  id,
  description,
  type: 'credit',
  category: 'deposit',
  amount: 10,
  balance_after: 10,
  created_at: '2026-10-12T12:00:00Z',
  wallet_type: 'PLAYER',
});

beforeEach(() => {
  m.user = { id: 'fixture-a' };
  m.queries.length = 0;
  vi.clearAllMocks();
});

describe('Wallet ledger request ownership', () => {
  it('an old account page cannot dismiss the new account loading screen', async () => {
    const { rerender } = render(<TransactionHistory walletId="fixture-a" limit={1} />);
    await waitFor(() => expect(m.queries).toHaveLength(1));
    await act(async () =>
      m.queries[0].resolve({ data: [row('a-first', 'Account A Movement')], error: null })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    await waitFor(() => expect(m.queries).toHaveLength(2));
    rerender(<TransactionHistory walletId="fixture-b" limit={1} />);
    await waitFor(() => expect(m.queries).toHaveLength(3));
    await act(async () =>
      m.queries[1].resolve({ data: [row('a-late', 'Account A Earlier Movement')], error: null })
    );
    expect(screen.queryByText('Account A Movement')).toBeNull();
    expect(screen.queryByText('Account A Earlier Movement')).toBeNull();
    await act(async () =>
      m.queries[2].resolve({ data: [row('b-first', 'Account B Movement')], error: null })
    );
    expect(await screen.findByText('Account B Movement')).toBeTruthy();
  });

  it('logout invalidates a ledger read already in flight', async () => {
    const { rerender } = render(<TransactionHistory />);
    await waitFor(() => expect(m.queries).toHaveLength(1));
    m.user = null;
    rerender(<TransactionHistory limit={21} />);
    await act(async () =>
      m.queries[0].resolve({ data: [row('a-late', 'Previous Account Movement')], error: null })
    );
    expect(screen.queryByText('Previous Account Movement')).toBeNull();
    expect(screen.getByText('No Transactions')).toBeTruthy();
  });
});
