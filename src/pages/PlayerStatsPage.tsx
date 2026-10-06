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
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  lazy,
  Suspense,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { tabTransition, instant } from '../components/stats/statsMotion';
import { useLocation, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
// The two caches sign-out has to be able to reach. They live in a leaf module
// so clearUserCaches can purge them without importing this page - that import
// would pull the whole Stats graph into the sign-out chunk and undo the lazy
// chart split.
import {
  STATS_CACHE_CONTRACT_VERSION,
  readStatsRangeMemo,
  writeStatsRangeMemo,
  clearStatsRangeMemo,
  type StatsCacheIdentity,
} from '../lib/statsCache';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import { compactChips } from '../utils/format';
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
const FinancialReportingPanel = lazy(() => import('../components/stats/FinancialReportingPanel'));
const ExactCashSessionsPanel = lazy(() => import('../components/stats/ExactCashSessionsPanel'));
const WorkspaceTab = lazy(() => import('./stats/WorkspaceTab'));
import { playerStyleFromStats } from '../components/stats/playerStyleFromStats';
import { ratioOrUnmeasured } from './stats/format';
import { RANGES, num, str, type FullStats, type HandMode, type HandRow } from './stats/types';
import PageSkeleton from '../components/common/PageSkeleton';
import { useStatsPulse } from '../hooks/useStatsPulse';
import { resolvedTimeZone, localDateFromYmd } from '../lib/localTime';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import './PlayerStatsPage.css';
import { reportError } from '../utils/errorReporter';
import { AgentRakeService, type AgentRoleRow } from '../services/AgentRakeService';
import {
  StatsFactsService,
  type CashOpportunityStats,
  type PlayerRakeStats,
} from '../services/StatsFactsService';
import type { CashEvidenceMetric } from '../components/stats/CashIntelligencePanel';
import { CHIP_STATS, statsRpcName, statsScopeArgs, type StatsClubId } from '../services/statsScope';
import { getUserMemberships } from '../services/ClubsService';
import { useArenaStatsScope } from './stats/arenaStatsScope';
import {
  normalizeStatsContractMetadata,
  statsContractMatchesRequest,
} from '../services/statsContract';
import {
  exportStatsOverview,
  exportStatsSessions,
  type StatsExportMetadata,
} from './stats/statsCsvExport';
import { buildStatsIntelligenceBrief } from '../components/stats/statsIntelligenceBrief';
import { capture } from '../lib/analytics';
import {
  buildStatsCashEvidencePath,
  restoreStatsEvidenceScroll,
} from '../lib/statsEvidenceNavigation';
import SharedClubStatsView from './stats/SharedClubStatsView';
import ClubScopeConsole from './stats/ClubScopeConsole';
import StatsHeadlineDeck from './stats/StatsHeadlineDeck';
import {
  BASE_TABS,
  EMPTY_FULL,
  EMPTY_LIFETIME,
  EMPTY_OVERALL,
  TAB_LABELS,
  getCachedFull,
  isFullStatsPayload,
  normalizeFull,
  normalizeHands,
  normalizeDashboardLayout,
  setCachedFull,
  validClubSort,
  validRangeKey,
  validTab,
  type ClubComparisonRow,
  type ClubComparisonSort,
  type StatCategory,
  type StatsClubOption,
} from './stats/playerStatsPageModel';
export default function PlayerStatsPage() {
  const { userId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { scope: statsScope, eyebrow: statsEyebrow } = useArenaStatsScope(); // Diamonds in the arena
  const statsTimezone = resolvedTimeZone();
  const targetUserId = userId || user?.id;
  const isOwnProfile = !userId || userId === user?.id;
  const [clubs, setClubs] = useState<StatsClubOption[]>([]);
  const [clubsLoading, setClubsLoading] = useState(true);
  const [clubsError, setClubsError] = useState(false);
  const [clubsReload, setClubsReload] = useState(0);
  const [selectedClubId, setSelectedClubId] = useState<StatsClubId>(
    () => searchParams.get('statsClub')?.trim() || null
  );
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonRows, setComparisonRows] = useState<ClubComparisonRow[] | null>(null);
  const [comparisonLoadedKey, setComparisonLoadedKey] = useState<string | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState(false);
  const [comparisonSort, setComparisonSort] = useState<ClubComparisonSort>(() =>
    validClubSort(searchParams.get('clubSort'))
  );
  const [full, setFull] = useState<FullStats | null>(null);
  // Keep the payload scope explicit. A failed range request must never leave
  // old numbers on screen under the newly selected range label.
  const loadedRangeKeyRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [servingCache, setServingCache] = useState(false);
  const [rangeKey, setRangeKey] = useState<string>(() => validRangeKey(searchParams.get('range')));
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [statsDataSource, setStatsDataSource] = useState<'live' | 'memory cache' | 'saved cache'>(
    'live'
  );
  // The dossier preloads every tab, then uses the browser's vector print/PDF
  // path so no renderer bundle or latency-sensitive server process is needed.
  const [printing, setPrinting] = useState(false);
  const [privacyPresentationMode, setPrivacyPresentationMode] = useState(false);
  const [dashboardLayout, setDashboardLayout] = useState<string[]>([]);
  const [preferencesState, setPreferencesState] = useState<'loading' | 'ready' | 'error'>(
    isOwnProfile ? 'loading' : 'ready'
  );
  const [preferencesReload, setPreferencesReload] = useState(0);
  useEffect(() => {
    if (!isOwnProfile) {
      setPrivacyPresentationMode(false);
      setPreferencesState('ready');
      return;
    }
    let cancelled = false;
    setPreferencesState('loading');
    void (async () => {
      try {
        const { statsWorkspaceService } = await import('../services/StatsWorkspaceService');
        const result = await statsWorkspaceService.loadPreferences();
        if (cancelled) return;
        if (!result.ok) {
          setPreferencesState('error');
          return;
        }
        setPrivacyPresentationMode(result.data.privacyPresentationMode);
        setDashboardLayout(
          (Array.isArray(result.data.dashboardLayout) ? result.data.dashboardLayout : []).filter(
            (value): value is string => typeof value === 'string'
          )
        );
        setPreferencesState('ready');
      } catch (error) {
        if (cancelled) return;
        reportError(error, 'PlayerStatsPage.load_preferences');
        setPreferencesState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile, user?.id, preferencesReload]);
  const selectedClub = useMemo(
    () => clubs.find((club) => club.id === selectedClubId) ?? null,
    [clubs, selectedClubId]
  );
  const clubLabel = selectedClub ? selectedClub.name : 'All Clubs';
  const updateStatsUrl = useCallback(
    (
      updates: Partial<{
        statsClub: string | null;
        range: string | null;
        tab: string | null;
        clubSort: string | null;
      }>,
      replace = false
    ) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(updates)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace }
      );
    },
    [setSearchParams]
  );
  useEffect(() => {
    if (!isOwnProfile || !user?.id || statsScope !== CHIP_STATS) {
      setClubs([]);
      setSelectedClubId(null);
      setClubsLoading(false);
      return;
    }
    let cancelled = false;
    setClubsLoading(true);
    setClubsError(false);
    void getUserMemberships({ id: user.id })
      .then((memberships) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const eligible = memberships
          .map((membership) => membership.club)
          .filter((club) => club?.id && club.lifecycle_status !== 'retired')
          .filter((club) => {
            if (seen.has(club.id)) return false;
            seen.add(club.id);
            return true;
          })
          .map((club) => ({ id: club.id, name: club.name || 'Club' }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setClubs(eligible);
        setSelectedClubId((current) =>
          current && eligible.some((club) => club.id === current) ? current : null
        );
      })
      .catch((error) => {
        if (cancelled) return;
        reportError(error, 'PlayerStatsPage.load_authorized_clubs');
        setClubs([]);
        setSelectedClubId(null);
        setClubsError(true);
      })
      .finally(() => {
        if (!cancelled) setClubsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile, user?.id, statsScope, clubsReload]);
  useEffect(() => {
    const done = () => setPrinting(false);
    // beforeprint is synchronous and cannot await lazy chunks. Cmd-P prints
    // the current tab; the Dossier action below preloads the complete report.
    window.addEventListener('afterprint', done);
    return () => {
      window.removeEventListener('afterprint', done);
    };
  }, []);
  // Mobile Safari can omit afterprint. Release the all-tabs print state when
  // focus/visibility proves the print sheet has closed.
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
    // Preload idempotent lazy chunks before the 1200ms chart-layout window so
    // a cold-cache PDF never captures Suspense text. Do not clear printing on
    // a timer: mobile print() returns before its preview closes.
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
  const cacheIdentityFor = useCallback(
    (cacheRangeKey: string, cacheRangeDays: number | null): StatsCacheIdentity => ({
      contractVersion: STATS_CACHE_CONTRACT_VERSION,
      viewerId: user?.id ?? '',
      targetUserId: targetUserId ?? '',
      clubId: selectedClubId,
      asset: statsScope,
      rangeKey: cacheRangeKey,
      rangeDays: cacheRangeDays,
      timezone: statsTimezone,
      visibility: isOwnProfile ? 'owner' : 'shared_club',
    }),
    [user?.id, targetUserId, selectedClubId, statsScope, statsTimezone, isOwnProfile]
  );
  const loadScopeKey = JSON.stringify(cacheIdentityFor(rangeKey, windowDays));
  const [handMode, setHandMode] = useState<HandMode>('biggest_won');
  const [hands, setHands] = useState<HandRow[] | null>(null);
  const [handsLoading, setHandsLoading] = useState(false);
  const [handsError, setHandsError] = useState(false);
  /** Bumped to re-run the hands effect; a retry must not depend on changing a filter. */
  const [handsReload, setHandsReload] = useState(0);
  const [category, setCategory] = useState<StatCategory>(() => validTab(searchParams.get('tab')));
  useEffect(() => restoreStatsEvidenceScroll(location), [location, loading, category]);
  const searchKey = searchParams.toString();
  useEffect(() => {
    const current = new URLSearchParams(searchKey);
    const nextRange = validRangeKey(current.get('range'));
    if (current.get('range') && nextRange === 'all') updateStatsUrl({ range: null }, true);
    if (current.get('tab') && validTab(current.get('tab')) === 'overview') {
      updateStatsUrl({ tab: null }, true);
    }
    if (current.get('clubSort') && validClubSort(current.get('clubSort')) === 'club') {
      updateStatsUrl({ clubSort: null }, true);
    }
    if (nextRange !== activeRangeKeyRef.current) {
      setFull(null);
      loadedRangeKeyRef.current = null;
      hasStatsRef.current = false;
      setServingCache(false);
      setLoadError(false);
      setLoading(true);
      setComparisonRows(null);
      setComparisonLoadedKey(null);
      activeRangeKeyRef.current = nextRange;
      setRangeKey(nextRange);
    }
    setCategory(validTab(current.get('tab')));
    setComparisonSort(validClubSort(current.get('clubSort')));
    if (!isOwnProfile) return;
    if (statsScope !== CHIP_STATS) {
      if (selectedClubId) setSelectedClubId(null);
      return;
    }
    const requestedClub = current.get('statsClub')?.trim() || null;
    if (clubsLoading) return;
    const nextClub =
      requestedClub && clubs.some((club) => club.id === requestedClub) ? requestedClub : null;
    if (requestedClub && !nextClub) updateStatsUrl({ statsClub: null }, true);
    if (nextClub !== selectedClubId) {
      setFull(null);
      setAllTimeFetched(null);
      setHands(null);
      setRakeStats(null);
      loadedRangeKeyRef.current = null;
      hasStatsRef.current = false;
      pendingRefreshRef.current = false;
      setServingCache(false);
      setLoadError(false);
      setHandsError(false);
      setAllTimeError(false);
      setLoading(true);
      setSelectedClubId(nextClub);
    }
    // URL changes (including browser Back/Forward) own this direction. Local
    // button handlers update state first and then push the URL; depending on
    // that local state here would immediately undo the user's click before
    // the router publishes the new search string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, clubs, clubsLoading, statsScope, isOwnProfile]);
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
  // A FAILED roles read is not "no roles" (2026-09-20): agentRoles stays null
  // (unknown) and the Rake tab keeps the Downline section, as unavailable.
  const [agentRolesError, setAgentRolesError] = useState(false);
  const [agentRolesReload, setAgentRolesReload] = useState(0);
  useEffect(() => {
    setAgentRolesError(false);
    // The Diamond Arena has no agents (ruling 16): no downline on its page.
    if (!isOwnProfile || !user?.id || statsScope !== CHIP_STATS) {
      setAgentRoles([]);
      return;
    }
    let cancelled = false;
    const fail = (err: unknown) => {
      if (cancelled) return;
      reportError(err, 'PlayerStatsPage.rpc_fn_my_agent_roles');
      setAgentRoles(null);
      setAgentRolesError(true);
    };
    void AgentRakeService.getMyAgentRoles().then((r) => {
      if (r?.error || !Array.isArray(r?.roles)) fail(r?.error ?? 'roles_unreadable');
      else if (!cancelled) setAgentRoles(r.roles);
    }, fail);
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile, user?.id, agentRolesReload, statsScope]);
  // POLISH 1 (Dan 2026-08-30): the player's OWN weighted rake. Cent-exact,
  // from the same allocator the money pipeline uses. Own profile only — the
  // RPC derives identity from auth.uid() and would refuse anyone else anyway.
  const [rakeStats, setRakeStats] = useState<PlayerRakeStats | null>(null);
  const [rakeLoading, setRakeLoading] = useState(false);
  // A FAILED rake read is not an empty ledger (2026-09-20): ScopedRead.error
  // was never read here, so a fault rendered as "Rake Ledger Empty".
  const [rakeError, setRakeError] = useState(false);
  const [rakeReload, setRakeReload] = useState(0);
  useEffect(() => {
    setRakeError(false);
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
    const fail = (err: unknown) => {
      if (cancelled) return;
      reportError(err, 'PlayerStatsPage.rpc_ca_player_rake_stats', { days: windowDays });
      setRakeError(true);
    };
    void load
      .call(StatsFactsService, statsScope, windowDays, selectedClubId)
      .then((r) => {
        // `error` is set only when the read FAILED; an empty ledger has none.
        if (r?.error) fail(r.error);
        else if (!cancelled) setRakeStats(r);
      })
      .catch(fail)
      .finally(() => {
        if (!cancelled) setRakeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOwnProfile, user?.id, windowDays, rakeReload, statsScope, selectedClubId]);
  const [cashOpportunityStats, setCashOpportunityStats] = useState<CashOpportunityStats | null>(
    null
  );
  const [cashOpportunityLoading, setCashOpportunityLoading] = useState(false);
  const [cashOpportunityError, setCashOpportunityError] = useState<string | null>(null);
  const [cashOpportunityReload, setCashOpportunityReload] = useState(0);
  useEffect(() => {
    if (!isOwnProfile || !targetUserId) {
      setCashOpportunityStats(null);
      setCashOpportunityLoading(false);
      setCashOpportunityError(null);
      return;
    }
    let cancelled = false;
    setCashOpportunityLoading(true);
    setCashOpportunityStats(null);
    setCashOpportunityError(null);
    void StatsFactsService.getCashOpportunityStats(
      targetUserId,
      statsScope,
      windowDays,
      selectedClubId,
      statsTimezone
    )
      .then((result) => {
        if (cancelled) return;
        if ('error' in result && result.error) {
          setCashOpportunityError(result.error);
          return;
        }
        setCashOpportunityStats(result as CashOpportunityStats);
      })
      .catch((error) => {
        if (cancelled) return;
        reportError(error, 'PlayerStatsPage.cash_opportunity_stats');
        setCashOpportunityError(error instanceof Error ? error.message : 'read_failed');
      })
      .finally(() => {
        if (!cancelled) setCashOpportunityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isOwnProfile,
    targetUserId,
    statsScope,
    windowDays,
    selectedClubId,
    statsTimezone,
    cashOpportunityReload,
  ]);
  const openCashEvidence = useCallback(
    (metric: CashEvidenceMetric) => {
      let from: string | null = null;
      let to: string | null = null;
      if (windowDays) {
        const end = new Date();
        const start = new Date(end);
        start.setDate(start.getDate() - windowDays + 1);
        from = start.toISOString().slice(0, 10);
        to = end.toISOString().slice(0, 10);
      }
      navigate(
        buildStatsCashEvidencePath(metric, {
          clubId: selectedClubId,
          asset: statsScope,
          from,
          to,
        })
      );
    },
    [navigate, selectedClubId, statsScope, windowDays]
  );
  const canSeeRake = (agentRoles?.length ?? 0) > 0;
  const TABS = useMemo<StatCategory[]>(() => {
    // Owner-only tabs are spliced in next to the tab they belong with, so the
    // order still derives from BASE_TABS and the two cannot drift.
    const out: StatCategory[] = [];
    for (const t of BASE_TABS) {
      out.push(t);
      if (isOwnProfile && t === 'positions') out.push('hands');
      if (isOwnProfile && t === 'analysis') out.push('trophies');
      if (isOwnProfile && t === 'analysis') out.push('workspace');
    }
    const available: StatCategory[] = canSeeRake || isOwnProfile ? [...out, 'rake'] : out;
    if (!isOwnProfile || dashboardLayout.length === 0) return available;
    return normalizeDashboardLayout(dashboardLayout, available);
  }, [canSeeRake, dashboardLayout, isOwnProfile]);
  // If the tab disappears (role revoked, or navigating to another profile),
  // do not strand the view on a tab that no longer exists.
  useEffect(() => {
    if (!TABS.includes(category)) {
      const fallback = TABS[0] ?? 'overview';
      setCategory(fallback);
      updateStatsUrl({ tab: fallback === 'overview' ? null : fallback }, true);
    }
  }, [TABS, category, updateStatsUrl]);
  useEffect(() => {
    if (category === 'rake' && !canSeeRake && !isOwnProfile) {
      setCategory('overview');
      updateStatsUrl({ tab: null }, true);
    }
  }, [category, canSeeRake, isOwnProfile, updateStatsUrl]);
  const changeCategory = useCallback(
    (nextCategory: StatCategory) => {
      setCategory(nextCategory);
      updateStatsUrl({ tab: nextCategory === 'overview' ? null : nextCategory });
    },
    [updateStatsUrl]
  );
  const statsSwipeHandlers = useSwipeTabs({
    tabs: TABS,
    activeTab: category,
    onTabChange: changeCategory,
  });
  // The page CSS already honours prefers-reduced-motion, but that only stops
  // CSS keyframes. framer-motion drives transforms from JS and ignores the
  // media query entirely, so without this hook moving the tab animation to
  // framer-motion would have quietly broken an accessibility setting that
  // used to work.
  const reduceMotion = useReducedMotion();
  const selectSection = useCallback(
    (section: StatCategory, reveal = false) => {
      if (reveal) shortcutDestinationRef.current = section;
      changeCategory(section);
    },
    [changeCategory]
  );
  const toast = useToast();
  const isMounted = useIsMounted();
  const hasStatsRef = useRef(false);
  const statsLoadingRef = useRef(false);
  // A refresh arriving while one is in flight is remembered and replayed once
  // instead of dropped: the bus events are debounced, not queued, so a discarded
  // HAND_COMPLETED used to leave the page stale until some later event.
  const pendingRefreshRef = useRef(false);
  const activeRangeKeyRef = useRef(rangeKey);
  const activeClubIdRef = useRef<StatsClubId>(selectedClubId);
  const activeLoadScopeRef = useRef(loadScopeKey);
  const previousLoadScopeRef = useRef(loadScopeKey);
  useLayoutEffect(() => {
    // Only a committed tree may advance the accepted request identity. React
    // can abandon a render, but it cannot abandon this layout effect.
    activeLoadScopeRef.current = loadScopeKey;
    if (previousLoadScopeRef.current === loadScopeKey) return;
    previousLoadScopeRef.current = loadScopeKey;
    setFull(null);
    setAllTimeFetched(null);
    setHands(null);
    loadedRangeKeyRef.current = null;
    hasStatsRef.current = false;
    setServingCache(false);
    setLoadError(false);
    setHandsError(false);
    setAllTimeError(false);
    setComparisonRows(null);
    setComparisonLoadedKey(null);
    setLoading(true);
    if (statsLoadingRef.current) pendingRefreshRef.current = true;
  }, [loadScopeKey]);
  const changeRange = useCallback(
    (nextRangeKey: string) => {
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
      setComparisonRows(null);
      setComparisonLoadedKey(null);
      activeRangeKeyRef.current = nextRangeKey;
      setRangeKey(nextRangeKey);
      updateStatsUrl({ range: nextRangeKey === 'all' ? null : nextRangeKey });
    },
    [updateStatsUrl]
  );
  const changeClub = useCallback(
    (nextClubId: StatsClubId) => {
      setFull(null);
      setAllTimeFetched(null);
      setHands(null);
      setRakeStats(null);
      loadedRangeKeyRef.current = null;
      hasStatsRef.current = false;
      pendingRefreshRef.current = false;
      setServingCache(false);
      setLoadError(false);
      setHandsError(false);
      setAllTimeError(false);
      setLoading(true);
      setSelectedClubId(nextClubId);
      updateStatsUrl({ statsClub: nextClubId });
    },
    [updateStatsUrl]
  );
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
      if (selectedClubId) params.set('statsClub', selectedClubId);
      if (windowDays) {
        const to = new Date();
        const from = new Date(to);
        from.setDate(from.getDate() - windowDays + 1);
        params.set('from', from.toISOString().slice(0, 10));
        params.set('to', to.toISOString().slice(0, 10));
      }
      navigate(`/hand-history?${params.toString()}`);
    },
    [navigate, windowDays, selectedClubId]
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
        const memoPayload = readStatsRangeMemo(cacheIdentityFor(rangeKey, windowDays));
        const memo = isFullStatsPayload(memoPayload) ? normalizeFull(memoPayload) : null;
        if (memo) {
          setFull(memo);
          loadedRangeKeyRef.current = loadScopeKey;
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
              .rpc(statsRpcName('ca_player_stats_overview_v2', selectedClubId), {
                // One asset per read, never summed (src/services/statsScope.ts).
                ...statsScopeArgs(statsScope, selectedClubId),
                p_user: targetUserId,
                p_days: windowDays,
                // Day buckets are cut in the player's zone, server-side
                // (phase 3). The RPC falls back to UTC for a name it does
                // not know and reports the zone it used as `window_tz`.
                p_tz: statsTimezone,
              })
              .then((r: any) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );
        if (!isMounted.current) return;
        // A slow response for the previous analysis window must never paint
        // underneath the newly selected label. The pending replay below will
        // request the current range as soon as this obsolete read unwinds.
        if (
          activeLoadScopeRef.current !== loadScopeKey ||
          activeRangeKeyRef.current !== rangeKey ||
          activeClubIdRef.current !== selectedClubId
        ) {
          pendingRefreshRef.current = true;
          return;
        }
        const contract = normalizeStatsContractMetadata(data);
        const scopeMatches = statsContractMatchesRequest(contract, {
          targetUserId,
          clubId: selectedClubId,
          asset: statsScope,
          rangeDays: windowDays,
          timezone: statsTimezone,
          visibility: 'owner',
        });
        const payloadMatches = isFullStatsPayload(data);
        if (!error && scopeMatches && payloadMatches) {
          const resolved = normalizeFull(data);
          const loadedAt = resolved.contract.generated_at
            ? Date.parse(resolved.contract.generated_at)
            : Date.now();
          setFull(resolved);
          loadedRangeKeyRef.current = loadScopeKey;
          setLastUpdatedAt(loadedAt);
          setStatsDataSource('live');
          hasStatsRef.current = true;
          setLoadError(false);
          setServingCache(false);
          // Only the unbounded view is cached — otherwise a 7-day payload could be
          // rehydrated on the next visit and read as all-time.
          if (windowDays === null) setCachedFull(cacheIdentityFor(rangeKey, windowDays), data);
          writeStatsRangeMemo(cacheIdentityFor(rangeKey, windowDays), data);
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
            club_scope: selectedClubId ?? 'all',
            cache_source: 'network',
            outcome: 'success',
          });
          // A page view must never run index maintenance. The retired client RPC
          // exceeded the authenticated timeout and evicted the shared Postgres
          // working set; the server-owned maintenance path owns that work.
        } else {
          if (hasStatsRef.current && loadedRangeKeyRef.current === loadScopeKey) {
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
          else if (!scopeMatches || !payloadMatches) {
            reportError(
              new Error(
                scopeMatches
                  ? 'Player Stats Payload Could Not Be Verified'
                  : 'Player Stats Scope Could Not Be Verified'
              ),
              'PlayerStatsPage.rpc_ca_player_stats_overview_v2'
            );
          }
          capture('stats_rpc_load', {
            duration_ms: Math.round(performance.now() - loadStartedAt),
            payload_bytes: 0,
            range: rangeKey,
            club_scope: selectedClubId ?? 'all',
            cache_source:
              hasStatsRef.current && loadedRangeKeyRef.current === loadScopeKey ? 'cache' : 'none',
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
            club_scope: selectedClubId ?? 'all',
            cache_source: hasStatsRef.current ? 'cache' : 'none',
            outcome: 'exception',
          });
          reportError(err, 'PlayerStatsPage.Failed_to_load_stats');
          if (isMounted.current) {
            if (hasStatsRef.current && loadedRangeKeyRef.current === loadScopeKey) {
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
    [
      targetUserId,
      isOwnProfile,
      rangeKey,
      windowDays,
      toast,
      isMounted,
      statsScope,
      cacheIdentityFor,
      selectedClubId,
      loadScopeKey,
      statsTimezone,
    ]
  );
  // Notable hands. Loaded only when the Analysis tab is actually open — the
  // 'biggest' modes score the whole analysis window, so this is not free.
  useEffect(() => {
    if (!targetUserId || !isOwnProfile || category !== 'analysis') return;
    let alive = true;
    setHandsLoading(true);
    setHandsError(false);
    supabase
      .rpc(statsRpcName('ca_player_hands_v2', selectedClubId), {
        ...statsScopeArgs(statsScope, selectedClubId),
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
            const verifiedHands = normalizeHands(data, {
              targetUserId,
              clubId: selectedClubId,
              asset: statsScope,
              visibility: 'owner',
            });
            if (verifiedHands === null) {
              reportError(
                new Error('notable hands payload did not match its v2 request contract'),
                'PlayerStatsPage.rpc_ca_player_hands_v2_shape'
              );
              setHandsError(true);
              setHands([]);
            } else {
              setHands(verifiedHands);
            }
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
  }, [targetUserId, isOwnProfile, category, handMode, handsReload, statsScope, selectedClubId]);
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
  /* Keep the shared debouncer on the last committed loader. Assigning during
   * render lets an abandoned concurrent render publish a stale closure. */
  useLayoutEffect(() => {
    loadRef.current = loadAllData;
  });
  useLayoutEffect(() => {
    activeRangeKeyRef.current = rangeKey;
  }, [rangeKey]);
  useLayoutEffect(() => {
    activeClubIdRef.current = selectedClubId;
  }, [selectedClubId]);
  /** One debounce window collapses the several events emitted by one hand and
   * the pulse fallback into one read. The committed loadRef prevents an old
   * range closure from overwriting the current window. */
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void loadRef.current?.({ fresh: true });
    }, 2000);
  }, []);
  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    []
  );
  /**
   * LIVE FROM ANY TAB, AND THE TAB RETURN (phase 3, 2026-09-04). masterBus
   * only carries events for the tables THIS tab is watching, so a player
   * grinding in one tab with Stats open in another never saw a refresh. The
   * realtime subscription on ca_hand_player_idx that used to cover this went
   * dead the day that table left the publication (4.5M rows a day of WAL for
   * one page), so the page now asks: ca_player_stats_pulse every 8s while
   * visible, one refetch when the player's newest hand or a tournament row
   * moves. The hook also owns the tab return, so a return costs one refetch,
   * not one for "time passed" and another for "the pulse moved".
   */
  useStatsPulse({
    userId: targetUserId,
    enabled: Boolean(targetUserId && isOwnProfile),
    onChange: scheduleRefresh,
    scope: statsScope,
    clubId: selectedClubId,
  });
  // SWR: show cached stats instantly on mount
  useEffect(() => {
    // Persistent storage holds only the unbounded payload. Never paint it
    // beneath a 7/30/90-day label while that range's network read is pending.
    if (!targetUserId || !isOwnProfile || rangeKey !== 'all') return;
    const cached = getCachedFull(cacheIdentityFor('all', null));
    if (cached) {
      setFull(cached.full);
      loadedRangeKeyRef.current = JSON.stringify(cacheIdentityFor('all', null));
      setLastUpdatedAt(
        cached.full.contract.generated_at
          ? Date.parse(cached.full.contract.generated_at)
          : cached.cachedAt
      );
      setStatsDataSource('saved cache');
      hasStatsRef.current = true;
      setLoading(false);
    }
  }, [targetUserId, isOwnProfile, rangeKey, cacheIdentityFor, selectedClubId]);
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
  }, [targetUserId, selectedClubId, rangeKey]);
  useEffect(() => {
    if (targetUserId && isOwnProfile && !clubsLoading) void loadAllData();
  }, [targetUserId, isOwnProfile, clubsLoading, loadAllData]);
  /**
   * ── Bus listeners for same-tab hands, into the shared debounce window ───
   * The five events one completed hand emits all land in scheduleRefresh, so
   * they cost one refetch between them (see the debouncer above).
   */
  useEffect(() => {
    const REFRESH_EVENTS = [
      'HAND_COMPLETED',
      'BALANCE_UPDATED',
      'CHIPS_DISTRIBUTED',
      'CASHOUT_APPROVED',
      'CREDIT_UPDATED',
    ] as const;
    const unsubs = REFRESH_EVENTS.map((e) => masterBus.subscribe(e as never, scheduleRefresh));
    return () => {
      unsubs.forEach((u) => u());
    };
  }, [scheduleRefresh]);
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
    const memoPayload = readStatsRangeMemo(cacheIdentityFor('all', null));
    if (isFullStatsPayload(memoPayload)) {
      const memo = normalizeFull(memoPayload);
      setAllTimeFetched(memo);
      setAllTimeError(false);
      return;
    }
    let cancelled = false;
    setAllTimeError(false);
    supabase
      .rpc(statsRpcName('ca_player_stats_overview_v2', selectedClubId), {
        /* Scoped: see the note on the windowed read above. */
        ...statsScopeArgs(statsScope, selectedClubId),
        p_user: targetUserId,
        p_days: null,
        p_tz: statsTimezone,
      })
      .then(
        ({ data, error }: any) => {
          if (cancelled || !isMounted.current) return;
          const contract = normalizeStatsContractMetadata(data);
          const scopeMatches = statsContractMatchesRequest(contract, {
            targetUserId,
            clubId: selectedClubId,
            asset: statsScope,
            rangeDays: null,
            timezone: statsTimezone,
            visibility: 'owner',
          });
          const payloadMatches = isFullStatsPayload(data);
          if (error || !scopeMatches || !payloadMatches) {
            if (error) reportError(error, 'PlayerStatsPage.rpc_all_time_for_trophies');
            else {
              reportError(
                new Error(
                  scopeMatches
                    ? 'Player Stats Lifetime Payload Could Not Be Verified'
                    : 'Player Stats Lifetime Scope Could Not Be Verified'
                ),
                'PlayerStatsPage.rpc_all_time_for_trophies'
              );
            }
            setAllTimeError(true);
            return;
          }
          const resolved = normalizeFull(data);
          writeStatsRangeMemo(cacheIdentityFor('all', null), data);
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
  }, [
    targetUserId,
    isOwnProfile,
    wantsAllTime,
    rangeKey,
    allTimeReload,
    isMounted,
    statsScope,
    cacheIdentityFor,
    selectedClubId,
    statsTimezone,
  ]);
  const allTimeStats: FullStats | null = rangeKey === 'all' ? full : allTimeFetched;
  const comparisonKey = `${user?.id ?? ''}:${targetUserId ?? ''}:${statsScope}:${rangeKey}:${statsTimezone}:${clubs.map((club) => club.id).join(',')}`;
  const comparisonRequestRef = useRef(0);
  const loadClubComparison = useCallback(async () => {
    if (!targetUserId || !isOwnProfile || clubs.length === 0) return;
    if (comparisonRows && comparisonLoadedKey === comparisonKey) return;
    const requestSequence = ++comparisonRequestRef.current;
    const requestKey = comparisonKey;
    setComparisonLoading(true);
    setComparisonError(false);
    try {
      const { data, error } = await supabase.rpc('ca_player_stats_club_comparison', {
        p_user: targetUserId,
        p_days: windowDays,
        p_asset: statsScope,
        p_tz: statsTimezone,
      });
      if (error || !Array.isArray(data?.rows)) {
        throw error ?? new Error('Club Comparison Payload Was Unreadable');
      }
      const rows: ClubComparisonRow[] = data.rows.map((row: any) => ({
        club: { id: str(row?.club_id), name: str(row?.club_name, 'Club') },
        hands: num(row?.hands),
        profit: num(row?.profit),
        bb100: num(row?.bb_per_100),
        vpip: num(row?.vpip),
        pfr: num(row?.pfr),
        hours: typeof row?.hours === 'number' && Number.isFinite(row.hours) ? row.hours : null,
        rake: num(row?.rake),
        tournamentEntries: num(row?.tournament_entries),
        tournamentCashes: num(row?.tournament_cashes),
        tournamentWins: num(row?.tournament_wins),
        tournamentWinnings: num(row?.tournament_winnings),
        lastPlayedAt: typeof row?.last_played_at === 'string' ? row.last_played_at : null,
      }));
      if (
        !isMounted.current ||
        requestSequence !== comparisonRequestRef.current ||
        requestKey !== comparisonKey
      )
        return;
      setComparisonRows(rows);
      setComparisonLoadedKey(requestKey);
    } catch (error) {
      reportError(error, 'PlayerStatsPage.load_club_comparison');
      if (isMounted.current && requestSequence === comparisonRequestRef.current)
        setComparisonError(true);
    } finally {
      if (isMounted.current && requestSequence === comparisonRequestRef.current)
        setComparisonLoading(false);
    }
  }, [
    targetUserId,
    isOwnProfile,
    clubs,
    comparisonRows,
    comparisonLoadedKey,
    comparisonKey,
    statsScope,
    statsTimezone,
    windowDays,
    isMounted,
  ]);
  useEffect(() => {
    if (comparisonOpen && comparisonLoadedKey !== comparisonKey) void loadClubComparison();
  }, [comparisonOpen, comparisonLoadedKey, comparisonKey, loadClubComparison]);
  const sortedComparisonRows = useMemo(() => {
    const rows = [...(comparisonRows ?? [])];
    const lastPlay = (row: ClubComparisonRow) => Date.parse(row.lastPlayedAt || '') || 0;
    rows.sort((a, b) => {
      if (comparisonSort === 'club') return a.club.name.localeCompare(b.club.name);
      const values: Record<
        Exclude<ClubComparisonSort, 'club'>,
        (row: ClubComparisonRow) => number
      > = {
        hands: (row) => row.hands,
        profit: (row) => row.profit,
        bb100: (row) => row.bb100,
        vpip: (row) => row.vpip,
        pfr: (row) => row.pfr,
        rake: (row) => row.rake,
        tournaments: (row) => row.tournamentEntries,
        lastPlay,
      };
      return values[comparisonSort](b) - values[comparisonSort](a);
    });
    return rows;
  }, [comparisonRows, comparisonSort]);
  const changeComparisonSort = useCallback(
    (nextSort: ClubComparisonSort) => {
      setComparisonSort(nextSort);
      updateStatsUrl({ clubSort: nextSort === 'club' ? null : nextSort });
    },
    [updateStatsUrl]
  );
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
  useEffect(() => {
    if (!isOwnProfile || !statsContract.valid || !lastUpdatedAt) return;
    void import('../services/StatsWorkspaceService').then(({ statsWorkspaceService }) =>
      statsWorkspaceService.evaluateAlerts({
        vpip: overall.vpip * 100,
        pfr: overall.pfr * 100,
        three_bet_percent: overall.three_bet_percent * 100,
        bb_per_100: overall.bb_per_100,
        total_profit: overall.total_profit,
        rake_paid: rakeStats?.rake_paid ?? 0,
      })
    );
  }, [isOwnProfile, statsContract.valid, lastUpdatedAt, overall, rakeStats?.rake_paid]);
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
  // Display-ready: no showdowns is Not Yet Measured, never "0%" (2026-09-20).
  const showdownWinRate = useMemo(
    () =>
      ratioOrUnmeasured(
        (overall.showdowns_won / overall.showdowns_total) * 100,
        overall.showdowns_total,
        (v) => `${v.toFixed(1)}%`
      ),
    [overall]
  );
  // Chart series with cumulative line
  const dailySeries = useMemo(() => {
    let cumulative = 0;
    return (full?.daily || []).map((d) => {
      cumulative += d.profit || 0;
      return {
        // 'YYYY-MM-DD' is a LOCAL day the server cut in the player's zone;
        // new Date('YYYY-MM-DD') would read it as UTC midnight and label a
        // Chicago player's Sep 3 as Sep 2.
        date: localDateFromYmd(d.date).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
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
    return `Cumulative cash profit across ${dailySeries.length.toLocaleString()} days, ${dailySeries[0].date} to ${last.date}, ending at ${compactChips(last.cumulative)}. Best day ${best.date} at ${compactChips(best.profit)}. Worst day ${worst.date} at ${compactChips(worst.profit)}.`;
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
  const panelResetKey = `${targetUserId ?? ''}:${selectedClubId ?? 'all'}:${rangeKey}:${lastUpdatedAt ?? 0}`;
  const financialPanel =
    targetUserId && isOwnProfile ? (
      <Suspense fallback={<div className="stats-section-loading">Opening Financial Ledger...</div>}>
        <FinancialReportingPanel
          userId={targetUserId}
          clubId={selectedClubId}
          clubLabel={clubLabel}
          days={windowDays}
          timezone={statsTimezone}
          asset={statsScope}
          resetKey={panelResetKey}
        />
      </Suspense>
    ) : null;
  const exactSessionPanel =
    targetUserId && isOwnProfile ? (
      <Suspense
        fallback={<div className="stats-section-loading">Opening Exact Session Ledger...</div>}
      >
        <ExactCashSessionsPanel
          userId={targetUserId}
          clubId={selectedClubId}
          clubLabel={clubLabel}
          days={windowDays}
          timezone={statsTimezone}
          asset={statsScope}
          resetKey={panelResetKey}
        />
      </Suspense>
    ) : null;
  const exportMetadata = (): StatsExportMetadata => ({
    clubId: selectedClubId,
    clubName: clubLabel,
    range: rangeLabel === 'All' ? 'All Time' : `Last ${rangeLabel}`,
    timezone: statsTimezone,
    asset: statsScope,
    unit: statsScope,
    coverage: JSON.stringify({
      analysis_hand_cap: statsContract.coverage.analysis_hand_cap,
      analysis_hands_capped: statsContract.coverage.analysis_hands_capped,
      lifetime_index_complete: statsContract.coverage.lifetime_index_complete,
      rollup_covered_through: statsContract.coverage.rollup_covered_through,
      club_breakdown_starts_at: statsContract.quality.club_breakdown_starts_at,
    }),
    source: statsContract.quality.cash_money_source,
    schemaVersion: statsContract.contract_version,
    generatedAt: statsContract.generated_at,
    privacyPresentationMode,
  });
  const exportSessionsCSV = () => {
    try {
      // buy_in, cash_out and ended are on every SessionRow and were dropped.
      // They are the figures anyone reconciling a bankroll in a spreadsheet
      // actually needs - profit alone cannot tell you what you sat down with.
      // Appended, not inserted, so an existing import template still works.
      // The range is recorded too: a file exported under "7 Days" was
      // indistinguishable from a lifetime export once it left the browser.
      exportStatsSessions(
        sessionRows.map((s) => ({
          date: new Date(s.date).toLocaleString(),
          ended: s.ended ? new Date(s.ended).toLocaleString() : '',
          duration_minutes: s.duration_minutes,
          hands: s.hands_played,
          buy_in: s.buy_in,
          cash_out: s.cash_out,
          profit: s.profit_loss,
        })),
        exportMetadata(),
        `player_session_history_${selectedClubId ?? 'all_clubs'}_${rangeKey}.csv`
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
        three_bet_percent:
          selectedClubId && !statsContract.quality.metric_availability.three_bet_percent
            ? 'Unavailable'
            : overall.three_bet_percent,
        fold_to_three_bet:
          selectedClubId && !statsContract.quality.metric_availability.fold_to_three_bet
            ? 'Unavailable'
            : overall.fold_to_three_bet,
        cbet_flop:
          selectedClubId && !statsContract.quality.metric_availability.cbet_flop
            ? 'Unavailable'
            : overall.cbet_flop,
        aggression_factor:
          selectedClubId && !statsContract.quality.metric_availability.aggression_factor
            ? 'Unavailable'
            : overall.aggression_factor,
        wtsd:
          selectedClubId && !statsContract.quality.metric_availability.wtsd
            ? 'Unavailable'
            : overall.wtsd,
        hours_played:
          selectedClubId && !statsContract.quality.metric_availability.hours_played
            ? 'Unavailable'
            : overall.hours_played,
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
      exportStatsOverview(
        source,
        RATE_FIELDS,
        exportMetadata(),
        `player_stats_overview_${selectedClubId ?? 'all_clubs'}_${rangeKey}.csv`
      );
    } catch (e) {
      reportError(e, 'PlayerStatsPage.exportOverviewCSV');
    }
  };
  if (!isOwnProfile) {
    return (
      <SharedClubStatsView
        targetUserId={targetUserId!}
        asset={statsScope}
        timezone={statsTimezone}
        rangeKey={rangeKey}
        windowDays={windowDays}
        initialClubId={searchParams.get('statsClub')}
        onClubChange={(clubId, replace) => updateStatsUrl({ statsClub: clubId }, replace)}
        onRangeChange={changeRange}
      />
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
            <span className="stats-eyebrow">{statsEyebrow}</span>
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
          <span className="empty-status">Readout Unavailable</span>
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
  if (isOwnProfile && preferencesState !== 'ready') {
    const failed = preferencesState === 'error';
    return (
      <div className="stats-page" aria-busy={failed ? undefined : true}>
        <section className="stats-command-deck" role={failed ? 'alert' : undefined}>
          <img
            className="stats-hero-art"
            src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-dossier-v2.webp`}
            alt=""
            aria-hidden="true"
          />
          <div className="stats-command-copy">
            <span className="stats-eyebrow">Private Stats Controls</span>
            <h1>Player Intelligence</h1>
            <p>
              {failed
                ? 'Your Privacy Preference Could Not Be Verified. Private Detail Remains Hidden.'
                : 'Verifying Your Privacy Preference Before Opening The Dossier...'}
            </p>
            {failed && (
              <button
                className="empty-cta"
                onClick={() => setPreferencesReload((value) => value + 1)}
              >
                Retry Privacy Check
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }
  const hasData = overall.total_hands > 0 || tourn.entries > 0;
  const emptyState = (
    <div className="stats-empty-state">
      <span className="empty-status">Awaiting Hand Ledger</span>
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
    <div className={`stats-page${privacyPresentationMode ? ' stats-page--presentation' : ''}`}>
      <ClubScopeConsole
        statsScope={statsScope}
        clubLabel={clubLabel}
        selectedClub={selectedClub}
        selectedClubId={selectedClubId}
        changeClub={changeClub}
        clubs={clubs}
        clubsLoading={clubsLoading}
        clubsError={clubsError}
        onRetryClubs={() => setClubsReload((value) => value + 1)}
        comparisonOpen={comparisonOpen}
        setComparisonOpen={setComparisonOpen}
        onRetryComparison={() => void loadClubComparison()}
        comparisonSort={comparisonSort}
        changeComparisonSort={changeComparisonSort}
        comparisonLoading={comparisonLoading}
        comparisonError={comparisonError}
        sortedComparisonRows={sortedComparisonRows}
      />
      <StatsHeadlineDeck
        statsEyebrow={statsEyebrow}
        refreshing={refreshing}
        statsContract={statsContract}
        rangeKey={rangeKey}
        changeRange={changeRange}
        lastUpdatedAt={lastUpdatedAt}
        statsDataSource={statsDataSource}
        overall={overall}
        lifetime={lifetime}
        handsWonPct={handsWonPct}
        privacyPresentationMode={privacyPresentationMode}
        category={category}
        hasData={hasData}
        selectedClubId={selectedClubId}
        servingCache={servingCache}
      />
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
          changeCategory(next);
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
            onClick={() => changeCategory(cat)}
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
            {!hasData && category !== 'rake' && category !== 'workspace' && emptyState}
            {!hasData && !privacyPresentationMode && showTab('tournaments') && financialPanel}
            {!hasData && !privacyPresentationMode && showTab('analysis') && exactSessionPanel}
            {privacyPresentationMode && category !== 'workspace' ? null : (
              <>
                {showTab('rake') && (
                  <RakeTab
                    rakeLoading={rakeLoading}
                    rakeStats={rakeStats}
                    rakeError={rakeError}
                    onRetryRake={() => setRakeReload((n) => n + 1)}
                    agentRoles={agentRoles}
                    agentRolesError={agentRolesError}
                    onRetryAgentRoles={() => setAgentRolesReload((n) => n + 1)}
                    isOwnProfile={isOwnProfile}
                    panelResetKey={panelResetKey}
                  />
                )}
                {showTab('overview') && hasData && (
                  <OverviewTab
                    scope={statsScope}
                    clubId={selectedClubId}
                    clubLabel={clubLabel}
                    metricAvailability={statsContract.quality.metric_availability}
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
                    privacyPresentationMode={privacyPresentationMode}
                  />
                )}
                {showTab('performance') && hasData && (
                  <PerformanceTab
                    scope={statsScope}
                    clubId={selectedClubId}
                    metricAvailability={statsContract.quality.metric_availability}
                    overall={overall}
                    showdownWinRate={showdownWinRate}
                    isOwnProfile={isOwnProfile}
                    panelResetKey={panelResetKey}
                    targetUserId={targetUserId}
                    windowDays={windowDays}
                    printing={printing}
                    cashOpportunityStats={cashOpportunityStats}
                    cashOpportunityLoading={cashOpportunityLoading}
                    cashOpportunityError={cashOpportunityError}
                    onRetryCashOpportunities={() => setCashOpportunityReload((value) => value + 1)}
                    onOpenCashEvidence={openCashEvidence}
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
                    scope={statsScope}
                    clubId={selectedClubId}
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
                    userId={targetUserId}
                    scope={statsScope}
                    clubId={selectedClubId}
                  />
                )}
                {showTab('tournaments') && hasData && (
                  <TournamentsTab
                    tourn={tourn}
                    overall={overall}
                    full={full}
                    financialPanel={financialPanel}
                  />
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
                    sessionsAvailable={statsContract.quality.section_availability.sessions}
                    sessionsReason={statsContract.quality.section_availability.sessions_reason}
                    exportSessionsCSV={exportSessionsCSV}
                    exportOverviewCSV={exportOverviewCSV}
                    handMode={handMode}
                    setHandMode={setHandMode}
                    hands={hands}
                    handsLoading={handsLoading}
                    handsError={handsError}
                    setHandsReload={setHandsReload}
                    openHandEvidence={openHandEvidence}
                    clubId={selectedClubId}
                    exactSessionPanel={exactSessionPanel}
                  />
                )}
                {category === 'workspace' && isOwnProfile && (
                  <WorkspaceTab
                    isOwnProfile
                    onPresentationModeChange={setPrivacyPresentationMode}
                    onDashboardLayoutChange={setDashboardLayout}
                    ruleReport={{
                      title: `${clubLabel} ${rangeLabel === 'All' ? 'All Time' : rangeLabel} Review`,
                      sourceVersion: 'stats-intelligence-brief-v1',
                      body: { findings: intelligenceBrief },
                      evidence: intelligenceBrief.map((item) => ({
                        finding_id: item.id,
                        value: item.value,
                        range: rangeKey,
                        club_id: selectedClubId,
                      })),
                      clubId: selectedClubId,
                      rangeDays: windowDays,
                      generatedAt:
                        statsContract.generated_at ?? new Date(lastUpdatedAt ?? 0).toISOString(),
                    }}
                  />
                )}
              </>
            )}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
