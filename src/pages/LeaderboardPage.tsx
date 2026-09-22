/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD PAGE: Club + Global Rankings with Real-Time Updates
 * ═══════════════════════════════════════════════════════════════════════════════
 * Rebuilt 2026-08-19 on the real-profit pipeline:
 * - Profit / hands / tournaments / ROI values are real (snapshot-delta RPCs).
 * - My Clubs vs Global scope both work (global = per-user stats across clubs).
 * - Rank-change arrows are real (current rank vs yesterday's snapshot rank).
 * - No emoji in source (SWC/build rule): Unicode symbols only.
 */

import { Virtuoso } from 'react-virtuoso';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { masterBus } from '../core/MasterBus';

import type {
  LeaderboardSettings,
  LeaderboardRewardContext,
  LeaderboardRewardPlan,
  LeaderboardSettlementStatus,
} from '../services/LeaderboardService';
import { LeaderboardService } from '../services/LeaderboardService';
import type {
  LeaderboardEntry,
  LeaderboardMetric,
  LeaderboardPeriod,
  TournamentStats,
} from '../services/LeaderboardService';
import { getUserMemberships } from '../services/ClubsService';
import { exportToCSV } from '../lib/export';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { PlayerAvatar } from '../components/avatars/PlayerAvatar';
import { LeaderboardPrizeWizard } from '../components/leaderboard/LeaderboardPrizeWizard';
import { LeaderboardSettlementCard } from '../components/leaderboard/LeaderboardSettlementCard';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { compactChips } from '../utils/format';
import './LeaderboardPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { retryFetch } from '../utils/retryFetch';
import { reportError } from '../utils/errorReporter';
import {
  allocateTiedPrizePlan,
  prizePlanLabel,
  totalPrizePlan,
} from '../utils/leaderboardPrizePlans';
import { CLUB_CONTEXT_PARAM, findClubByParam, readClubContextParam } from '../utils/clubScopedPath';

// ── SWR Cache helpers ──
const LB_CACHE_KEY = 'lb_cache_v2_';
const LB_CACHE_TTL_MS = 5 * 60 * 1000;
const LB_CACHE_MAX_RECORDS = 20;

interface LeaderboardCacheRecord {
  version: 2;
  storedAt: number;
  entries: LeaderboardEntry[];
}

// Program history is stated in the calendar the rules run on (UTC), so the
// published moment reads the same for every member wherever they sit.
function formatUtcTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(parsed)} UTC`;
}

function isLeaderboardEntry(value: unknown): value is LeaderboardEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LeaderboardEntry>;
  return (
    Number.isFinite(entry.rank) &&
    typeof entry.userId === 'string' &&
    typeof entry.username === 'string' &&
    Number.isFinite(entry.value)
  );
}

function getCachedEntries(key: string): LeaderboardCacheRecord | null {
  const storageKey = LB_CACHE_KEY + key;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LeaderboardCacheRecord>;
    if (
      parsed.version !== 2 ||
      !Number.isFinite(parsed.storedAt) ||
      Date.now() - (parsed.storedAt as number) > LB_CACHE_TTL_MS ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(isLeaderboardEntry)
    ) {
      sessionStorage.removeItem(storageKey);
      return null;
    }
    return parsed as LeaderboardCacheRecord;
  } catch {
    sessionStorage.removeItem(storageKey);
    return null;
  }
}
function setCachedEntries(key: string, entries: LeaderboardEntry[]) {
  try {
    const record: LeaderboardCacheRecord = { version: 2, storedAt: Date.now(), entries };
    sessionStorage.setItem(LB_CACHE_KEY + key, JSON.stringify(record));

    const records: { key: string; storedAt: number }[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const storageKey = sessionStorage.key(index);
      if (!storageKey?.startsWith(LB_CACHE_KEY)) continue;
      try {
        const cached = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
        records.push({ key: storageKey, storedAt: Number(cached.storedAt) || 0 });
      } catch {
        sessionStorage.removeItem(storageKey);
      }
    }
    records
      .sort((a, b) => b.storedAt - a.storedAt)
      .slice(LB_CACHE_MAX_RECORDS)
      .forEach((recordToRemove) => sessionStorage.removeItem(recordToRemove.key));
  } catch {
    /* quota */
  }
}

const podiumAnimationStyle = {
  opacity: 0,
  transform: 'translateY(16px)',
  animation: 'animationsFadeInUp 0.7s ease-out forwards',
};

const rankingRowAnimationStyle = (index: number) =>
  index > 12
    ? {}
    : {
        opacity: 0,
        transform: 'translateY(8px)',
        animation: `animationsFadeInUp 0.5s ease-out ${index * 60}ms forwards`,
      };

type LeaderboardScope = 'my-clubs' | 'global';
type LeaderboardTab = 'rankings' | 'tournaments';

interface UserClub {
  id: string;
  name: string;
  role: string;
  canManagePrizes: boolean;
  /* THE URL DOES NOT SPEAK UUID. `SlugEnforcer` rewrites every club path to
     its slug, so the club a player is standing in reaches this page as
     `?club=deep-stack-society`, not as a UUID — and the old membership check
     (`clubs.some((c) => c.id === requestedClubId)`) could only ever be true
     for a UUID. Carrying the slug and the 6-digit code on the record is what
     lets `matchesClubParam` answer that question without a network hop.
     Both are already in the `getUserMemberships` select. */
  slug?: string | null;
  club_id?: string | number | null;
}

// Ranking controls are live text on the approved console, never glyph icons.
const METRIC_OPTIONS: {
  value: LeaderboardMetric;
  label: string;
  description: string;
  globalSupported: boolean;
}[] = [
  {
    value: 'profit',
    label: 'Profit',
    description: 'Net Chips Won (Winnings Minus Invested)',
    globalSupported: true,
  },
  {
    value: 'bb100',
    label: 'BB/100',
    description: 'Big Blinds Won Per 100 Hands - Comparable Across Stakes',
    globalSupported: true,
  },
  {
    value: 'hands_played',
    label: 'Hands Played',
    description: 'Total Hands Dealt In',
    globalSupported: true,
  },
  {
    value: 'tournaments_won',
    label: 'Tournaments Won',
    description: 'Tournament Victories',
    globalSupported: true,
  },
  {
    value: 'vpip',
    label: 'VPIP',
    description: 'Voluntarily Put Chips In Pot %',
    globalSupported: false,
  },
  {
    value: 'pfr',
    label: 'PFR',
    description: 'Preflop Raise %',
    globalSupported: false,
  },
  {
    value: 'roi',
    label: 'ROI',
    description: 'Return On Invested Chips %',
    globalSupported: true,
  },
];

const PAGE_SIZE = 50;

const PERIOD_OPTIONS: { value: LeaderboardPeriod; label: string }[] = [
  { value: 'daily', label: 'Today' },
  { value: 'weekly', label: 'This Week' },
  { value: 'monthly', label: 'This Month' },
  { value: 'all_time', label: 'All Time' },
];

export default function LeaderboardPage() {
  useEffect(() => {
    document.title = 'Leaderboard | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthUser();
  const toast = useToast();
  const [scope, setScope] = useState<LeaderboardScope>('my-clubs');
  const [period, setPeriod] = useState<LeaderboardPeriod>('weekly');
  const [periodOffset, setPeriodOffset] = useState<number>(0);
  const [metric, setMetric] = useState<LeaderboardMetric>('profit');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [totalRanked, setTotalRanked] = useState<number | null>(null);
  const [baselineDate, setBaselineDate] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userRank, setUserRank] = useState<{ rank: number; total: number; value: number } | null>(
    null
  );
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  // Club selection

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<LeaderboardSettings | null>(null);
  const [editingSettings, setEditingSettings] = useState<LeaderboardSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsReloadKey, setSettingsReloadKey] = useState(0);
  const settingsStaleRef = useRef(false);
  const [ownerToolsError, setOwnerToolsError] = useState<string | null>(null);
  const [rewardPlan, setRewardPlan] = useState<LeaderboardRewardPlan | null>(null);
  const [settlementStatus, setSettlementStatus] = useState<LeaderboardSettlementStatus | null>(
    null
  );
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [settlementError, setSettlementError] = useState<string | null>(null);
  const settingsRequestRef = useRef(0);
  const openedSetupLinkRef = useRef<string | null>(null);
  const previousUserIdRef = useRef<string | null>(null);

  const [userClubs, setUserClubs] = useState<UserClub[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string | null>(null);
  const [clubsLoading, setClubsLoading] = useState(true);

  // Tournament stats (club-scoped)
  const [activeTab, setActiveTab] = useState<LeaderboardTab>('rankings');
  const activeTabRef = useRef<LeaderboardTab>('rankings');
  const [tournamentStats, setTournamentStats] = useState<TournamentStats[]>([]);
  const [tournamentsLoading, setTournamentsLoading] = useState(false);
  const [tournamentError, setTournamentError] = useState<string | null>(null);

  // Refs for realtime callbacks to avoid stale closures
  const loadLeaderboardRef = useRef(async (_silent?: boolean, _getIsMounted?: () => boolean) => {});
  const loadTournamentStatsRef = useRef(
    async (_getIsMounted?: () => boolean, _silent?: boolean) => {}
  );
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { isRefreshing } = useVisibilityRefresh(async () => {
    if (activeTabRef.current === 'rankings') {
      await loadLeaderboardRef.current(true, () => isMountedRef.current);
    } else {
      await loadTournamentStatsRef.current(() => isMountedRef.current, true);
    }
  });

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    isMountedRef.current = true;
    const timeout = setTimeout(() => {
      if (!isMountedRef.current) return;
      setLoading(false);
      setClubsLoading(false);
    }, 5000);
    return () => {
      isMountedRef.current = false;
      clearTimeout(timeout);
    };
  }, []);

  // Load user's clubs on mount or when user auth changes
  useEffect(() => {
    let isMounted = true;
    const previousUserId = previousUserIdRef.current;
    if (user === null || (previousUserId && user?.id && previousUserId !== user.id)) {
      setShowSettings(false);
      setEditingSettings(null);
    }
    if (user?.id) previousUserIdRef.current = user.id;
    else if (user === null) previousUserIdRef.current = null;
    setUserClubs([]);
    setSelectedClubId(null);
    setUserRank(null);
    setSettlementStatus(null);
    setSettlementError(null);
    setSettings(null);
    if (user?.id) {
      loadUserClubs(() => isMounted);
    } else if (user === null) {
      setClubsLoading(false);
      setUserClubs([]);
      setSelectedClubId(null);
    }
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Keep activeTabRef in sync
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // Store latest load functions in refs
  useEffect(() => {
    loadLeaderboardRef.current = loadLeaderboard;
    loadTournamentStatsRef.current = loadTournamentStats;
  });

  // Global scope: force rankings tab and a supported metric
  useEffect(() => {
    if (scope === 'global') {
      if (activeTab === 'tournaments') setActiveTab('rankings');
      const opt = METRIC_OPTIONS.find((m) => m.value === metric);
      if (opt && !opt.globalSupported) setMetric('profit');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // ── Bus Listener: instant leaderboard refresh when engine completes a hand ──
  useEffect(() => {
    const scheduleRefresh = (view: LeaderboardTab) => {
      if (document.visibilityState !== 'visible' || activeTabRef.current !== view) return;
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
      refreshDebounceRef.current = setTimeout(() => {
        if (view === 'rankings') {
          loadLeaderboardRef.current(true, () => isMountedRef.current);
        } else {
          loadTournamentStatsRef.current(() => isMountedRef.current, true);
        }
      }, 600);
    };
    const unsub = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => scheduleRefresh(activeTabRef.current),
      500
    );
    const unsub2 = masterBus.subscribeDebounced(
      'CHIPS_DISTRIBUTED',
      () => scheduleRefresh('rankings'),
      500
    );
    const unsub3 = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => scheduleRefresh('rankings'),
      500
    );
    const unsub4 = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => scheduleRefresh('rankings'),
      500
    );
    const unsub5 = masterBus.subscribeDebounced(
      'TOURNAMENT_UPDATED',
      () => scheduleRefresh('tournaments'),
      2000
    );
    return () => {
      unsub();
      unsub2();
      unsub3();
      unsub4();
      unsub5();
      if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
    };
  }, []);

  // AUDIT 2026-08-19: a realtime channel on `promotion_leaderboards` used to live
  // here. This view reads player_stats, so that channel could never fire for it;
  // it was dead weight that made the page look more live than it was. Freshness
  // comes from the 30s poll plus the debounced HAND_COMPLETED bus event above.
  // A channel on player_stats itself is deliberately NOT used: it changes on
  // every seat of every hand (~1.1M writes/day) and would flood the client.

  useEffect(() => {
    const requestId = ++settingsRequestRef.current;
    // Any fetch of the owner record (club switch, account switch, retry, a
    // refused publish) replaces the snapshot, so a pending "stale" mark from a
    // refused publish is satisfied here and must not fire again later.
    settingsStaleRef.current = false;
    setSettings((current) => (current?.club_id === selectedClubId ? current : null));
    setSettingsError(null);
    if (!selectedClubId) {
      setSettingsLoading(false);
      return;
    }

    setSettingsLoading(true);
    LeaderboardService.getLeaderboardRewardSetup(selectedClubId)
      .then((data) => {
        if (requestId !== settingsRequestRef.current) return;
        setSettings(data);
      })
      .catch(() => {
        if (requestId === settingsRequestRef.current) {
          setSettingsError('Prize Setup Could Not Be Loaded.');
        }
      })
      .finally(() => {
        if (requestId === settingsRequestRef.current) setSettingsLoading(false);
      });
  }, [selectedClubId, userClubs, settingsReloadKey]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requestedClubId = readClubContextParam(params);
    if (params.get('setup') !== 'prizes' || !requestedClubId) {
      openedSetupLinkRef.current = null;
      return;
    }

    /* Same identity rule as the club selection above: the prize-setup deep
       link is built by the hamburger with a UUID today, but a slug is an
       equally valid thing for that URL to carry (and will be, the moment a
       player copies the address bar), so both must resolve here too. */
    const requestedClub = findClubByParam(userClubs, requestedClubId);
    if (requestedClub && selectedClubId !== requestedClub.id) {
      setSelectedClubId(requestedClub.id);
      setScope('my-clubs');
      setActiveTab('rankings');
      return;
    }

    const requestKey = requestedClubId;
    if (
      requestedClub &&
      selectedClubId === requestedClub.id &&
      // A club switch and this effect can share one render. React has queued
      // the stale settings reset by then, but this closure can still see the
      // previous club's owner record. Never open that record under the new URL.
      settings?.club_id === requestedClub.id &&
      settings?.can_manage &&
      openedSetupLinkRef.current !== requestKey
    ) {
      openedSetupLinkRef.current = requestKey;
      setEditingSettings(settings);
      setShowSettings(true);
      params.delete('setup');
      navigate({ search: params.toString() }, { replace: true });
    }
  }, [location.search, navigate, selectedClubId, settings, userClubs]);

  // 2026-08-24: a useMasterBusChannel({ table: 'tournament_players',
  // filter: null }) used to sit here. It NEVER SUBSCRIBED - the hook
  // early-returns on `if (!enabled || !channelName || !filter)`
  // (useMasterBusChannel.ts:93), so a null filter silently means "do nothing".
  // It read as live realtime coverage and was not; the 30s poll below has been
  // the only refresh mechanism this page ever had.
  //
  // Deleted rather than repaired, because repairing it means subscribing to
  // tournament_players with NO filter - every chip update, elimination and
  // registration for every tournament on the platform delivered to every
  // client viewing a leaderboard. A leaderboard is aggregate, non-actionable
  // data; a poll is the right mechanism for it and the wrong thing to replace
  // with a firehose.

  // Auto-refresh every 30 seconds
  useEffect(() => {
    refreshTimerRef.current = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (activeTabRef.current === 'rankings') {
        loadLeaderboardRef.current(true, () => isMountedRef.current);
      } else {
        loadTournamentStatsRef.current(() => isMountedRef.current, true);
      }
    }, 30000);

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, []);

  // Fetch Rankings Data (club scope needs a club; global scope does not)
  useEffect(() => {
    let isMounted = true;
    if (activeTab === 'rankings' && (scope === 'global' || selectedClubId)) {
      if (scope === 'global') {
        const opt = METRIC_OPTIONS.find((m) => m.value === metric);
        if (opt && !opt.globalSupported) return;
      }
      loadLeaderboard(false, () => isMounted);
    } else if (scope === 'my-clubs' && !selectedClubId) {
      setEntries([]);
      setLoadError(null);
      setLoading(false);
    }
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, period, periodOffset, metric, selectedClubId, activeTab, user?.id]);

  // Fetch Tournament Stats Data (club-scoped only)
  useEffect(() => {
    let isMounted = true;
    if (selectedClubId && activeTab === 'tournaments') {
      if (scope === 'global') return;
      loadTournamentStats(() => isMounted);
    } else if (!selectedClubId) {
      setTournamentStats([]);
      setTournamentError(null);
      setTournamentsLoading(false);
    }
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClubId, activeTab, scope]);

  const loadUserClubs = async (getIsMounted?: () => boolean) => {
    setClubsLoading(true);
    try {
      const memberships = await getUserMemberships(user);
      let rewardContexts: LeaderboardRewardContext[] = [];
      try {
        rewardContexts = await LeaderboardService.getManageableRewardContexts(true);
        setOwnerToolsError(null);
      } catch {
        setOwnerToolsError('Owner Prize Tools Could Not Be Loaded.');
      }
      const memberClubs: UserClub[] = memberships
        .map(
          (m): UserClub => ({
            id: (m.club?.id || m.club_id) as string,
            name: m.club?.name || 'Unknown Club',
            role: String(m.role || 'member'),
            canManagePrizes: rewardContexts.some(
              (context) => context.club_id === (m.club?.id || m.club_id)
            ),
            slug: m.club?.slug ?? null,
            club_id: m.club?.club_id ?? null,
          })
        )
        .filter((c) => Boolean(c.id));
      const clubs: UserClub[] = [...memberClubs];
      for (const context of rewardContexts) {
        if (clubs.some((club) => club.id === context.club_id)) continue;
        /* A reward context is a club whose prizes this owner funds, which they
           may not be a MEMBER of, so the membership join above never saw it and
           there is no slug to carry. Such a club is still reachable by its UUID
           — which is what the Owner Prize Tools link builds — so the null here
           narrows how it can be addressed, not whether it can be. */
        clubs.push({
          id: context.club_id,
          name: context.club_name,
          role: context.funding_owner_type === 'union' ? 'union_owner' : 'owner',
          canManagePrizes: true,
          slug: null,
          club_id: null,
        });
      }

      if (getIsMounted && !getIsMounted()) return;
      setUserClubs(clubs);

      /* ── THE REPORTED BUG LIVED IN THE LINE BELOW (Dan, 2026-09-02) ───────
         It used to read:

             requestedClubId && clubs.some((club) => club.id === requestedClubId)
               ? requestedClubId
               : … : clubs[0]?.id || null

         Two faults, and they compounded. First, `club.id === requestedClubId`
         is true only for a UUID, while `SlugEnforcer` guarantees the URL
         carries a SLUG — so arriving from inside Deep Stack Society, the test
         failed on a club the player is very much in. Second, the failure was
         silent: it fell through to `clubs[0]`, an arbitrary first membership,
         which rendered Club JAQK under a heading that gave no hint the URL
         had been ignored. A thrown-away parameter looked like a wrong number.

         `findClubByParam` matches id, slug OR 6-digit code, so every form the
         URL can legitimately carry now resolves — and it resolves to the club
         RECORD, so `selectedClubId` stays the UUID the queries below need
         while the address bar keeps the slug Dan reads. */
      const requestedClubId = readClubContextParam(location.search);
      const requestedClub = findClubByParam(clubs, requestedClubId);

      /* An unmatched param is NOT the same as no param: the URL named a club
         this viewer is not in (left the club, wrong account, stale link).
         Falling back to `clubs[0]` silently is what made the original fault
         invisible, so say so instead of just substituting.

         THE TOAST FIRES HERE, NOT INSIDE THE UPDATER BELOW. A `setState`
         updater must be pure — React may invoke it more than once for a
         single update — so a toast raised inside one is a duplicate-render
         bug waiting for the next React upgrade. The Toast layer's dedupe
         would have hidden it, which is worse: hidden, not absent. */
      if (requestedClubId && !requestedClub) {
        toast.error('That Club Leaderboard Is Not Available To You. Showing Your Clubs Instead.');
        /* And take the bad club OUT of the URL. Left there, the hamburger, the
           section rail and the footer keep stamping it onto every link, and
           the workspace keeps trying to load a club this viewer is not in,
           while the page shows a different one - the address bar would be
           lying about what is on screen. */
        const params = new URLSearchParams(location.search);
        params.delete(CLUB_CONTEXT_PARAM);
        navigate({ search: params.toString() }, { replace: true });
      }

      setSelectedClubId((currentClubId) => {
        if (requestedClub) return requestedClub.id;
        if (clubs.some((club) => club.id === currentClubId)) return currentClubId;
        return clubs[0]?.id || null;
      });
    } catch (error) {
      reportError(error, 'LeaderboardPage.Failed_to_load_clubs');
      if (!getIsMounted || getIsMounted()) {
        setUserClubs([]);
        setSelectedClubId(null);
      }
      toast.error('Failed to load clubs');
    }
    if (getIsMounted && !getIsMounted()) return;
    setClubsLoading(false);
  };

  /**
   * Switch club AND say so in the URL.
   *
   * The selector used to call `setSelectedClubId` alone, which left the page
   * showing one club while `?club=` still named another. That disagreement is
   * not cosmetic on this page: the hamburger, the section rail and the footer
   * all read the URL to decide which club THEIR links carry, so a player who
   * switched clubs here and then opened the menu was handed links back to the
   * club they had just switched away from.
   *
   * The slug is preferred over the UUID for the same reason `SlugEnforcer`
   * exists — Dan's "THE SLUGS MUST MATCH" — and `findClubByParam` reads both,
   * so a shared link keeps working either way. `replace` keeps the back
   * button meaning "the page before this one" rather than replaying every
   * club the player skimmed through.
   */
  /* The URL can change while this page stays mounted: the hamburger's club
     selector rewrites `?club=` on a scoped page, the section rail's
     Leaderboards link is clicked while already here, or the back button moves
     between two clubs. `/leaderboard` has no route key, so nothing remounts,
     and `loadUserClubs` reads the param only once per account. Follow the
     param whenever it names a club this viewer is in; an unmatched one was
     already reported and cleared by `loadUserClubs`. `selectClub` below writes
     the same club it selects, so this cannot loop. */
  useEffect(() => {
    if (userClubs.length === 0) return;
    const requested = findClubByParam(userClubs, readClubContextParam(location.search));
    if (requested && requested.id !== selectedClubId) setSelectedClubId(requested.id);
  }, [location.search, userClubs, selectedClubId]);

  const selectClub = (clubId: string) => {
    setSelectedClubId(clubId);
    const club = userClubs.find((candidate) => candidate.id === clubId);
    const params = new URLSearchParams(location.search);
    params.set(CLUB_CONTEXT_PARAM, club?.slug || clubId);
    navigate({ search: params.toString() }, { replace: true });
  };

  const reqSeqRef = useRef(0);
  const activeRankingRequestRef = useRef(0);

  const loadLeaderboard = async (silent = false, getIsMounted?: () => boolean) => {
    const isGlobal = scope === 'global';
    if (!isGlobal && !selectedClubId) {
      setLoading(false);
      return;
    }
    if (silent && activeRankingRequestRef.current !== 0) return;
    // Monotonic request token: a newer request always wins, and an in-flight
    // response that is no longer current is discarded rather than rendered.
    const myReq = ++reqSeqRef.current; // also invalidates any in-flight loadMore
    activeRankingRequestRef.current = myReq;

    // SWR: show cached data instantly
    const cacheKey = `${isGlobal ? 'global' : selectedClubId}_${metric}_${period}_${periodOffset}`;
    if (isGlobal) {
      setSettlementStatus(null);
      setRewardPlan(null);
      setSettlementError(null);
    }
    if (!user?.id) setUserRank(null);
    if (!silent) {
      setLoadError(null);
      setSettlementStatus(null);
      setRewardPlan(null);
      setSettlementError(null);
      setSettlementLoading(
        !isGlobal && Boolean(selectedClubId) && (period === 'weekly' || period === 'monthly')
      );
      setUserRank(null);
      const cached = getCachedEntries(cacheKey);
      if (cached && cached.entries.length > 0) {
        setEntries(cached.entries);
        setTotalRanked(cached.entries[0]?.totalRanked ?? null);
        setBaselineDate(cached.entries[0]?.baselineDate ?? null);
        setLastUpdated(new Date(cached.storedAt));
        setLoading(false);
      } else {
        setEntries([]);
        setTotalRanked(null);
        setBaselineDate(null);
        setUserRank(null);
        setLoading(true);
      }
    }
    try {
      const data = await retryFetch(
        () =>
          isGlobal
            ? LeaderboardService.getGlobalLeaderboard(
                metric,
                period,
                PAGE_SIZE,
                0,
                periodOffset,
                true
              )
            : LeaderboardService.getClubLeaderboard(
                selectedClubId as string,
                metric,
                period,
                PAGE_SIZE,
                0,
                periodOffset,
                true
              ),
        { maxRetries: 2 }
      );
      if (myReq !== reqSeqRef.current) return; // superseded by a newer request
      if (getIsMounted && !getIsMounted()) return;
      setEntries(data);
      setTotalRanked(data[0]?.totalRanked ?? null);
      setBaselineDate(data[0]?.baselineDate ?? null);
      setCachedEntries(cacheKey, data);
      setLastUpdated(new Date());
      setLoadError(null);

      // The ranked rows are the primary content. Render them as soon as the
      // ranking + profile queries complete instead of holding the skeleton on
      // screen while secondary payout and personal-rank metadata load.
      if (!silent) setLoading(false);

      // Secondary metadata is independent and can arrive in parallel. One
      // settlement read model replaces separate plan and payout queries.
      const periodMetadataPromise =
        !isGlobal && selectedClubId && (period === 'weekly' || period === 'monthly')
          ? LeaderboardService.getPeriodWindow(period, periodOffset).then(async (window) => {
              if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
                setSettlementLoading(true);
              }
              try {
                const status = await LeaderboardService.getLeaderboardSettlementStatus(
                  selectedClubId,
                  period,
                  window.start_date
                );
                if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
                  setSettlementStatus(status);
                  setRewardPlan(status.program);
                  setSettlementError(null);
                }
              } catch (error) {
                reportError(error, 'LeaderboardPage.Settlement_status_failed');
                if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
                  setSettlementError('Period Settlement Could Not Be Verified.');
                }
              } finally {
                if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
                  setSettlementLoading(false);
                }
              }
            })
          : Promise.resolve().then(() => {
              if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
                setSettlementStatus(null);
                setRewardPlan(null);
                setSettlementError(null);
                setSettlementLoading(false);
              }
            });

      const rankPromise = user?.id
        ? (isGlobal
            ? LeaderboardService.getGlobalUserRank(user.id, metric, period, periodOffset)
            : LeaderboardService.getUserRank(
                user.id,
                selectedClubId as string,
                metric,
                period,
                periodOffset
              )
          ).then((rank) => {
            if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
              setUserRank(rank);
            }
          })
        : Promise.resolve();

      await Promise.allSettled([periodMetadataPromise, rankPromise]);
    } catch (error) {
      reportError(error, 'LeaderboardPage.Failed_to_load_leaderboard');
      if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
        setLoadError('Rankings Could Not Be Refreshed.');
        if (!silent) toast.error('Failed to load leaderboard');
      }
    } finally {
      if (myReq === reqSeqRef.current) {
        activeRankingRequestRef.current = 0;
        if (!getIsMounted || getIsMounted()) setLoading(false);
      }
    }
  };

  /**
   * Append the next page.
   *
   * Guarded by the same request token the main load uses. Without it, changing
   * metric/period/scope while a page request is in flight merges rows scored by
   * the OLD filter into the NEW list - and because the offset is derived from
   * entries.length, the list it appends to may already have been replaced.
   * A superseded page is discarded rather than rendered.
   */
  const loadMore = async () => {
    if (loadingMore) return;
    const isGlobal = scope === 'global';
    if (!isGlobal && !selectedClubId) return;
    const myReq = reqSeqRef.current;
    const offset = entries.length;
    setLoadingMore(true);
    try {
      const more = isGlobal
        ? await LeaderboardService.getGlobalLeaderboard(
            metric,
            period,
            PAGE_SIZE,
            offset,
            periodOffset,
            true
          )
        : await LeaderboardService.getClubLeaderboard(
            selectedClubId as string,
            metric,
            period,
            PAGE_SIZE,
            offset,
            periodOffset,
            true
          );
      if (myReq !== reqSeqRef.current) return; // filters moved on; drop this page
      if (more.length > 0) {
        setEntries((prev) => {
          // The list may have been replaced while this was in flight.
          if (prev.length !== offset) return prev;
          const seen = new Set(prev.map((e) => e.userId));
          const next = [...prev, ...more.filter((m) => !seen.has(m.userId))];
          const cacheKey = `${isGlobal ? 'global' : selectedClubId}_${metric}_${period}_${periodOffset}`;
          setCachedEntries(cacheKey, next);
          return next;
        });
      }
    } catch (e) {
      reportError(e, 'LeaderboardPage.loadMore');
      toast.error('Could not load more');
    } finally {
      if (myReq === reqSeqRef.current) setLoadingMore(false);
    }
  };

  const tournReqSeqRef = useRef(0);

  const loadTournamentStats = async (getIsMounted?: () => boolean, silent = false) => {
    if (!selectedClubId) {
      setTournamentsLoading(false);
      return;
    }
    const myReq = ++tournReqSeqRef.current;
    if (!silent) setTournamentsLoading(true);
    setTournamentError(null);
    try {
      const data = await retryFetch(
        () => LeaderboardService.getClubTournamentStats(selectedClubId, 50, 0, true),
        { maxRetries: 2 }
      );
      if (myReq !== tournReqSeqRef.current) return;
      if (getIsMounted && !getIsMounted()) return;
      setTournamentStats(data);
      setLastUpdated(new Date());
      setTournamentError(null);
    } catch (error) {
      reportError(error, 'LeaderboardPage.Failed_to_load_tournament_stats');
      if (myReq === tournReqSeqRef.current) {
        setTournamentError('Tournament Stats Could Not Be Refreshed.');
        if (!silent) toast.error('Failed to load tournament stats');
      }
    } finally {
      if (myReq === tournReqSeqRef.current && (!getIsMounted || getIsMounted()))
        setTournamentsLoading(false);
    }
  };

  const formatValue = (value: number, m: LeaderboardMetric): string => {
    const precise = Math.trunc(value * 10) / 10;
    if (m === 'vpip' || m === 'pfr' || m === 'roi') {
      return `${precise}%`;
    }
    if (m === 'bb100') {
      return `${precise > 0 ? '+' : ''}${precise} BB/100`;
    }
    return compactChips(value);
  };

  const getRankLabel = (rank: number): string => {
    const base = rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `#${rank}`;
    const isTie = entries.filter((entry) => entry.rank === rank).length > 1;
    return isTie ? `T-${base}` : base;
  };

  const canManagePrizes = Boolean(settings?.can_manage);

  const visibleMetricOptions = METRIC_OPTIONS.filter(
    (m) => scope === 'my-clubs' || m.globalSupported
  );
  const payoutsByUser = useMemo(
    () => new Map((settlementStatus?.receipts || []).map((payout) => [payout.user_id, payout])),
    [settlementStatus?.receipts]
  );
  const plannedPrizesByUser = useMemo(() => {
    if (
      scope !== 'my-clubs' ||
      !rewardPlan?.rewards_enabled ||
      rewardPlan.payout_metric !== metric
    ) {
      return new Map<string, number>();
    }
    return allocateTiedPrizePlan(entries, rewardPlan.prizes);
  }, [entries, metric, rewardPlan, scope]);

  const top3 = entries.slice(0, 3);
  const rest = entries.slice(3);

  // Rate metrics are meaningless without volume, so every row carries the hand
  // count for the selected period, and rows that fail the ROI qualifier say so
  // rather than silently sorting last.
  const renderRowContext = (entry: LeaderboardEntry) => {
    const bits: string[] = [];
    if (entry.hands != null && entry.hands > 0) {
      bits.push(`${compactChips(entry.hands)} Hands`);
    }
    if ((metric === 'roi' || metric === 'bb100') && entry.qualified === false) {
      // The threshold itself lives only in SQL (v_min_hands). Restating it here
      // would be a second source of truth with nothing keeping the two in step,
      // so the row reports the RPC's `qualified` verdict rather than the number.
      bits.push('Too Few Hands - Unranked');
    }
    if (bits.length === 0) return null;
    return <span className="entry-subline">{bits.join(' \u00B7 ')}</span>;
  };

  // Rows are clickable; make them operable from the keyboard too.
  const rowKeyActivate = (userId: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(`/profile/${userId}`);
    }
  };

  const renderChangeBadge = (change: number) => {
    if (!change) return null;
    return (
      <span className={`change rank-change-anim ${change > 0 ? 'up' : 'down'}`}>
        {change > 0 ? 'Up' : 'Down'} {Math.abs(change)}
      </span>
    );
  };

  const renderPrizeBadge = (entry: LeaderboardEntry) => {
    const payout = payoutsByUser.get(entry.userId);
    if (payout) {
      return <span className="payout-badge">Paid {compactChips(payout.payout_amount)} Chips</span>;
    }
    const planned = plannedPrizesByUser.get(entry.userId);
    if (!planned) return null;
    const prizeState =
      settlementStatus?.state === 'failed'
        ? 'Delayed'
        : settlementStatus?.state === 'pending'
          ? 'Pending'
          : 'Prize';
    return (
      <span className="payout-badge payout-badge-planned">
        {prizeState} {compactChips(planned)} Chips
      </span>
    );
  };

  const renderPodiumPlace = (entry: LeaderboardEntry) => {
    return (
      <div
        className={`podium-place ${entry.userId === user?.id ? 'current-user' : ''}`}
        onClick={() => navigate(`/profile/${entry.userId}`)}
        onKeyDown={rowKeyActivate(entry.userId)}
        role="button"
        tabIndex={0}
        aria-label={`${getRankLabel(entry.rank)}, ${entry.username}, ${formatValue(entry.value, metric)}`}
      >
        <span className="entry-rank">{getRankLabel(entry.rank)}</span>
        <PlayerAvatar
          src={entry.avatar}
          name={entry.username}
          size="sm"
          level={entry.level || 1}
          showPresence={false}
          showLevelBadge={false}
          showVipRing={false}
        />
        <div className="entry-info">
          <span className="entry-name">{entry.username}</span>
          {entry.isVIP && <span className="entry-vip-tag">VIP</span>}
          {renderRowContext(entry)}
        </div>
        <div className={`entry-value ${entry.value >= 0 ? 'positive' : 'negative'}`}>
          {formatValue(entry.value, metric)}
          {renderPrizeBadge(entry)}
          {renderChangeBadge(entry.change)}
        </div>
      </div>
    );
  };

  // Period deltas are measured from a daily snapshot. If that job missed a day
  // the baseline is older than the label implies, so show the real span.
  const windowLabel = (() => {
    if (period === 'all_time') return 'Since 2026-05-21';
    if (!baselineDate) return null;
    const days = Math.round(
      (Date.now() - new Date(`${baselineDate}T00:00:00Z`).getTime()) / 86400000
    );
    const expected = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
    return days > expected ? `${days} Day Window` : `Since ${baselineDate}`;
  })();

  const activeMetric = METRIC_OPTIONS.find((option) => option.value === metric);
  const programMetricLabel =
    METRIC_OPTIONS.find((option) => option.value === settings?.payout_metric)?.label || 'Profit';
  const selectedClubName = userClubs.find((club) => club.id === selectedClubId)?.name;
  const currentError = activeTab === 'rankings' ? loadError : tournamentError;
  const canExport =
    (entries.length > 0 && activeTab === 'rankings') ||
    (tournamentStats.length > 0 && activeTab === 'tournaments');

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (scope !== 'my-clubs') return;
    let nextTab: LeaderboardTab | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      nextTab = activeTab === 'rankings' ? 'tournaments' : 'rankings';
    } else if (event.key === 'Home') {
      nextTab = 'rankings';
    } else if (event.key === 'End') {
      nextTab = 'tournaments';
    }
    if (!nextTab) return;
    event.preventDefault();
    setActiveTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`leaderboard-${nextTab}-tab`)?.focus());
  };

  const retryCurrentView = () => {
    if (activeTab === 'rankings') {
      loadLeaderboardRef.current(false, () => isMountedRef.current);
    } else {
      loadTournamentStatsRef.current(() => isMountedRef.current, false);
    }
  };

  const exportLeaderboard = () => {
    try {
      if (activeTab === 'rankings') {
        exportToCSV(entries, `leaderboard_${scope}_${metric}_${period}.csv`, [
          { key: 'rank', label: 'Rank' },
          { key: 'username', label: 'Username' },
          { key: 'value', label: activeMetric?.label || 'Value' },
          { key: 'hands', label: 'Hands' },
          { key: 'change', label: 'Change' },
          { key: 'userId', label: 'User ID' },
        ]);
      } else {
        exportToCSV(tournamentStats, `leaderboard_${scope}_tournaments.csv`, [
          { key: 'username', label: 'Username' },
          { key: 'tournamentsPlayed', label: 'Tournaments' },
          { key: 'wins', label: 'Wins' },
          { key: 'finalTables', label: 'Final Tables' },
          { key: 'itmFinishes', label: 'ITM' },
          { key: 'totalPrizes', label: 'Total Prizes' },
          { key: 'roi', label: 'ROI' },
          { key: 'biggestWin', label: 'Biggest Win' },
          { key: 'userId', label: 'User ID' },
        ]);
      }
      toast.success('Leaderboard Exported');
    } catch (error) {
      reportError(error, 'LeaderboardPage.export');
      toast.error('Export Failed');
    }
  };

  return (
    <div className="leaderboard-page" data-arena-surface="leaderboard-console">
      <h1 className="lb-sr-only">Leaderboards</h1>
      <SpadeConsole
        className="lb-console"
        eyebrow="Club Arena"
        title="Leaderboards"
        titleId="leaderboard-title"
        subtitle={
          scope === 'global' ? 'Across Club Arena' : selectedClubName || 'Your Club Rankings'
        }
        pill={
          currentError
            ? 'Delayed'
            : clubsLoading || (activeTab === 'rankings' ? loading : tournamentsLoading)
              ? 'Loading'
              : 'Live'
        }
        pillInk={currentError ? 'red' : 'green'}
        aria-labelledby="leaderboard-title"
      >
        <div className="lb-live-rail" aria-live="polite">
          <span>
            {isRefreshing
              ? 'Refreshing Board'
              : currentError
                ? 'Update Delayed'
                : `Updated ${lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
          </span>
          {activeTab === 'rankings' && windowLabel && (
            <span className="lb-window-label" title="The Snapshot This Period Is Measured From">
              {windowLabel}
            </span>
          )}
        </div>
        {activeTab === 'rankings' && (
          <div className="lb-telemetry" aria-label="Current Leaderboard Summary">
            <div>
              <span className="lb-telemetry-label">Field</span>
              <strong>{totalRanked != null ? compactChips(totalRanked) : '-'}</strong>
              <span>Ranked Players</span>
            </div>
            <div>
              <span className="lb-telemetry-label">Your Position</span>
              <strong>{userRank ? getRankLabel(userRank.rank) : '-'}</strong>
              <span>
                {userRank ? `Of ${userRank.total.toLocaleString('en-US')}` : 'Enter The Field'}
              </span>
            </div>
            <div>
              <span className="lb-telemetry-label">Measured By</span>
              <strong>{activeMetric?.label || 'Profit'}</strong>
              <span>Ranking Signal</span>
            </div>
          </div>
        )}

        <section className="lb-control-deck" aria-label="Leaderboard Controls">
          <div className="lb-control-header">
            <div className="leaderboard-tabs" role="tablist" aria-label="Leaderboard Views">
              <button
                id="leaderboard-rankings-tab"
                className={`tab-btn ${activeTab === 'rankings' ? 'active' : ''}`}
                onClick={() => setActiveTab('rankings')}
                onKeyDown={handleTabKeyDown}
                role="tab"
                aria-selected={activeTab === 'rankings'}
                aria-controls="leaderboard-content-panel"
                tabIndex={activeTab === 'rankings' ? 0 : -1}
              >
                Rankings
              </button>
              {scope === 'my-clubs' && (
                <button
                  id="leaderboard-tournaments-tab"
                  className={`tab-btn ${activeTab === 'tournaments' ? 'active' : ''}`}
                  onClick={() => setActiveTab('tournaments')}
                  onKeyDown={handleTabKeyDown}
                  role="tab"
                  aria-selected={activeTab === 'tournaments'}
                  aria-controls="leaderboard-content-panel"
                  tabIndex={activeTab === 'tournaments' ? 0 : -1}
                >
                  Tournament Stats
                </button>
              )}
            </div>
            <div className="lb-control-actions">
              {ownerToolsError && (
                <button
                  className="lb-action-btn"
                  onClick={() => void loadUserClubs(() => isMountedRef.current)}
                  title={ownerToolsError}
                >
                  Retry Owner Tools
                </button>
              )}
              {settingsError && scope !== 'global' && activeTab === 'rankings' && (
                <button
                  className="lb-action-btn lb-action-prize"
                  onClick={() => setSettingsReloadKey((value) => value + 1)}
                  title={settingsError}
                >
                  Retry Prize Setup
                </button>
              )}
              {canManagePrizes && scope !== 'global' && activeTab === 'rankings' && (
                <button
                  className="lb-action-btn lb-action-prize"
                  onClick={() => {
                    if (!settings) return;
                    setEditingSettings(settings);
                    setShowSettings(true);
                  }}
                  title="Set Up Leaderboard Prizes"
                  disabled={settingsLoading || !settings}
                >
                  {settingsLoading
                    ? 'Loading Prize Setup'
                    : settings?.setup_complete
                      ? 'Review Prize Setup'
                      : 'Set Up Prizes'}
                </button>
              )}
              {canExport && (
                <button className="lb-action-btn" onClick={exportLeaderboard}>
                  Export CSV
                </button>
              )}
            </div>
          </div>

          <div className="leaderboard-filters">
            <div className="lb-control-group lb-arena-group">
              <span className="lb-control-label">Arena</span>
              <div className="lb-arena-controls">
                {/* Club Selector (club scope, multiple clubs) */}
                {scope === 'my-clubs' && userClubs.length > 1 && (
                  <div className="filter-group">
                    <select
                      aria-label="Club"
                      value={selectedClubId || ''}
                      onChange={(e) => selectClub(e.target.value)}
                    >
                      {userClubs.map((club) => (
                        <option key={club.id} value={club.id}>
                          {club.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {scope === 'my-clubs' && userClubs.length <= 1 && (
                  <span className="lb-club-readout">{selectedClubName || 'My Club'}</span>
                )}

                {/* Scope Toggle */}
                <div className="filter-group scope-toggle">
                  <button
                    className={scope === 'my-clubs' ? 'active' : ''}
                    onClick={() => setScope('my-clubs')}
                    aria-pressed={scope === 'my-clubs'}
                  >
                    My Clubs
                  </button>
                  <button
                    className={scope === 'global' ? 'active' : ''}
                    onClick={() => setScope('global')}
                    aria-pressed={scope === 'global'}
                  >
                    Global
                  </button>
                </div>
              </div>
            </div>

            {/* Period Selector */}
            {activeTab === 'rankings' && (
              <div className="lb-control-group lb-period-group">
                <span className="lb-control-label">Period</span>
                <div className="filter-group lb-chip-bar">
                  {PERIOD_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`lb-filter-chip ${period === opt.value ? 'active' : ''}`}
                      onClick={() => {
                        setPeriod(opt.value);
                        setPeriodOffset(0);
                      }}
                      aria-pressed={period === opt.value}
                    >
                      {opt.label}
                    </button>
                  ))}
                  {period !== 'all_time' && (
                    <div className="lb-period-stepper">
                      <button
                        className="lb-step-btn"
                        onClick={() => setPeriodOffset((o) => o - 1)}
                        title="Previous Period"
                        aria-label="Previous Period"
                      >
                        Previous
                      </button>
                      <span>
                        {periodOffset === 0
                          ? 'Current'
                          : periodOffset === -1
                            ? 'Last'
                            : `${Math.abs(periodOffset)} Periods Ago`}
                      </span>
                      <button
                        className="lb-step-btn"
                        onClick={() => setPeriodOffset((o) => Math.min(0, o + 1))}
                        disabled={periodOffset >= 0}
                        title="Next Period"
                        aria-label="Next Period"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Metric Selector */}
            {activeTab === 'rankings' && (
              <div className="lb-control-group lb-metric-group">
                <div className="lb-metric-heading">
                  <span className="lb-control-label">Ranking Signal</span>
                  <span>{activeMetric?.description}</span>
                </div>
                <div className="filter-group lb-chip-bar lb-chip-scroll">
                  {visibleMetricOptions.map((opt) => (
                    <button
                      key={opt.value}
                      className={`lb-filter-chip ${metric === opt.value ? 'active' : ''}`}
                      title={opt.description}
                      onClick={() => setMetric(opt.value)}
                      aria-pressed={metric === opt.value}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {activeTab === 'tournaments' && (
              <p className="lb-period-note">All Recorded Tournaments</p>
            )}
          </div>
        </section>

        {currentError &&
          ((activeTab === 'rankings' && entries.length > 0) ||
            (activeTab === 'tournaments' && tournamentStats.length > 0)) && (
            <div className="lb-refresh-warning" role="status">
              <div>
                <strong>Live Update Delayed</strong>
                <span>Showing The Last Verified Board.</span>
              </div>
              <button onClick={retryCurrentView}>Retry Now</button>
            </div>
          )}

        {/* Leaderboard Content */}
        <div
          id="leaderboard-content-panel"
          className="leaderboard-list"
          role="tabpanel"
          aria-labelledby={`leaderboard-${activeTab}-tab`}
          aria-busy={
            clubsLoading ||
            (activeTab === 'rankings'
              ? loading || isRefreshing
              : tournamentsLoading || isRefreshing)
          }
        >
          {clubsLoading && scope === 'my-clubs' ? (
            <p className="lb-loading" role="status">
              Loading Your Clubs...
            </p>
          ) : scope === 'my-clubs' && userClubs.length === 0 ? (
            <div className="empty-state">
              <p>Join A Club To See Leaderboard Rankings, Or Switch To Global.</p>
              <button className="join-club-btn" onClick={() => navigate('/clubs')}>
                Browse Clubs
              </button>
            </div>
          ) : activeTab === 'rankings' && loading ? (
            <p className="lb-loading" role="status">
              Loading Rankings...
            </p>
          ) : activeTab === 'rankings' && loadError && entries.length === 0 ? (
            <div className="empty-state lb-error-state" role="alert">
              <p>Rankings Could Not Be Loaded.</p>
              <p className="empty-sub">Check Your Connection And Try Again.</p>
              <button className="join-club-btn" onClick={retryCurrentView}>
                Retry Rankings
              </button>
            </div>
          ) : activeTab === 'rankings' && entries.length === 0 ? (
            <div className="empty-state">
              <p>No Rankings Yet For This Period.</p>
              <p className="empty-sub">Start Playing To Climb The Leaderboard.</p>
              <button className="join-club-btn" onClick={() => navigate('/')}>
                Find A Table
              </button>
            </div>
          ) : activeTab === 'tournaments' && tournamentsLoading ? (
            <p className="lb-loading" role="status">
              Loading Tournament Stats...
            </p>
          ) : activeTab === 'tournaments' && tournamentError && tournamentStats.length === 0 ? (
            <div className="empty-state lb-error-state" role="alert">
              <p>Tournament Stats Could Not Be Loaded.</p>
              <p className="empty-sub">Check Your Connection And Try Again.</p>
              <button className="join-club-btn" onClick={retryCurrentView}>
                Retry Tournament Stats
              </button>
            </div>
          ) : activeTab === 'tournaments' && tournamentStats.length === 0 ? (
            <div className="empty-state">
              <p>No Tournament Stats Yet.</p>
              <p className="empty-sub">Register For A Tournament To See Your Stats.</p>
            </div>
          ) : activeTab === 'rankings' && entries.length > 0 ? (
            <>
              {/* ── TOP 3 PODIUM ── */}
              {top3.length >= 3 && (
                <div className="podium-section" style={podiumAnimationStyle}>
                  {top3.map((entry) => (
                    <div key={entry.userId}>{renderPodiumPlace(entry)}</div>
                  ))}
                </div>
              )}

              {/* Show top 3 as list rows if less than 3 total */}
              {top3.length < 3 &&
                top3.map((entry, index) => (
                  <div
                    key={entry.userId}
                    className={`leaderboard-entry ${entry.userId === user?.id ? 'current-user' : ''}`}
                    onClick={() => navigate(`/profile/${entry.userId}`)}
                    onKeyDown={rowKeyActivate(entry.userId)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${getRankLabel(entry.rank)} ${entry.username}, ${formatValue(entry.value, metric)}`}
                    style={{ ...rankingRowAnimationStyle(index), cursor: 'pointer' }}
                  >
                    <span className={`entry-rank top-3`}>{getRankLabel(entry.rank)}</span>
                    <div className="entry-avatar">
                      {entry.avatar ? (
                        <img src={entry.avatar} alt="" loading="lazy" />
                      ) : (
                        <span>{(entry.username || '?')[0]?.toUpperCase()}</span>
                      )}
                    </div>
                    <div className="entry-info">
                      <span className="entry-name">
                        {entry.username}
                        {entry.isVIP && <span className="entry-vip-tag">VIP</span>}
                      </span>
                    </div>
                    <div className={`entry-value ${entry.value >= 0 ? 'positive' : 'negative'}`}>
                      {renderPrizeBadge(entry)}
                      {formatValue(entry.value, metric)}
                      {renderChangeBadge(entry.change)}
                    </div>
                  </div>
                ))}

              {/* ── REMAINING RANKINGS (4th+) ── */}
              {rest.length > 0 && (
                <div className="rankings-divider">
                  <span>Rankings</span>
                </div>
              )}
              <Virtuoso
                useWindowScroll
                data={rest}
                computeItemKey={(index, item) => item.userId}
                itemContent={(index: number, entry: LeaderboardEntry) => (
                  <div
                    className={`leaderboard-entry ${entry.userId === user?.id ? 'current-user' : ''}`}
                    onClick={() => navigate(`/profile/${entry.userId}`)}
                    onKeyDown={rowKeyActivate(entry.userId)}
                    role="button"
                    tabIndex={0}
                    aria-label={`${getRankLabel(entry.rank)} ${entry.username}, ${formatValue(entry.value, metric)}`}
                    style={{ ...rankingRowAnimationStyle(index), cursor: 'pointer' }}
                  >
                    <span className="entry-rank">{getRankLabel(entry.rank)}</span>
                    <div className="entry-avatar">
                      {entry.avatar ? (
                        <img src={entry.avatar} alt="" loading="lazy" />
                      ) : (
                        <span>{(entry.username || '?')[0]?.toUpperCase()}</span>
                      )}
                    </div>
                    <div className="entry-info">
                      <span className="entry-name">
                        {entry.username}
                        {entry.isVIP && <span className="entry-vip-tag">VIP</span>}
                        {(entry.change || 0) >= 3 && (
                          <span className="hot-streak-badge" title="Hot Streak: Climbing Fast">
                            Rising
                          </span>
                        )}
                      </span>
                      {renderRowContext(entry)}
                    </div>
                    <div className={`entry-value ${entry.value >= 0 ? 'positive' : 'negative'}`}>
                      {renderPrizeBadge(entry)}
                      {formatValue(entry.value, metric)}
                      {renderChangeBadge(entry.change)}
                    </div>
                  </div>
                )}
              />

              {totalRanked != null && entries.length < totalRanked && (
                <button
                  className="lb-load-more"
                  onClick={loadMore}
                  disabled={loadingMore}
                  aria-label={`Load More, Showing ${entries.length} Of ${totalRanked}`}
                >
                  {loadingMore
                    ? 'Loading...'
                    : `Show More (${entries.length.toLocaleString('en-US')} Of ${totalRanked.toLocaleString('en-US')})`}
                </button>
              )}

              {/* Ranked, but below the visible cut - pin their own row so the number
                in the sticky card has something to sit against. */}
              {userRank && !entries.some((e) => e.userId === user?.id) && (
                <>
                  <div className="rankings-divider">
                    <span>Your Position</span>
                  </div>
                  <div
                    className="leaderboard-entry current-user pinned-self"
                    onClick={() => user?.id && navigate(`/profile/${user.id}`)}
                    onKeyDown={user?.id ? rowKeyActivate(user.id) : undefined}
                    role="button"
                    tabIndex={0}
                    aria-label={`Your Position, ${getRankLabel(userRank.rank)}, ${formatValue(userRank.value, metric)}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="entry-rank">{getRankLabel(userRank.rank)}</span>
                    <div className="entry-avatar">
                      <span>You</span>
                    </div>
                    <div className="entry-info">
                      <span className="entry-name">You</span>
                      <span className="entry-subline">
                        Of {userRank.total.toLocaleString('en-US')} Ranked
                      </span>
                    </div>
                    <div className={`entry-value ${userRank.value >= 0 ? 'positive' : 'negative'}`}>
                      {formatValue(userRank.value, metric)}
                    </div>
                  </div>
                </>
              )}
            </>
          ) : activeTab === 'tournaments' && tournamentStats.length > 0 ? (
            <div className="tournament-stats-scroll">
              {/* Tournament Stats Header */}
              <div className="tournament-stats-header">
                <div className="stats-column-header">Player</div>
                <div className="stats-column-header">Tournaments</div>
                <div className="stats-column-header">Wins</div>
                <div className="stats-column-header">Final Tables</div>
                <div className="stats-column-header">ITM</div>
                <div className="stats-column-header">Total Prizes</div>
                <div className="stats-column-header">ROI</div>
                <div className="stats-column-header">Biggest Win</div>
              </div>

              {/* Tournament Stats Rows */}
              <Virtuoso
                useWindowScroll
                data={tournamentStats}
                computeItemKey={(index, item) => item.userId}
                itemContent={(index: number, stat: TournamentStats) => (
                  <div
                    className={`tournament-stats-entry ${index < 12 ? `animate-fade-in-up stagger-${Math.min(index + 1, 10)}` : ''} ${stat.userId === user?.id ? 'current-user' : ''}`}
                    onClick={() => navigate(`/profile/${stat.userId}`)}
                    onKeyDown={rowKeyActivate(stat.userId)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Rank ${index + 1}, ${stat.username}, ${stat.totalPrizes.toLocaleString()} Total Prizes`}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="stats-cell player-cell">
                      <span className="rank-badge">#{index + 1}</span>
                      <div className="entry-avatar">
                        {stat.avatar ? (
                          <img src={stat.avatar} alt="" loading="lazy" />
                        ) : (
                          <span>{(stat.username || '?')[0]?.toUpperCase()}</span>
                        )}
                      </div>
                      <span className="player-name">{stat.username}</span>
                    </div>
                    <div className="stats-cell" data-label="Tournaments">
                      {compactChips(stat.tournamentsPlayed)}
                    </div>
                    <div className="stats-cell wins" data-label="Wins">
                      {compactChips(stat.wins)}
                    </div>
                    <div className="stats-cell" data-label="Final Tables">
                      {compactChips(stat.finalTables)}
                    </div>
                    <div className="stats-cell" data-label="ITM">
                      {compactChips(stat.itmFinishes)}
                    </div>
                    <div className="stats-cell prizes" data-label="Total Prizes">
                      {compactChips(stat.totalPrizes)}
                    </div>
                    <div
                      className={`stats-cell roi ${stat.roi >= 0 ? 'positive' : 'negative'}`}
                      data-label="ROI"
                    >
                      {Math.trunc(stat.roi * 10) / 10}%
                    </div>
                    <div className="stats-cell biggest" data-label="Biggest Win">
                      {compactChips(stat.biggestWin)}
                    </div>
                  </div>
                )}
              />
            </div>
          ) : null}
        </div>
        {activeTab === 'rankings' &&
          scope === 'my-clubs' &&
          canManagePrizes &&
          settings &&
          !settings.setup_complete && (
            /* First eligible use: the owner of a club that has never published
               a program sees the decision in front of them instead of having to
               find the control in the deck or the hamburger. */
            <section className="lb-prize-program" aria-label="Leaderboard Prize Program">
              <div className="lb-prize-program-copy">
                <span className="lb-prize-program-kicker">Prize Program</span>
                <h2>No Prize Program Yet</h2>
                <p>
                  {`${settings.funding_label} Funds Leaderboard Prizes For ${settings.club_name}. Decide Whether To Reward Players, Then Publish A Plan.`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingSettings(settings);
                  setShowSettings(true);
                }}
              >
                Set Up Prizes
              </button>
              <span className="lb-prize-program-safety">
                Nothing Is Paid Until A Plan Is Published And Its Period Closes.
              </span>
            </section>
          )}
        {activeTab === 'rankings' && scope === 'my-clubs' && settings?.setup_complete && (
          <section className="lb-prize-program" aria-label="Leaderboard Prize Program">
            <div className="lb-prize-program-copy">
              <span className="lb-prize-program-kicker">Prize Program</span>
              <h2>
                {settings.rewards_enabled && settings.funding_status === 'funded'
                  ? 'Prize Program Published And Funded'
                  : settings.rewards_enabled
                    ? 'Prize Program Funding Required'
                    : 'Prize Program Disabled'}
              </h2>
              <p>
                {settings.rewards_enabled
                  ? `${settings.program_funding_label || settings.funding_label} Published A ${prizePlanLabel(settings.suggestion_key)} Plan Ranked By ${programMetricLabel}.`
                  : `A Prize Plan Is Saved For ${settings.club_name}, But Rewards Are Not Published.`}
              </p>
              {settings.rewards_enabled && (
                <ul className="lb-prize-rules" role="list" aria-label="Prize Rules">
                  <li>{`Ranked By ${programMetricLabel} Across Each Weekly And Monthly Round.`}</li>
                  <li>Weeks Start Sunday At 00:00 UTC. Months Start On The First At 00:00 UTC.</li>
                  <li>Rule Changes Start At The Next Weekly Or Monthly UTC Boundary.</li>
                  <li>Tied Places Share Their Occupied Prizes.</li>
                  <li>
                    {settings.funding_status === 'underfunded'
                      ? `Paid From ${settings.program_funding_label || settings.funding_label} After The Period Closes, Once It Covers The Published Prizes.`
                      : `Paid From ${settings.program_funding_label || settings.funding_label} After The Period Closes.`}
                  </li>
                  <li>
                    {
                      'Prize Marks A Planned Amount While A Round Is Live. Paid Marks A Verified Receipt.'
                    }
                  </li>
                </ul>
              )}
            </div>
            <dl className="lb-prize-program-totals">
              <div>
                <dt>Program Version</dt>
                <dd>
                  V{settings.program_version}
                  {settings.published_at && (
                    <small>Published {formatUtcTimestamp(settings.published_at)}</small>
                  )}
                </dd>
              </div>
              <div>
                <dt>Weekly</dt>
                <dd>
                  {compactChips(totalPrizePlan(settings.weekly_prizes))} Chips
                  {settings.weekly_effective_from && (
                    <small>From {settings.weekly_effective_from}</small>
                  )}
                </dd>
              </div>
              <div>
                <dt>Monthly</dt>
                <dd>
                  {compactChips(totalPrizePlan(settings.monthly_prizes))} Chips
                  {settings.monthly_effective_from && (
                    <small>From {settings.monthly_effective_from}</small>
                  )}
                </dd>
              </div>
            </dl>
            {canManagePrizes && (
              <button
                type="button"
                onClick={() => {
                  setEditingSettings(settings);
                  setShowSettings(true);
                }}
              >
                Review Setup
              </button>
            )}
            <span className="lb-prize-program-safety" role={settlementError ? 'status' : undefined}>
              {settlementError ||
                (settings.funding_status === 'underfunded'
                  ? 'Published Prizes Stay Visible. Settlement Waits For The Promo Wallet And Never Uses The Operating Wallet.'
                  : 'Published Rules Activate At The Dates Shown. Settlement Uses The Recorded Promo Wallet After The Period Closes.')}
            </span>
          </section>
        )}

        {activeTab === 'rankings' &&
          scope === 'my-clubs' &&
          selectedClubId &&
          (period === 'weekly' || period === 'monthly') &&
          /* A club that has never completed setup has never had a program
             (setup_complete is setup_completed_at IS NOT NULL, stamped on every
             save), so no batch or receipt can exist and every round would read
             "No Program". The owner already has the first-use section; the card
             would only repeat it with a second setup button. */
          (!settings || settings.setup_complete) && (
            <LeaderboardSettlementCard
              status={settlementStatus}
              currentUserId={user?.id}
              loading={settlementLoading}
              error={settlementError}
              onRetry={() => loadLeaderboardRef.current(false, () => isMountedRef.current)}
              onReviewSetup={
                canManagePrizes && settings
                  ? () => {
                      setEditingSettings(settings);
                      setShowSettings(true);
                    }
                  : undefined
              }
            />
          )}
      </SpadeConsole>
      {showSettings && editingSettings?.can_manage && (
        <LeaderboardPrizeWizard
          isOpen={showSettings}
          setup={editingSettings}
          onClose={() => {
            setShowSettings(false);
            setEditingSettings(null);
            if (settingsStaleRef.current) {
              /* A refused publish means the owner record we opened with may
                 have been superseded (another session, a funding change).
                 Refetch so the next Set Up starts from the current version
                 instead of repeating the same conflict. */
              settingsStaleRef.current = false;
              setSettingsReloadKey((value) => value + 1);
            }
          }}
          onSaveError={() => {
            settingsStaleRef.current = true;
          }}
          onSaved={(savedSetup) => {
            // A publish that succeeds after an earlier refusal in the same
            // dialog leaves nothing stale: the saved record is authoritative.
            settingsStaleRef.current = false;
            setSettings(savedSetup);
            setShowSettings(false);
            setEditingSettings(null);
            toast.success(`Prize Program V${savedSetup.program_version} Published.`);
          }}
        />
      )}
    </div>
  );
}
