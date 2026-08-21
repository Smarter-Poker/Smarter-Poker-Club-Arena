/**
 *  PLAYER STATS PAGE — Premium Glassmorphism Design
 *
 * 2026-08-19 rebuild:
 *  - Stats now come from the ca_player_stats_full RPC which computes lifetime
 *    cash + tournament statistics directly from hand_history (the old
 *    player_stats query used .maybeSingle() and ERRORED whenever a user had
 *    rows in more than one club — that is why the page showed "No Stats Yet").
 *  - Adds a Tournaments tab (entries, ITM, wins, ROI, recent results).
 *  - Adds "Send to Personal Assistant" (runs leak detection server-side).
 *  - Full CSV export of sessions and overview stats.
 *  - Legacy player_stats fallback if the RPC is unavailable (aggregates the
 *    per-club rows instead of .maybeSingle()).
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { tabTransition, instant } from '../components/stats/statsMotion';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { useIsMounted } from '../hooks/useIsMounted';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import PositionWinRates from '../components/stats/PositionWinRates';
import PositionalRadar from '../components/stats/PositionalRadar';
import SessionHistory from '../components/stats/SessionHistory';
import BankrollTracker from '../components/stats/BankrollTracker';
import AdvancedStatsSummary from '../components/stats/AdvancedStatsSummary';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import './PlayerStatsPage.css';
import { reportError } from '../utils/errorReporter';
import DownlineRakePanel from '../components/agent/DownlineRakePanel';
import { AgentRakeService, type AgentRoleRow } from '../services/AgentRakeService';

// ── SWR Cache helpers (localStorage for cross-session persistence) ──
const STATS_CACHE_KEY = 'ps_stats_v3_';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedFull(userId: string): FullStats | null {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.cachedAt && Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parsed.full || null;
  } catch {
    return null;
  }
}
function setCachedFull(userId: string, full: FullStats) {
  try {
    localStorage.setItem(STATS_CACHE_KEY + userId, JSON.stringify({ full, cachedAt: Date.now() }));
  } catch {
    /* quota */
  }
}

// ── Types matching the ca_player_stats_full RPC payload ──
interface OverallStats {
  total_hands: number;
  cash_hands: number;
  tourney_hands: number;
  tournaments_with_hands: number;
  hands_won: number;
  hands_lost: number;
  vpip: number; // fraction 0..1
  pfr: number;
  three_bet_percent: number;
  fold_to_three_bet: number;
  cbet_flop: number;
  aggression_factor: number;
  showdowns_total: number;
  showdowns_won: number;
  wtsd: number;
  total_profit: number;
  total_winnings: number;
  total_invested: number;
  biggest_pot_won: number;
  biggest_hand_loss: number;
  bb_per_100: number;
  hours_played: number;
  // Analysis window. The RPC scores the player's most recent `hand_cap` hands;
  // `hands_capped` is true when that limit actually bit, so the UI can say so
  // instead of presenting a truncated total as a lifetime figure.
  hand_cap: number;
  hands_capped: boolean;
  first_hand_at?: string;
  last_hand_at?: string;
}

interface DailyPoint {
  date: string;
  hands: number;
  profit: number;
}

interface SessionRow {
  id: number;
  date: string;
  ended: string;
  duration_minutes: number;
  hands_played: number;
  buy_in: number;
  cash_out: number;
  profit_loss: number;
}

interface PositionRow {
  position: string;
  hands_played: number;
  vpip_count: number;
  pfr_count: number;
  three_bet_count: number;
  hands_won: number;
  total_profit: number;
  bb100: number;
}

interface VariantRow {
  variant: string;
  hands: number;
  hands_won: number;
  profit: number;
  bb100: number;
}

interface LifetimeStats {
  hands: number;
  first_hand_at: string | null;
  last_hand_at: string | null;
  /** False while the indexer is still walking back through older history. */
  indexed_complete: boolean;
}

interface HandRow {
  id: string;
  played_at: string;
  variant: string;
  big_blind: number;
  is_tournament: boolean;
  position: string | null;
  pot_size: number;
  won: number;
  profit: number;
  is_winner: boolean;
  players: number;
  board: string[] | null;
  hole_cards: unknown;
}

type HandMode = 'biggest_won' | 'biggest_lost' | 'recent';

interface StakeRow {
  big_blind: number;
  hands: number;
  hands_won: number;
  profit: number;
  bb100: number;
}

interface TournamentSummary {
  entries: number;
  cashes: number;
  wins: number;
  best_finish: number | null;
  itm_percent: number;
  total_buyins: number;
  total_winnings: number;
  net_profit: number;
  roi: number;
}

interface RecentTournament {
  name: string;
  start_time: string | null;
  variant: string | null;
  finish_rank: number | null;
  status: string | null;
  prize: number;
  buyin: number;
}

interface FullStats {
  overall: OverallStats;
  lifetime: LifetimeStats;
  window_days: number | null;
  daily: DailyPoint[];
  sessions: SessionRow[];
  positions: PositionRow[];
  variants: VariantRow[];
  stakes: StakeRow[];
  tournaments: TournamentSummary;
  recent_tournaments: RecentTournament[];
}

type StatCategory = 'overview' | 'performance' | 'positions' | 'tournaments' | 'analysis' | 'rake';

// Single source of truth for the tabs: the swipe handler and the pill row both
// read this, so they can never drift out of sync.
const BASE_TABS: StatCategory[] = [
  'overview',
  'performance',
  'positions',
  'tournaments',
  'analysis',
];

const TAB_LABELS: Record<StatCategory, string> = {
  overview: 'Overview',
  performance: 'Performance',
  positions: 'Positions',
  tournaments: 'Tournaments',
  analysis: 'Analysis',
  rake: 'Rake',
};

// Analysis ranges. `null` = no time bound (the most recent hand_cap hands,
// whenever they were played) — the previous, only behaviour.
const RANGES: { key: string; days: number | null; label: string }[] = [
  { key: '7d', days: 7, label: '7 Days' },
  { key: '30d', days: 30, label: '30 Days' },
  { key: 'all', days: null, label: 'All' },
];

const CHART_COLORS = ['#4169E1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981'];

