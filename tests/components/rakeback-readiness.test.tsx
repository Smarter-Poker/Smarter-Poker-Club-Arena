import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRakebackReadiness,
  nextRakebackBoundary,
  rakebackAccountingDay,
} from '@/utils/rakebackReadiness';

const fixture = vi.hoisted(() => ({
  user: { id: 'player-1' },
  result: { data: [] as Record<string, unknown>[], error: null as unknown },
  deferReads: false,
  pendingReads: [] as (() => void)[],
  limits: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
  lt: vi.fn(),
  emit: vi.fn(),
  toast: { error: vi.fn() },
  refresh: (() => {}) as () => void,
}));

// Only external boundaries are replaced. The page, readiness helper, the shared
// Pacific accounting calendar, the header and the retry owner all run.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      fixture.from(table);
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      let orderColumn = 'period_start';
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          fixture.eq(column, value);
          filters.push((row) => row[column] === value);
          return query;
        },
        gt: (column: string, value: number) => {
          filters.push((row) => Number(row[column]) > value);
          return query;
        },
        lt: (column: string, value: string) => {
          fixture.lt(column, value);
          filters.push((row) => String(row[column]) < value);
          return query;
        },
        not: (column: string, _operator: string, value: unknown) => {
          filters.push((row) => row[column] !== value);
          return query;
        },
        order: (column: string) => {
          orderColumn = column;
          return query;
        },
        limit: (count: number) => {
          fixture.limits(count);
          const result = {
            data: fixture.result.data
              .filter((row) => filters.every((filter) => filter(row)))
              .sort((a, b) => String(b[orderColumn]).localeCompare(String(a[orderColumn])))
              .slice(0, count)
              .map((row) => ({ ...row })),
            error: fixture.result.error,
          };
          return fixture.deferReads
            ? new Promise((resolve) => fixture.pendingReads.push(() => resolve(result)))
            : Promise.resolve(result);
        },
      };
      return query;
    },
    rpc: (...args: unknown[]) => fixture.rpc(...args),
  },
}));
vi.mock('@/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: fixture.user }) }));
vi.mock('@/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('@/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: (refresh: () => void) => {
    fixture.refresh = refresh;
  },
}));
vi.mock('@/components/common/Toast', () => ({ useToast: () => fixture.toast }));
vi.mock('@/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: () => () => {},
    emit: (...args: unknown[]) => fixture.emit(...args),
  },
}));
// Charts are unrelated to readiness and need a measured browser layout.
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null,
  BarChart: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

import RakebackPage from '@/pages/RakebackPage';

function period(id: string, club: string | null, end: string, earned: number, status = 'pending') {
  return {
    id,
    user_id: 'player-1',
    club_id: club,
    period_start: end,
    period_end: end,
    rake_generated: earned * 10,
    rakeback_rate: 0.1,
    rakeback_earned: earned,
    status,
  };
}
async function openPage(rows: Record<string, unknown>[]) {
  fixture.result = { data: rows, error: null };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <MemoryRouter>
        <RakebackPage />
      </MemoryRouter>
    );
  });
  return view;
}
function readyValue() {
  const summary = screen.getByLabelText('Rakeback Engine Live Summary');
  return within(summary).getByText('Next Ready Period').parentElement!.querySelector('dd')!
    .textContent;
}
function rerenderPage(view: ReturnType<typeof render>) {
  view.rerender(
    <MemoryRouter>
      <RakebackPage />
    </MemoryRouter>
  );
}
async function resolveReads() {
  const reads = fixture.pendingReads.splice(0);
  await act(async () => {
    reads.forEach((resolve) => resolve());
  });
}

