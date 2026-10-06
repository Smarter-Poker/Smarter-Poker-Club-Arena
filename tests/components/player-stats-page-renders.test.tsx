/**
 * PlayerStatsPage must mount.
 *
 * WHY THIS EXISTS
 * ---------------
 * The page went to its error boundary in production ("Player Stats Encountered
 * An Error") while 2,688 tests were green. Every one of those tests exercised a
 * pure function; none mounted a component, and none mounted the page. A render
 * throw is completely invisible to that kind of suite — and because the page is
 * wrapped in PageErrorBoundary, the only symptom a user sees is a warning
 * screen with no information in it.
 *
 * This test renders the real page against the real RPC shapes. It is the
 * cheapest possible guard against shipping a blank page again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// ── Network and platform boundaries ──────────────────────────────────────────

/** Exactly what ca_player_stats_overview_v2 returns for an account with NO hands. */
const EMPTY_OVERALL = {
  pfr: 0,
  vpip: 0,
  wtsd: 0,
  hand_cap: 750,
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
  total_prizes: 0,
  total_bounty_winnings: 0,
  total_bounties: 0,
};

let rpcPayload: Record<string, unknown> = {};
let notableHandsPayload: Record<string, unknown> = {};
let routeUserId: string | undefined;
let preferencesError: Error | null;
let authUserId = 'user-1';
const rpcMock = vi.hoisted(() => vi.fn());
const statsRouteState = vi.hoisted(() => ({ search: '' }));
const toastApi = vi.hoisted(() => ({
  show: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_player_stats_overview_v2') return { data: rpcPayload, error: null };
      if (fn === 'ca_player_hands_v2') return { data: notableHandsPayload, error: null };
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        in: self,
        gte: self,
        order: self,
        limit: self,
        maybeSingle: async () => ({
          data: null,
          error: table === 'ca_stats_workspace_preferences' ? preferencesError : null,
        }),
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
    user: { id: authUserId, username: 'smarterpoker', display_name: 'Smarter Poker' },
    isHydrating: false,
  }),
}));

/**
 * Dan 2026-08-25: this page now renders ClubBottomNav (the footer belongs on
 * every page the footer can reach), which uses `useLocation` and `Link`. A mock
 * that stops at useParams/useNavigate made the whole page throw
 * "No useLocation export is defined on the react-router-dom mock" - which reads
 * as a broken stats page and is really a stale mock. Anything this page renders
 * transitively has to be answerable here.
 */
vi.mock('react-router-dom', () => ({
  useParams: () => (routeUserId ? { userId: routeUserId } : {}),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(statsRouteState.search), vi.fn()],
  useLocation: () => ({
    pathname: '/stats',
    search: statsRouteState.search,
    hash: '',
    state: null,
    key: 'test',
  }),
  // JSX (automatic runtime) rather than React.createElement: a vi.mock factory
  // is hoisted above the imports, so referencing an imported React binding
  // inside it would blow up before initialisation.
  Link: ({ to, children }: { to: string; children?: unknown }) => <a href={to}>{children}</a>,
}));

vi.mock('../../src/services/ClubsService', () => ({
  getUserMemberships: vi.fn().mockResolvedValue([]),
}));

// Read status since 2026-09-20 (Stats contract truth): { roles, error? }, so
// a failed roles read is never mistaken for a player who holds no roles.
vi.mock('../../src/services/AgentRakeService', () => ({
  AgentRakeService: { getMyAgentRoles: vi.fn().mockResolvedValue({ roles: [] }) },
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
    getDistribution: vi.fn().mockResolvedValue([]),
    getCashOpportunityStats: vi.fn().mockResolvedValue({
      contract_version: 2,
      metrics: {},
      splits: {},
      coverage: { exact_hands: 0, returned_hands: 0 },
    }),
  };
  // POLISH 1 (2026-08-30): the page reads its own weighted rake. Mocked here
  // so the mock cannot lag the service it stands in for.
  (svc as Record<string, unknown>).getRakeStats = vi.fn().mockResolvedValue({
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
  });
  (svc as Record<string, unknown>).getHandRakeShare = vi.fn().mockResolvedValue({ found: false });
  return { __esModule: true, default: svc, StatsFactsService: svc };
});

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => toastApi,
}));

