/**
 * The Settlement Center renders WeeklyAccountingWorkspace, whose h2 is
 * "Club Weekly Accounting", above ClubWeeklyAccountingSummary. When the summary
 * also called itself "Club Weekly Accounting" the page carried two headings and
 * two regions of that name, and financial-admin-deep.spec.ts failed on strict
 * mode (Post-Deploy E2E run 37569802965). Real component, synthetic reads.
 */
import { render, screen } from '@testing-library/react';
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

describe('the summary is named for what it lists', () => {
  it('owns "Club Weekly Summaries", never the workspace name above it', async () => {
    fixture.rows = [weeklyStatementRow()];
    render(<ClubWeeklyAccountingSummary clubId={ID.club} />);
    await screen.findByRole('table');
    expect(screen.getByRole('heading', { name: 'Club Weekly Summaries' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Club Weekly Summaries' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Club Weekly Accounting' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Club Weekly Accounting' })).toBeNull();
  });
});
