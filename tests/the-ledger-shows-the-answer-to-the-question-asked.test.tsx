/**
 * A refund is taken from the row the admin can see.
 *
 * The purchase ledger debounces its search, so a pause can put a second
 * request on the wire while an earlier page or search is still travelling.
 * Nothing ordered the replies. An older one landing second would seat rows
 * the admin never asked for underneath buttons that move money, and the
 * refund control reads its purchase id straight off the row it is drawn in.
 *
 * This pins the rule: only the newest request may write to the table.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/components/common/confirmDialog', () => ({ confirmDialog: vi.fn() }));
vi.mock('../src/services/clubArenaApi', () => ({ callClubArenaApi: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'token', user: { id: 'user-a' } } },
      }),
    },
  },
}));

import PurchaseLedger from '../src/pages/marketplace/PurchaseLedger';

const row = (id: string, buyerName: string) => ({
  id,
  itemName: 'Seat Ticket',
  category: null,
  buyerId: `buyer-${id}`,
  buyerName,
  pricePaid: 100,
  currency: 'diamonds' as const,
  createdAt: new Date().toISOString(),
  refundedAt: null,
  status: 'owned' as const,
  refundable: true,
});

const payload = (rows: ReturnType<typeof row>[]) => ({
  ok: true,
  json: async () => ({ success: true, purchases: rows, total: rows.length }),
});

describe('the purchase ledger shows the answer to the question actually asked', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.toast.error.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const openLedger = async () => {
    render(<PurchaseLedger clubId="club-a" userId="user-a" />);
    fireEvent.click(screen.getByRole('button', { name: /Purchase Ledger/i }));
  };

  it('discards a reply that arrives after a newer one, however slow it was', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(url);
      return calls.length === 1 ? first.promise : second.promise;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await openLedger();
    await waitFor(() => expect(calls.length).toBe(1)); // the unfiltered first load

    // Ask a narrower question and let the pause fire.
    fireEvent.change(screen.getByLabelText(/Search Purchases/i), {
      target: { value: 'alice' },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toContain('q=alice');

    // The NEWER request answers first.
    await act(async () => {
      second.resolve(payload([row('p-alice', 'Alice')]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    // ...and the older, unfiltered one straggles in behind it.
    await act(async () => {
      first.resolve(payload([row('p-bob', 'Bob'), row('p-carol', 'Carol')]));
      await Promise.resolve();
    });

    // The table still answers the question the admin asked.
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    expect(screen.queryByText('Carol')).not.toBeInTheDocument();
  });

  it('does not raise an alarm when the request that failed is one nobody awaits', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const calls: string[] = [];
    const fetchMock = vi.fn(() => {
      calls.push('call');
      return calls.length === 1 ? first.promise : second.promise;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await openLedger();
    await waitFor(() => expect(calls.length).toBe(1));

    fireEvent.change(screen.getByLabelText(/Search Purchases/i), {
      target: { value: 'alice' },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await waitFor(() => expect(calls.length).toBe(2));

    await act(async () => {
      second.resolve(payload([row('p-alice', 'Alice')]));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    // The superseded request now fails. The rows on screen are fine, so the
    // admin is told nothing and the good rows keep their place.
    await act(async () => {
      first.resolve({ ok: false, json: async () => ({ success: false, error: 'boom' }) });
      await Promise.resolve();
    });

    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