const EMPTY_OVERALL: OverallStats = {
  total_hands: 0,
  cash_hands: 0,
  tourney_hands: 0,
  tournaments_with_hands: 0,
  hands_won: 0,
  hands_lost: 0,
  vpip: 0,
  pfr: 0,
  three_bet_percent: 0,
  fold_to_three_bet: 0,
  cbet_flop: 0,
  aggression_factor: 0,
  showdowns_total: 0,
  showdowns_won: 0,
  wtsd: 0,
  total_profit: 0,
  total_winnings: 0,
  total_invested: 0,
  biggest_pot_won: 0,
  biggest_hand_loss: 0,
  bb_per_100: 0,
  hours_played: 0,
  hand_cap: 0,
  hands_capped: false,
};

const EMPTY_LIFETIME: LifetimeStats = {
  hands: 0,
  first_hand_at: null,
  last_hand_at: null,
  indexed_complete: false,
};

const EMPTY_FULL: FullStats = {
  overall: EMPTY_OVERALL,
  lifetime: EMPTY_LIFETIME,
  window_days: null,
  daily: [],
  sessions: [],
  positions: [],
  variants: [],
  stakes: [],
  tournaments: {
    entries: 0,
    cashes: 0,
    wins: 0,
    best_finish: null,
    itm_percent: 0,
    total_buyins: 0,
    total_winnings: 0,
    net_profit: 0,
    roi: 0,
  },
  recent_tournaments: [],
};

// ── RPC payload hardening ──────────────────────────────────────────────────
// Every number the UI formats goes through `num()`. A spread over defaults only
// fills in MISSING keys — an explicit null (which Postgres aggregates can
// produce) would survive it and blow up the first .toFixed()/.toLocaleString()
// in the hero, taking the whole page down rather than one tile.
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : fallback;

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback;

function normalizeFull(data: any): FullStats {
  const o = data?.overall ?? {};
  const t = data?.tournaments ?? {};
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  const lt = data?.lifetime ?? {};

  return {
    window_days: typeof data?.window_days === 'number' ? data.window_days : null,
    lifetime: {
      hands: num(lt.hands),
      first_hand_at: lt.first_hand_at ?? null,
      last_hand_at: lt.last_hand_at ?? null,
      indexed_complete: lt.indexed_complete === true,
    },
    overall: {
      total_hands: num(o.total_hands),
      cash_hands: num(o.cash_hands),
      tourney_hands: num(o.tourney_hands),
      tournaments_with_hands: num(o.tournaments_with_hands),
      hands_won: num(o.hands_won),
      hands_lost: num(o.hands_lost),
      vpip: num(o.vpip),
      pfr: num(o.pfr),
      three_bet_percent: num(o.three_bet_percent),
      fold_to_three_bet: num(o.fold_to_three_bet),
      cbet_flop: num(o.cbet_flop),
      aggression_factor: num(o.aggression_factor),
      showdowns_total: num(o.showdowns_total),
      showdowns_won: num(o.showdowns_won),
      wtsd: num(o.wtsd),
      total_profit: num(o.total_profit),
      total_winnings: num(o.total_winnings),
      total_invested: num(o.total_invested),
      biggest_pot_won: num(o.biggest_pot_won),
      biggest_hand_loss: num(o.biggest_hand_loss),
      bb_per_100: num(o.bb_per_100),
      hours_played: num(o.hours_played),
      hand_cap: num(o.hand_cap),
      hands_capped: o.hands_capped === true,
      first_hand_at: o.first_hand_at ?? undefined,
      last_hand_at: o.last_hand_at ?? undefined,
    },
    daily: arr(data?.daily).map((d) => ({
      date: str(d?.date),
      hands: num(d?.hands),
      profit: num(d?.profit),
    })),
    sessions: arr(data?.sessions).map((x) => ({
      id: num(x?.id),
      date: str(x?.date),
      ended: str(x?.ended),
      duration_minutes: num(x?.duration_minutes),
      hands_played: num(x?.hands_played),
      buy_in: num(x?.buy_in),
      cash_out: num(x?.cash_out),
      profit_loss: num(x?.profit_loss),
    })),
    positions: arr(data?.positions).map((x) => ({
      position: str(x?.position, 'UNK'),
      hands_played: num(x?.hands_played),
      vpip_count: num(x?.vpip_count),
      pfr_count: num(x?.pfr_count),
      three_bet_count: num(x?.three_bet_count),
      hands_won: num(x?.hands_won),
      total_profit: num(x?.total_profit),
      bb100: num(x?.bb100),
    })),
    variants: arr(data?.variants).map((x) => ({
      variant: str(x?.variant, 'unknown'),
      hands: num(x?.hands),
      hands_won: num(x?.hands_won),
      profit: num(x?.profit),
      bb100: num(x?.bb100),
    })),
    stakes: arr(data?.stakes).map((x) => ({
      big_blind: num(x?.big_blind),
      hands: num(x?.hands),
      hands_won: num(x?.hands_won),
      profit: num(x?.profit),
      bb100: num(x?.bb100),
    })),
    tournaments: {
      entries: num(t.entries),
      cashes: num(t.cashes),
      wins: num(t.wins),
      best_finish: typeof t.best_finish === 'number' ? t.best_finish : null,
      itm_percent: num(t.itm_percent),
      total_buyins: num(t.total_buyins),
      total_winnings: num(t.total_winnings),
      net_profit: num(t.net_profit),
      roi: num(t.roi),
    },
    recent_tournaments: arr(data?.recent_tournaments).map((x) => ({
      name: str(x?.name, 'Tournament'),
      start_time: x?.start_time ?? null,
      variant: x?.variant ?? null,
      finish_rank: typeof x?.finish_rank === 'number' ? x.finish_rank : null,
      status: x?.status ?? null,
      prize: num(x?.prize),
      buyin: num(x?.buyin),
    })),
  };
}

// ── Animated counter hook ──
function useCountUpNumber(target: number, duration: number = 400) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let startTime: number;
    let rafId: number;
    const animate = (now: number) => {
      if (!startTime) startTime = now;
      const progress = Math.min((now - startTime) / duration, 1);
      setDisplay(Math.floor(target * progress));
      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        setDisplay(target);
      }
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [target, duration]);
  return display;
}

// ── Hands-won gauge ──
// Share of hands won sits around 10-20% in real poker (you fold most hands).
// This was previously labelled "Win Rate" and banded at 35/45/55, so every
// honest player rendered red on a near-empty arc. Bands are now calibrated to
// hands-won, and the arc is scaled against a 40% ceiling so typical values
// produce a readable sweep instead of a sliver.
const HANDS_WON_ARC_CEILING = 40;