import PlayerStatsPage from '../../src/pages/PlayerStatsPage';
import { clearStatsRangeMemo } from '../../src/lib/statsCache';
import { isFullStatsPayload, normalizeHands } from '../../src/pages/stats/playerStatsPageModel';

beforeEach(() => {
  localStorage.clear();
  clearStatsRangeMemo();
  routeUserId = undefined;
  statsRouteState.search = '';
  authUserId = 'user-1';
  preferencesError = null;
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (fn: string) => {
    if (fn === 'ca_player_stats_overview_v2') return { data: rpcPayload, error: null };
    if (fn === 'ca_player_hands_v2') return { data: notableHandsPayload, error: null };
    return { data: null, error: null };
  });
  rpcPayload = {
    contract_version: 2,
    generated_at: '2026-08-31T12:00:00.000Z',
    scope: {
      target_user_id: 'user-1',
      club_id: null,
      asset: 'chips',
      range_days: null,
      range_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      visibility: 'owner',
    },
    quality: {
      cash_money_source: 'exact_settlement',
      cash_money_exact: true,
      exact_cash_hands: 0,
      advanced_facts_source: 'ca_hand_player_stat',
      historical_club_breakdown_available: false,
      live_tail_included: false,
    },
    coverage: {
      analysis_hand_cap: 750,
      analysis_hands_capped: false,
      lifetime_index_complete: true,
      first_hand_at: null,
      last_hand_at: null,
      rollup_covered_through: '2026-08-31T11:59:00.000Z',
      rollup_updated_at: '2026-08-31T12:00:00.000Z',
    },
    user_id: 'user-1',
    overall: EMPTY_OVERALL,
    lifetime: { hands: 0, first_hand_at: null, last_hand_at: null, indexed_complete: true },
    daily: [],
    sessions: [],
    positions: [],
    variants: [],
    stakes: [],
    tournaments: EMPTY_TOURNAMENTS,
    recent_tournaments: [],
    window_days: null,
  };
  notableHandsPayload = {
    contract_version: 2,
    scope: {
      target_user_id: 'user-1',
      club_id: null,
      asset: 'chips',
      visibility: 'owner',
    },
    hands: [],
    generated_at: '2026-08-31T12:00:00.000Z',
  };
});

afterEach(() => cleanup());

