/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CLUB DASHBOARD PAINTS THE FLOOR IT WAS TOLD ABOUT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04, phase 4)
 *
 * The page had unit tests for its pure helpers and none that mounted it, which
 * is how a Tables tab could say "319 Live" over 50 rows for months. This
 * mounts it with the RPC answers stubbed and asserts what an operator reads:
 * the header comes from ca_club_tables' floor-wide figures, the sort goes to
 * the server, the Revenue tab exists only for a finance role, the insurance
 * cards appear only when a policy was sold, and the horse toggle appears only
 * when the viewer can see the flag.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_SLUG = 'deep-stack-society-11192';
const CLUB_UUID = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const OWNER_ID = '47965354-0e56-43ef-931c-ddaab82af765';

const rpcMock = vi.hoisted(() => vi.fn());
const fromMock = vi.hoisted(() => vi.fn());
const resolveMock = vi.hoisted(() => vi.fn());
const toastState = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const authState = vi.hoisted(() => ({
  user: { id: '47965354-0e56-43ef-931c-ddaab82af765' } as { id: string } | null,
}));
const tableState = vi.hoisted(() => ({
  clubs: { owner_id: '47965354-0e56-43ef-931c-ddaab82af765' },
  club_members: { role: 'owner' } as { role: string } | null,
}));
const searchState = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useParams: () => ({ clubId: CLUB_SLUG }),
  useSearchParams: () => [searchState.params, vi.fn()],
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: authState.user, isHydrating: false }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (...args: unknown[]) => resolveMock(...args),
  isUUID: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toastState }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: () => () => undefined,
    subscribeDebounced: () => () => undefined,
  },
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => undefined }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => undefined }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/lazyWithRetry', () => ({
  lazyWithRetry: () => () => <div data-testid="chart" />,
}));
vi.mock('../../src/components/club/ClubActivityFeed', () => ({
  default: () => <div data-testid="activity-feed" />,
}));
const chatProps = vi.hoisted(() => ({ last: null as { clubId: string } | null }));
vi.mock('../../src/components/club/ClubChat', () => ({
  default: (props: { clubId: string }) => {
    chatProps.last = props;
    return null;
  },
}));
vi.mock('../../src/components/admin/ClubMemberManagement', () => ({
  default: () => <div data-testid="member-management" />,
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => <div /> }));

import ClubDashboard from '../../src/pages/club/ClubDashboard';

const STATS = {
  total_members: 417,
  online_now: 250,
  active_tables: 319,
  total_tables: 4884,
  hands_today: 149200,
  rake_today: 55892.01,
  new_this_week: 417,
  hands_week: 474929,
  rake_week: 304458.31,
  seated_now: 243,
  daily_series: [],
};

const table = (i: number, status: string, seated: number) => ({
  id: `table-${status}-${i}`,
  name: `Table ${status} ${i}`,
  game_type: 'cash',
  game_variant: 'nlh',
  stakes: '$0.10/$0.20',
  small_blind: 0.1,
  big_blind: 0.2,
  status,
  current_players: seated,
  max_players: 9,
  created_at: '2026-09-01T00:00:00Z',
  is_deleted: false,
});

// Three rows returned for 319 live tables: the header must read 319, and the
// seat figures must be the floor-wide ones, not a sum over the three.
const TABLES = {
  live: [table(1, 'running', 9), table(2, 'running', 4), table(3, 'waiting', 0)],
  recent: [table(1, 'closed', 0)],
  live_count: 319,
  live_truncated: false,
  total_count: 4884,
  seated_people: 243,
  seat_rows: 479,
};

const player = (i: number, isHorse: boolean) => ({
  user_id: `user-${i}`,
  display_name: `Player ${i}`,
  avatar_url: null,
  is_horse: isHorse,
  hands_played: 100 * i,
  hands_attributed: 90 * i,
  hands_won: 10 * i,
  total_won: 500,
  profit: 100 - i,
  biggest_pot_won: 50,
  win_rate: 10,
});

const REVENUE = {
  range_days: 7,
  totals: { hands: 474929, rake: 304458.31, bbj: 0, pot_total: 1, avg_pot: 1, rake_per_hand: 0.64 },
  insurance: { contracts: 0, premiums: 0, payouts: 0, net: 0, bank: 'club' },
  daily: [],
  by_table: [],
};

const TOURNAMENTS = {
  live: [],
  recent: [
    {
      id: 't-1',
      name: 'Nightly Turbo',
      status: 'completed',
      variant: 'nlh',
      buy_in: 5,
      prize_pool: 120,
      players: 24,
      ended_at: '2026-09-04T01:00:00Z',
    },
  ],
  summary: {
    live_count: 0,
    window_days: 7,
    completed_in_window: 3534,
    prize_pool_in_window: 185161.85,
  },
};

