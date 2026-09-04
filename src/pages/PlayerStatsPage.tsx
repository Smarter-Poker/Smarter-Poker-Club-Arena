/**
 *  PLAYER STATS PAGE — Premium Glassmorphism Design
 *
 * 2026-08-19 rebuild:
 *  - Stats now come from the owner-only ca_player_stats_overview_v2 RPC, which computes lifetime
 *    cash + tournament statistics directly from hand_history (the old
 *    player_stats query used .maybeSingle() and ERRORED whenever a user had
 *    rows in more than one club — that is why the page showed "No Stats Yet").
 *  - Adds a Tournaments tab (entries, ITM, wins, ROI, recent results).
 *  - Full CSV export of sessions and overview stats.
 *  - Contract v2 reports source quality and coverage instead of silently
 *    substituting an incompatible legacy payload when the RPC is unavailable.
 */

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  lazy,
  Suspense,
  useLayoutEffect,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { tabTransition, instant } from '../components/stats/statsMotion';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
// The two caches sign-out has to be able to reach. They live in a leaf module
// so clearUserCaches can purge them without importing this page - that import
// would pull the whole Stats graph into the sign-out chunk and undo the lazy
// chart split.
import {
  STATS_CACHE_PREFIX,
  readStatsRangeMemo,
  writeStatsRangeMemo,
  clearStatsRangeMemo,
} from '../lib/statsCache';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { useIsMounted } from '../hooks/useIsMounted';
/**
 * ONE LAZY CHUNK PER TAB (Stats Page Programme phase 2, 2026-09-04).
 *
 * recharts (120 KB gzipped) and every panel used to be lazy one by one while
 * the markup of all eight tabs sat inline in this file. The tabs are their
 * own modules now, so the default Overview visit downloads the page plus one
 * tab, and a panel is only ever requested by the tab that draws it. The
 * per-panel lazies inside each tab keep the chart split from 2026-08-25.
 */
const RakeTab = lazy(() => import('./stats/RakeTab'));
const OverviewTab = lazy(() => import('./stats/OverviewTab'));
const PerformanceTab = lazy(() => import('./stats/PerformanceTab'));
const PositionsTab = lazy(() => import('./stats/PositionsTab'));
const HandsTab = lazy(() => import('./stats/HandsTab'));
const TrophiesTab = lazy(() => import('./stats/TrophiesTab'));
const TournamentsTab = lazy(() => import('./stats/TournamentsTab'));
const AnalysisTab = lazy(() => import('./stats/AnalysisTab'));
import { playerStyleFromStats } from '../components/stats/playerStyleFromStats';
import {
  RANGES,
  num,
  str,
  type FullStats,
  type HandMode,
  type HandRow,
  type OverallStats,
  type LifetimeStats,
} from './stats/types';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import './PlayerStatsPage.css';
import { reportError } from '../utils/errorReporter';
import { AgentRakeService, type AgentRoleRow } from '../services/AgentRakeService';
import { StatsFactsService, type PlayerRakeStats } from '../services/StatsFactsService';
import { normalizeStatsContractMetadata } from '../services/statsContract';
import { buildStatsIntelligenceBrief } from '../components/stats/statsIntelligenceBrief';
import { capture } from '../lib/analytics';

// ── SWR Cache helpers (localStorage for cross-session persistence) ──
const STATS_CACHE_KEY = STATS_CACHE_PREFIX;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CachedFull {
  full: FullStats;
  cachedAt: number;
}

function getCachedFull(userId: string): CachedFull | null {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.cachedAt && Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    if (!parsed.full || typeof parsed.full !== 'object') return null;
    /**
     * NORMALIZE THE CACHE TOO (Dan 2026-08-25).
     *
     * normalizeFull exists because "an explicit null would survive JSON and
     * blow up the first .toFixed()/.toLocaleString() in the hero, taking the
     * whole page down" - and it was applied to the RPC path only. This path
     * calls setLoading(false) and paints the hero straight from localStorage,
     * so an entry written by an older build, or truncated by a quota-exceeded
     * write, reached the hero unguarded and threw before the network replied.
     * That is the exact shape of the incident this page's tests exist for:
     * green suite, blank page, error boundary with nothing in it.
     */
    return { full: normalizeFull(parsed.full), cachedAt: num(parsed.cachedAt, Date.now()) };
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

// Types, RANGES and num/str live in ./stats/types.ts (phase 2 split).

type StatCategory =
  | 'overview'
  | 'performance'
  | 'positions'
  | 'hands'
  | 'tournaments'
  | 'analysis'
  | 'trophies'
  | 'rake';

// Single source of truth for the tabs: the swipe handler and the pill row both
// read this, so they can never drift out of sync.
//
// PRIVACY: 'hands' is NOT in this list. It renders the 13x13 hole-card grid,
// which is built from ca_hand_facts.hole_cards — holdings that were never shown
// at showdown. /stats/:userId is an existing route that renders this page for
// any user, so the tab is appended for the profile owner only. The database
// refuses a cross-user read regardless (ca_assert_self), but a tab that exists
// and then errors is worse than a tab that was never offered.
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
  hands: 'Hands',
  tournaments: 'Tournaments',
  analysis: 'Analysis',
  trophies: 'Trophies',
  rake: 'Rake',
};

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
  contract: normalizeStatsContractMetadata(null),
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
    total_prizes: 0,
    total_bounty_winnings: 0,
    total_bounties: 0,
    net_profit: 0,
    roi: 0,
  },
  recent_tournaments: [],
};

/**
 * Harden the notable-hands payload (Dan 2026-08-25).
 *
 * The hand list is the only section that formatted RPC values directly:
 * `h.profit.toLocaleString()`, `h.pot_size.toLocaleString()`, `h.big_blind`,
 * `new Date(h.played_at)`. `data as HandRow[]` is a compile-time claim about
 * a runtime payload; one null column and the whole page goes to the error
 * boundary, because this is also the one numeric section with no PanelBoundary
 * around it. Both halves of that are fixed - this normalizer and the boundary.
 */
function normalizeHands(data: unknown): HandRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((h: any, i: number) => ({
    id: str(h?.id, `hand-${i}`),
    played_at: str(h?.played_at),
    variant: str(h?.variant, 'Unknown'),
    big_blind: num(h?.big_blind),
    is_tournament: h?.is_tournament === true,
    position: typeof h?.position === 'string' ? h.position : null,
    pot_size: num(h?.pot_size),
    won: num(h?.won),
    profit: num(h?.profit),
    is_winner: h?.is_winner === true,
    players: num(h?.players),
    board: Array.isArray(h?.board) ? h.board.filter((c: unknown) => typeof c === 'string') : null,
    hole_cards: h?.hole_cards ?? null,
  }));
}

