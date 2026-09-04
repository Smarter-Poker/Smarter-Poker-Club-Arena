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
};

let rpcPayload: Record<string, unknown> = {};
let routeUserId: string | undefined;
const rpcMock = vi.hoisted(() => vi.fn());
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
      return { data: null, error: null };
    }),
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
  useLocation: () => ({ pathname: '/stats', search: '', hash: '', state: null, key: 'test' }),
  // JSX (automatic runtime) rather than React.createElement: a vi.mock factory
  // is hoisted above the imports, so referencing an imported React binding
  // inside it would blow up before initialisation.
  Link: ({ to, children }: { to: string; children?: unknown }) => <a href={to}>{children}</a>,
}));

vi.mock('../../src/services/AgentRakeService', () => ({
  AgentRakeService: { getMyAgentRoles: vi.fn().mockResolvedValue([]) },
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

beforeEach(() => {
  localStorage.clear();
  clearStatsRangeMemo();
  routeUserId = undefined;
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (fn: string) => {
    if (fn === 'ca_player_stats_overview_v2') return { data: rpcPayload, error: null };
    return { data: null, error: null };
  });
  rpcPayload = {
    contract_version: 2,
    generated_at: '2026-08-31T12:00:00.000Z',
    scope: { target_user_id: 'user-1', club_id: null, range_days: null, visibility: 'owner' },
    quality: {
      cash_money_source: 'reconstructed_actions',
      cash_money_exact: false,
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
});

afterEach(() => cleanup());

describe('PlayerStatsPage mounts', () => {
  it('renders the private boundary without requesting another player stats', async () => {
    routeUserId = 'user-2';

    render(<PlayerStatsPage />);

    expect(await screen.findByText('Player Stats Are Private')).toBeInTheDocument();
    expect(screen.getByText(/No All-Club Financial Data Is Exposed/i)).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('renders for an account with NO hands without hitting the error boundary', async () => {
    // This is the exact shape smarterpoker returns in production, and the
    // state the page was crashing in.
    expect(() => render(<PlayerStatsPage />)).not.toThrow();
    await waitFor(() => {
      expect(document.body.textContent).toBeTruthy();
    });
  });

  it('renders for an account WITH hands', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: {
        ...EMPTY_OVERALL,
        total_hands: 20000,
        cash_hands: 18000,
        hands_won: 4200,
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
  });

  it('never relabels a prior payload when a new range fails', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: { ...EMPTY_OVERALL, total_hands: 20000, cash_hands: 18000 },
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

  it('completes a dossier shortcut by selecting, focusing, and revealing its destination', async () => {
    rpcPayload = {
      ...rpcPayload,
      overall: { ...EMPTY_OVERALL, total_hands: 2_000, cash_hands: 2_000 },
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
    };
    render(<PlayerStatsPage />);
    // The tab strip mounts with the payload, not with the heading; on a loaded
    // runner the two are visibly apart (the awaited-element law, 2026-09-04).
    const analysisTab = await screen.findByRole('tab', { name: 'Analysis' }, { timeout: 6_000 });
    await screen.findByText('2,000');
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