function stubRpc(overrides: Record<string, unknown> = {}) {
  rpcMock.mockImplementation((name: string) => {
    if (name in overrides) return Promise.resolve(overrides[name]);
    if (name === 'ca_club_dashboard_stats') return Promise.resolve({ data: STATS, error: null });
    if (name === 'ca_club_tables') return Promise.resolve({ data: TABLES, error: null });
    if (name === 'ca_club_top_players')
      return Promise.resolve({ data: [player(1, true), player(2, false)], error: null });
    if (name === 'ca_club_revenue') return Promise.resolve({ data: REVENUE, error: null });
    if (name === 'ca_club_tournaments') return Promise.resolve({ data: TOURNAMENTS, error: null });
    if (name === 'ca_club_members') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
  resolveMock.mockReset();
  localStorage.clear();
  authState.user = { id: OWNER_ID };
  tableState.clubs = { owner_id: OWNER_ID };
  tableState.club_members = { role: 'owner' };
  searchState.params = new URLSearchParams();
  resolveMock.mockResolvedValue(CLUB_UUID);
  stubRpc();
  fromMock.mockImplementation((tableName: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
      chain[method] = () => chain;
    }
    chain.maybeSingle = () => {
      if (tableName === 'clubs') {
        return Promise.resolve({
          data: { id: CLUB_UUID, name: 'Deep Stack Society', ...tableState.clubs },
          error: null,
        });
      }
      if (tableName === 'club_members') {
        return Promise.resolve({ data: tableState.club_members, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
    return chain;
  });
});

const rpcArgs = (name: string) =>
  rpcMock.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);

async function mountAndOpen(tab?: string) {
  render(<ClubDashboard />);
  await waitFor(() => expect(screen.getByText('Deep Stack Society')).toBeTruthy());
  if (tab) {
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
    });
  }
}

describe('the tables tab', () => {
  it('reads the floor through ca_club_tables and never the raw tables table', async () => {
    await mountAndOpen();
    expect(rpcArgs('ca_club_tables')).toEqual([{ p_club_id: CLUB_UUID, p_limit: 500 }]);
    expect(fromMock.mock.calls.map((c) => c[0])).not.toContain('tables');
  });

  it('paints the header from the floor-wide count, not from the rows on screen', async () => {
    await mountAndOpen('Tables');
    // 319 live over 3 rows, 243 people over 479 seats.
    const header = screen.getByText(/Club Tables \(4,884\)/).parentElement!;
    expect(header.textContent).toContain('319 Live');
    expect(header.textContent).toContain('243 People Seated');
    expect(header.textContent).toContain('(479 Seats)');
    expect(screen.getByText('Live Now (319)')).toBeTruthy();
    expect(screen.getByText('Recently Closed (1)')).toBeTruthy();
    expect(screen.getByText('Table running 1')).toBeTruthy();
    expect(screen.getByText('Table closed 1')).toBeTruthy();
  });

  it('says when the live list was capped', async () => {
    stubRpc({
      ca_club_tables: { data: { ...TABLES, live_count: 700, live_truncated: true }, error: null },
    });
    await mountAndOpen('Tables');
    expect(screen.getByText(/Showing The Fullest 3/)).toBeTruthy();
  });
});

describe('the leaderboard', () => {
  it('sends the sort key to the server and re-reads when it changes', async () => {
    await mountAndOpen();
    expect(rpcArgs('ca_club_top_players').at(-1)).toMatchObject({ p_sort: 'profit', p_limit: 100 });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Sort Leaderboard'), { target: { value: 'hands' } });
    });
    await waitFor(() =>
      expect(rpcArgs('ca_club_top_players').at(-1)).toMatchObject({ p_sort: 'hands' })
    );
  });

  it('offers the horse toggle only when the viewer can see the flag', async () => {
    await mountAndOpen();
    expect(screen.getByLabelText('Hide Horses')).toBeTruthy();
    expect(localStorage.getItem('ca_dashboard_hide_horses')).toBeNull();
  });

  it('hides the toggle when every row reads false, because it could do nothing', async () => {
    stubRpc({ ca_club_top_players: { data: [player(1, false), player(2, false)], error: null } });
    await mountAndOpen();
    expect(screen.queryByLabelText('Hide Horses')).toBeNull();
  });

  it('relabels the scoped figures while the filter is on, and forgets it on the next visit', async () => {
    await mountAndOpen();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Hide Horses'));
    });
    expect(screen.getByText(/Person-Hands \(Horses Hidden\)/)).toBeTruthy();
    expect(localStorage.getItem('ca_dashboard_hide_horses')).toBeNull();
  });
});