function normalizeFull(data: any): FullStats {
  const o = data?.overall ?? {};
  const t = data?.tournaments ?? {};
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  const lt = data?.lifetime ?? {};

  return {
    contract: normalizeStatsContractMetadata(data),
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
      total_prizes: num(t.total_prizes),
      total_bounty_winnings: num(t.total_bounty_winnings),
      total_bounties: num(t.total_bounties),
      net_profit: num(t.net_profit),
      roi: num(t.roi),
    },
    recent_tournaments: arr(data?.recent_tournaments).map((x) => ({
      tournament_id: typeof x?.tournament_id === 'string' ? x.tournament_id : null,
      name: str(x?.name, 'Tournament'),
      start_time: x?.start_time ?? null,
      variant: x?.variant ?? null,
      is_mystery_bounty: x?.is_mystery_bounty === true,
      finish_rank: typeof x?.finish_rank === 'number' ? x.finish_rank : null,
      status: x?.status ?? null,
      prize: num(x?.prize),
      bounty_winnings: num(x?.bounty_winnings),
      bounties: num(x?.bounties),
      /* An older cached payload has no total_won and its `prize` was already
         the sum. Falling back to `prize` keeps such a row's net figure right
         rather than reporting a bounty-heavy result as a loss. */
      total_won: x?.total_won == null ? num(x?.prize) : num(x?.total_won),
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
    // requestAnimationFrame does not fire in a hidden tab, so a page opened in
    // the background read "0%" beside a correctly drawn arc until the next
    // frame. The value is the value, whatever the frame rate: settle it on a
    // timer as well (seen live 2026-09-03).
    const settle = window.setTimeout(() => setDisplay(target), duration + 50);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(settle);
    };
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
  // Math.min(100, Math.max(0, NaN)) is NaN, and NaN reaches strokeDashoffset
  // (silently dropped by the browser, so the arc renders FULL) and the label
  // (rendered as "NaN%"). A non-finite input is a bug upstream; refuse it here
  // rather than drawing a confident 100% ring.
  const value = Number.isFinite(handsWonPct) ? Math.min(100, Math.max(0, handsWonPct)) : 0;
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

export default function PlayerStatsPage() {
  const { userId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();

  const targetUserId = userId || user?.id;
  const isOwnProfile = !userId || userId === user?.id;
  const [full, setFull] = useState<FullStats | null>(null);
  // Keep the payload scope explicit. A failed range request must never leave
  // old numbers on screen under the newly selected range label.
  const loadedRangeKeyRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [servingCache, setServingCache] = useState(false);
  const [rangeKey, setRangeKey] = useState<string>('all');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [statsDataSource, setStatsDataSource] = useState<'live' | 'memory cache' | 'saved cache'>(
    'live'
  );
  /**
   * PRINT DOSSIER
   *
   * The export buttons used to dump raw CSV. A dossier needs the charts, and
   * the three obvious ways to make a PDF were all worse than this one:
   *   - jspdf + html2canvas: ~400KB of bundle on a mobile-first product, for a
   *     rarely-used export, and charts come out as soft rasterised images.
   *   - headless Chrome on the engine box: the engine runs live poker and is
   *     latency-critical. Spawning Chrome next to it to render a report is a
   *     bad trade for gameplay.
   *   - a Vercel render function: cross-repo, near the 50MB function ceiling
   *     with bundled chromium, plus cold starts to babysit.
   *
   * The browser already has an excellent PDF engine. Rendering every tab at
   * once and handing it a proper print stylesheet gives real vector text,
   * selectable and crisp, at zero bundle cost and zero server load. "Save as
   * PDF" is in every print dialog on desktop, and on the Share sheet on
   * mobile.
   */
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const done = () => setPrinting(false);
    /**
     * NO `beforeprint` ARM (Dan 2026-08-25).
     *
     * There was one, and it could never have worked: `beforeprint` is
     * synchronous - the browser starts paginating the moment the handlers
     * return - so a React state update scheduled inside it cannot commit
     * first. Cmd-P printed the current tab regardless, which is exactly what
     * the removed comment claimed it fixed.
     *
     * The lazy chart split makes it unfixable in that form as well: arming
     * `printing` now needs three network round trips, and a synchronous event
     * cannot await them. Cmd-P honestly prints the tab you are on; the Dossier
     * button is the path that produces the complete report, and it preloads.
     */
    window.addEventListener('afterprint', done);
    return () => {
      window.removeEventListener('afterprint', done);
    };
  }, []);

  /**
   * ESCAPE HATCH for a stuck `printing` (Dan 2026-08-25).
   *
   * `afterprint` is not reliable on mobile Safari or in several in-app
   * browsers - the exact platforms this mobile-first product targets. When it
   * never fires, `printing` stays true, and because showTab() short-circuits
   * on it BEFORE checking the selected tab, changing tabs stopped doing
   * anything at all: every section rendered at once, three recharts containers
   * and the 13x13 heatmap included, and the Dossier button sat disabled
   * reading "Preparing Dossier..." with no way back except a reload.
   *
   * This is NOT the timer that was correctly removed: it does not fire on a
   * schedule after print(). It fires when the user comes back to the page,
   * which on every platform means the print sheet is gone.
   */
  useEffect(() => {
    if (!printing) return;
    const release = () => {
      if (document.visibilityState === 'visible') setPrinting(false);
    };
    window.addEventListener('focus', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('focus', release);
      document.removeEventListener('visibilitychange', release);
    };
  }, [printing]);

  const printTimerRef = useRef<number | null>(null);

  const printDossier = useCallback(async () => {
    setPrinting(true);
    // Every tab has to mount, recharts has to measure its ResponsiveContainers,
    // and the framer-motion entrances have to settle. Charts are handed
    // `still` while printing so their own 1500ms recharts animation is off,
    // but the layout pass still needs a moment. 1200ms is generous enough that
    // nothing is caught mid-draw and short enough not to feel broken.
    //
    // There is deliberately NO timed fallback that clears `printing`. The
    // previous one fired 1s after print(), and on Safari and mobile - where
    // print() returns IMMEDIATELY rather than blocking - it collapsed the
    // dossier back to a single tab while the print preview was still open,
    // which is precisely the failure it was meant to guard against. `printing`
    // is cleared by the afterprint listener, with a focus/visibility release
    // above as the escape hatch for the platforms where afterprint never
    // fires (a stuck `printing` makes the tab strip inert, see showTab).
    /**
     * AWAIT THE LAZY CHUNKS FIRST (Dan 2026-08-25).
     *
     * The three chart components are lazy now, and the default tab is Overview
     * - which is the entire point of the split - so when the user presses this
     * button their chunks have usually never been requested. The 1200ms budget
     * below was sized for a layout pass, not a network round trip, so on a cold
     * cache window.print() fired while the Suspense boundaries were still
     * showing their fallbacks and the PDF captured the literal text
     * "Loading Charts...". A dossier is the copy someone reads months later as
     * authoritative; it does not get to contain a spinner.
     *
     * import() is idempotent and the module registry caches it, so after this
     * resolves the lazy components render synchronously. A chunk that fails to
     * load is left to PanelBoundary - we still print the rest.
     */
    await Promise.all([
      import('./stats/RakeTab'),
      import('./stats/OverviewTab'),
      import('./stats/PerformanceTab'),
      import('./stats/PositionsTab'),
      import('./stats/HandsTab'),
      import('./stats/TrophiesTab'),
      import('./stats/TournamentsTab'),
      import('./stats/AnalysisTab'),
      import('../components/stats/StatsCharts'),
      import('../components/stats/EVLuckChart'),
      import('../components/stats/BankrollTracker'),
      import('../components/stats/PositionWinRates'),
      import('../components/stats/PositionalRadar'),
      import('../components/stats/HoleCardHeatmap'),
      import('../components/stats/NemesisPanel'),
      import('../components/stats/BenchmarkPanel'),
      import('../components/stats/TrophyRoom'),
      import('../components/stats/StatsShareCard'),
      import('../components/stats/SessionHistory'),
      import('../components/stats/AdvancedStatsSummary'),
      import('../components/agent/DownlineRakePanel'),
    ]).catch(() => undefined);

    if (printTimerRef.current !== null) window.clearTimeout(printTimerRef.current);
    printTimerRef.current = window.setTimeout(() => {
      printTimerRef.current = null;
      window.print();
    }, 1200);
  }, []);

  useEffect(
    () => () => {
      if (printTimerRef.current !== null) window.clearTimeout(printTimerRef.current);
    },
    []
  );

  // Component-scope so the fact-layer panels (EV curve, heatmap, rivals) share
  // the SAME range the main RPC was loaded with. It used to be a local inside
  // the loader, which meant anything rendered outside that closure had no way
  // to honour the range selector.
  const windowDays = useMemo<number | null>(
    () => RANGES.find((r) => r.key === rangeKey)?.days ?? null,
    [rangeKey]
  );
  const [handMode, setHandMode] = useState<HandMode>('biggest_won');
  const [hands, setHands] = useState<HandRow[] | null>(null);
  const [handsLoading, setHandsLoading] = useState(false);
  const [handsError, setHandsError] = useState(false);
  /** Bumped to re-run the hands effect; a retry must not depend on changing a filter. */
  const [handsReload, setHandsReload] = useState(0);
  const [category, setCategory] = useState<StatCategory>('overview');
  const shortcutDestinationRef = useRef<StatCategory | null>(null);
  /**
   * A tab renders when it is selected, OR when the dossier is printing — that
   * is how one set of section markup serves both the tabbed screen view and a
   * complete printed report, with no duplicated JSX to drift apart.
   */
  const showTab = useCallback(
    (t: StatCategory) => printing || category === t,
    [printing, category]
  );

  // RAKE REPORTING IS AN AGENT PRIVILEGE. A player sees no Rake tab at all
  // until they are promoted; the RPCs refuse them regardless, this just keeps
  // the tab from appearing. It is also hidden when looking at someone else's
  // stats page — an agent's book is theirs, not a public profile field.
  const [agentRoles, setAgentRoles] = useState<AgentRoleRow[] | null>(null);

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

  // POLISH 1 (Dan 2026-08-30): the player's OWN weighted rake. Cent-exact,
  // from the same allocator the money pipeline uses. Own profile only — the
  // RPC derives identity from auth.uid() and would refuse anyone else anyway.
  const [rakeStats, setRakeStats] = useState<PlayerRakeStats | null>(null);
  const [rakeLoading, setRakeLoading] = useState(false);
  useEffect(() => {
    if (!isOwnProfile || !user?.id) {
      setRakeStats(null);
      setRakeLoading(false);
      return;
    }
    let cancelled = false;
    // Defensive by doctrine: a stale cached bundle (or any build where this
    // method is absent) must degrade to "no rake panel", never take the whole
    // stats page down with it.
    const load = StatsFactsService?.getRakeStats;
    if (typeof load !== 'function') {
      setRakeStats(null);
      setRakeLoading(false);
      return;
    }
    setRakeLoading(true);
    setRakeStats(null);
    void load
      .call(StatsFactsService, windowDays)
      .then((r) => {
        if (!cancelled) setRakeStats(r);
      })
      .catch(() => {
        if (!cancelled) setRakeStats(null);
      })
      .finally(() => {
        if (!cancelled) setRakeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile, user?.id, windowDays]);

  const canSeeRake = (agentRoles?.length ?? 0) > 0;
  const TABS = useMemo<StatCategory[]>(() => {
    // Owner-only tabs are spliced in next to the tab they belong with, so the
    // order still derives from BASE_TABS and the two cannot drift.
    const out: StatCategory[] = [];
    for (const t of BASE_TABS) {
      out.push(t);
      if (isOwnProfile && t === 'positions') out.push('hands');
      if (isOwnProfile && t === 'analysis') out.push('trophies');
    }
    return canSeeRake || isOwnProfile ? [...out, 'rake'] : out;
  }, [canSeeRake, isOwnProfile]);

  // If the tab disappears (role revoked, or navigating to another profile),
  // do not strand the view on a tab that no longer exists.
  useEffect(() => {
    if (!TABS.includes(category)) setCategory('overview');
  }, [TABS, category]);

  useEffect(() => {
    if (category === 'rake' && !canSeeRake && !isOwnProfile) setCategory('overview');
  }, [category, canSeeRake, isOwnProfile]);
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
  const selectSection = useCallback((section: StatCategory, reveal = false) => {
    if (reveal) shortcutDestinationRef.current = section;
    setCategory(section);
  }, []);
  const toast = useToast();
  const isMounted = useIsMounted();
  const hasStatsRef = useRef(false);
  const statsLoadingRef = useRef(false);
  // A refresh arriving while one is in flight is remembered and replayed once
  // instead of dropped: the bus events are debounced, not queued, so a discarded
  // HAND_COMPLETED used to leave the page stale until some later event.
  const pendingRefreshRef = useRef(false);
  const activeRangeKeyRef = useRef(rangeKey);
  const changeRange = useCallback((nextRangeKey: string) => {
    if (nextRangeKey === activeRangeKeyRef.current) return;
    // Clear the prior scope before changing the label. A matching per-range
    // memo may hydrate immediately; otherwise the page shows its loader/error
    // state instead of relabelling stale figures.
    setFull(null);
    loadedRangeKeyRef.current = null;
    hasStatsRef.current = false;
    setServingCache(false);
    setLoadError(false);
    setLoading(true);
    activeRangeKeyRef.current = nextRangeKey;
    setRangeKey(nextRangeKey);
  }, []);
  /**
   * The CURRENT loader. Both the shared debouncer and the in-flight replay
   * below read it, so neither can fire a copy captured under an older range.
   */
  const loadRef = useRef<((opts?: { fresh?: boolean }) => Promise<void>) | null>(null);
  const openHandEvidence = useCallback(
    (filters: { variant?: string; position?: string; bigBlind?: number } = {}) => {
      const params = new URLSearchParams({ source: 'stats' });
      if (filters.variant) params.set('variant', filters.variant);
      if (filters.position) params.set('position', filters.position);
      if (filters.bigBlind) params.set('bigBlind', String(filters.bigBlind));
      if (windowDays) {
        const to = new Date();
        const from = new Date(to);
        from.setDate(from.getDate() - windowDays + 1);
        params.set('from', from.toISOString().slice(0, 10));
        params.set('to', to.toISOString().slice(0, 10));
      }
      navigate(`/hand-history?${params.toString()}`);
    },
    [navigate, windowDays]
  );
  // The index refresh is a WRITE. Un-throttled it fired on every bus refresh and
  // every tab-visibility change, i.e. repeatedly during active play.

  // ── Single RPC pulls everything from hand_history server-side ──
  const loadAllData = useCallback(
    async (opts?: { fresh?: boolean }): Promise<void> => {
      if (!targetUserId || !isOwnProfile) return;
      const loadStartedAt = performance.now();
      if (statsLoadingRef.current) {
        pendingRefreshRef.current = true;
        return;
      }
      // `fresh` means "something changed" - a bus event, a tab return, a retry.
      // Those drop the memo entirely rather than reading it, so this can never
      // serve a stale number in the one situation where staleness matters.
      if (opts?.fresh) {
        clearStatsRangeMemo();
      } else {
        const memo = readStatsRangeMemo(targetUserId, rangeKey) as FullStats | null;
        if (memo) {
          setFull(memo);
          loadedRangeKeyRef.current = rangeKey;
          setLastUpdatedAt(
            memo.contract?.generated_at ? Date.parse(memo.contract.generated_at) : Date.now()
          );
          setStatsDataSource('memory cache');
          hasStatsRef.current = true;
          setLoadError(false);
          setServingCache(false);
          setLoading(false);
          return;
        }
      }
      statsLoadingRef.current = true;
      if (!hasStatsRef.current) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        const { data, error } = await retryFetch(
          () =>
            supabase
              .rpc('ca_player_stats_overview_v2', {
                p_user: targetUserId,
                p_days: windowDays,
              })
              .then((r: any) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );

        if (!isMounted.current) return;

        // A slow response for the previous analysis window must never paint
        // underneath the newly selected label. The pending replay below will
        // request the current range as soon as this obsolete read unwinds.
        if (activeRangeKeyRef.current !== rangeKey) {
          pendingRefreshRef.current = true;
          return;
        }

        const contract = normalizeStatsContractMetadata(data);
        if (!error && data && data.overall && contract.valid) {
          const resolved = normalizeFull(data);
          const loadedAt = resolved.contract.generated_at
            ? Date.parse(resolved.contract.generated_at)
            : Date.now();
          setFull(resolved);
          loadedRangeKeyRef.current = rangeKey;
          setLastUpdatedAt(loadedAt);
          setStatsDataSource('live');
          hasStatsRef.current = true;
          setLoadError(false);
          setServingCache(false);
          // Only the unbounded view is cached — otherwise a 7-day payload could be
          // rehydrated on the next visit and read as all-time.
          if (windowDays === null) setCachedFull(targetUserId, resolved);
          writeStatsRangeMemo(targetUserId, rangeKey, resolved);
          capture('stats_rpc_load', {
            duration_ms: Math.round(performance.now() - loadStartedAt),
            payload_bytes: (() => {
              try {
                return new Blob([JSON.stringify(data)]).size;
              } catch {
                return 0;
              }
            })(),
            range: rangeKey,
            cache_source: 'network',
            outcome: 'success',
          });

          // A PAGE VIEW MUST NOT TRIGGER A MAINTENANCE JOB. (removed 2026-08-24)
          //
          // This used to fire ca_refresh_hand_player_index({ p_max_hands: 3000 })
          // whenever a player opened their stats page. The comment claimed the
          // batch was "sized to finish inside the 8s statement_timeout".
          // Production disagreed: pg_stat_statements put that RPC at a 73,901 ms
          // MEAN and a 173,487 ms max, and it was caught live in pg_stat_activity
          // at 26.9s waiting on IO/DataFileRead - i.e. dragging the 10GB
          // hand_history table off disk and evicting everyone else's working set
          // from shared_buffers. That is why unrelated queries all over the
          // platform went slow at once; a trivial PostgREST health probe was
          // taking 14.4 SECONDS while raw Postgres answered the same shape in
          // 0.17ms.
          //
          // The 5-minute guard below did not bound it either: lastIndexRefreshRef
          // is per component instance, so it throttled one tab, not the platform.
          //
          // It is already done properly server-side:
          // pages/api/cron/club-stats-maintenance.js runs the same RPC every 15
          // minutes with p_max_hands: 60000, under service_role, off the request
          // path. That route's own comment records the decision to own it there.
          // So this call was redundant as well as harmful, and the index it
          // maintains stays just as fresh without it.
        } else {
          if (hasStatsRef.current && loadedRangeKeyRef.current === rangeKey) {
            // Something is already on screen (cache or an earlier load). Keep it,
            // but say it is stale rather than pretending it is current.
            setServingCache(true);
          } else {
            setFull(null);
            loadedRangeKeyRef.current = null;
            hasStatsRef.current = false;
            setLoadError(true);
          }
          if (error) reportError(error, 'PlayerStatsPage.rpc_ca_player_stats_overview_v2');
          capture('stats_rpc_load', {
            duration_ms: Math.round(performance.now() - loadStartedAt),
            payload_bytes: 0,
            range: rangeKey,
            cache_source:
              hasStatsRef.current && loadedRangeKeyRef.current === rangeKey ? 'cache' : 'none',
            outcome: 'error',
          });
        }
      } catch (err: any) {
        // retryFetch throws when the component goes away mid-flight; that is a
        // navigation, not an application error worth reporting.
        const unmounted = err instanceof Error && /unmounted/i.test(err.message || '');
        if (!unmounted) {
          capture('stats_rpc_load', {
            duration_ms: Math.round(performance.now() - loadStartedAt),
            payload_bytes: 0,
            range: rangeKey,
            cache_source: hasStatsRef.current ? 'cache' : 'none',
            outcome: 'exception',
          });
          reportError(err, 'PlayerStatsPage.Failed_to_load_stats');
          if (isMounted.current) {
            if (hasStatsRef.current && loadedRangeKeyRef.current === rangeKey) {
              setServingCache(true);
            } else {
              setFull(null);
              loadedRangeKeyRef.current = null;
              hasStatsRef.current = false;
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
          // loadRef, not the closed-over loadAllData: if the user changed the
          // range while a load was in flight, replaying the old closure refetched
          // the PREVIOUS window and overwrote the newer data with it.
          void loadRef.current?.({ fresh: true });
        } else if (isMounted.current) {
          setRefreshing(false);
        }
      }
      // toast comes from context and isMounted is a ref wrapper: both stable.
    },
    [targetUserId, isOwnProfile, rangeKey, windowDays, toast, isMounted]
  );

  // Notable hands. Loaded only when the Analysis tab is actually open — the
  // 'biggest' modes score the whole analysis window, so this is not free.
  useEffect(() => {
    if (!targetUserId || !isOwnProfile || category !== 'analysis') return;
    let alive = true;
    setHandsLoading(true);
    setHandsError(false);
    supabase
      .rpc('ca_player_hands_v2', {
        p_user: targetUserId,
        p_mode: handMode,
        p_limit: 10,
      })
      .then(
        ({ data, error }: any) => {
          if (!alive || !isMounted.current) return;
          if (error) {
            // An empty list and a failed read are different statements. This
            // used to render both as "No Hands In This Range Yet." - the same
            // lie about a player's history that this page was rebuilt to stop
            // telling, reintroduced one section further down.
            reportError(error, 'PlayerStatsPage.rpc_ca_player_hands_v2');
            setHandsError(true);
            setHands([]);
          } else {
            // The only place on this page that formats numbers straight off the
            // wire. `as HandRow[]` is a compile-time claim, not a runtime one,
            // so harden here the way normalizeFull hardens the main payload.
            setHands(normalizeHands(data));
          }
          setHandsLoading(false);
        },
        (err: unknown) => {
          if (!alive || !isMounted.current) return;
          reportError(err, 'PlayerStatsPage.rpc_ca_player_hands_v2');
          setHandsError(true);
          setHands([]);
          setHandsLoading(false);
        }
      );
    return () => {
      alive = false;
    };
    // rangeKey is deliberately NOT a dependency: ca_player_hands_v2 is declared
    // (uuid, text, int) and takes no window argument, so re-running it on a
    // range change fired an identical, expensive query whose result could not
    // differ. The list is all-time and the empty state now says so.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId, isOwnProfile, category, handMode, handsReload]);

  /**
   * Keep the selected pill visible. The strip scrolls now (see the CSS), and
   * both the swipe gesture and the Arrow keys can move `category` to a tab that
   * is off-screen - so the user would have no idea which view they were on.
   */
  useEffect(() => {
    const tab = document.getElementById(`stats-tab-${category}`);
    tab?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
    if (shortcutDestinationRef.current !== category) return;
    shortcutDestinationRef.current = null;
    tab?.focus();
    document.getElementById(`stats-panel-${category}`)?.scrollIntoView({
      inline: 'nearest',
      block: 'start',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [category, reduceMotion]);

  /* Kept current for the debouncer and the in-flight replay above.
   *
   * ASSIGNED IN A LAYOUT EFFECT, NOT DURING RENDER. This used to be a bare
   * `loadRef.current = loadAllData` at render scope. Mutating a ref while
   * rendering is a side effect in a function React is allowed to call more than
   * once and to throw away - StrictMode double-invokes it in development, and
   * concurrent rendering may abandon a render entirely - so an abandoned render
   * could leave the ref pointing at a loader belonging to state that was never
   * committed. That is precisely the stale-closure bug the ref exists to prevent,
   * reintroduced one level up.
   *
   * useLayoutEffect runs synchronously after every commit and before paint, and
   * both readers are post-commit: one is inside an async load's `finally`, the
   * other inside a setTimeout owned by a MasterBus subscription created in a
   * passive effect. Passive effects run after layout effects, so the ref is
   * always populated before anything can read it.
   */
  useLayoutEffect(() => {
    loadRef.current = loadAllData;
  });

  useLayoutEffect(() => {
    activeRangeKeyRef.current = rangeKey;
  }, [rangeKey]);

  // A tab return means time has passed, so it CLEARS the memo and refetches.
  useVisibilityRefresh(() => loadAllData({ fresh: true }));

  // SWR: show cached stats instantly on mount
  useEffect(() => {
    if (!targetUserId || !isOwnProfile) return;
    const cached = getCachedFull(targetUserId);
    if (cached) {
      setFull(cached.full);
      loadedRangeKeyRef.current = 'all';
      setLastUpdatedAt(
        cached.full.contract.generated_at
          ? Date.parse(cached.full.contract.generated_at)
          : cached.cachedAt
      );
      setStatsDataSource('saved cache');
      hasStatsRef.current = true;
      setLoading(false);
    }
  }, [targetUserId, isOwnProfile]);

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
    if (targetUserId && isOwnProfile) void loadAllData();
  }, [targetUserId, isOwnProfile, loadAllData]);

  /**
   * ── Bus listeners: ONE debounce window, not five ────────────────────────
   *
   * MEASURED 2026-08-25. The underlying overview rollup costs 2.6s warm and 15s COLD for
   * a heavy account, against an 8s statement_timeout on the `authenticated`
   * role. This used to be five INDEPENDENT `subscribeDebounced` calls, each
   * with its own 2000ms window - and a single completed hand emits
   * HAND_COMPLETED, BALANCE_UPDATED and CHIPS_DISTRIBUTED within milliseconds
   * of each other. Three windows, three refetches per hand, plus the
   * pendingRefreshRef replay for a fourth.
   *
   * So a player sitting on this page with one table running was asking the
   * database for up to four multi-second scans of a 10GB table per hand. One
   * shared debouncer collapses that to one.
   *
   * The handler goes through a ref so the replay and the timer always call the
   * CURRENT loader: `loadAllData` closes over `rangeKey`, and firing a stale
   * copy refetches the previous window and overwrites newer data with it.
   */
  useEffect(() => {
    const REFRESH_EVENTS = [
      'HAND_COMPLETED',
      'BALANCE_UPDATED',
      'CHIPS_DISTRIBUTED',
      'CASHOUT_APPROVED',
      'CREDIT_UPDATED',
    ] as const;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadRef.current?.({ fresh: true });
      }, 2000);
    };

    const unsubs = REFRESH_EVENTS.map((e) => masterBus.subscribe(e as never, schedule));

    /**
     * LIVE FROM ANY TAB (2026-09-03). masterBus only carries events for the
     * tables THIS tab is watching, so a player grinding in one tab with Stats
     * open in another never saw a refresh. The hand_history trigger now writes
     * one ca_hand_player_idx row per seat the moment a hand is recorded, and
     * that table is in the realtime publication with an owner-only policy - so
     * this subscription fires for exactly the hands this player was dealt
     * into, wherever they were played, and nothing else. It feeds the SAME
     * debouncer as the bus, so a hand that arrives by both routes still costs
     * one refetch.
     */
    const channelKey = targetUserId && isOwnProfile ? `stats-live-${targetUserId}` : null;
    if (channelKey) {
      masterBus
        .getOrCreateChannel(channelKey)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'ca_hand_player_idx',
            filter: `user_id=eq.${targetUserId}`,
          },
          schedule
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR' && err) {
            reportError(err, 'PlayerStatsPage.realtime_channel_error');
          }
        });
    }

    return () => {
      if (timer) clearTimeout(timer);
      unsubs.forEach((u) => u());
      if (channelKey) masterBus.removeRegisteredChannel(channelKey);
    };
    // loadRef is a ref wrapper; the only real dependency is whose hands to
    // listen for. Re-subscribing on a range change would drop a pending
    // debounce window on the floor, so rangeKey is deliberately not here.
  }, [targetUserId, isOwnProfile]);

  /**
   * ALL-TIME PAYLOAD FOR LIFETIME READOUTS (2026-09-03).
   *
   * TrophyRoom used to be fed the range-windowed `overall`, so every milestone
   * ("Play 10,000 hands", "Log 50 hours") was re-judged against 7/30/90 days
   * and switching the range un-earned trophies. When the page range is "All"
   * the current payload IS the all-time one; otherwise the all-time payload is
   * fetched once, lazily, only while the Trophies tab is open, through the same
   * per-range memo the range buttons use - so returning to "All" costs nothing.
   */
  const [allTimeFetched, setAllTimeFetched] = useState<FullStats | null>(null);
  const [allTimeError, setAllTimeError] = useState(false);
  const [allTimeReload, setAllTimeReload] = useState(0);
  // The share card's style badge is a lifetime reading too (Overview tab).
  const wantsAllTime = category === 'trophies' || category === 'overview' || printing;
  useEffect(() => {
    if (!targetUserId || !isOwnProfile || !wantsAllTime || rangeKey === 'all') return;
    const memo = readStatsRangeMemo(targetUserId, 'all') as FullStats | null;
    if (memo) {
      setAllTimeFetched(memo);
      setAllTimeError(false);
      return;
    }
    let cancelled = false;
    setAllTimeError(false);
    supabase.rpc('ca_player_stats_overview_v2', { p_user: targetUserId, p_days: null }).then(
      ({ data, error }: any) => {
        if (cancelled || !isMounted.current) return;
        const contract = normalizeStatsContractMetadata(data);
        if (error || !data?.overall || !contract.valid) {
          if (error) reportError(error, 'PlayerStatsPage.rpc_all_time_for_trophies');
          setAllTimeError(true);
          return;
        }
        const resolved = normalizeFull(data);
        writeStatsRangeMemo(targetUserId, 'all', resolved);
        setAllTimeFetched(resolved);
      },
      (err: unknown) => {
        if (cancelled || !isMounted.current) return;
        reportError(err, 'PlayerStatsPage.rpc_all_time_for_trophies');
        setAllTimeError(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [targetUserId, isOwnProfile, wantsAllTime, rangeKey, allTimeReload, isMounted]);
  const allTimeStats: FullStats | null = rangeKey === 'all' ? full : allTimeFetched;

  // Style label for the share card. Shared with TrophyRoom so the two can
  // never disagree about what style a player is - see playerStyleFromStats.
  const shareStyle = useMemo(
    () => playerStyleFromStats(allTimeStats?.overall ?? full?.overall),
    [allTimeStats?.overall, full?.overall]
  );

  const overall = full?.overall ?? EMPTY_OVERALL;
  const lifetime = full?.lifetime ?? EMPTY_LIFETIME;
  const tourn = full?.tournaments ?? EMPTY_FULL.tournaments;
  const statsContract = full?.contract ?? EMPTY_FULL.contract;

  /**
   * ONE source of truth, as a NUMBER (Dan 2026-08-25).
   *
   * This was a pre-formatted string, and the gauge took `parseFloat` of it
   * while BenchmarkPanel recomputed the same thing from the counts with a
   * comment explaining why the string must not be reused. Two derivations of
   * one number, and the string round-trip was the path by which a NaN could
   * reach strokeDashoffset - where the browser drops it silently and the arc
   * renders FULL.
   */
  const handsWonPct = useMemo(
    () => (overall.total_hands > 0 ? (overall.hands_won / overall.total_hands) * 100 : 0),
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

  /** Text alternatives for the three charts, from the same memos they plot. */
  const profitChartSummary = useMemo(() => {
    if (dailySeries.length === 0) return 'No cash results in this range.';
    const last = dailySeries[dailySeries.length - 1];
    const best = dailySeries.reduce((a, b) => (b.profit > a.profit ? b : a));
    const worst = dailySeries.reduce((a, b) => (b.profit < a.profit ? b : a));
    return `Cumulative cash profit across ${dailySeries.length.toLocaleString()} days, ${dailySeries[0].date} to ${last.date}, ending at ${last.cumulative.toLocaleString()}. Best day ${best.date} at ${best.profit.toLocaleString()}. Worst day ${worst.date} at ${worst.profit.toLocaleString()}.`;
  }, [dailySeries]);

  const dailyChartSummary = useMemo(() => {
    if (dailySeries.length === 0) return 'No daily results in this range.';
    const up = dailySeries.filter((d) => d.profit > 0).length;
    return `Daily cash result for ${dailySeries.length.toLocaleString()} days. ${up.toLocaleString()} winning days, ${(dailySeries.length - up).toLocaleString()} losing or break-even.`;
  }, [dailySeries]);

  const positionChartSummary = useMemo(() => {
    if (positionPie.length === 0) return 'No positional data in this range.';
    return `Hands won by position: ${positionPie
      .map((p) => `${p.name} ${p.value.toLocaleString()}`)
      .join(', ')}.`;
  }, [positionPie]);

  const intelligenceBrief = useMemo(
    () =>
      buildStatsIntelligenceBrief({
        overall,
        positions: full?.positions,
        variants: full?.variants,
        daily: full?.daily,
        windowDays,
      }),
    [overall, full?.positions, full?.variants, full?.daily, windowDays]
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
  const rangeLabel = RANGES.find((r) => r.key === rangeKey)?.label ?? 'All';
  // A panel that threw on one range's payload gets another go on the next.
  const panelResetKey = `${targetUserId ?? ''}:${rangeKey}:${lastUpdatedAt ?? 0}`;

  const exportSessionsCSV = () => {
    try {
      // buy_in, cash_out and ended are on every SessionRow and were dropped.
      // They are the figures anyone reconciling a bankroll in a spreadsheet
      // actually needs - profit alone cannot tell you what you sat down with.
      // Appended, not inserted, so an existing import template still works.
      // The range is recorded too: a file exported under "7 Days" was
      // indistinguishable from a lifetime export once it left the browser.
      exportToCSV(
        sessionRows.map((s) => ({
          date: new Date(s.date).toLocaleString(),
          ended: s.ended ? new Date(s.ended).toLocaleString() : '',
          duration_minutes: s.duration_minutes,
          hands: s.hands_played,
          buy_in: s.buy_in,
          cash_out: s.cash_out,
          profit: s.profit_loss,
          analysis_window: RANGES.find((r) => r.key === rangeKey)?.label ?? 'All Time',
        })),
        `player_session_history_${rangeKey}.csv`,
        [
          { key: 'date', label: 'Started' },
          { key: 'ended', label: 'Ended' },
          { key: 'duration_minutes', label: 'Duration (Min)' },
          { key: 'hands', label: 'Hands' },
          { key: 'buy_in', label: 'Buy In' },
          { key: 'cash_out', label: 'Cash Out' },
          { key: 'profit', label: 'Profit' },
          { key: 'analysis_window', label: 'Analysis Window' },
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
        /* Section 37: the export carries the halves as well as the sum, so a
           spreadsheet can separate placement money from bounty money without
           re-deriving one from the other. */
        tournament_total_prizes: tourn.total_prizes,
        tournament_total_bounty_winnings: tourn.total_bounty_winnings,
        tournament_total_bounties: tourn.total_bounties,
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

  // Phase 1 security boundary. The legacy route accepted any player UUID and
  // the SECURITY DEFINER RPC returned that player's all-club financial data.
  // Shared-club views return in phase 3 only after the database can enforce a
  // club scope; until then the honest and safe result is an explicit private
  // state, with no request and no target-bound cache hydration.
  if (!isOwnProfile) {
    return (
      <div className="stats-page">
        <div className="stats-empty-state" role="status">
          <span className="empty-icon" aria-hidden="true">
            {'!'}
          </span>
          <span className="empty-title">Player Stats Are Private</span>
          <span className="empty-description">
            Cross-Player Statistics Require An Authorized Shared-Club View. No All-Club Financial
            Data Is Exposed From This Profile.
          </span>
          <button className="empty-cta" onClick={() => navigate('/')}>
            Back To Club Arena
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="stats-page stats-page-loading" aria-busy="true">
        <section className="stats-command-deck stats-command-deck-loading">
          <img
            className="stats-hero-art"
            src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-dossier-v2.webp`}
            alt=""
            aria-hidden="true"
            fetchPriority="high"
            decoding="async"
          />
          <div className="stats-command-copy">
            <span className="stats-eyebrow">Club Arena // Player Analytics</span>
            <h1>Player Intelligence</h1>
            <p>Opening Your Performance Dossier...</p>
          </div>
          <div className="stats-loading-readout">
            <span />
            <span />
            <span />
          </div>
        </section>
        <div className="stats-loading-details">
          <PageSkeleton variant="stats" />
        </div>
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
            Your Statistics Are Still There - We Just Could Not Reach Them Right Now.
          </span>
          <button
            className="empty-cta"
            onClick={() => {
              setLoadError(false);
              setLoading(true);
              void loadAllData({ fresh: true });
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
        Play Some Hands At The Tables And Your Statistics Will Appear Here Automatically.
      </span>
      <button className="empty-cta" onClick={() => navigate('/')}>
        Go To Lobby
      </button>
    </div>
  );

  return (
    <div className="stats-page">
      {/* ── COMMAND DECK ─────────────────────────────────────────────────────
          The artwork is deliberately data-free. All player figures remain live,
          selectable HTML so a new RPC response never requires a new image. */}
      <section className="stats-command-deck" aria-labelledby="stats-page-title">
        <img
          className="stats-hero-art"
          src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-dossier-v2.webp`}
          alt=""
          aria-hidden="true"
          fetchPriority="high"
          decoding="async"
        />

        <div className="stats-command-copy">
          <span className="stats-eyebrow">Club Arena // Player Analytics</span>
          <h1 id="stats-page-title">Player Intelligence</h1>
          <p>Every Recorded Hand, Distilled Into Patterns You Can Use At The Next Table.</p>

          {/* Analysis range. Everything below the hero is computed over this window. */}
          <div className="stats-range-control">
            <span className="stats-range-label">
              Analysis Window
              <span
                className={`stats-range-status ${refreshing ? 'is-refreshing' : ''}`}
                role="status"
              >
                {refreshing
                  ? 'Updating'
                  : !statsContract.valid
                    ? 'Unavailable'
                    : statsContract.quality.live_tail_included
                      ? 'Live'
                      : 'Snapshot'}
              </span>
            </span>
            <div className="stats-range-row" role="group" aria-label="Analysis Range">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  className={rangeKey === r.key ? 'active' : ''}
                  aria-pressed={rangeKey === r.key}
                  onClick={() => changeRange(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {lastUpdatedAt && (
              <time className="stats-last-updated" dateTime={new Date(lastUpdatedAt).toISOString()}>
                Updated{' '}
                {new Date(lastUpdatedAt).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })}{' '}
                · {statsDataSource}
              </time>
            )}
          </div>
        </div>

        <div className="stats-hero" role="group" aria-label="Headline Performance">
          <HandsWonGauge handsWonPct={handsWonPct} />
          <div className="hero-stats">
            <div className="hero-stat">
              <span className="hero-stat-label">
                {lifetime.hands > overall.total_hands ? 'Hands Played' : 'Total Hands'}
              </span>
              <span className="hero-stat-value cyan">
                {Math.max(lifetime.hands, overall.total_hands).toLocaleString()}
              </span>
              {lifetime.hands > overall.total_hands && (
                <span className="hero-stat-sub">
                  {overall.total_hands.toLocaleString()} Analysed
                </span>
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
      </section>

      {/* Analysis-window and staleness notices: never present a truncated or
          stale figure as though it were a current lifetime total. */}
      <div className="stats-notice-deck" aria-live="polite">
        {hasData && overall.hands_capped && (
          <div className="stats-notice">
            Based On Your Most Recent {overall.hand_cap.toLocaleString()} Hands
            {rangeKey !== 'all' ? ' In This Range' : ''}.
          </div>
        )}
        {hasData && !overall.hands_capped && rangeKey !== 'all' && (
          <div className="stats-notice">
            {overall.total_hands.toLocaleString()} Hands In The Last{' '}
            {RANGES.find((r) => r.key === rangeKey)?.label}.
          </div>
        )}
        {/* Small samples: bb/100 swings wildly over a few hundred hands, and a
          confident-looking number invites the wrong conclusion. */}
        {/* indexed_complete is parsed by normalizeFull and was read nowhere. A
          player whose backfill is incomplete saw a confident lifetime figure
          that would change tomorrow, on a page whose whole design rule is
          "never present a truncated figure as a lifetime total". */}
        {hasData && !lifetime.indexed_complete && (
          <div className="stats-notice">
            Older Hands Are Still Being Indexed. These Totals Will Grow.
          </div>
        )}
        {hasData && overall.cash_hands > 0 && overall.cash_hands < 1000 && (
          <div className="stats-notice">
            {overall.cash_hands.toLocaleString()} Cash Hands Is A Small Sample - Win Rate Is Not Yet
            Meaningful.
          </div>
        )}
        {/* The money source is measured per payload now (see the v2 RPC): the
            engine's own settlement row is used wherever one exists, and the
            action reconstruction only for the hands that predate it. Say which,
            with the count, rather than a blanket warning on every load. */}
        {hasData &&
          overall.cash_hands > 0 &&
          !statsContract.quality.cash_money_exact &&
          statsContract.quality.cash_money_source === 'mixed' && (
            <div className="stats-notice">
              {statsContract.quality.exact_cash_hands.toLocaleString()} Of{' '}
              {overall.cash_hands.toLocaleString()} Cash Hands Use The Engine's Exact Settlement.
              The Rest Are Reconstructed From Recorded Actions.
            </div>
          )}
        {hasData &&
          overall.cash_hands > 0 &&
          statsContract.quality.cash_money_source === 'reconstructed_actions' && (
            <div className="stats-notice stats-notice-warn">
              Cash Result And BB/100 Are Reconstructed From Recorded Actions For This Window. No
              Exact Settlement Rows Exist For These Hands Yet.
            </div>
          )}
        {hasData && !statsContract.quality.historical_club_breakdown_available && (
          <div className="stats-notice">
            This Readout Is An Owner-Only All-Clubs Total. Club-Level Breakdown Is Not Available In
            This Contract.
          </div>
        )}
        {hasData &&
          !statsContract.quality.live_tail_included &&
          statsContract.coverage.rollup_covered_through && (
            <div className="stats-notice">
              Snapshot Includes Recorded Hands Through{' '}
              {new Date(statsContract.coverage.rollup_covered_through).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              . Newer Hands Appear After The Next Stats Rollup.
            </div>
          )}
        {servingCache && (
          <div className="stats-notice stats-notice-warn">
            Showing Your Last Loaded Stats - The Refresh Did Not Go Through.
          </div>
        )}
      </div>

      {hasData && (
        <section className="stats-intelligence-brief" aria-labelledby="stats-brief-title">
          <div className="stats-brief-head">
            <div>
              <span className="stats-section-kicker">Range Dossier // Scoped Readout</span>
              <h2 id="stats-brief-title">Evidence At A Glance</h2>
            </div>
            <p>
              Sample-Aware Facts From This Window. Coaching Requires A Persisted Assistant Report.
            </p>
          </div>

          <div className="stats-brief-grid">
            {intelligenceBrief.map((item, index) => (
              <article className={`stats-brief-item tone-${item.tone}`} key={item.id}>
                <span className="stats-brief-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="stats-brief-label">{item.label}</span>
                <strong>{item.value}</strong>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>

          <div className="stats-brief-actions" aria-label="Dossier Shortcuts">
            <button type="button" onClick={() => selectSection('analysis', true)}>
              Open Deep Analysis
            </button>
            <button
              type="button"
              onClick={() => selectSection(isOwnProfile ? 'hands' : 'positions', true)}
            >
              {isOwnProfile ? 'Review Hand Patterns' : 'Inspect Positions'}
            </button>
          </div>
        </section>
      )}

      {/* ── PILL TABS ── */}
      {/* A real tablist. This was eight buttons whose active state lived only in
          a CSS class, so a screen reader could not tell which view was open,
          and the swipe gesture had no keyboard equivalent - Arrow keys now do
          what the swipe does. Roving tabindex per the WAI-ARIA tab pattern. */}
      <div
        className="stats-pill-tabs"
        role="tablist"
        aria-label="Statistics Sections"
        onKeyDown={(e) => {
          /* A ROVING TABINDEX MUST ACTUALLY MOVE FOCUS.
             Each tab is `tabIndex={category === cat ? 0 : -1}`, so selecting a
             new one drops the OLD button to -1. Without the focus() below, focus
             stayed on that old button - now removed from the tab order - so a
             keyboard user got no announcement of the new tab, and their next Tab
             press jumped somewhere unrelated. The ARIA tablist pattern requires
             focus to follow selection; selection alone is only half of it.

             focus() is safe to call before React re-renders: programmatic focus
             works on a tabIndex={-1} element, and the attribute updates to 0 in
             the same commit. */
          const KEYS = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
          if (!KEYS.includes(e.key)) return;
          e.preventDefault();
          const i = TABS.indexOf(category);
          const next =
            e.key === 'Home'
              ? TABS[0]
              : e.key === 'End'
                ? TABS[TABS.length - 1]
                : e.key === 'ArrowRight'
                  ? TABS[(i + 1) % TABS.length]
                  : TABS[(i - 1 + TABS.length) % TABS.length];
          setCategory(next);
          document.getElementById(`stats-tab-${next}`)?.focus();
        }}
      >
        {TABS.map((cat) => (
          <button
            key={cat}
            role="tab"
            id={`stats-tab-${cat}`}
            aria-selected={category === cat}
            aria-controls={`stats-panel-${cat}`}
            tabIndex={category === cat ? 0 : -1}
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
          role="tabpanel"
          id={`stats-panel-${category}`}
          aria-labelledby={`stats-tab-${category}`}
          className="stats-content"
          variants={reduceMotion ? undefined : tabTransition}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={reduceMotion ? instant : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          {...statsSwipeHandlers}
        >
          <Suspense fallback={<div className="stats-section-loading">Loading Section...</div>}>
            {/* EMPTY STATE — shown on EVERY tab. Previously only Overview had one,
            so a player with no hands saw a wall of 0.0% rows and empty charts.
            Rake opts out: an agent who has played no hands themselves still has
            a downline generating rake, and that is the whole point of the tab. */}
            {!hasData && category !== 'rake' && emptyState}

            {showTab('rake') && (
              <RakeTab
                rakeLoading={rakeLoading}
                rakeStats={rakeStats}
                agentRoles={agentRoles}
                isOwnProfile={isOwnProfile}
                panelResetKey={panelResetKey}
              />
            )}

            {showTab('overview') && hasData && (
              <OverviewTab
                overall={overall}
                full={full}
                rangeKey={rangeKey}
                rangeLabel={rangeLabel}
                showdownWinRate={showdownWinRate}
                handsWonPct={handsWonPct}
                isOwnProfile={isOwnProfile}
                panelResetKey={panelResetKey}
                targetUserId={targetUserId}
                windowDays={windowDays}
                user={user}
                shareStyle={shareStyle}
                printing={printing}
                printDossier={printDossier}
                openHandEvidence={openHandEvidence}
              />
            )}

            {showTab('performance') && hasData && (
              <PerformanceTab
                overall={overall}
                showdownWinRate={showdownWinRate}
                isOwnProfile={isOwnProfile}
                panelResetKey={panelResetKey}
                targetUserId={targetUserId}
                windowDays={windowDays}
                printing={printing}
              />
            )}

            {showTab('positions') && hasData && (
              <PositionsTab
                full={full}
                panelResetKey={panelResetKey}
                targetUserId={targetUserId}
                windowDays={windowDays}
                openHandEvidence={openHandEvidence}
              />
            )}

            {/* Owner only, see the PRIVACY note on BASE_TABS */}
            {showTab('hands') && isOwnProfile && hasData && (
              <HandsTab
                panelResetKey={panelResetKey}
                targetUserId={targetUserId}
                windowDays={windowDays}
              />
            )}

            {showTab('trophies') && isOwnProfile && hasData && (
              <TrophiesTab
                panelResetKey={panelResetKey}
                allTimeStats={allTimeStats}
                allTimeError={allTimeError}
                setAllTimeReload={setAllTimeReload}
              />
            )}

            {showTab('tournaments') && hasData && (
              <TournamentsTab tourn={tourn} overall={overall} full={full} />
            )}

            {showTab('analysis') && hasData && (
              <AnalysisTab
                overall={overall}
                full={full}
                panelResetKey={panelResetKey}
                targetUserId={targetUserId}
                rangeKey={rangeKey}
                rangeLabel={rangeLabel}
                printing={printing}
                advancedInitialData={advancedInitialData}
                dailySeries={dailySeries}
                positionPie={positionPie}
                profitChartSummary={profitChartSummary}
                dailyChartSummary={dailyChartSummary}
                positionChartSummary={positionChartSummary}
                sessionRows={sessionRows}
                exportSessionsCSV={exportSessionsCSV}
                exportOverviewCSV={exportOverviewCSV}
                handMode={handMode}
                setHandMode={setHandMode}
                hands={hands}
                handsLoading={handsLoading}
                handsError={handsError}
                setHandsReload={setHandsReload}
                openHandEvidence={openHandEvidence}
              />
            )}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
