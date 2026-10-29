import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Club Data counts America/Chicago days (20261022120121): today is the Chicago date.
const chicagoToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
/** The instant `hhmmss` on the Chicago clock on calendar date `day` (DST aware). */
function chicagoInstant(day: string, hhmmss: string): Date {
  const guess = new Date(`${day}T${hhmmss}Z`);
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (asUtc.getTime() - shown.getTime()));
}

const CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const TEST_END_DATE = chicagoToday();
const testRangeStart = new Date(`${TEST_END_DATE}T00:00:00Z`);
testRangeStart.setUTCDate(testRangeStart.getUTCDate() - 13);
const TEST_START_DATE = testRangeStart.toISOString().slice(0, 10);
const testPreviousEnd = new Date(testRangeStart);
testPreviousEnd.setUTCDate(testPreviousEnd.getUTCDate() - 1);
const testPreviousStart = new Date(testPreviousEnd);
testPreviousStart.setUTCDate(testPreviousStart.getUTCDate() - 13);

const snapshot = {
  range: { start: TEST_START_DATE, end: TEST_END_DATE, days: 14 },
  previous_range: {
    start: testPreviousStart.toISOString().slice(0, 10),
    end: testPreviousEnd.toISOString().slice(0, 10),
    days: 14,
  },
  filters: { game: 'ALL', stakes: 'ALL', search: null },
  summary: {
    games: 1,
    total_winnings: 2450,
    mtt_winnings: 500,
    cash_winnings: 1950,
    fee: 321.5,
    cash_fee: 250,
    mtt_fee: 71.5,
    hands: 900,
  },
  previous: {
    games: 10,
    total_winnings: 2000,
    mtt_winnings: 400,
    cash_winnings: 1600,
    fee: 300,
    hands: 800,
  },
  delta: { fee_pct: 7.2, games_pct: -90, winnings_abs: 450, fee_abs: 21.5 },
  rows: [
    {
      kind: 'CASH',
      id: 'game-1',
      name: 'Shark Table One',
      variant: 'NLH',
      game_class: 'HOLDEM',
      stakes_tier: 'SMALL',
      blinds: '1 / 2',
      rake_percent: 10,
      started_at: '2026-08-30T12:00:00Z',
      status: 'complete',
      creator_id: 'player-1',
      creator_name: 'Dealer One',
      creator_avatar: null,
      fee: 42.5,
      winnings: 120,
      hands: 80,
      players: 6,
    },
  ],
  row_count: 1,
  union_id: 'union-1',
  data_updated_at: '2026-08-30T12:05:00Z',
  generated_at: '2026-08-30T12:05:02Z',
};

const zeroSnapshot = {
  ...snapshot,
  summary: {
    games: 0,
    total_winnings: 0,
    mtt_winnings: 0,
    cash_winnings: 0,
    fee: 0,
    cash_fee: 0,
    mtt_fee: 0,
    hands: 0,
  },
  previous: {
    games: 0,
    total_winnings: 0,
    mtt_winnings: 0,
    cash_winnings: 0,
    fee: 0,
    cash_fee: 0,
    mtt_fee: 0,
    hands: 0,
  },
  delta: { fee_pct: null, games_pct: null, winnings_abs: 0, fee_abs: 0 },
  rows: [],
  row_count: 0,
};

const playerBreakdown = {
  range: snapshot.range,
  rake_complete_through: '2026-08-29',
  totals: { players: 1, net: 120, rake: 42.5, hands: 80 },
  players: [
    {
      user_id: 'player-1',
      username: 'Table Regular',
      avatar_url: null,
      is_horse: true,
      net: 120,
      cash_net: 120,
      tournament_net: 0,
      rake: 42.5,
      hands: 80,
    },
  ],
  player_count: 1,
  generated_at: '2026-08-30T12:05:02Z',
};