// Sunday 2026-09-20 closes at Pacific midnight starting Monday 2026-09-21,
// which is 07:00Z. The retired UTC rule closed it at 2026-09-21T00:00:00Z.
const PACIFIC_CLOSE = '2026-09-21T07:00:00.000Z';
const SEVEN_HOURS_EARLY = '2026-09-21T00:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
  vi.clearAllMocks();
  fixture.user = { id: 'player-1' };
  fixture.deferReads = false;
  fixture.pendingReads = [];
  fixture.rpc.mockResolvedValue({
    data: { success: true, total_payout: 0, periods_claimed: 0 },
    error: null,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('rakeback readiness closes on the Pacific accounting calendar', () => {
  const sunday = [
    { id: 'p', club_id: 'club-1', period_end: '2026-09-20', rakeback_earned: 9, status: 'pending' },
  ];

  it('is still pending at 17:00 PDT Sunday, seven hours before the Pacific close', () => {
    const readiness = getRakebackReadiness(sunday, Date.parse(SEVEN_HOURS_EARLY));
    expect(readiness.readyAmount).toBe(0);
    expect(readiness.pendingAmount).toBe(9);
    expect(readiness.targetClubId).toBeNull();
    expect(readiness.readyPeriodIds.size).toBe(0);
    expect(readiness.nextChangeAt).toBe(Date.parse(PACIFIC_CLOSE));
  });

  it('is still pending one millisecond before the Pacific close', () => {
    expect(getRakebackReadiness(sunday, Date.parse(PACIFIC_CLOSE) - 1).readyAmount).toBe(0);
  });

  it('becomes ready exactly at Pacific midnight starting Monday', () => {
    const readiness = getRakebackReadiness(sunday, Date.parse(PACIFIC_CLOSE));
    expect(readiness.readyAmount).toBe(9);
    expect(readiness.pendingAmount).toBe(0);
    expect(readiness.targetClubId).toBe('club-1');
    expect(readiness.nextChangeAt).toBeNull();
  });

  // The 167 and 169-hour DST weeks. `accountingWeekEndingOn` already pins these
  // exact instants, so agreeing with it proves ONE Pacific calendar, not two.
  it.each([
    ['167-hour week ending Sunday', '2026-03-08', '2026-03-09', '2026-03-09T07:00:00.000Z'],
    ['169-hour week ending Sunday', '2026-11-01', '2026-11-02', '2026-11-02T08:00:00.000Z'],
  ])('%s closes with the accounting week, not at UTC midnight', (_name, end, monday, close) => {
    const rows = [
      { id: 'dst', club_id: 'club-dst', period_end: end, rakeback_earned: 5, status: 'pending' },
    ];
    // tests/unit/AccountingObservationService.test.ts pins these same instants
    // to accountingWeekEndingOn, so the two readers cannot drift apart.
    expect(getRakebackReadiness(rows, Date.parse(close) - 1).readyAmount).toBe(0);
    expect(getRakebackReadiness(rows, Date.parse(close)).readyAmount).toBe(5);
    // UTC midnight of the following day is the instant the retired rule used.
    expect(Date.parse(`${monday}T00:00:00.000Z`)).toBeLessThan(Date.parse(close));
    expect(getRakebackReadiness(rows, Date.parse(`${monday}T00:00:00.000Z`)).readyAmount).toBe(0);
  });

  it.each([
    ['2026-02-30', 'impossible calendar day'],
    ['unknown', 'not a date'],
    ['2026-09-10T00:00:00Z', 'an instant rather than a DATE'],
    ['0000-01-02', 'a zero year'],
  ])('never converts %s into eligibility (%s)', (end) => {
    const rows = [
      { id: 'bad', club_id: 'club-bad', period_end: end, rakeback_earned: 4, status: 'pending' },
    ];
    const readiness = getRakebackReadiness(rows, Date.parse('2030-01-01T00:00:00.000Z'));
    expect(readiness.readyAmount).toBe(0);
    expect(readiness.pendingAmount).toBe(4);
    expect(readiness.targetClubId).toBeNull();
    expect(readiness.nextChangeAt).toBeNull();
  });

  it('names the Pacific accounting day and its close, not the UTC ones', () => {
    // 2026-09-21T02:00Z is still Sunday 19:00 in Pacific time.
    expect(rakebackAccountingDay(Date.parse('2026-09-21T02:00:00.000Z'))).toBe('2026-09-20');
    expect(nextRakebackBoundary(Date.parse('2026-09-21T02:00:00.000Z'))).toBe(
      Date.parse(PACIFIC_CLOSE)
    );
    expect(rakebackAccountingDay(Date.parse(PACIFIC_CLOSE))).toBe('2026-09-21');
  });
});

describe('RakebackPage presents automatic weekly settlement, never a claim', () => {
  it('offers no claim action and calls no retired claim RPC for a ready period', async () => {
    const view = await openPage([period('ready', 'club-ready', '2026-09-08', 20)]);
    expect(readyValue()).toBe('20');
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
    expect(view.container.querySelector('.claim-btn')).toBeNull();
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(view.container.querySelector('.period-earned .status')).toHaveTextContent(
      'Ready To Settle'
    );
  });

  it('tells the player when the money actually moves', async () => {
    await openPage([period('ready', 'club-ready', '2026-09-08', 20)]);
    expect(
      screen.getByText('Settled Automatically Every Monday At 4:00 AM Central Time.')
    ).toBeInTheDocument();
    const info = screen.getByText('How Rakeback Works').closest('.rakeback-info') as HTMLElement;
    expect(
      within(info).getByText(/Earning Periods Close At Midnight Pacific Time/)
    ).toBeInTheDocument();
    expect(
      within(info).getByText(/Rakeback Is Settled Automatically Every Monday At 4:00 AM Central/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/00:00 UTC/)).toBeNull();
    expect(screen.queryByText(/Claims Are Processed One Club At A Time/)).toBeNull();
    expect(screen.queryByText(/A Club Claim May Include More Periods/)).toBeNull();
  });

  it('never calls any RPC at all, for any mix of ready, open, paid and hidden rows', async () => {
    const rows = [
      period('open', 'club-open', '2026-09-11', 30),
      period('zero', 'club-zero', '2026-09-08', 0),
      period('missing-club', null, '2026-09-08', 5),
      period('ready', 'club-ready', '2026-09-08', 20),
      period('other-ready', 'club-other', '2026-09-07', 10),
      period('paid', 'club-paid', '2026-09-06', 7, 'paid'),
    ];
    const view = await openPage(rows);
    expect(readyValue()).toBe('20');
    expect(screen.getByText('Recent Pending Earnings: 65')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(6);
    expect(view.container.querySelectorAll('.period-earned .status.paid')).toHaveLength(1);
    expect(fixture.rpc).not.toHaveBeenCalled();
    expect(fixture.emit).not.toHaveBeenCalled();
  });

  it('discovers a positive closed club outside the twelve recent history rows', async () => {
    const recent = Array.from({ length: 12 }, (_, i) =>
      period(`recent-${i}`, 'club-recent', '2026-09-11', 2, 'paid')
    );
    const view = await openPage([...recent, period('older', 'club-older', '2026-09-07', 9)]);
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(12);
    expect(readyValue()).toBe('9');
    const summary = screen.getByLabelText('Rakeback Engine Live Summary');
    expect(within(summary).getByText('Recent Earnings').parentElement).toHaveTextContent('24');
    expect(screen.getByText('Recent Pending Earnings: 0')).toBeInTheDocument();
    expect(
      screen.getByText('Estimate For One Period. The Automatic Run May Settle More Periods.')
    ).toBeInTheDocument();
    expect(fixture.limits.mock.calls.map(([n]) => n)).toEqual([12, 1]);
    expect(fixture.rpc).not.toHaveBeenCalled();
  });
});

describe('RakebackPage reads the Pacific accounting boundary', () => {
  it('queries eligibility with the Pacific accounting day, not the UTC one', async () => {
    // Sunday 19:00 PDT. The UTC date has already rolled to the 21st.
    vi.setSystemTime(new Date('2026-09-21T02:00:00.000Z'));
    await openPage([period('sunday', 'club-sunday', '2026-09-20', 9)]);
    expect(fixture.lt).toHaveBeenCalledWith('period_end', '2026-09-20');
    expect(fixture.lt).not.toHaveBeenCalledWith('period_end', '2026-09-21');
    expect(readyValue()).toBe('0');
    expect(screen.getByText('Recent Pending Earnings: 9')).toBeInTheDocument();
  });

  it('does not present the week as ready seven hours before its Pacific close', async () => {
    vi.setSystemTime(new Date(SEVEN_HOURS_EARLY));
    await openPage([period('sunday', 'club-sunday', '2026-09-20', 9)]);
    expect(readyValue()).toBe('0');
    expect(screen.getByText('Recent Pending Earnings: 9')).toBeInTheDocument();
  });

  it('becomes ready at the Pacific close while the page stays open', async () => {
    vi.setSystemTime(new Date(Date.parse(PACIFIC_CLOSE) - 1));
    const view = await openPage([period('sunday', 'club-sunday', '2026-09-20', 9)]);
    expect(readyValue()).toBe('0');
    expect(fixture.from).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(readyValue()).toBe('9');
    expect(fixture.from).toHaveBeenCalledTimes(4);
    expect(fixture.lt).toHaveBeenLastCalledWith('period_end', '2026-09-21');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wake at UTC midnight, which is no longer a boundary', async () => {
    vi.setSystemTime(new Date('2026-09-20T23:59:59.999Z'));
    await openPage([period('sunday', 'club-sunday', '2026-09-20', 9)]);
    expect(fixture.from).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(fixture.from).toHaveBeenCalledTimes(2);
    expect(readyValue()).toBe('0');
  });
});

describe('RakebackPage retains its loading, empty, error and account states', () => {
  it('shows the financial skeleton until the first read resolves', async () => {
    fixture.deferReads = true;
    const view = await openPage([period('closed', 'club-closed', '2026-09-08', 9)]);
    expect(view.container.querySelector('.loading-state')).not.toBeNull();
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(0);
    fixture.deferReads = false;
    await resolveReads();
    expect(view.container.querySelector('.loading-state')).toBeNull();
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(1);
  });

  it('shows the empty state with no history and no claim offer', async () => {
    await openPage([]);
    expect(
      screen.getByText('No Rakeback History Yet. Play Some Hands To Earn Rakeback!')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
    const summary = screen.getByLabelText('Rakeback Engine Live Summary');
    expect(within(summary).getByText('Latest Period Rate').parentElement).toHaveTextContent(
      'Unavailable'
    );
  });

  it('reports a failed refresh and retries it without offering a claim', async () => {
    const view = await openPage([period('closed', 'club-closed', '2026-09-08', 9)]);
    fixture.result = { data: [], error: { message: 'read unavailable' } };
    await act(async () => {
      fixture.refresh();
    });
    expect(
      screen.getByText('Rakeback Data Could Not Be Refreshed. Please Try Again.')
    ).toBeInTheDocument();
    expect(fixture.toast.error).toHaveBeenCalledWith('Failed To Load Rakeback Data.');
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull();
    fixture.result = { data: [period('closed', 'club-closed', '2026-09-08', 9)], error: null };
    await act(async () => {
      fixture.refresh();
    });
    expect(view.container.querySelectorAll('.period-row')).toHaveLength(1);
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it('queues the new account read and discards the old account snapshot', async () => {
    fixture.deferReads = true;
    const view = await openPage([period('old', 'club-old', '2026-09-08', 99)]);
    fixture.user = { id: 'player-2' };
    fixture.result = {
      data: [{ ...period('new', 'club-new', '2026-09-08', 7), user_id: 'player-2' }],
      error: null,
    };
    await act(async () => {
      rerenderPage(view);
    });
    expect(readyValue()).toBe('0');
    fixture.deferReads = false;
    await resolveReads();
    expect(readyValue()).toBe('7');
    expect(fixture.from).toHaveBeenCalledTimes(4);
    expect(fixture.eq).toHaveBeenCalledWith('user_id', 'player-2');
    expect(fixture.rpc).not.toHaveBeenCalled();
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 0])(
    'labels the latest period rate accurately for %s',
    async (rate) => {
      await openPage([{ ...period('rate', 'club', '2026-09-08', 0), rakeback_rate: rate }]);
      const summary = screen.getByLabelText('Rakeback Engine Live Summary');
      expect(within(summary).getByText('Latest Period Rate').parentElement).toHaveTextContent(
        rate === 0 ? '0.0%' : 'Unavailable'
      );
      expect(screen.queryByText('Your Rate')).toBeNull();
    }
  );
});
