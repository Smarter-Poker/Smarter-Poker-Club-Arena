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
  handlers: new Set<(payload: unknown) => void>(),
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

vi.mock('../../src/hooks/useMasterBusSubscription', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useMasterBusSubscriptions: (_events: string[], handler: (payload: unknown) => void) => {
      const latest = useRef(handler);
      latest.current = handler;
      useEffect(() => {
        const forward = (payload: unknown) => latest.current(payload);
        realtimeState.handlers.add(forward);
        return () => {
          realtimeState.handlers.delete(forward);
        };
      }, []);
    },
  };
});

import ClubDataPage from '../../src/pages/club/ClubDataPage';
import {
  CLUB_DATA_CACHE_PREFIX,
  clubDataQueryKey,
  writeClubDataCache,
} from '../../src/lib/clubDataCache';

afterEach(() => cleanup());

beforeEach(() => {
  localStorage.clear();
  authState.current = { user: { id: 'owner-1' }, isHydrating: false };
  routeState.clubId = CLUB_ID;
  rpcMock.mockReset();
  downloadMock.mockClear();
  sessionStorage.clear();
  realtimeState.handlers.clear();
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

import RakeSnapshotPanel from '../../src/components/club/RakeSnapshotPanel';
import { periodToRange } from '../../src/services/ClubRakeSnapshotService';

function rakePayload(name = 'Rake Agent') {
  return {
    scope: 'club',
    scope_label: 'Shark Club',
    club_id: CLUB_ID,
    union_id: null,
    range: { ...periodToRange('month'), days: 13 },
    previous_range: snapshot.previous_range,
    summary: snapshot.summary,
    previous: snapshot.previous,
    delta: snapshot.delta,
    series: [],
    series_bucket: 'day',
    breakdown_kind: 'agent',
    breakdown: [
      {
        agent_user_id: 'agent-1',
        name,
        role: 'agent',
        direct_players: 1,
        direct_active: 1,
        direct_rake: 42,
        direct_hands: 1,
        network_players: 1,
        network_rake: 42,
        sub_agents: 0,
        is_unassigned: false,
      },
    ],
    breakdown_count: 1,
    breakdown_offset: 0,
    breakdown_total: 42,
    applied_search: null,
    applied_sort: 'rake',
    generated_at: new Date().toISOString(),
  };
}
function abortable<T>(promise: Promise<T>, onSignal?: (signal: AbortSignal) => void) {
  return Object.assign(promise, {
    abortSignal(signal: AbortSignal) {
      onSignal?.(signal);
      return this;
    },
  });
}
const rakeCalls = () => rpcMock.mock.calls.filter(([fn]) => fn === 'ca_rake_snapshot_v2');

it('does not amplify failed rake reads through successful ledger invalidations', async () => {
  const ledger = rpcMock.getMockImplementation()!;
  let fail = true;
  rpcMock.mockImplementation((fn: string, args?: Record<string, unknown>) => {
    if (fn === 'ca_rake_snapshot_v2')
      return abortable(
        Promise.resolve(
          fail
            ? {
                data: null,
                error: { code: '57014', message: 'canceling statement due to statement timeout' },
              }
            : { data: rakePayload(), error: null }
        )
      );
    return ledger(fn, args);
  });
  render(<ClubDataPage />);
  await screen.findByText('Shark Table One');
  fireEvent.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
  await waitFor(() => expect(rakeCalls()).toHaveLength(1));
  await waitFor(() =>
    expect(document.body.textContent).toMatch(/snapshot could not|statement timeout/i)
  );
  for (let index = 0; index < 2; index++) {
    const before = rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot_v2').length;
    await act(async () => {
      for (const handler of realtimeState.handlers) handler({ clubId: CLUB_ID });
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    await waitFor(() =>
      expect(
        rpcMock.mock.calls.filter(([fn]) => fn === 'ca_club_data_snapshot_v2').length
      ).toBeGreaterThan(before)
    );
    expect(rakeCalls()).toHaveLength(1);
  }
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Club Ledger' }));
  await screen.findByText('Rake Agent');
  expect(rakeCalls()).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Day', exact: true }));
  await waitFor(() => expect(rakeCalls()).toHaveLength(3));
});

it('aborts retired reads while preserving the selected reporting period across Simple mode', async () => {
  let finish: ((value: unknown) => void) | undefined;
  let signal: AbortSignal | undefined;
  rpcMock.mockImplementation(() =>
    abortable(
      new Promise((resolve) => {
        finish = resolve;
      }),
      (value) => {
        signal = value;
      }
    )
  );
  const view = render(<RakeSnapshotPanel clubId={CLUB_ID} userId="owner-1" scopes={['club']} />);
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Year', exact: true }));
  await waitFor(() => expect(rakeCalls()).toHaveLength(2));
  const retiredFinish = finish;
  view.rerender(
    <RakeSnapshotPanel active={false} clubId={CLUB_ID} userId="owner-1" scopes={['club']} />
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    retiredFinish?.({ data: rakePayload('Retired Answer'), error: null });
  });
  expect(screen.queryByText('Retired Answer')).not.toBeInTheDocument();
  view.rerender(<RakeSnapshotPanel active clubId={CLUB_ID} userId="owner-1" scopes={['club']} />);
  await waitFor(() => expect(rakeCalls()).toHaveLength(3));
  expect(screen.getByRole('button', { name: 'Year', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

it('issues no hidden rake reads in default Simple mode', async () => {
  const ledger = rpcMock.getMockImplementation()!;
  rpcMock.mockImplementation((fn: string, args?: Record<string, unknown>) =>
    fn === 'ca_rake_snapshot_v2'
      ? abortable(Promise.resolve({ data: rakePayload(), error: null }))
      : ledger(fn, args)
  );
  render(<ClubDataPage />);
  await screen.findByText('Shark Table One');
  expect(rakeCalls()).toHaveLength(0);
});