const gamePage = {
  sort: 'recent',
  rows: snapshot.rows,
  next_cursor: null,
  has_more: false,
  filtered_count: snapshot.row_count,
  generated_at: snapshot.generated_at,
};

const playerPage = {
  sort: 'winners',
  rows: playerBreakdown.players,
  next_cursor: null,
  has_more: false,
  filtered_count: playerBreakdown.player_count,
  generated_at: playerBreakdown.generated_at,
};

function gamePageFor(args: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    ...gamePage,
    sort: args.p_sort ?? 'recent',
    contract: 'ca_club_game_page.v2',
    contract_version: 2,
    club_id: args.p_club_id ?? CLUB_ID,
    requested_start: args.p_start ?? TEST_START_DATE,
    requested_end: args.p_end ?? TEST_END_DATE,
    requested_game: args.p_game ?? 'ALL',
    requested_stakes: args.p_stakes ?? 'ALL',
    requested_search: args.p_search ?? null,
    requested_sort: args.p_sort ?? 'recent',
    requested_cursor: args.p_cursor ?? null,
    requested_limit: args.p_limit ?? 100,
    ...overrides,
  };
}

function playerPageFor(
  args: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
) {
  return {
    ...playerPage,
    sort: args.p_sort ?? 'winners',
    contract: 'ca_club_player_page.v2',
    contract_version: 2,
    club_id: args.p_club_id ?? CLUB_ID,
    requested_start: args.p_start ?? TEST_START_DATE,
    requested_end: args.p_end ?? TEST_END_DATE,
    requested_sort: args.p_sort ?? 'winners',
    requested_search: args.p_search ?? null,
    requested_cursor: args.p_cursor ?? null,
    requested_limit: args.p_limit ?? 100,
    ...overrides,
  };
}

function snapshotWithRows(rows: typeof snapshot.rows, rowCount: number) {
  return {
    ...snapshot,
    summary: { ...snapshot.summary, games: rowCount },
    delta: {
      ...snapshot.delta,
      games_pct:
        Math.round(((rowCount - snapshot.previous.games) / snapshot.previous.games) * 1000) / 10,
    },
    rows,
    row_count: rowCount,
  };
}

function playerBreakdownWithRows(rows: typeof playerBreakdown.players, playerCount: number) {
  return {
    ...playerBreakdown,
    totals: { ...playerBreakdown.totals, players: playerCount },
    players: rows,
    player_count: playerCount,
  };
}

const latestInvoice = {
  invoice_id: 'invoice-1',
  status: 'awaiting_payment',
  overdue: false,
  paid_total: 0,
  outstanding: 350,
  issued_at: '2026-08-30T09:00:00Z',
  due_at: '2026-09-02T09:00:00Z',
  amount: 350,
  direction: 'club owes union',
  period_start: '2026-08-23',
  period_end: '2026-08-29',
  breakdown: { rake_generated: 500, rakeback_due: 150, union_fee_kept: 350 },
  message_sent: true,
};

const authState = vi.hoisted(() => ({
  current: { user: { id: 'owner-1' } as { id: string } | null, isHydrating: false },
}));