function HandsWonGauge({ handsWonPct }: { handsWonPct: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const value = Math.min(100, Math.max(0, handsWonPct));
  const arcPercent = Math.min(100, (value / HANDS_WON_ARC_CEILING) * 100);
  const dashOffset = circumference - (arcPercent / 100) * circumference;

  const getColor = () => {
    if (value >= 22) return '#10b981';
    if (value >= 15) return '#00d4ff';
    if (value >= 10) return '#f59e0b';
    return '#ef4444';
  };

  const countedRate = useCountUpNumber(Math.floor(value), 800);

  return (
    <div className="hero-gauge">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle className="gauge-bg" cx="50" cy="50" r={radius} />
        <circle
          className="gauge-fill"
          cx="50"
          cy="50"
          r={radius}
          stroke={getColor()}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ filter: `drop-shadow(0 0 6px ${getColor()}40)` }}
        />
      </svg>
      <div className="gauge-center">
        <span className="gauge-value" style={{ color: getColor() }}>
          {countedRate}%
        </span>
        <span className="gauge-label">Hands Won</span>
      </div>
    </div>
  );
}

// ── Legacy fallback: aggregate per-club player_stats rows ──
// (values may be stored as fractions or percentages depending on writer;
//  normalize anything > 1 as a percentage)
function normFraction(v: number): number {
  return v > 1 ? v / 100 : v;
}

async function loadLegacyStats(userId: string): Promise<FullStats | null> {
  const { data, error } = await supabase
    .from('player_stats')
    .select('hands_played, total_winnings, total_losses, vpip, pfr')
    .eq('user_id', userId);
  if (error || !data || data.length === 0) return null;
  const hands = data.reduce((s, r) => s + (r.hands_played || 0), 0);
  const winnings = data.reduce((s, r) => s + (r.total_winnings || 0), 0);
  const losses = data.reduce((s, r) => s + (r.total_losses || 0), 0);
  const wVpip =
    hands > 0
      ? data.reduce((s, r) => s + normFraction(r.vpip || 0) * (r.hands_played || 0), 0) / hands
      : 0;
  const wPfr =
    hands > 0
      ? data.reduce((s, r) => s + normFraction(r.pfr || 0) * (r.hands_played || 0), 0) / hands
      : 0;
  return {
    ...EMPTY_FULL,
    overall: {
      ...EMPTY_OVERALL,
      total_hands: hands,
      cash_hands: hands,
      vpip: wVpip,
      pfr: wPfr,
      total_profit: winnings - losses,
      total_winnings: winnings,
    },
  };
}