describe('the revenue tab', () => {
  it('is offered to the owner and reads the window the range selects', async () => {
    await mountAndOpen('Revenue');
    expect(rpcArgs('ca_club_revenue').at(-1)).toEqual({ p_club_id: CLUB_UUID, p_days: 7 });
    expect(screen.getByText('Rake Collected')).toBeTruthy();
  });

  it('is not on the strip for a plain member', async () => {
    tableState.clubs = { owner_id: 'somebody-else' };
    tableState.club_members = { role: 'player' };
    await mountAndOpen();
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Revenue' })).toBeNull());
    expect(screen.getByRole('tab', { name: 'Tournaments' })).toBeTruthy();
  });

  it('is offered to the club owner even without a membership row', async () => {
    tableState.club_members = null;
    await mountAndOpen();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Revenue' })).toBeTruthy());
  });

  it('names the refusal when the server says this role may not look', async () => {
    stubRpc({
      ca_club_revenue: {
        data: null,
        error: { code: '42501', message: 'not authorized for this club' },
      },
    });
    await mountAndOpen('Revenue');
    await waitFor(() =>
      expect(
        screen.getByText('Revenue Is Restricted To Club Owners, Admins And Super Agents')
      ).toBeTruthy()
    );
  });

  it('shows no insurance card for a club that has never sold a policy', async () => {
    await mountAndOpen('Revenue');
    await waitFor(() => expect(screen.getByText('Rake Collected')).toBeTruthy());
    expect(screen.queryByText(/Insurance Net/)).toBeNull();
    expect(screen.queryByText('View Full Insurance Report')).toBeNull();
  });

  it('shows the insurance cards once a contract exists', async () => {
    stubRpc({
      ca_club_revenue: {
        data: {
          ...REVENUE,
          insurance: { contracts: 12, premiums: 40, payouts: 10, net: 30, bank: 'club' },
        },
        error: null,
      },
    });
    await mountAndOpen('Revenue');
    await waitFor(() => expect(screen.getByText('Insurance Net (Club Bank)')).toBeTruthy());
    expect(screen.getByText('View Full Insurance Report')).toBeTruthy();
  });

  it('says Last 90 Days when the range is All, because that is what the server returns', async () => {
    localStorage.setItem('ca_dashboard_range', JSON.stringify('all'));
    await mountAndOpen('Revenue');
    await waitFor(() => expect(screen.getByText('Revenue (Last 90 Days)')).toBeTruthy());
    expect(rpcArgs('ca_club_revenue').at(-1)).toEqual({ p_club_id: CLUB_UUID, p_days: 90 });
  });
});

describe('the tournaments tab', () => {
  it('sends the range and reads the window back from the summary', async () => {
    await mountAndOpen('Tournaments');
    expect(rpcArgs('ca_club_tournaments').at(-1)).toEqual({
      p_club_id: CLUB_UUID,
      p_limit: 25,
      p_days: 7,
    });
    await waitFor(() => expect(screen.getByText(/3,534 Finished In Last 7D/)).toBeTruthy());
    expect(screen.getByText('Recently Finished (Newest 1 Of 3,534)')).toBeTruthy();
  });
});

describe('the club chat', () => {
  it('is handed the resolved uuid, not the route slug', async () => {
    await mountAndOpen();
    await waitFor(() => expect(chatProps.last).not.toBeNull());
    expect(chatProps.last!.clubId).toBe(CLUB_UUID);
  });
});

describe('the metric cards', () => {
  it('are read once per load, not twice', async () => {
    await mountAndOpen();
    expect(rpcArgs('ca_club_dashboard_stats')).toHaveLength(1);
  });

  it('say the read failed rather than holding a skeleton for ever', async () => {
    stubRpc({
      ca_club_dashboard_stats: { data: null, error: { code: 'PGRST301', message: 'boom' } },
    });
    await mountAndOpen();
    await waitFor(() =>
      expect(screen.getByText('The Club Metrics Could Not Be Loaded')).toBeTruthy()
    );
  });
});

describe('a failed tables read', () => {
  it('is named on the tab, not shown as loading', async () => {
    stubRpc({ ca_club_tables: { data: null, error: { code: 'PGRST301', message: 'boom' } } });
    await mountAndOpen('Tables');
    await waitFor(() =>
      expect(screen.getByText('The Table List Could Not Be Loaded')).toBeTruthy()
    );
    expect(screen.queryByText('Loading Tables...')).toBeNull();
  });
});