const routeState = vi.hoisted(() => ({ clubId: 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4' }));
const rpcMock = vi.hoisted(() => vi.fn());
const fromMock = vi.hoisted(() => vi.fn());
const downloadMock = vi.hoisted(() => vi.fn(() => true));
const realtimeState = vi.hoisted(() => ({
  channels: [] as Array<Record<string, any>>,
  busHandler: null as ((payload: unknown) => void) | null,
  busEvents: [] as string[],
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => authState.current,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ clubId: routeState.clubId }),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

vi.mock('../../src/utils/downloadCsv', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/downloadCsv')>(
    '../../src/utils/downloadCsv'
  );
  return { ...actual, downloadCsv: downloadMock };
});

vi.mock('../../src/hooks/useMasterBusChannel', () => ({
  useMasterBusChannel: (options: Record<string, any>) => realtimeState.channels.push(options),
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: (events: string[], handler: (payload: unknown) => void) => {
    realtimeState.busEvents = events;
    realtimeState.busHandler = handler;
  },
}));

/**
 * The rake snapshot panel is stubbed here, and the reason is worth writing down
 * because the failure was confusing.
 *
 * This file's bus mock keeps ONE handler:  realtimeState.busHandler = handler.
 * The panel subscribes to the same events as the page, so the moment it gained
 * a subscription the panel's handler replaced the page's, and firing
 * busHandler exercised the panel while asserting on the page. Two tests began
 * failing with "expected 1 to be 2" - the page had simply never been told.
 *
 * Nothing was wrong in production: the real bus fans out to every subscriber
 * and both components refresh. The single-handler double could not represent a
 * second subscriber, and this file is about the LEDGER, not the panel, which
 * has its own tests. Stubbing it keeps the subject of these assertions the
 * thing they are named after - and removes the panel's unmocked RPC from the
 * stderr of every test in the file.
 */
vi.mock('../../src/components/club/RakeSnapshotPanel', () => ({
  default: () => null,
}));

import ClubDataPage from '../../src/pages/club/ClubDataPage';
import {
  CLUB_DATA_CACHE_PREFIX,
  clubDataQueryKey,
  writeClubDataCache,
} from '../../src/lib/clubDataCache';

afterEach(() => cleanup());

beforeEach(() => {
  authState.current = { user: { id: 'owner-1' }, isHydrating: false };
  routeState.clubId = CLUB_ID;
  rpcMock.mockReset();
  downloadMock.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  realtimeState.channels = [];
  realtimeState.busHandler = null;
  realtimeState.busEvents = [];
  rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
    if (fn === 'ca_club_data_snapshot_v2') return { data: snapshot, error: null };
    if (fn === 'ca_club_game_page') {
      return { data: gamePageFor(args), error: null };
    }
    if (fn === 'ca_club_player_breakdown') return { data: playerBreakdown, error: null };
    if (fn === 'ca_club_player_page') {
      return { data: playerPageFor(args), error: null };
    }
    if (fn === 'ca_club_union_invoices') return { data: [], error: null };
    return { data: null, error: null };
  });
  fromMock.mockReset();
  fromMock.mockImplementation(() => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { name: 'Shark Club' }, error: null }) }),
    }),
  }));
});

