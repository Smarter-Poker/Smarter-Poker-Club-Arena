import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  clubId: '11111111-1111-4111-8111-111111111111',
  viewerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  scopeUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  mounted: { current: true },
  toast: { error: vi.fn() },
  reads: [] as Array<{
    resolve: (value: { data: unknown; error: unknown }) => void;
    filters: Array<[string, unknown]>;
  }>,
}));

vi.mock('../../src/hooks/useFinancialAdminScope', () => ({
  useFinancialAdminScope: () => ({
    status: 'ready',
    clubId: m.clubId,
    platformWide: false,
    clubRole: 'owner',
    isPlatformStaff: false,
    userId: m.scopeUserId,
    message: null,
    reload: vi.fn(),
  }),
  clubScoped: (query: { eq: (column: string, value: string) => unknown }) =>
    query.eq('club_id', m.clubId),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: m.viewerId } }),
}));
vi.mock('../../src/hooks/useIsMounted', () => ({ useIsMounted: () => m.mounted }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => m.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/safeErrorMessage', () => ({
  safeErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('../../src/core/MasterBus', () => {
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn(() => channel),
  };
  return {
    masterBus: {
      getOrCreateChannel: vi.fn(() => channel),
      removeRegisteredChannel: vi.fn(),
    },
  };
});
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const filters: Array<[string, unknown]> = [];
      const query: Record<string, unknown> = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      });
      query.not = vi.fn((column: string, operator: string, value: unknown) => {
        filters.push([`${column}:${operator}`, value]);
        return query;
      });
      query.order = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.then = (done: (value: unknown) => unknown, fail: (error: unknown) => unknown) => {
        const promise = new Promise<{ data: unknown; error: unknown }>((resolve) => {
          m.reads.push({ resolve, filters });
        });
        return promise.then(done, fail);
      };
      return query;
    }),
  },
}));

import SettlementHistoryPage from '../../src/pages/SettlementHistoryPage';

const cycle = (id: string, period: string, clubId = m.clubId) => ({
  id,
  club_id: clubId,
  period_id: period,
  invoice_type: 'union_to_club',
  gross_amount: 100,
  net_amount: 10,
  breakdown: { union_hold_amount: 10, club_retained: 90 },
  status: 'paid',
  created_at: '2026-10-03T12:00:00Z',
});

beforeEach(() => {
  m.clubId = '11111111-1111-4111-8111-111111111111';
  m.viewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  m.scopeUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  m.mounted.current = true;
  m.reads.length = 0;
  m.toast.error.mockReset();
});

describe('SettlementHistoryPage request scope', () => {
  it('never publishes an old club history after the route scope changes', async () => {
    const view = render(
      <MemoryRouter>
        <SettlementHistoryPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(m.reads).toHaveLength(1));

    m.clubId = '22222222-2222-4222-8222-222222222222';
    view.rerender(
      <MemoryRouter>
        <SettlementHistoryPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(m.reads).toHaveLength(2));

    await act(async () => {
      m.reads[1].resolve({
        data: [cycle('aaaaaaaa-1111-4111-8111-111111111111', 'Current Week')],
        error: null,
      });
    });
    expect(await screen.findByText(/Current Week/)).toBeTruthy();

    await act(async () => {
      m.reads[0].resolve({
        data: [
          cycle(
            '99999999-9999-4999-8999-999999999999',
            'Previous Week',
            '11111111-1111-4111-8111-111111111111'
          ),
        ],
        error: null,
      });
    });
    expect(screen.queryByText(/Previous Week/)).toBeNull();
    expect(m.reads[0].filters).toContainEqual(['club_id', '11111111-1111-4111-8111-111111111111']);
    expect(m.reads[1].filters).toContainEqual(['club_id', '22222222-2222-4222-8222-222222222222']);
    expect(m.reads[1].filters).toContainEqual(['breakdown->>union_hold_amount:is', null]);
    expect(m.reads[1].filters).toContainEqual(['breakdown->>club_retained:is', null]);
  });

  it('refuses a malformed cycle instead of painting a green completed zero', async () => {
    render(
      <MemoryRouter>
        <SettlementHistoryPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(m.reads).toHaveLength(1));
    await act(async () => {
      m.reads[0].resolve({
        data: [
          {
            ...cycle('aaaaaaaa-2222-4222-8222-222222222222', 'Broken Week'),
            status: null,
            gross_amount: null,
          },
        ],
        error: null,
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Settlement History Could Not Be Loaded'
    );
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.queryByText(/Broken Week/)).toBeNull();
  });

  it('refuses a non-conserving settlement split instead of publishing false net revenue', async () => {
    render(
      <MemoryRouter>
        <SettlementHistoryPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(m.reads).toHaveLength(1));
    await act(async () => {
      m.reads[0].resolve({
        data: [
          {
            ...cycle('aaaaaaaa-3333-4333-8333-333333333333', 'Broken Split'),
            breakdown: { union_hold_amount: 10, club_retained: 95 },
          },
        ],
        error: null,
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Settlement History Could Not Be Loaded'
    );
    expect(screen.queryByText(/Broken Split/)).toBeNull();
    expect(screen.queryByText(/95/)).toBeNull();
  });

  it('refuses a well-formed settlement row from another club', async () => {
    render(
      <MemoryRouter>
        <SettlementHistoryPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(m.reads).toHaveLength(1));
    await act(async () => {
      m.reads[0].resolve({
        data: [
          cycle(
            '88888888-8888-4888-8888-888888888888',
            'Wrong Club Week',
            '22222222-2222-4222-8222-222222222222'
          ),
        ],
        error: null,
      });
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Settlement History Could Not Be Loaded'
    );
    expect(screen.queryByText(/Wrong Club Week/)).toBeNull();
  });

  it('removes the prior account history before a same-club scope recheck completes', async () => {
    const view = render(
      <MemoryRouter>
        <SettlementHistoryPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(m.reads).toHaveLength(1));
    await act(async () => {
      m.reads[0].resolve({
        data: [cycle('77777777-7777-4777-8777-777777777777', 'First Account Week')],
        error: null,
      });
    });
    expect(await screen.findByText(/First Account Week/)).toBeTruthy();

    m.viewerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    view.rerender(
      <MemoryRouter>
        <SettlementHistoryPage />
      </MemoryRouter>
    );

    expect(screen.queryByText(/First Account Week/)).toBeNull();
    expect(screen.getAllByText('Checking Your Club Finance Access.')).not.toHaveLength(0);
    expect(m.reads).toHaveLength(1);
  });
});