describe('PlayerStatsPage mounts', () => {
  it('uses the authorized shared-club boundary without requesting private owner stats', async () => {
    routeUserId = 'user-2';

    render(<PlayerStatsPage />);

    expect(await screen.findByText('Shared Readout Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Authorized Shared-Club Readout')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('ca_player_stats_shared_clubs', {
      p_target_user: 'user-2',
      p_asset: 'chips',
    });
    expect(rpcMock).not.toHaveBeenCalledWith('ca_player_stats_overview_v2', expect.anything());
  });

  it('renders for an account with NO hands without hitting the error boundary', async () => {
    // This is the exact shape smarterpoker returns in production, and the
    // state the page was crashing in.
    expect(isFullStatsPayload(rpcPayload)).toBe(true);
    expect(() => render(<PlayerStatsPage />)).not.toThrow();
    expect(await screen.findByText('No Stats Yet')).toBeVisible();
    expect(screen.queryByText("Couldn't Load Your Stats")).not.toBeInTheDocument();
  });

  it('keeps private stats hidden until the privacy preference can be verified', async () => {
    preferencesError = new Error('preferences unavailable');
    render(<PlayerStatsPage />);

    expect(
      await screen.findByText('Private Detail Remains Hidden.', { exact: false })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry Privacy Check' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Overview' })).not.toBeInTheDocument();

    preferencesError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry Privacy Check' }));
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeVisible();
  });

  it('renders for an account WITH hands', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 20000,
        cash_hands: 18000,
        tourney_hands: 2000,
        hands_won: 4200,
        hands_lost: 15800,
        vpip: 0.41,
        pfr: 0.09,
        bb_per_100: -22.5,
        hours_played: 61.5,
        aggression_factor: 0.7,
        showdowns_total: 1200,
        showdowns_won: 430,
        fold_to_three_bet: 0.81,
        cbet_flop: 0.91,
      },
      quality: {
        ...(rpcPayload.quality as Record<string, unknown>),
        cash_money_source: 'exact_settlement',
        cash_money_exact: true,
        exact_cash_hands: 18000,
      },
      coverage: {
        ...(rpcPayload.coverage as Record<string, unknown>),
        analysis_hands_capped: true,
      },
      positions: [
        {
          position: 'UTG',
          hands_played: 3000,
          vpip_count: 1300,
          pfr_count: 200,
          three_bet_count: 40,
          hands_won: 500,
          total_profit: -900,
          bb100: -30,
        },
        {
          position: 'BTN',
          hands_played: 3000,
          vpip_count: 1000,
          pfr_count: 300,
          three_bet_count: 60,
          hands_won: 700,
          total_profit: 300,
          bb100: 9,
        },
        {
          position: 'BB',
          hands_played: 3000,
          vpip_count: 1500,
          pfr_count: 150,
          three_bet_count: 30,
          hands_won: 520,
          total_profit: -1100,
          bb100: -34,
        },
      ],
    };

    expect(() => render(<PlayerStatsPage />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByText(/Overview/i)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /Player Intelligence/i })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: /Analysis Range/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /Evidence At A Glance/i })).toBeInTheDocument();
      expect(screen.getByText('Established')).toBeInTheDocument();
    });

    expect(document.querySelector('.stats-hero-art')).toHaveAttribute(
      'src',
      expect.stringContaining('player-intelligence-dossier-v2.webp')
    );

    expect(screen.getByRole('button', { name: 'Open Deep Analysis' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Analysis Panels Use Your Most Recent 750 Hands. Headline Totals Still Include Every Hand In This Range.'
      )
    ).toBeVisible();
  });

  it('renders the owner mystery-bounty split and net from verified v2 fields', async () => {
    statsRouteState.search = '?tab=tournaments';
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 1,
        tourney_hands: 1,
        tournaments_with_hands: 1,
        hands_lost: 1,
      },
      lifetime: { hands: 1, first_hand_at: null, last_hand_at: null, indexed_complete: true },
      tournaments: {
        ...EMPTY_TOURNAMENTS,
        entries: 1,
        cashes: 1,
        itm_percent: 1,
        total_buyins: 25,
        total_winnings: 60,
        total_prizes: 40,
        total_bounty_winnings: 20,
        total_bounties: 1,
        net_profit: 35,
        roi: 1.4,
      },
      recent_tournaments: [
        {
          tournament_id: '11111111-1111-4111-8111-111111111111',
          name: 'mystery sunday',
          start_time: '2026-10-05T10:00:00Z',
          ended_at: '2026-10-05T14:00:00Z',
          variant: 'nlh',
          is_mystery_bounty: true,
          finish_rank: 2,
          status: 'eliminated',
          prize: 40,
          bounty_winnings: 20,
          bounties: 1,
          total_won: 60,
          buyin: 25,
        },
      ],
    };

    render(<PlayerStatsPage />);

    expect(await screen.findByText('Mystery Sunday')).toBeVisible();
    expect(screen.getByText(/Mystery Bounty/)).toBeVisible();
    expect(screen.getByText(/Prize 40.*1 KO 20.*Total 60/)).toBeVisible();
    expect(document.querySelector('.tournament-item-net')).toHaveTextContent('+35');
  });

  it('never relabels a prior payload when a new range fails', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 20000,
        cash_hands: 18000,
        tourney_hands: 2000,
        hands_lost: 20000,
      },
      quality: {
        ...(rpcPayload.quality as Record<string, unknown>),
        exact_cash_hands: 18000,
      },
      coverage: {
        ...(rpcPayload.coverage as Record<string, unknown>),
        analysis_hands_capped: true,
      },
    };
    render(<PlayerStatsPage />);
    expect(await screen.findByText('20,000')).toBeInTheDocument();

    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'ca_player_stats_overview_v2') {
        return { data: null, error: { code: '57014', message: 'timed out' } };
      }
      return { data: null, error: null };
    });
    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));

    expect(
      await screen.findByText("Couldn't Load Your Stats", undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    expect(screen.queryByText('20,000')).not.toBeInTheDocument();
  }, 8_000);

  it('rejects a valid-shaped overview payload for the wrong account scope', async () => {
    rpcPayload = {
      ...rpcPayload,
      scope: { ...(rpcPayload.scope as object), target_user_id: 'another-user' },
      overall: { ...EMPTY_OVERALL, total_hands: 123, cash_hands: 123, hands_lost: 123 },
    };
    render(<PlayerStatsPage />);

    expect(await screen.findByText("Couldn't Load Your Stats")).toBeVisible();
    expect(screen.queryByText('123')).not.toBeInTheDocument();
  });

  it('rejects a scope-matching malformed success instead of rewriting it as zero stats', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 'not-a-count',
        total_profit: 'not-an-amount',
      },
    };

    render(<PlayerStatsPage />);

    expect(await screen.findByText("Couldn't Load Your Stats")).toBeVisible();
    expect(screen.queryByText('No Stats Yet')).not.toBeInTheDocument();
    expect(toastApi.error).not.toHaveBeenCalledWith(expect.stringContaining('No Stats'));
  });

  it('rejects finite but impossible owner rates and count relationships', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 100,
        cash_hands: 80,
        tourney_hands: 20,
        hands_won: 12,
        hands_lost: 88,
        vpip: 1.01,
        pfr: 0.2,
      },
      lifetime: { hands: 100, first_hand_at: null, last_hand_at: null, indexed_complete: true },
      quality: {
        ...(rpcPayload.quality as Record<string, unknown>),
        cash_money_source: 'exact_settlement',
        cash_money_exact: true,
        exact_cash_hands: 80,
      },
    };

    render(<PlayerStatsPage />);

    expect(await screen.findByText("Couldn't Load Your Stats")).toBeVisible();
    expect(screen.queryByText('101.0%')).not.toBeInTheDocument();
  });

  it('validates owner rate, hand-total, tournament-total, and count domains', () => {
    const valid = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 100,
        cash_hands: 80,
        tourney_hands: 20,
        tournaments_with_hands: 2,
        hands_won: 12,
        hands_lost: 88,
        showdowns_total: 20,
        showdowns_won: 8,
        vpip: 0.3,
        pfr: 0.2,
        three_bet_percent: 0.08,
        fold_to_three_bet: 0.5,
        cbet_flop: 0.6,
        wtsd: 0.25,
        aggression_factor: 1.2,
        total_winnings: 120,
        total_invested: 100,
        biggest_pot_won: 20,
        hours_played: 4,
      },
      lifetime: { hands: 100, first_hand_at: null, last_hand_at: null, indexed_complete: true },
      quality: {
        ...(rpcPayload.quality as Record<string, unknown>),
        exact_cash_hands: 80,
      },
      tournaments: {
        ...EMPTY_TOURNAMENTS,
        entries: 10,
        cashes: 3,
        wins: 1,
        best_finish: 1,
        itm_percent: 0.3,
        total_buyins: 100,
        total_winnings: 150,
        total_prizes: 120,
        total_bounty_winnings: 30,
        net_profit: 50,
        roi: 0.5,
      },
    };

    expect(isFullStatsPayload(valid)).toBe(true);
    expect(isFullStatsPayload({ ...valid, overall: { ...valid.overall, vpip: 1.01 } })).toBe(false);
    expect(isFullStatsPayload({ ...valid, overall: { ...valid.overall, pfr: -0.01 } })).toBe(false);
    expect(
      isFullStatsPayload({
        ...valid,
        overall: { ...valid.overall, three_bet_percent: 1.01 },
      })
    ).toBe(false);
    expect(isFullStatsPayload({ ...valid, overall: { ...valid.overall, cash_hands: 81 } })).toBe(
      false
    );
    expect(
      isFullStatsPayload({ ...valid, tournaments: { ...valid.tournaments, cashes: 11 } })
    ).toBe(false);
    expect(isFullStatsPayload({ ...valid, tournaments: { ...valid.tournaments, wins: 11 } })).toBe(
      false
    );
    expect(isFullStatsPayload({ ...valid, tournaments: { ...valid.tournaments, wins: 4 } })).toBe(
      false
    );
    expect(
      isFullStatsPayload({ ...valid, overall: { ...valid.overall, total_hands: 100.5 } })
    ).toBe(false);
    expect(isFullStatsPayload({ ...valid, overall: { ...valid.overall, hand_cap: 0 } })).toBe(
      false
    );
    expect(
      isFullStatsPayload({
        ...valid,
        overall: { ...valid.overall, hand_cap: 50, hands_capped: false },
        coverage: {
          ...(valid.coverage as Record<string, unknown>),
          analysis_hand_cap: 50,
          analysis_hands_capped: true,
        },
      })
    ).toBe(true);

    const withFinancialDetails = {
      ...valid,
      sessions: [
        {
          id: 1,
          date: '2026-10-05T12:00:00Z',
          ended: '2026-10-05T13:00:00Z',
          duration_minutes: 60,
          hands_played: 20,
          buy_in: 100,
          cash_out: 125,
          profit_loss: 25,
        },
      ],
      recent_tournaments: [
        {
          tournament_id: '11111111-1111-4111-8111-111111111111',
          name: 'Mystery Sunday',
          start_time: '2026-10-05T10:00:00Z',
          ended_at: '2026-10-05T14:00:00Z',
          variant: 'nlh',
          is_mystery_bounty: true,
          finish_rank: 2,
          status: 'eliminated',
          prize: 40,
          bounty_winnings: 20,
          bounties: 1,
          total_won: 60,
          buyin: 25,
        },
      ],
    };
    expect(isFullStatsPayload(withFinancialDetails)).toBe(true);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        tournaments: { ...valid.tournaments, total_winnings: 149.99 },
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        tournaments: { ...valid.tournaments, net_profit: 49.99 },
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        tournaments: { ...valid.tournaments, itm_percent: 0.3001 },
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        tournaments: { ...valid.tournaments, roi: 0.5001 },
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        sessions: [{ ...withFinancialDetails.sessions[0], cash_out: 124.99 }],
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        sessions: [{ ...withFinancialDetails.sessions[0], duration_minutes: 0 }],
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        sessions: [{ ...withFinancialDetails.sessions[0], ended: '2026-10-05T11:59:59Z' }],
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        recent_tournaments: [{ ...withFinancialDetails.recent_tournaments[0], total_won: 59.99 }],
      })
    ).toBe(false);
    const { is_mystery_bounty: _missingFlag, ...missingMysteryFlag } =
      withFinancialDetails.recent_tournaments[0];
    expect(
      isFullStatsPayload({ ...withFinancialDetails, recent_tournaments: [missingMysteryFlag] })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...withFinancialDetails,
        quality: { ...valid.quality, cash_money_source: 'mixed' },
      })
    ).toBe(false);
    expect(
      isFullStatsPayload({
        ...valid,
        positions: [
          {
            position: null,
            hands_played: 10,
            vpip_count: 3,
            pfr_count: 2,
            hands_won: 1,
            total_profit: 4,
            bb100: null,
          },
        ],
      })
    ).toBe(true);
  });

  it('refuses a scope-mismatched all-time payload instead of painting lifetime trophies', async () => {
    statsRouteState.search = '?range=30d&tab=trophies';
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const rangedPayload = {
      ...rpcPayload,
      scope: {
        ...(rpcPayload.scope as Record<string, unknown>),
        range_days: 30,
        range_tz: timezone,
      },
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 10,
        cash_hands: 10,
        hands_won: 2,
        hands_lost: 8,
      },
      lifetime: { hands: 10, first_hand_at: null, last_hand_at: null, indexed_complete: true },
      quality: {
        ...(rpcPayload.quality as Record<string, unknown>),
        exact_cash_hands: 10,
      },
      window_days: 30,
    };
    rpcMock.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn !== 'ca_player_stats_overview_v2') return { data: null, error: null };
      if (args?.p_days === null) {
        return {
          data: {
            ...rangedPayload,
            scope: {
              ...(rangedPayload.scope as Record<string, unknown>),
              target_user_id: 'wrong-owner',
              range_days: null,
            },
            window_days: null,
          },
          error: null,
        };
      }
      return { data: rangedPayload, error: null };
    });

    render(<PlayerStatsPage />);

    expect(
      await screen.findByText('Your All-Time Stats Could Not Be Loaded For The Trophy Room.', {
        exact: false,
      })
    ).toBeVisible();
    expect(screen.queryByText('First Hand')).not.toBeInTheDocument();
  });

  it('never paints an in-flight payload from the previous signed-in account', async () => {
    let resolveFirst!: (value: { data: Record<string, unknown>; error: null }) => void;
    let resolveSecond!: (value: { data: Record<string, unknown>; error: null }) => void;
    let overviewCalls = 0;
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn !== 'ca_player_stats_overview_v2') return { data: null, error: null };
      overviewCalls += 1;
      return new Promise((resolve) => {
        if (overviewCalls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
    const first = {
      ...rpcPayload,
      scope: { ...(rpcPayload.scope as object), target_user_id: 'user-1' },
      overall: { ...EMPTY_OVERALL, total_hands: 111, cash_hands: 111, hands_lost: 111 },
      quality: { ...(rpcPayload.quality as object), exact_cash_hands: 111 },
    };
    const second = {
      ...rpcPayload,
      scope: { ...(rpcPayload.scope as object), target_user_id: 'user-2' },
      overall: { ...EMPTY_OVERALL, total_hands: 222, cash_hands: 222, hands_lost: 222 },
      quality: { ...(rpcPayload.quality as object), exact_cash_hands: 222 },
    };

    const view = render(<PlayerStatsPage />);
    await waitFor(() => expect(overviewCalls).toBe(1));
    authUserId = 'user-2';
    view.rerender(<PlayerStatsPage />);
    resolveFirst({ data: first, error: null });
    await waitFor(() => expect(overviewCalls).toBe(2));
    expect(screen.queryByText('111')).not.toBeInTheDocument();
    resolveSecond({ data: second, error: null });
    expect(await screen.findByText('222')).toBeVisible();
  });

  it('completes a dossier shortcut by selecting, focusing, and revealing its destination', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 2_000,
        cash_hands: 2_000,
        hands_lost: 2_000,
      },
      quality: { ...(rpcPayload.quality as object), exact_cash_hands: 2_000 },
      coverage: { ...(rpcPayload.coverage as object), analysis_hands_capped: true },
    };
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render(<PlayerStatsPage />);
    const shortcut = await screen.findByRole('button', { name: 'Open Deep Analysis' });
    fireEvent.click(shortcut);

    const analysisTab = screen.getByRole('tab', { name: 'Analysis' });
    await waitFor(() => {
      expect(analysisTab).toHaveAttribute('aria-selected', 'true');
      expect(analysisTab).toHaveFocus();
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'stats-panel-analysis');
      expect(scrollIntoView).toHaveBeenCalled();
    });
  });

  it('lazy-loads the Analysis tab chunk and the coach reads the page payload through the seam (phase 2)', async () => {
    // 2,000 hands clears LEAK_MIN_HANDS (500); VPIP 41 / PFR 9 is the loose-
    // passive leak findLeaks names first. The numbers arrive from the page's
    // payload, cross the lazy() boundary as props, and render inside
    // AnalysisTab - the whole point of the split being safe.
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 2_000,
        cash_hands: 2_000,
        hands_lost: 2_000,
        vpip: 0.41,
        pfr: 0.09,
        three_bet_percent: 0.04,
        fold_to_three_bet: 0.6,
        cbet_flop: 0.5,
        wtsd: 0.28,
        aggression_factor: 1.2,
        showdowns_total: 400,
        showdowns_won: 180,
        bb_per_100: -12,
      },
      quality: { ...(rpcPayload.quality as object), exact_cash_hands: 2_000 },
      coverage: { ...(rpcPayload.coverage as object), analysis_hands_capped: true },
    };
    render(<PlayerStatsPage />);
    // The tab strip mounts with the payload, not with the heading; on a loaded
    // runner the two are visibly apart (the awaited-element law, 2026-09-04).
    const analysisTab = await screen.findByRole('tab', { name: 'Analysis' }, { timeout: 6_000 });
    // The payload has painted once the hand count is on the page. Two places
    // print it, the headline deck and (once its chunk resolves) an Overview
    // row, so asking for exactly one passed only while the lazy chunk was
    // still loading and failed with "Found multiple elements" when it was
    // already cached (2026-10-04: every full `vitest related` run on a
    // two-core box). Either order is the payload having arrived.
    await screen.findAllByText('2,000');
    fireEvent.click(analysisTab);
    expect(
      await screen.findByText('What To Work On', undefined, { timeout: 6_000 })
    ).toBeInTheDocument();
    // The Overview chunk is not what is on screen any more.
    await waitFor(() => {
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'stats-panel-analysis');
      expect(screen.queryByRole('heading', { name: /Core Tendencies/i })).not.toBeInTheDocument();
    });
  });

  it('accepts only exact v2 notable-hand evidence for the requested owner scope', () => {
    const request = {
      targetUserId: 'user-1',
      clubId: null,
      asset: 'chips' as const,
      visibility: 'owner' as const,
    };
    const hand = {
      id: '11111111-1111-4111-8111-111111111111',
      played_at: '2026-08-31T11:30:00.000Z',
      variant: 'NLH',
      big_blind: 2,
      is_tournament: false,
      position: 'BTN',
      pot_size: 120.5,
      won: 120.5,
      profit: 80.5,
      is_winner: true,
      players: 6,
      board: ['As', 'Kh', '2d'],
      hole_cards: ['Ah', 'Ad'],
    };
    const envelope = {
      ...notableHandsPayload,
      scope: {
        target_user_id: 'user-1',
        club_id: null,
        asset: 'chips',
        visibility: 'owner',
      },
      hands: [hand],
    };

    expect(normalizeHands(envelope, request)).toEqual([hand]);
    expect(normalizeHands([], request)).toBeNull();
    expect(
      normalizeHands(
        { ...envelope, scope: { ...envelope.scope, target_user_id: 'another-user' } },
        request
      )
    ).toBeNull();
    expect(
      normalizeHands({ ...envelope, hands: [{ ...hand, id: 'invent-me' }] }, request)
    ).toBeNull();
    expect(
      normalizeHands({ ...envelope, hands: [{ ...hand, pot_size: Number.NaN }] }, request)
    ).toBeNull();
    expect(normalizeHands({ ...envelope, hands: [] }, request)).toEqual([]);
  });

  it('shows unavailable and no evidence link for a wrong-scope notable-hands success', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 1,
        cash_hands: 1,
        hands_lost: 1,
      },
      lifetime: { hands: 1, first_hand_at: null, last_hand_at: null, indexed_complete: true },
      quality: { ...(rpcPayload.quality as object), exact_cash_hands: 1 },
    };
    notableHandsPayload = {
      ...notableHandsPayload,
      scope: {
        ...(notableHandsPayload.scope as Record<string, unknown>),
        target_user_id: 'another-user',
      },
      hands: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          played_at: '2026-08-31T11:30:00.000Z',
          variant: 'NLH',
          big_blind: 2,
          is_tournament: false,
          position: 'BTN',
          pot_size: 120.5,
          won: 120.5,
          profit: 80.5,
          is_winner: true,
          players: 6,
          board: ['As', 'Kh', '2d'],
          hole_cards: ['Ah', 'Ad'],
        },
      ],
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(<PlayerStatsPage />);
      fireEvent.click(await screen.findByRole('tab', { name: 'Analysis' }, { timeout: 6_000 }));
      await waitFor(() =>
        expect(rpcMock).toHaveBeenCalledWith(
          'ca_player_hands_v2',
          expect.objectContaining({ p_user: 'user-1', p_asset: 'chips' })
        )
      );

      expect(
        await screen.findByText(
          /Could Not Load Notable Hands\./,
          { selector: '.hand-empty' },
          { timeout: 6_000 }
        )
      ).toBeVisible();
      expect(screen.queryByRole('link', { name: /Open Hand From/i })).not.toBeInTheDocument();
      expect(screen.queryByText('No Cash Hands Recorded Yet.')).not.toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  }, 8_000);

  it('survives a completely malformed RPC payload', async () => {
    // normalizeFull() is supposed to harden every field. If it ever stops
    // doing so, the page must still not throw.
    rpcPayload = {} as Record<string, unknown>;
    expect(() => render(<PlayerStatsPage />)).not.toThrow();
    await waitFor(() => expect(document.body.textContent).toBeTruthy());
  });

  it('survives a null RPC payload', async () => {
    rpcPayload = null as unknown as Record<string, unknown>;
    expect(() => render(<PlayerStatsPage />)).not.toThrow();
    await waitFor(() => expect(document.body.textContent).toBeTruthy());
  });
});