describe('Simple Club Data', () => {
  it.each([false, true])(
    'refresh reconnects only failed live feeds (Advanced=%s)',
    async (advanced) => {
      render(<ClubDataPage />);
      await screen.findByText('Shark Table One');
      if (advanced) fireEvent.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
      const latest = () => realtimeState.channels.slice(-4);
      act(() => latest().forEach((config) => config.onSubscriptionStatus('SUBSCRIBED')));
      act(() =>
        latest()
          .find((config) => config.table === 'tables')
          ?.onSubscriptionStatus('TIMED_OUT')
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: advanced ? 'Refresh Club Ledger' : 'Refresh Simple Club Data',
          exact: true,
        })
      );
      expect(latest().find((config) => config.table === 'tables')?.restartKey).toBe(1);
      expect(
        latest()
          .filter((config) => config.table !== 'tables')
          .map((config) => config.restartKey ?? 0)
      ).toEqual([0, 0, 0]);
      await waitFor(() =>
        expect(
          screen.getByRole('button', {
            name: advanced ? 'Refresh Club Ledger' : 'Refresh Simple Club Data',
            exact: true,
          })
        ).toBeEnabled()
      );
      act(() =>
        latest()
          .find((config) => config.table === 'tables')
          ?.onSubscriptionStatus('SUBSCRIBED')
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: advanced ? 'Refresh Club Ledger' : 'Refresh Simple Club Data',
          exact: true,
        })
      );
      expect(latest().find((config) => config.table === 'tables')?.restartKey).toBe(1);
    }
  );
  it('defaults to Simple and restores all Advanced tools without resetting verified rows', async () => {
    render(<ClubDataPage />);
    await screen.findByText('Shark Table One');
    const page = document.querySelector('[data-page="club-data"]');

    expect(page).toHaveAttribute('data-club-data-mode', 'simple');
    expect(screen.getByRole('button', { name: 'Simple', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByRole('heading', { name: 'Data Integrity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Players' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search Games' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Date Range' }).querySelectorAll('button')
    ).toHaveLength(3);
    const calls = rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot_v2').length;
    fireEvent.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
    expect(page).toHaveAttribute('data-club-data-mode', 'advanced');
    expect(screen.getByRole('heading', { name: 'Data Integrity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Players' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Date Range' }).querySelectorAll('button')
    ).toHaveLength(5);
    expect(screen.getByText('Shark Table One')).toBeInTheDocument();
    expect(rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot_v2')).toHaveLength(
      calls
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Players' }));
    await screen.findByText('Table Regular');
    fireEvent.click(screen.getByRole('button', { name: 'Simple', exact: true }));
    expect(screen.getByText('Shark Table One')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Players' })).not.toBeInTheDocument();
  });
  it('routes the calendar and simple game/stakes controls into the authoritative query', async () => {
    render(<ClubDataPage />);
    await screen.findByText('Shark Table One');
    const calendar = screen.getByLabelText('Period Ending (Chicago Time)');
    const callsBefore = rpcMock.mock.calls.length;
    fireEvent.change(calendar, { target: { value: '2999-12-31' } });
    expect(calendar).toHaveValue(TEST_END_DATE);
    expect(rpcMock.mock.calls).toHaveLength(callsBefore);
    fireEvent.change(calendar, { target: { value: '' } });
    expect(calendar).toHaveValue(TEST_END_DATE);
    fireEvent.change(calendar, { target: { value: '2026-08-15' } });
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        'ca_club_data_snapshot_v2',
        expect.objectContaining({ p_end: '2026-08-15' })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Omaha', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Micro', exact: true }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        'ca_club_data_snapshot_v2',
        expect.objectContaining({ p_game: 'OMAHA', p_stakes: 'MICRO' })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Micro', exact: true }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        'ca_club_data_snapshot_v2',
        expect.objectContaining({ p_game: 'OMAHA', p_stakes: 'ALL' })
      )
    );
  });
});

for (const advanced of [false, true]) {
  for (const scope of ['account', 'club']) {
    it(`keeps refresh ownership across ${scope} changes in ${advanced ? 'Advanced' : 'Simple'}`, async () => {
      const view = render(<ClubDataPage />);
      await screen.findByText('Shark Table One');
      if (advanced) fireEvent.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
      const refresh = () =>
        screen.getByRole('button', {
          name: advanced ? 'Refresh Club Ledger' : 'Refresh Simple Club Data',
        });
      let resolveOld!: (result: any) => void;
      let resolveNew!: (result: any) => void;
      let incomingCalls = 0;
      rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'ca_club_data_snapshot_v2') {
          if (authState.current.user?.id === 'owner-1' && routeState.clubId === CLUB_ID)
            return await new Promise((resolve) => {
              resolveOld = resolve;
            });
          incomingCalls++;
          if (incomingCalls === 2)
            return await new Promise((resolve) => {
              resolveNew = resolve;
            });
          return { data: snapshot, error: null };
        }
        if (fn === 'ca_club_game_page') return { data: gamePageFor(args), error: null };
        if (fn === 'ca_club_union_invoices') return { data: [], error: null };
        return { data: null, error: null };
      });
      fireEvent.click(refresh());
      await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
      if (scope === 'account') authState.current = { user: { id: 'owner-2' }, isHydrating: false };
      else routeState.clubId = 'b52545cc-9e1d-411b-9f1e-f9c4e76bf0e5';
      view.rerender(<ClubDataPage />);
      await screen.findByText('Shark Table One');
      fireEvent.click(refresh());
      await waitFor(() => expect(resolveNew).toBeTypeOf('function'));
      await act(async () => {
        resolveOld({ data: snapshot, error: null });
      });
      expect(refresh()).toBeDisabled();
      expect(refresh()).toHaveTextContent('Refreshing');
      expect(screen.queryByText('Club Ledger Refreshed.')).not.toBeInTheDocument();
      await act(async () => {
        resolveNew({ data: snapshot, error: null });
      });
      await waitFor(() => expect(refresh()).toBeEnabled());
      expect(screen.getAllByText('Club Ledger Refreshed.').length).toBeGreaterThan(0);
    });
  }
}