export default function PlayerStatsPage() {
  const { userId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();

  const targetUserId = userId || user?.id;
  const [full, setFull] = useState<FullStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [servingCache, setServingCache] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rangeKey, setRangeKey] = useState<string>('all');
  const [handMode, setHandMode] = useState<HandMode>('biggest_won');
  const [hands, setHands] = useState<HandRow[] | null>(null);
  const [handsLoading, setHandsLoading] = useState(false);
  const [category, setCategory] = useState<StatCategory>('overview');

  // RAKE REPORTING IS AN AGENT PRIVILEGE. A player sees no Rake tab at all
  // until they are promoted; the RPCs refuse them regardless, this just keeps
  // the tab from appearing. It is also hidden when looking at someone else's
  // stats page — an agent's book is theirs, not a public profile field.
  const [agentRoles, setAgentRoles] = useState<AgentRoleRow[] | null>(null);
  const isOwnProfile = !userId || userId === user?.id;

  useEffect(() => {
    if (!isOwnProfile || !user?.id) {
      setAgentRoles([]);
      return;
    }
    let cancelled = false;
    void AgentRakeService.getMyAgentRoles().then((r) => {
      if (!cancelled) setAgentRoles(r);
    });
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile, user?.id]);

  const canSeeRake = (agentRoles?.length ?? 0) > 0;
  const TABS = useMemo<StatCategory[]>(
    () => (canSeeRake ? [...BASE_TABS, 'rake'] : BASE_TABS),
    [canSeeRake]
  );

  // If the tab disappears (role revoked, or navigating to another profile),
  // do not strand the view on a tab that no longer exists.
  useEffect(() => {
    if (category === 'rake' && !canSeeRake) setCategory('overview');
  }, [category, canSeeRake]);
  const statsSwipeHandlers = useSwipeTabs({
    tabs: TABS,
    activeTab: category,
    onTabChange: setCategory,
  });
  // The page CSS already honours prefers-reduced-motion, but that only stops
  // CSS keyframes. framer-motion drives transforms from JS and ignores the
  // media query entirely, so without this hook moving the tab animation to
  // framer-motion would have quietly broken an accessibility setting that
  // used to work.
  const reduceMotion = useReducedMotion();
  const toast = useToast();
  const isMounted = useIsMounted();
  const hasStatsRef = useRef(false);
  const statsLoadingRef = useRef(false);
  // A refresh arriving while one is in flight is remembered and replayed once
  // instead of dropped: the bus events are debounced, not queued, so a discarded
  // HAND_COMPLETED used to leave the page stale until some later event.
  const pendingRefreshRef = useRef(false);
  // The index refresh is a WRITE. Un-throttled it fired on every bus refresh and
  // every tab-visibility change, i.e. repeatedly during active play.
  const lastIndexRefreshRef = useRef(0);

  // ── Single RPC pulls everything from hand_history server-side ──
  const loadAllData = useCallback(async (): Promise<void> => {
    if (!targetUserId) return;
    if (statsLoadingRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    statsLoadingRef.current = true;
    if (!hasStatsRef.current) setLoading(true);

    try {
      const windowDays = RANGES.find((r) => r.key === rangeKey)?.days ?? null;
      const { data, error } = await retryFetch(
        () =>
          supabase
            .rpc('ca_player_stats_full', { p_user: targetUserId, p_days: windowDays })
            .then((r: any) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (!isMounted.current) return;

      if (!error && data && data.overall) {
        const resolved = normalizeFull(data);
        setFull(resolved);
        hasStatsRef.current = true;
        setLoadError(false);
        setServingCache(false);
        // Only the unbounded view is cached — otherwise a 7-day payload could be
        // rehydrated on the next visit and read as all-time.
        if (windowDays === null) setCachedFull(targetUserId, resolved);

        // Fire-and-forget: advance the player->hand index past the hands played
        // since the last refresh, so the live window the RPC has to scan stays
        // short. Never blocks or fails the render — the RPC is correct with or
        // without it, this only keeps it fast.
        // Batch is sized to finish inside the 8s statement_timeout on the
        // `authenticated` role; concurrent callers no-op via an advisory lock.
        const nowMs = Date.now();
        if (nowMs - lastIndexRefreshRef.current > 5 * 60 * 1000) {
          lastIndexRefreshRef.current = nowMs;
          void supabase.rpc('ca_refresh_hand_player_index', { p_max_hands: 3000 }).then(
            () => undefined,
            () => undefined
          );
        }
      } else {
        // Legacy fallback (aggregates per-club rows; never .maybeSingle())
        const legacy = await loadLegacyStats(targetUserId);
        if (!isMounted.current) return;
        if (legacy) {
          setFull(legacy);
          hasStatsRef.current = true;
          setLoadError(false);
        } else if (hasStatsRef.current) {
          // Something is already on screen (cache or an earlier load). Keep it,
          // but say it is stale rather than pretending it is current.
          setServingCache(true);
        } else {
          setFull(null);
          setLoadError(true);
        }
        if (error) reportError(error, 'PlayerStatsPage.rpc_ca_player_stats_full');
      }
    } catch (err: any) {
      // retryFetch throws when the component goes away mid-flight; that is a
      // navigation, not an application error worth reporting.
      const unmounted = err instanceof Error && /unmounted/i.test(err.message || '');
      if (!unmounted) {
        reportError(err, 'PlayerStatsPage.Failed_to_load_stats');
        if (isMounted.current) {
          if (hasStatsRef.current) {
            setServingCache(true);
          } else {
            setFull(null);
            setLoadError(true);
            toast.error('Failed to load player stats');
          }
        }
      }
    } finally {
      if (isMounted.current) setLoading(false);
      statsLoadingRef.current = false;
      if (pendingRefreshRef.current && isMounted.current) {
        pendingRefreshRef.current = false;
        void loadAllData();
      }
    }
    // toast comes from context and isMounted is a ref wrapper: both stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId, rangeKey]);

  // Notable hands. Loaded only when the Analysis tab is actually open — the
  // 'biggest' modes score the whole analysis window, so this is not free.
  useEffect(() => {
    if (!targetUserId || category !== 'analysis') return;
    let alive = true;
    setHandsLoading(true);
    supabase.rpc('ca_player_hands', { p_user: targetUserId, p_mode: handMode, p_limit: 10 }).then(
      ({ data, error }: any) => {
        if (!alive || !isMounted.current) return;
        setHands(!error && Array.isArray(data) ? (data as HandRow[]) : []);
        setHandsLoading(false);
      },
      () => {
        if (!alive || !isMounted.current) return;
        setHands([]);
        setHandsLoading(false);
      }
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId, category, handMode, rangeKey]);

  useVisibilityRefresh(loadAllData);

  // SWR: show cached stats instantly on mount
  useEffect(() => {
    if (!targetUserId) return;
    const cached = getCachedFull(targetUserId);
    if (cached) {
      setFull(cached);
      hasStatsRef.current = true;
      setLoading(false);
    }
  }, [targetUserId]);

  // Safety net so a hung auth/Supabase call cannot pin the skeleton forever.
  // 20s, not 10s: retryFetch does up to 3 attempts with 1s + 2s backoff and a
  // first call for a high-volume account takes a few seconds — the old 10s fired
  // MID-RETRY and showed "No Stats Yet" while the request was still in flight.
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!isMounted.current) return;
      setLoading(false);
      if (!hasStatsRef.current) setLoadError(true);
    }, 20000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  useEffect(() => {
    if (targetUserId) void loadAllData();
  }, [targetUserId, loadAllData]);

  // ── Bus Listeners: debounced refresh from engine events ──
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced('HAND_COMPLETED', () => loadAllData(), 2000);
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadAllData(), 2000);
    const unsubChips = masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', () => loadAllData(), 2000);
    const unsubCashout = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => loadAllData(),
      2000
    );
    const unsubCredit = masterBus.subscribeDebounced('CREDIT_UPDATED', () => loadAllData(), 2000);
    return () => {
      unsubHand();
      unsubBalance();
      unsubChips();
      unsubCashout();
      unsubCredit();
    };
  }, [loadAllData]);

  const overall = full?.overall ?? EMPTY_OVERALL;
  const lifetime = full?.lifetime ?? EMPTY_LIFETIME;
  const tourn = full?.tournaments ?? EMPTY_FULL.tournaments;

  const handsWonPct = useMemo(
    () =>
      overall.total_hands > 0
        ? ((overall.hands_won / overall.total_hands) * 100).toFixed(1)
        : '0.0',
    [overall]
  );

  const showdownWinRate = useMemo(
    () =>
      overall.showdowns_total > 0
        ? ((overall.showdowns_won / overall.showdowns_total) * 100).toFixed(1)
        : '0',
    [overall]
  );

  // Chart series with cumulative line
  const dailySeries = useMemo(() => {
    let cumulative = 0;
    return (full?.daily || []).map((d) => {
      cumulative += d.profit || 0;
      return {
        date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        profit: d.profit || 0,
        hands: d.hands || 0,
        cumulative: Math.round(cumulative * 100) / 100,
      };
    });
  }, [full]);

  const positionPie = useMemo(
    () =>
      (full?.positions || [])
        .filter((p) => p.hands_won > 0)
        .map((p) => ({ name: p.position, value: p.hands_won })),
    [full]
  );

  // AdvancedStatsSummary expects a player_stats-like object (fractions)
  const advancedInitialData = useMemo(
    () => ({
      total_hands: overall.total_hands,
      total_profit: overall.total_profit,
      hours_played: overall.hours_played,
      showdowns_won: overall.showdowns_won,
      showdowns_total: overall.showdowns_total,
      aggression_factor: overall.aggression_factor,
      three_bet_percent: overall.three_bet_percent,
      fold_to_three_bet: overall.fold_to_three_bet,
      cbet_flop: overall.cbet_flop,
      vpip: overall.vpip,
      pfr: overall.pfr,
      bb_per_100: overall.bb_per_100,
      total_winnings: overall.total_winnings,
    }),
    [overall]
  );

  // Memoised: this array is the `initialSessions` prop for both SessionHistory
  // and BankrollTracker, whose effects key on prop identity. A fresh [] every
  // render made both children re-run their effects on every tab click.
  const sessionRows = useMemo(() => full?.sessions ?? [], [full]);

  // ── Send stats to the Personal Assistant (server-side leak detection) ──
  const sendToAssistant = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const ENGINE_URL = import.meta.env?.VITE_ENGINE_URL ?? 'https://engine.smarter.poker';
      const res = await fetch(`${ENGINE_URL}/assistant/leaks/detect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      // The detector needs a minimum sample and says so in the body. Reporting
      // "exported" and navigating regardless would claim work that did not
      // happen — the player would land on an assistant with nothing new.
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error('Assistant export failed. Try again in a moment.');
      } else if (body && typeof body.leaksDetected === 'number' && body.leaksDetected === 0) {
        const analysed = typeof body.handsAnalyzed === 'number' ? body.handsAnalyzed : null;
        toast.info(
          body.message ||
            (analysed !== null
              ? `Analysed ${analysed.toLocaleString()} hands - nothing to flag yet.`
              : 'Nothing to flag yet.')
        );
      } else {
        const n = typeof body?.leaksDetected === 'number' ? body.leaksDetected : null;
        toast.success(
          n !== null
            ? `${n} pattern${n === 1 ? '' : 's'} sent to your Personal Assistant...`
            : 'Stats exported. Opening your Personal Assistant...'
        );
        setTimeout(() => {
          window.location.href = '/hub/personal-assistant';
        }, 900);
      }
    } catch (e) {
      reportError(e, 'PlayerStatsPage.sendToAssistant');
      toast.error('Assistant export failed. Try again in a moment.');
    } finally {
      if (isMounted.current) setExporting(false);
    }
  };

  const exportSessionsCSV = () => {
    try {
      exportToCSV(
        sessionRows.map((s) => ({
          date: new Date(s.date).toLocaleString(),
          duration_minutes: s.duration_minutes,
          hands: s.hands_played,
          profit: s.profit_loss,
        })),
        'player_session_history.csv',
        [
          { key: 'date', label: 'Date' },
          { key: 'duration_minutes', label: 'Duration (min)' },
          { key: 'hands', label: 'Hands' },
          { key: 'profit', label: 'Profit' },
        ]
      );
    } catch (e) {
      reportError(e, 'PlayerStatsPage.exportSessionsCSV');
    }
  };

  const exportOverviewCSV = () => {
    try {
      // The RPC returns rates as fractions. Export them the way the page shows
      // them (percentages, with a unit column) so CSV and screen agree.
      const RATE_FIELDS = new Set([
        'vpip',
        'pfr',
        'three_bet_percent',
        'fold_to_three_bet',
        'cbet_flop',
        'wtsd',
        'itm_percent',
        'roi',
      ]);
      const source: Record<string, unknown> = {
        ...overall,
        tournament_entries: tourn.entries,
        tournament_cashes: tourn.cashes,
        tournament_wins: tourn.wins,
        tournament_best_finish: tourn.best_finish ?? '',
        tournament_total_buyins: tourn.total_buyins,
        tournament_total_winnings: tourn.total_winnings,
        tournament_net_profit: tourn.net_profit,
        itm_percent: tourn.itm_percent,
        roi: tourn.roi,
      };
      const rows = Object.entries(source).map(([k, v]) => {
        if (RATE_FIELDS.has(k)) {
          return { stat: k, value: (num(v) * 100).toFixed(2), unit: '%' };
        }
        if (typeof v === 'boolean') return { stat: k, value: v ? 'yes' : 'no', unit: '' };
        return { stat: k, value: String(v ?? ''), unit: '' };
      });
      exportToCSV(rows, 'player_stats_overview.csv', [
        { key: 'stat', label: 'Stat' },
        { key: 'value', label: 'Value' },
        { key: 'unit', label: 'Unit' },
      ]);
    } catch (e) {
      reportError(e, 'PlayerStatsPage.exportOverviewCSV');
    }
  };

  if (loading) {
    return (
      <div className="stats-page">
        <PageSkeleton variant="stats" />
      </div>
    );
  }

  // Nothing loaded and nothing cached: say so and offer a retry. The old code
  // fell through to "No Stats Yet", telling a player with thousands of hands
  // that they had never played.
  if (loadError && !full) {
    return (
      <div className="stats-page">
        <div className="stats-empty-state">
          <span className="empty-icon">{'!'}</span>
          <span className="empty-title">Couldn't Load Your Stats</span>
          <span className="empty-description">
            Your statistics are still there - we just could not reach them right now.
          </span>
          <button
            className="empty-cta"
            onClick={() => {
              setLoadError(false);
              setLoading(true);
              void loadAllData();
            }}
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const hasData = overall.total_hands > 0 || tourn.entries > 0;

  const emptyState = (
    <div className="stats-empty-state">
      <span className="empty-icon">{'♠'}</span>
      <span className="empty-title">No Stats Yet</span>
      <span className="empty-description">
        Play some hands at the tables and your statistics will appear here automatically.
      </span>
      <button className="empty-cta" onClick={() => navigate('/')}>
        Go to Lobby
      </button>
    </div>
  );

  return (
    <div className="stats-page">
      {/* ── HERO SECTION ── */}
      <div className="stats-hero">
        <HandsWonGauge handsWonPct={parseFloat(handsWonPct)} />
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-label">
              {lifetime.hands > overall.total_hands ? 'Hands Played' : 'Total Hands'}
            </span>
            <span className="hero-stat-value cyan">
              {Math.max(lifetime.hands, overall.total_hands).toLocaleString()}
            </span>
            {lifetime.hands > overall.total_hands && (
              <span className="hero-stat-sub">{overall.total_hands.toLocaleString()} analysed</span>
            )}
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">Cash Profit</span>
            <span
              className={`hero-stat-value ${overall.total_profit >= 0 ? 'positive' : 'negative'}`}
            >
              {overall.total_profit >= 0 ? '+' : ''}
              {overall.total_profit.toLocaleString()}
            </span>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">BB/100</span>
            <span
              className={`hero-stat-value ${overall.bb_per_100 >= 0 ? 'positive' : 'negative'}`}
            >
              {overall.bb_per_100.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Analysis range. Everything below the hero is computed over this window. */}
      <div className="stats-range-row">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={rangeKey === r.key ? 'active' : ''}
            onClick={() => setRangeKey(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Analysis-window and staleness notices: never present a truncated or
          stale figure as though it were a current lifetime total. */}
      {hasData && overall.hands_capped && (
        <div className="stats-notice">
          Based on your most recent {overall.hand_cap.toLocaleString()} hands
          {rangeKey !== 'all' ? ' in this range' : ''}.
        </div>
      )}
      {hasData && !overall.hands_capped && rangeKey !== 'all' && (
        <div className="stats-notice">
          {overall.total_hands.toLocaleString()} hands in the last{' '}
          {RANGES.find((r) => r.key === rangeKey)?.label.toLowerCase()}.
        </div>
      )}
      {/* Small samples: bb/100 swings wildly over a few hundred hands, and a
          confident-looking number invites the wrong conclusion. */}
      {hasData && overall.cash_hands > 0 && overall.cash_hands < 1000 && (
        <div className="stats-notice">
          {overall.cash_hands.toLocaleString()} cash hands is a small sample - win rate is not yet
          meaningful.
        </div>
      )}
      {servingCache && (
        <div className="stats-notice stats-notice-warn">
          Showing your last loaded stats - the refresh did not go through.
        </div>
      )}

      {/* ── PILL TABS ── */}
      <div className="stats-pill-tabs">
        {TABS.map((cat) => (
          <button
            key={cat}
            className={category === cat ? 'active' : ''}
            onClick={() => setCategory(cat)}
          >
            {TAB_LABELS[cat]}
          </button>
        ))}
      </div>

      {/* ── STATS CONTENT ──
          AnimatePresence keyed on `category` cross-fades the tab bodies.
          mode="wait" so the outgoing tab finishes before the incoming one
          starts and the page height never lurches mid-swap.

          The swipe handlers stay spread on THIS element rather than moving to
          a new outer wrapper: useSwipeTabs attaches touch listeners here, and
          nesting them under a wrapper would leave the gesture reading a node
          that no longer moves with the content. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={category}
          className="stats-content"
          variants={reduceMotion ? undefined : tabTransition}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={reduceMotion ? instant : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          {...statsSwipeHandlers}
        >
        {/* EMPTY STATE — shown on EVERY tab. Previously only Overview had one,
            so a player with no hands saw a wall of 0.0% rows and empty charts.
            Rake opts out: an agent who has played no hands themselves still has
            a downline generating rake, and that is the whole point of the tab. */}
        {!hasData && category !== 'rake' && emptyState}

        {/* ── RAKE TAB — live downline earnings, agents only ── */}
        {category === 'rake' && agentRoles && agentRoles.length > 0 && (
          <DownlineRakePanel roles={agentRoles} />
        )}

        {/* ── OVERVIEW TAB ── */}
        {category === 'overview' && hasData && (
          <>
            <div className="stats-grid">
              <StatRow label="VPIP" value={`${(overall.vpip * 100).toFixed(1)}%`} color="#00d4ff" />
              <StatRow label="PFR" value={`${(overall.pfr * 100).toFixed(1)}%`} color="#8b5cf6" />
              <StatRow
                label="Aggression Factor"
                value={overall.aggression_factor.toFixed(2)}
                color="#f59e0b"
              />
              <StatRow
                label="Hours Played"
                value={`${overall.hours_played.toFixed(1)}h`}
                color="#06b6d4"
              />
              <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} color="#22c55e" />
              <StatRow
                label="BB/100"
                value={overall.bb_per_100.toFixed(2)}
                color="#4169E1"
                highlight
              />
              <StatRow
                label="Cash Hands"
                value={overall.cash_hands.toLocaleString()}
                color="#00d4ff"
              />
              <StatRow
                label="Tournament Hands"
                value={overall.tourney_hands.toLocaleString()}
                color="#8b5cf6"
              />
            </div>

            {/* Per-variant breakdown */}
            {(full?.variants?.length ?? 0) > 0 && (
              <div className="variant-table">
                <div className="variant-row variant-head">
                  <span>Game</span>
                  <span>Hands</span>
                  <span>Won</span>
                  <span>Profit</span>
                  <span>BB/100</span>
                </div>
                {(full?.variants || []).map((v) => (
                  <div className="variant-row" key={v.variant}>
                    <span className="variant-name">{String(v.variant).toUpperCase()}</span>
                    <span>{v.hands.toLocaleString()}</span>
                    <span>{v.hands_won.toLocaleString()}</span>
                    <span className={v.profit >= 0 ? 'positive' : 'negative'}>
                      {v.profit >= 0 ? '+' : ''}
                      {v.profit.toLocaleString()}
                    </span>
                    <span className={v.bb100 >= 0 ? 'positive' : 'negative'}>
                      {v.bb100.toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Per-stake breakdown: which game size is actually carrying (or
                bleeding) the results, instead of one blended number. */}
            {(full?.stakes?.length ?? 0) > 1 && (
              <div className="variant-table">
                <div className="variant-row variant-head">
                  <span>Stake</span>
                  <span>Hands</span>
                  <span>Won</span>
                  <span>Profit</span>
                  <span>BB/100</span>
                </div>
                {(full?.stakes || []).map((st) => (
                  <div className="variant-row" key={`stake-${st.big_blind}`}>
                    <span className="variant-name">{st.big_blind} BB</span>
                    <span>{st.hands.toLocaleString()}</span>
                    <span>{st.hands_won.toLocaleString()}</span>
                    <span className={st.profit >= 0 ? 'positive' : 'negative'}>
                      {st.profit >= 0 ? '+' : ''}
                      {st.profit.toLocaleString()}
                    </span>
                    <span className={st.bb100 >= 0 ? 'positive' : 'negative'}>
                      {st.bb100.toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="stats-action-row">
              <button className="view-hands-btn" onClick={() => navigate('/player-sessions')}>
                View Hand Histories
              </button>
              <button
                className="assistant-export-btn"
                onClick={sendToAssistant}
                disabled={exporting}
              >
                {exporting ? 'Exporting...' : 'Send to Personal Assistant'}
              </button>
            </div>
          </>
        )}

        {/* ── PERFORMANCE TAB ── */}
        {category === 'performance' && hasData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Preflop */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#00d4ff' }}>Preflop</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="VPIP"
                  value={`${(overall.vpip * 100).toFixed(1)}%`}
                  color="#00d4ff"
                />
                <StatRow label="PFR" value={`${(overall.pfr * 100).toFixed(1)}%`} color="#8b5cf6" />
                <StatRow
                  label="3-Bet %"
                  value={`${(overall.three_bet_percent * 100).toFixed(1)}%`}
                  color="#f59e0b"
                />
                <StatRow
                  label="Fold to 3-Bet"
                  value={`${(overall.fold_to_three_bet * 100).toFixed(1)}%`}
                  color="#ef4444"
                />
              </div>
            </div>
            {/* Postflop */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#8b5cf6' }}>Postflop</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="C-Bet Flop"
                  value={`${(overall.cbet_flop * 100).toFixed(1)}%`}
                  color="#8b5cf6"
                />
                <StatRow
                  label="WTSD"
                  value={`${(overall.wtsd * 100).toFixed(1)}%`}
                  color="#6366f1"
                />
                <StatRow
                  label="Aggression Factor"
                  value={overall.aggression_factor.toFixed(2)}
                  color="#f59e0b"
                />
                <StatRow label="Showdown Win %" value={`${showdownWinRate}%`} color="#22c55e" />
              </div>
            </div>
            {/* Results */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#22c55e' }}>Results</h3>
              </div>
              <div className="stats-grid">
                <StatRow
                  label="Cash Profit"
                  value={overall.total_profit.toLocaleString()}
                  color="#22c55e"
                  highlight
                />
                <StatRow label="BB/100" value={overall.bb_per_100.toFixed(2)} color="#4169E1" />
                <StatRow
                  label="Total Won"
                  value={overall.total_winnings.toLocaleString()}
                  color="#10b981"
                />
                <StatRow
                  label="Total Invested"
                  value={overall.total_invested.toLocaleString()}
                  color="#06b6d4"
                />
                <StatRow
                  label="Biggest Pot Won"
                  value={overall.biggest_pot_won.toLocaleString()}
                  color="#10b981"
                />
                <StatRow
                  label="Biggest Hand Loss"
                  value={overall.biggest_hand_loss.toLocaleString()}
                  color="#ef4444"
                />
                <StatRow
                  label="Hands Won"
                  value={overall.hands_won.toLocaleString()}
                  color="#22c55e"
                />
                <StatRow
                  label="Hands Lost"
                  value={overall.hands_lost.toLocaleString()}
                  color="#ef4444"
                />
              </div>
            </div>
          </div>
        )}

        {/* ── POSITIONS TAB ── */}
        {category === 'positions' && hasData && (
          <div>
            {/* Positional shape first: a player reads the SHAPE of their game
                before they read any individual number, and a web that pinches
                at the button is a leak no table of rates makes obvious. Pure
                presentation over full.positions, which is already loaded. */}
            <PositionalRadar positions={full?.positions} />
            <PositionWinRates userId={targetUserId} initialPositions={full?.positions} />
          </div>
        )}

        {/* ── TOURNAMENTS TAB ── */}
        {category === 'tournaments' && hasData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#f59e0b' }}>Tournament Results</h3>
              </div>
              <div className="stats-grid">
                <StatRow label="Entries" value={tourn.entries.toLocaleString()} color="#00d4ff" />
                <StatRow label="Cashes" value={tourn.cashes.toLocaleString()} color="#22c55e" />
                <StatRow
                  label="ITM %"
                  value={`${(tourn.itm_percent * 100).toFixed(1)}%`}
                  color="#10b981"
                />
                <StatRow label="Wins" value={tourn.wins.toLocaleString()} color="#f59e0b" />
                <StatRow
                  label="Best Finish"
                  value={tourn.best_finish ? `#${tourn.best_finish}` : '-'}
                  color="#8b5cf6"
                />
                <StatRow
                  label="Total Buy-ins"
                  value={tourn.total_buyins.toLocaleString()}
                  color="#06b6d4"
                />
                <StatRow
                  label="Total Winnings"
                  value={tourn.total_winnings.toLocaleString()}
                  color="#10b981"
                />
                <StatRow
                  label="Net Profit"
                  value={`${tourn.net_profit >= 0 ? '+' : ''}${tourn.net_profit.toLocaleString()}`}
                  color={tourn.net_profit >= 0 ? '#22c55e' : '#ef4444'}
                  highlight
                />
                <StatRow
                  label="ROI"
                  value={`${(tourn.roi * 100).toFixed(1)}%`}
                  color={tourn.roi >= 0 ? '#22c55e' : '#ef4444'}
                />
                <StatRow
                  label="Tournament Hands"
                  value={overall.tourney_hands.toLocaleString()}
                  color="#8b5cf6"
                />
              </div>
            </div>

            {(full?.recent_tournaments?.length ?? 0) > 0 ? (
              <div>
                <div className="stats-section-header">
                  <h3 style={{ color: '#3b82f6' }}>Recent Tournaments</h3>
                </div>
                <div className="tournament-list">
                  {(full?.recent_tournaments || []).map((t, i) => (
                    <div className="tournament-item" key={i}>
                      <div className="tournament-item-main">
                        <span className="tournament-item-name">{t.name}</span>
                        <span className="tournament-item-date">
                          {t.start_time
                            ? new Date(t.start_time).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            : '-'}
                          {t.variant ? ` · ${t.variant.toUpperCase()}` : ''}
                        </span>
                      </div>
                      <div className="tournament-item-result">
                        <span className="tournament-item-rank">
                          {t.finish_rank ? `#${t.finish_rank}` : t.status || '-'}
                        </span>
                        <span
                          className={`tournament-item-net ${num(t.prize) - num(t.buyin) >= 0 ? 'positive' : 'negative'}`}
                        >
                          {num(t.prize) - num(t.buyin) >= 0 ? '+' : ''}
                          {(num(t.prize) - num(t.buyin)).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="stats-empty-state">
                <span className="empty-title">No Tournaments Yet</span>
                <span className="empty-description">
                  Register for a tournament in the lobby and your results will show up here.
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── ANALYSIS TAB ── */}
        {category === 'analysis' && hasData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Advanced Stats */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#f59e0b' }}>Advanced Stats</h3>
              </div>
              <AdvancedStatsSummary userId={targetUserId} initialData={advancedInitialData} />
            </div>

            {/* Charts */}
            <div className="charts-section">
              <div className="stats-section-header">
                <h3 style={{ color: '#00d4ff' }}>Charts</h3>
              </div>

              <div className="stats-action-row">
                {sessionRows.length > 0 && (
                  <button className="export-btn" onClick={exportSessionsCSV}>
                    Export Sessions CSV
                  </button>
                )}
                <button className="export-btn" onClick={exportOverviewCSV}>
                  Export Stats CSV
                </button>
                <button
                  className="assistant-export-btn"
                  onClick={sendToAssistant}
                  disabled={exporting}
                >
                  {exporting ? 'Exporting...' : 'Send to Personal Assistant'}
                </button>
              </div>

              {/* Profit Over Time Chart */}
              <div className="chart-card">
                <div className="chart-card-header">
                  <h3>Profit Over Time (90 days)</h3>
                </div>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={dailySeries}>
                      <defs>
                        <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#4169E1" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#4169E1" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(14, 14, 28, 0.95)',
                          border: '1px solid rgba(0, 212, 255, 0.2)',
                          borderRadius: '10px',
                          backdropFilter: 'blur(16px)',
                        }}
                        labelStyle={{ color: '#fff' }}
                      />
                      <Area
                        type="monotone"
                        dataKey="cumulative"
                        stroke="#4169E1"
                        fill="url(#profitGradient)"
                        strokeWidth={2}
                        name="Cumulative Profit"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Session Results Bar Chart */}
              <div className="chart-card">
                <div className="chart-card-header">
                  <h3>Daily Results</h3>
                </div>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={dailySeries}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(14, 14, 28, 0.95)',
                          border: '1px solid rgba(0, 212, 255, 0.2)',
                          borderRadius: '10px',
                          backdropFilter: 'blur(16px)',
                        }}
                        labelStyle={{ color: '#fff' }}
                      />
                      <Bar dataKey="profit" name="Profit" radius={[4, 4, 0, 0]}>
                        {dailySeries.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={entry.profit >= 0 ? '#22c55e' : '#ef4444'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Position Breakdown Pie Chart */}
              {positionPie.length > 0 && (
                <div className="chart-card">
                  <div className="chart-card-header">
                    <h3>Hands Won by Position</h3>
                  </div>
                  <div className="chart-container pie-chart">
                    <ResponsiveContainer width="100%" height={250}>
                      <PieChart>
                        <Pie
                          data={positionPie}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={90}
                          paddingAngle={2}
                          dataKey="value"
                          nameKey="name"
                          label={({ name, value }) => `${name}: ${value}`}
                          labelLine={{ stroke: 'rgba(255,255,255,0.3)' }}
                        >
                          {positionPie.map((_entry, index) => (
                            <Cell
                              key={`cell-${index}`}
                              fill={CHART_COLORS[index % CHART_COLORS.length]}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: 'rgba(14, 14, 28, 0.95)',
                            border: '1px solid rgba(0, 212, 255, 0.2)',
                            borderRadius: '10px',
                            backdropFilter: 'blur(16px)',
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>

            {/* Notable hands — every stat above used to be a dead end. */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#f59e0b' }}>Notable Hands</h3>
              </div>
              <div className="hand-mode-row">
                {(
                  [
                    ['biggest_won', 'Biggest Wins'],
                    ['biggest_lost', 'Worst Losses'],
                    ['recent', 'Most Recent'],
                  ] as [HandMode, string][]
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    className={handMode === mode ? 'active' : ''}
                    onClick={() => setHandMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {handsLoading && <div className="hand-empty">Loading hands...</div>}
              {!handsLoading && hands && hands.length === 0 && (
                <div className="hand-empty">No hands in this range yet.</div>
              )}
              {!handsLoading && hands && hands.length > 0 && (
                <div className="hand-list">
                  {hands.map((h) => (
                    <div className="hand-row" key={h.id}>
                      <div className="hand-row-main">
                        <span className="hand-row-meta">
                          {new Date(h.played_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                          {' · '}
                          {String(h.variant || '').toUpperCase()}
                          {h.position ? ` · ${h.position}` : ''}
                          {h.is_tournament ? ' · MTT' : ` · ${h.big_blind} BB`}
                          {` · ${h.players} players`}
                        </span>
                        {Array.isArray(h.board) && h.board.length > 0 && (
                          <span className="hand-row-board">
                            {h.board.map((c) => formatCard(String(c))).join('  ')}
                          </span>
                        )}
                      </div>
                      <div className="hand-row-result">
                        <span
                          className={`hand-row-profit ${h.profit >= 0 ? 'positive' : 'negative'}`}
                        >
                          {h.profit >= 0 ? '+' : ''}
                          {h.profit.toLocaleString()}
                        </span>
                        <span className="hand-row-pot">pot {h.pot_size.toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                  <button className="view-hands-btn" onClick={() => navigate('/player-sessions')}>
                    Open Full Hand History
                  </button>
                </div>
              )}
            </div>

            {/* Sessions */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#3b82f6' }}>Cash Sessions</h3>
              </div>
              <SessionHistory userId={targetUserId} initialSessions={sessionRows} />
              {overall.tourney_hands > 0 && (
                <div className="stats-notice">
                  Cash tables only - tournament results are in the Tournaments tab, because a
                  tournament result is a prize, not chips won at a table.
                </div>
              )}
            </div>

            {/* Bankroll */}
            <div>
              <div className="stats-section-header">
                <h3 style={{ color: '#10b981' }}>Cash Bankroll</h3>
              </div>
              <BankrollTracker userId={targetUserId} initialSessions={sessionRows} />
            </div>
          </div>
        )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// hand_history stores board cards as "8hearts" / "Aspades". Render them as
// rank + suit symbol rather than dumping the raw token at the player.
const SUIT_SYMBOLS: Record<string, string> = {
  hearts: '\u2665',
  diamonds: '\u2666',
  clubs: '\u2663',
  spades: '\u2660',
};

function formatCard(card: string): string {
  const m = /^([0-9TJQKA]{1,2})(hearts|diamonds|clubs|spades)$/i.exec(card.trim());
  if (!m) return card;
  return `${m[1].toUpperCase()}${SUIT_SYMBOLS[m[2].toLowerCase()] ?? ''}`;
}

function StatRow({
  label,
  value,
  highlight,
  color = '#00d4ff',
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
}) {
  return (
    <div className={`stat-row ${highlight ? 'highlight' : ''}`}>
      <span className="row-label">
        <span className="row-dot" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="row-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}
