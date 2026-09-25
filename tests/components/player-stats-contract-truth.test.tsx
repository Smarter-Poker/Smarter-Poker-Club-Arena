/**
 * THE PLAYER STATS PAGE NEVER STATES WHAT IT COULD NOT READ
 * (Stats contract truth, 2026-09-20).
 *
 * Mounts the real page against the real read shapes and drives the four
 * page-level defects end to end:
 *
 *   1. getRakeStats resolved with ScopedRead.error and the page stored the
 *      zeroed shape (and its `.catch` stored null): the Rake tab said "Rake
 *      Ledger Empty" about a read that never happened.
 *   2. getMyAgentRoles answered a failed read with [], and the Downline Rake
 *      section vanished for a real agent.
 *   3. The hero printed a rate over an empty sample as a result: a red "0%"
 *      hands-won ring with no hands, "0.00" BB/100 with no cash hands.
 *   5. The hero printed the all-time hand count under a plain label on a
 *      range-scoped page.
 *
 * Each failure must be reported under the page's own context, render the
 * designed "Readout Unavailable" state rather than the empty one, and clear
 * on a Try Again that genuinely refetches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

const EMPTY_OVERALL = {
  pfr: 0,
  vpip: 0,
  wtsd: 0,
  hand_cap: 25_000,
  cbet_flop: 0,
  hands_won: 0,
  bb_per_100: 0,
  cash_hands: 0,
  hands_lost: 0,
  total_hands: 0,
  hands_capped: false,
  hours_played: 0,
  last_hand_at: null,
  total_profit: 0,
  first_hand_at: null,
  showdowns_won: 0,
  tourney_hands: 0,
  total_invested: 0,
  total_winnings: 0,
  biggest_pot_won: 0,
  showdowns_total: 0,
  aggression_factor: 0,
  biggest_hand_loss: 0,
  fold_to_three_bet: 0,
  three_bet_percent: 0,
  tournaments_with_hands: 0,
};

const PLAYED_OVERALL = {
  ...EMPTY_OVERALL,
  total_hands: 2_000,
  cash_hands: 2_000,
  hands_won: 400,
  hands_lost: 1_600,
  vpip: 0.25,
  pfr: 0.18,
  bb_per_100: 4.25,
  showdowns_total: 300,
  showdowns_won: 160,
  aggression_factor: 2.4,
};

const EMPTY_TOURNAMENTS = {
  roi: 0,
  wins: 0,
  cashes: 0,
  entries: 0,
  net_profit: 0,
  best_finish: null,
  itm_percent: 0,
  total_buyins: 0,
  total_winnings: 0,
};

const EMPTY_RAKE = {
  hands: 0,
  raked_hands: 0,
  rake_paid: 0,
  rake_per_100: 0,
  rake_in_bb: 0,
  bb_per_100: 0,
  avg_rake_per_raked_hand: 0,
  first_hand_at: null,
  last_hand_at: null,
  days: null,
};

const AGENT_ROLE = {
  club_id: 'club-1',
  club_name: 'Main Club',
  role: 'agent',
  agent_id: 'agent-1',
  is_overseer: false,
};

let rpcPayload: Record<string, unknown> = {};
let rakeMode: 'ok' | 'error' | 'throw' = 'ok';
let rolesMode: 'none' | 'agent' | 'error' | 'throw' = 'none';

const rpcMock = vi.hoisted(() => vi.fn());
const reportErrorMock = vi.hoisted(() => vi.fn());
const getRakeStats = vi.hoisted(() => vi.fn());
const getMyAgentRoles = vi.hoisted(() => vi.fn());
const toastApi = vi.hoisted(() => ({
  show: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../src/utils/errorReporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/errorReporter')>()),
  reportError: reportErrorMock,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        in: self,
        gte: self,
        order: self,
        limit: self,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      });
      return chain;
    }),
    auth: { getSession: async () => ({ data: { session: null } }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  },
  getAuthUser: async () => null,
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({
    user: { id: 'user-1', username: 'smarterpoker', display_name: 'Smarter Poker' },
    isHydrating: false,
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/stats', search: '', hash: '', state: null, key: 'test' }),
  Link: ({ to, children }: { to: string; children?: unknown }) => <a href={to}>{children}</a>,
}));

vi.mock('../../src/services/AgentRakeService', () => ({
  AgentRakeService: { getMyAgentRoles },
}));

vi.mock('../../src/components/agent/DownlineRakePanel', () => ({
  default: () => <div>Downline Panel Rendered</div>,
}));

vi.mock('../../src/services/StatsFactsService', () => {
  const svc = {
    getEVCurve: vi.fn().mockResolvedValue({
      points: [],
      summary: {
        hands: 0,
        all_in_hands: 0,
        net_bb: 0,
        ev_net_bb: 0,
        luck_bb: 0,
        luck_bb_per_100: 0,
        biggest_suckout: 0,
        biggest_beat: 0,
        capped: false,
      },
      generated_at: '',
    }),
    getHandGrid: vi
      .fn()
      .mockResolvedValue({ cells: [], totals: { hands: 0, classes_seen: 0 }, filters: {} }),
    getClassHands: vi.fn().mockResolvedValue({ hand_class: null, hands: [] }),
    getNemesis: vi.fn().mockResolvedValue({
      nemesis: null,
      target: null,
      worst: [],
      best: [],
      min_hands: 25,
      opponents_qualified: 0,
      generated_at: '',
    }),
    getDistribution: vi.fn().mockResolvedValue({ rows: [] }),
    getRakeStats,
    getHandRakeShare: vi.fn().mockResolvedValue({ found: false }),
  };
  return { __esModule: true, default: svc, StatsFactsService: svc };
});

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => toastApi,
}));

import PlayerStatsPage from '../../src/pages/PlayerStatsPage';
import { clearStatsRangeMemo } from '../../src/lib/statsCache';
import { NOT_YET_MEASURED } from '../../src/pages/stats/format';

function payload(overall: Record<string, unknown>, lifetimeHands: number) {
  return {
    contract_version: 2,
    generated_at: '2026-09-20T12:00:00.000Z',
    scope: { target_user_id: 'user-1', club_id: null, range_days: null, visibility: 'owner' },
    quality: {
      cash_money_source: 'engine_settlement',
      cash_money_exact: true,
      advanced_facts_source: 'ca_hand_player_stat',
      historical_club_breakdown_available: false,
      live_tail_included: false,
    },
    coverage: {
      analysis_hand_cap: 25_000,
      analysis_hands_capped: false,
      lifetime_index_complete: true,
      first_hand_at: null,
      last_hand_at: null,
      rollup_covered_through: '2026-09-20T11:59:00.000Z',
      rollup_updated_at: '2026-09-20T12:00:00.000Z',
    },
    user_id: 'user-1',
    overall,
    lifetime: {
      hands: lifetimeHands,
      first_hand_at: null,
      last_hand_at: null,
      indexed_complete: true,
    },
    daily: [],
    sessions: [],
    positions: [],
    variants: [],
    stakes: [],
    tournaments: EMPTY_TOURNAMENTS,
    recent_tournaments: [],
    window_days: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  clearStatsRangeMemo();
  reportErrorMock.mockReset();
  rakeMode = 'ok';
  rolesMode = 'none';
  rpcPayload = payload(PLAYED_OVERALL, 2_000);
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (fn: string) => {
    if (fn === 'ca_player_stats_overview_v2') return { data: rpcPayload, error: null };
    return { data: null, error: null };
  });
  getRakeStats.mockReset();
  getRakeStats.mockImplementation(async (scope: unknown) => {
    if (rakeMode === 'throw') throw new Error('Failed to fetch');
    if (rakeMode === 'error') {
      return { ...EMPTY_RAKE, scope, error: 'canceling statement due to statement timeout' };
    }
    return { ...EMPTY_RAKE, scope };
  });
  getMyAgentRoles.mockReset();
  getMyAgentRoles.mockImplementation(async () => {
    if (rolesMode === 'throw') throw new Error('Load failed');
    if (rolesMode === 'error') return { roles: [], error: 'Failed to fetch' };
    return { roles: rolesMode === 'agent' ? [AGENT_ROLE] : [] };
  });
});

afterEach(() => cleanup());

async function openRakeTab() {
  const tab = await screen.findByRole('tab', { name: 'Rake' }, { timeout: 6_000 });
  fireEvent.click(tab);
  await waitFor(() =>
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'stats-panel-rake')
  );
}

const reportedUnder = (context: string) =>
  reportErrorMock.mock.calls.filter((call) => call[1] === context);

describe('a failed rake read is not an empty ledger (defect 1)', () => {
  it('renders Readout Unavailable, never Rake Ledger Empty, and reports under the page', async () => {
    rakeMode = 'error';
    render(<PlayerStatsPage />);
    await openRakeTab();

    expect(
      await screen.findByText("Couldn't Load Your Rake", undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(screen.getByText('Readout Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Rake Ledger Empty')).not.toBeInTheDocument();
    expect(screen.queryByText('No Rake In This Window')).not.toBeInTheDocument();

    const reports = reportedUnder('PlayerStatsPage.rpc_ca_player_rake_stats');
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0][0]).toBe('canceling statement due to statement timeout');
  }, 12_000);

  it('a read that throws is unavailable too, not empty', async () => {
    rakeMode = 'throw';
    render(<PlayerStatsPage />);
    await openRakeTab();
    expect(
      await screen.findByText("Couldn't Load Your Rake", undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(screen.queryByText('Rake Ledger Empty')).not.toBeInTheDocument();
    expect(reportedUnder('PlayerStatsPage.rpc_ca_player_rake_stats').length).toBeGreaterThanOrEqual(
      1
    );
  }, 12_000);

  it('Try Again refetches, and a successful retry clears the unavailable state', async () => {
    rakeMode = 'error';
    render(<PlayerStatsPage />);
    await openRakeTab();
    const alert = await screen.findByRole('alert', undefined, { timeout: 6_000 });
    expect(within(alert).getByText("Couldn't Load Your Rake")).toBeInTheDocument();

    const callsBefore = getRakeStats.mock.calls.length;
    rakeMode = 'ok';
    fireEvent.click(within(alert).getByRole('button', { name: 'Try Again' }));

    // An honest empty ledger now - because the read succeeded and found nothing.
    expect(
      await screen.findByText('Rake Ledger Empty', undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't Load Your Rake")).not.toBeInTheDocument();
    expect(getRakeStats.mock.calls.length).toBe(callsBefore + 1);
  }, 12_000);
});

describe('a failed agent-roles read is not "no roles" (defect 2)', () => {
  it('keeps the Downline section as unavailable, reports it, and never claims an empty ledger', async () => {
    rolesMode = 'error';
    render(<PlayerStatsPage />);
    await openRakeTab();

    expect(
      await screen.findByText("Couldn't Load Your Downline Rake", undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(screen.queryByText('Rake Ledger Empty')).not.toBeInTheDocument();

    const reports = reportedUnder('PlayerStatsPage.rpc_fn_my_agent_roles');
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0][0]).toBe('Failed to fetch');
  }, 12_000);

  it('a roles read that throws is unavailable too', async () => {
    rolesMode = 'throw';
    render(<PlayerStatsPage />);
    await openRakeTab();
    expect(
      await screen.findByText("Couldn't Load Your Downline Rake", undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(reportedUnder('PlayerStatsPage.rpc_fn_my_agent_roles').length).toBeGreaterThanOrEqual(1);
  }, 12_000);

  it('Try Again re-reads the roles and restores the real Downline panel', async () => {
    rolesMode = 'error';
    render(<PlayerStatsPage />);
    await openRakeTab();
    const alert = await screen.findByRole('alert', undefined, { timeout: 6_000 });

    const callsBefore = getMyAgentRoles.mock.calls.length;
    rolesMode = 'agent';
    fireEvent.click(within(alert).getByRole('button', { name: 'Try Again' }));

    expect(
      await screen.findByText('Downline Panel Rendered', undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't Load Your Downline Rake")).not.toBeInTheDocument();
    expect(getMyAgentRoles.mock.calls.length).toBe(callsBefore + 1);
  }, 12_000);

  it('a player who genuinely holds no roles still gets the honest empty ledger', async () => {
    render(<PlayerStatsPage />);
    await openRakeTab();
    expect(
      await screen.findByText('Rake Ledger Empty', undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(screen.queryByText('Readout Unavailable')).not.toBeInTheDocument();
    expect(reportErrorMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'PlayerStatsPage.rpc_fn_my_agent_roles'
    );
  }, 12_000);
});

async function hero() {
  return screen.findByRole('group', { name: 'Headline Performance' }, { timeout: 6_000 });
}

describe('the hero hand count says when it is lifetime (defect 5)', () => {
  it('labels the all-time count Lifetime Hands when it is the larger figure', async () => {
    rpcPayload = payload(PLAYED_OVERALL, 50_000);
    render(<PlayerStatsPage />);
    const h = await hero();
    expect(await within(h).findByText('50,000')).toBeInTheDocument();
    expect(within(h).getByText('Lifetime Hands')).toBeInTheDocument();
    expect(within(h).getByText('2,000 Analysed')).toBeInTheDocument();
    expect(within(h).queryByText('Total Hands')).not.toBeInTheDocument();
    expect(within(h).queryByText('Hands Played')).not.toBeInTheDocument();
  }, 12_000);

  it('says Total Hands when the lifetime and analysed counts agree', async () => {
    render(<PlayerStatsPage />);
    const h = await hero();
    expect(await within(h).findByText('2,000')).toBeInTheDocument();
    expect(within(h).getByText('Total Hands')).toBeInTheDocument();
    expect(within(h).queryByText('Lifetime Hands')).not.toBeInTheDocument();
  }, 12_000);

  it('never calls the analysed count lifetime while the lifetime index is catching up', async () => {
    rpcPayload = payload(PLAYED_OVERALL, 100);
    render(<PlayerStatsPage />);
    const h = await hero();
    expect(await within(h).findByText('2,000')).toBeInTheDocument();
    expect(within(h).getByText('Total Hands')).toBeInTheDocument();
    expect(within(h).queryByText('Lifetime Hands')).not.toBeInTheDocument();
  }, 12_000);
});

describe('the hero does not rate an empty sample (defect 3, hero)', () => {
  it('with no hands scored, the gauge and BB/100 read Not Yet Measured, not 0% and 0.00', async () => {
    rpcPayload = {
      ...payload(EMPTY_OVERALL, 0),
      tournaments: { ...EMPTY_TOURNAMENTS, entries: 3, total_buyins: 300 },
    };
    render(<PlayerStatsPage />);
    const h = await hero();
    await waitFor(() => expect(within(h).getAllByText(NOT_YET_MEASURED)).toHaveLength(2));
    const gauge = h.querySelector('.gauge-center') as HTMLElement;
    expect(within(gauge).getByText(NOT_YET_MEASURED)).toBeInTheDocument();
    expect(within(gauge).getByText('Hands Won')).toBeInTheDocument();
    expect(gauge.querySelector('.gauge-value')).toBeNull();
    expect(within(h).queryByText('0.00')).not.toBeInTheDocument();
    // No win or loss colour on a figure that was never measured.
    const bb = within(h).getByText('BB/100').parentElement as HTMLElement;
    const value = bb.querySelector('.hero-stat-value') as HTMLElement;
    expect(value).toHaveTextContent(NOT_YET_MEASURED);
    expect(value.className).not.toMatch(/\b(positive|negative)\b/);
  }, 12_000);

  it('tournament-only hands: hands won is measured, BB/100 is not', async () => {
    rpcPayload = payload(
      { ...PLAYED_OVERALL, cash_hands: 0, tourney_hands: 2_000, bb_per_100: 0 },
      2_000
    );
    render(<PlayerStatsPage />);
    const h = await hero();
    await waitFor(() => expect(within(h).getAllByText(NOT_YET_MEASURED)).toHaveLength(1));
    expect(h.querySelector('.gauge-center .gauge-value')).not.toBeNull();
    const bb = within(h).getByText('BB/100').parentElement as HTMLElement;
    expect(bb.querySelector('.hero-stat-value')).toHaveTextContent(NOT_YET_MEASURED);
  }, 12_000);

  it('a measured cash win rate still prints its number and its colour', async () => {
    render(<PlayerStatsPage />);
    const h = await hero();
    expect(await within(h).findByText('4.25')).toHaveClass('positive');
    expect(within(h).queryByText(NOT_YET_MEASURED)).not.toBeInTheDocument();
  }, 12_000);
});