for (const historical of [false, true]) {
  it(`rolls the current Chicago day at midnight while preserving ${historical ? 'historical' : 'current'} intent`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(chicagoInstant(TEST_END_DATE, '23:59:50'));
    try {
      render(<ClubDataPage />);
      await screen.findByText('Shark Table One');
      const calendar = screen.getByLabelText('Period Ending (Chicago Time)');
      const chosen = historical ? TEST_START_DATE : TEST_END_DATE;
      if (historical) fireEvent.change(calendar, { target: { value: chosen } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      const tomorrow = new Date(`${TEST_END_DATE}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const expected = historical ? chosen : tomorrow.toISOString().slice(0, 10);
      expect(calendar).toHaveValue(expected);
      expect(rpcMock).toHaveBeenCalledWith(
        'ca_club_data_snapshot_v2',
        expect.objectContaining({ p_end: expected })
      );
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
}

for (const advanced of [false, true]) {
  it(`never relabels the outgoing game's money during an uncached query in ${advanced ? 'Advanced' : 'Simple'}`, async () => {
    render(<ClubDataPage />);
    await screen.findByText('Shark Table One');
    if (advanced) fireEvent.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
    let resolveQuery!: (result: any) => void;
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_club_data_snapshot_v2')
        return await new Promise((resolve) => {
          resolveQuery = resolve;
        });
      return { data: null, error: null };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Omaha', exact: true }));
    await waitFor(() => expect(resolveQuery).toBeTypeOf('function'));
    expect(screen.queryByText('Shark Table One')).not.toBeInTheDocument();
    expect(screen.getByText('Finding Matching Games')).toBeInTheDocument();
    expect(screen.queryByText('0 Matching Games')).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Club Performance Summary')).queryByText('2.4K')
    ).not.toBeInTheDocument();
    await act(async () => {
      resolveQuery({ data: null, error: null });
    });
    expect(screen.queryByText('Shark Table One')).not.toBeInTheDocument();
    expect(screen.getByText('Matching Games Unavailable')).toBeInTheDocument();
  });
}

for (const intent of ['calendar', 'previous period']) {
  it(`preserves an explicit ${intent} choice made after midnight before the next poll`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(chicagoInstant(TEST_END_DATE, '23:59:50'));
    try {
      render(<ClubDataPage />);
      await screen.findByText('Shark Table One');
      const tomorrowDay = new Date(`${TEST_END_DATE}T00:00:00Z`);
      tomorrowDay.setUTCDate(tomorrowDay.getUTCDate() + 1);
      const tomorrow = chicagoInstant(tomorrowDay.toISOString().slice(0, 10), '00:00:10');
      vi.setSystemTime(tomorrow);
      const calendar = screen.getByLabelText('Period Ending (Chicago Time)');
      fireEvent.change(calendar, { target: { value: tomorrowDay.toISOString().slice(0, 10) } });
      if (intent === 'calendar') fireEvent.change(calendar, { target: { value: TEST_END_DATE } });
      else {
        fireEvent.click(screen.getByRole('button', { name: '1 Day', exact: true }));
        fireEvent.click(screen.getByRole('button', { name: 'Previous Period' }));
      }
      expect(calendar).toHaveValue(TEST_END_DATE);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(calendar).toHaveValue(TEST_END_DATE);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
}
