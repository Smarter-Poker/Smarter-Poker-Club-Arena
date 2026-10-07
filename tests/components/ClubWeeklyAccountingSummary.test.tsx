/** Actual summary component, reader and account guard; synthetic DB responses. UNRUN. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKLY_ID as ID, weeklyStatementRow } from '../helpers/clubWeeklyStatement';

const fixture = vi.hoisted(() => ({
  userId: null as string | null,
  auth: undefined as
    | undefined
    | ((event: { payload: { isAuthenticated: boolean; userId?: string } }) => void),
  rows: [] as Record<string, unknown>[],
  reply: null as null | (() => Promise<unknown>),
  calls: [] as Array<{ table: string; filters: Array<[string, unknown]>; cap: number }>,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({
    user: fixture.userId ? { id: fixture.userId } : null,
    isHydrating: false,
  }),
}));
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({
    loaded: !!fixture.userId,
    authenticated: !!fixture.userId,
    userId: fixture.userId,
  }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn((event, callback) => {
      if (event === 'AUTH_STATE_CHANGED') fixture.auth = callback;
      return vi.fn();
    }),
  },
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: vi.fn(async (id) => id) }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import { supabase } from '../../src/lib/supabase';
import ClubWeeklyAccountingSummary from '../../src/components/accounting/ClubWeeklyAccountingSummary';

function signIn(userId: string | null) {
  fixture.userId = userId;
  fixture.auth?.({ payload: { isAuthenticated: !!userId, userId: userId ?? undefined } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.rows = [];
  fixture.reply = null;
  fixture.calls = [];
  signIn(null);
  signIn(ID.actor);
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const call = { table, filters: [] as Array<[string, unknown]>, cap: Infinity };
    fixture.calls.push(call);
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'gte', 'lte']) query[method] = vi.fn(() => query);
    query.eq = vi.fn((key: string, value: unknown) => {
      call.filters.push([key, value]);
      return query;
    });
    query.limit = vi.fn((cap: number) => {
      call.cap = cap;
      return query;
    });
    query.then = (done: (value: unknown) => unknown, fail: (error: unknown) => unknown) => {
      const reply = fixture.reply
        ? fixture.reply()
        : Promise.resolve({
            data: fixture.rows
              .filter((row) => call.filters.every(([key, value]) => row[key] === value))
              .slice(0, call.cap),
            error: null,
          });
      return reply.then(done, fail);
    };
    return query as never;
  });
});

describe('issued club weekly summaries', () => {
  it('shows aggregate exact cents only and never queries individual commissions or a payer', async () => {
    fixture.rows = [
      weeklyStatementRow(),
      weeklyStatementRow({ invoice_type: 'transaction_receipt', gross_amount: '987654.32' }),
    ];
    render(<ClubWeeklyAccountingSummary clubId={ID.club} />);
    await screen.findByRole('columnheader', { name: 'Rake Received' });
    expect(screen.getByRole('columnheader', { name: 'Rakeback Paid' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Rake Retained' })).toBeTruthy();
    expect(screen.queryByText('987,654.32 Chips')).toBeNull();
    expect(screen.queryByText('Agent User ID')).toBeNull();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toEqual({
      table: 'settlement_invoices',
      cap: 50,
      filters: [
        ['club_id', ID.club],
        ['invoice_type', 'club_weekly_accounting'],
      ],
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('distinguishes unavailable reads from an actual empty authorized result', async () => {
    fixture.reply = async () => ({ data: null, error: { message: 'refused' } });
    render(<ClubWeeklyAccountingSummary clubId={ID.club} />);
    await screen.findByRole('alert');
    expect(screen.queryByText('No Issued Weekly Summaries Were Found For This Club.')).toBeNull();
    fixture.reply = null;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Weekly Summaries' }));
    await screen.findByText('No Issued Weekly Summaries Were Found For This Club.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('removes previously visible money when refresh fails validation', async () => {
    fixture.rows = [weeklyStatementRow()];
    render(<ClubWeeklyAccountingSummary clubId={ID.club} />);
    await screen.findByRole('table');
    fixture.rows = [weeklyStatementRow({ net_amount: '9999.00' })];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Weekly Summaries' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('never publishes a late previous-club response over the next club', async () => {
    const old = deferred<unknown>();
    fixture.reply = () => old.promise;
    const view = render(<ClubWeeklyAccountingSummary clubId={ID.club} />);
    await waitFor(() => expect(fixture.calls).toHaveLength(1));
    fixture.reply = null;
    view.rerender(<ClubWeeklyAccountingSummary clubId={ID.otherClub} />);
    await screen.findByText('No Issued Weekly Summaries Were Found For This Club.');
    await act(async () => {
      old.resolve({ data: [weeklyStatementRow()], error: null });
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retires a batched account A-B-A read even when the visible user ID returns to A', async () => {
    const old = deferred<unknown>();
    fixture.reply = () => old.promise;
    const view = render(<ClubWeeklyAccountingSummary clubId={ID.club} />);
    await waitFor(() => expect(fixture.calls).toHaveLength(1));
    act(() => {
      signIn(ID.otherActor);
      signIn(ID.actor);
    });
    fixture.reply = null;
    view.rerender(<ClubWeeklyAccountingSummary clubId={ID.club} />);
    await screen.findByText('No Issued Weekly Summaries Were Found For This Club.');
    await act(async () => {
      old.resolve({ data: [weeklyStatementRow()], error: null });
    });
    expect(screen.queryByRole('table')).toBeNull();
  });
});
