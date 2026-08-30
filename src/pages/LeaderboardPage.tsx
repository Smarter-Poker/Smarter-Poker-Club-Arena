/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD PAGE — Club + Global Rankings with Real-Time Updates
 * ═══════════════════════════════════════════════════════════════════════════════
 * Rebuilt 2026-08-19 on the real-profit pipeline:
 * - Profit / hands / tournaments / ROI values are real (snapshot-delta RPCs).
 * - My Clubs vs Global scope both work (global = per-user stats across clubs).
 * - Rank-change arrows are real (current rank vs yesterday's snapshot rank).
 * - No emoji in source (SWC/build rule): Unicode symbols only.
 */

import { Virtuoso } from 'react-virtuoso';

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { masterBus } from '../core/MasterBus';

import type { LeaderboardSettings, LeaderboardPayout } from '../services/LeaderboardService';
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
import ConfirmModal from '../components/common/ConfirmModal';
import { PlayerAvatar } from '../components/avatars/PlayerAvatar';
import type { VipTier } from '../components/avatars/PlayerAvatar';
import './LeaderboardPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { retryFetch } from '../utils/retryFetch';
import { reportError } from '../utils/errorReporter';

// ── SWR Cache helpers ──
const LB_CACHE_KEY = 'lb_cache_';
function getCachedEntries(key: string): LeaderboardEntry[] | null {
  try {
    const raw = sessionStorage.getItem(LB_CACHE_KEY + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedEntries(key: string, data: LeaderboardEntry[]) {
  try {
    sessionStorage.setItem(LB_CACHE_KEY + key, JSON.stringify(data));
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
  role: any;
}

// Metric definitions. Unicode symbols only (no emoji: build rule).
const METRIC_OPTIONS: {
  value: LeaderboardMetric;
  label: string;
  icon: string;
  description: string;
  globalSupported: boolean;
}[] = [
  {
    value: 'profit',
    label: 'Profit',
    icon: '◆',
    description: 'Net chips won (winnings minus invested)',
    globalSupported: true,
  },
  {
    value: 'bb100',
    label: 'bb/100',
    icon: '◈',
    description: 'Big blinds won per 100 hands - comparable across stakes',
    globalSupported: true,
  },
  {
    value: 'hands_played',
    label: 'Hands Played',
    icon: '♠',
    description: 'Total hands dealt in',
    globalSupported: true,
  },
  {
    value: 'tournaments_won',
    label: 'Tournaments Won',
    icon: '★',
    description: 'Tournament victories',
    globalSupported: true,
  },
  {
    value: 'vpip',
    label: 'VPIP',
    icon: '▦',
    description: 'Voluntarily put chips in pot %',
    globalSupported: false,
  },
  {
    value: 'pfr',
    label: 'PFR',
    icon: '▤',
    description: 'Preflop raise %',
    globalSupported: false,
  },
  {
    value: 'roi',
    label: 'ROI',
    icon: '▲',
    description: 'Return on invested chips %',
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
  useVisibilityRefresh(() => loadLeaderboard());
  const { user } = useAuthUser();
  const toast = useToast();
  const [scope, setScope] = useState<LeaderboardScope>('my-clubs');
  const [period, setPeriod] = useState<LeaderboardPeriod>('weekly');
  const [periodOffset, setPeriodOffset] = useState<number>(0);
  const [metric, setMetric] = useState<LeaderboardMetric>('profit');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  /** Payout confirmation — replaced a raw window.confirm (2026-08-28). */
  const [confirmPayout, setConfirmPayout] = useState(false);
  const [payingOut, setPayingOut] = useState(false);
  const [totalRanked, setTotalRanked] = useState<number | null>(null);
  const [baselineDate, setBaselineDate] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userRank, setUserRank] = useState<{ rank: number; total: number; value: number } | null>(
    null
  );
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  // Club selection

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<LeaderboardSettings | null>(null);
  const [payouts, setPayouts] = useState<LeaderboardPayout[]>([]);

  useEffect(() => {
    if (!showSettings) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowSettings(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [showSettings]);

  const [userClubs, setUserClubs] = useState<UserClub[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string | null>(null);
  const [clubsLoading, setClubsLoading] = useState(true);

  // Tournament stats (club-scoped)
  const [activeTab, setActiveTab] = useState<LeaderboardTab>('rankings');
  const activeTabRef = useRef<LeaderboardTab>('rankings');
  const [tournamentStats, setTournamentStats] = useState<TournamentStats[]>([]);
  const [tournamentsLoading, setTournamentsLoading] = useState(false);

  // Refs for realtime callbacks to avoid stale closures
  const loadLeaderboardRef = useRef(async (_silent?: boolean, _getIsMounted?: () => boolean) => {});
  const loadTournamentStatsRef = useRef(async (_getIsMounted?: () => boolean) => {});

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
    const unsub = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        if (activeTabRef.current === 'rankings') {
          loadLeaderboardRef.current(true);
        } else {
          loadTournamentStatsRef.current();
        }
      },
      500
    );
    const unsub2 = masterBus.subscribeDebounced(
      'CHIPS_DISTRIBUTED',
      () => loadLeaderboardRef.current(true),
      500
    );
    const unsub3 = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => loadLeaderboardRef.current(true),
      500
    );
    const unsub4 = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => loadLeaderboardRef.current(true),
      500
    );
    const unsub5 = masterBus.subscribeDebounced(
      'TOURNAMENT_UPDATED',
      () => {
        if (activeTabRef.current === 'tournaments') {
          loadTournamentStatsRef.current();
        }
      },
      2000
    );
    return () => {
      unsub();
      unsub2();
      unsub3();
      unsub4();
      unsub5();
    };
  }, []);

  // AUDIT 2026-08-19: a realtime channel on `promotion_leaderboards` used to live
  // here. This view reads player_stats, so that channel could never fire for it —
  // it was dead weight that made the page look more live than it was. Freshness
  // comes from the 30s poll plus the debounced HAND_COMPLETED bus event above.
  // A channel on player_stats itself is deliberately NOT used: it changes on
  // every seat of every hand (~1.1M writes/day) and would flood the client.

  useEffect(() => {
    let isMounted = true;
    if (selectedClubId && userClubs.find((c) => c.id === selectedClubId)?.role === 'owner') {
      LeaderboardService.getLeaderboardSettings(selectedClubId).then((data) => {
        if (isMounted && data) {
          setSettings(data);
        }
      });
    }
    return () => {
      isMounted = false;
    };
  }, [selectedClubId, userClubs]);

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
      if (activeTabRef.current === 'rankings') {
        loadLeaderboardRef.current(true, () => isMountedRef.current);
      } else {
        loadTournamentStatsRef.current(() => isMountedRef.current);
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
      setLoading(false);
    }
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, period, periodOffset, metric, selectedClubId, activeTab]);

  // Fetch Tournament Stats Data (club-scoped only)
  useEffect(() => {
    let isMounted = true;
    if (selectedClubId && activeTab === 'tournaments') {
      if (scope === 'global') return;
      loadTournamentStats(() => isMounted);
    } else if (!selectedClubId) {
      setTournamentStats([]);
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
      const clubs = memberships
        .map((m) => ({
          id: (m.club?.id || m.club_id) as string,
          name: m.club?.name || 'Unknown Club',
          role: m.role,
        }))
        .filter((c): c is UserClub => Boolean(c.id));

      if (getIsMounted && !getIsMounted()) return;
      setUserClubs(clubs as UserClub[]);
      if (clubs.length > 0 && !selectedClubId) {
        setSelectedClubId(clubs[0].id as string);
      }
    } catch (error) {
      reportError(error, 'LeaderboardPage.Failed_to_load_clubs');
      toast.error('Failed to load clubs');
    }
    if (getIsMounted && !getIsMounted()) return;
    setClubsLoading(false);
  };

  const reqSeqRef = useRef(0);

  const loadLeaderboard = async (silent = false, getIsMounted?: () => boolean) => {
    const isGlobal = scope === 'global';
    if (!isGlobal && !selectedClubId) {
      setLoading(false);
      return;
    }
    // Monotonic request token: a newer request always wins, and an in-flight
    // response that is no longer current is discarded rather than rendered.
    const myReq = ++reqSeqRef.current; // also invalidates any in-flight loadMore

    // SWR: show cached data instantly
    const cacheKey = `${isGlobal ? 'global' : selectedClubId}_${metric}_${period}_${periodOffset}`;
    if (isGlobal) setPayouts([]);
    if (!user?.id) setUserRank(null);
    if (!silent) {
      const cached = getCachedEntries(cacheKey);
      if (cached && cached.length > 0) {
        setEntries(cached);
        setTotalRanked(cached[0]?.totalRanked ?? null);
        setBaselineDate(cached[0]?.baselineDate ?? null);
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
            ? LeaderboardService.getGlobalLeaderboard(metric, period, PAGE_SIZE, 0, periodOffset)
            : LeaderboardService.getClubLeaderboard(
                selectedClubId as string,
                metric,
                period,
                PAGE_SIZE,
                0,
                periodOffset
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

      // The ranked rows are the primary content. Render them as soon as the
      // ranking + profile queries complete instead of holding the skeleton on
      // screen while secondary payout and personal-rank metadata load.
      if (!silent) setLoading(false);

      // Secondary metadata is independent and can arrive in parallel. This
      // removes two serial round-trips from the visible page-load path.
      const payoutPromise =
        !isGlobal && selectedClubId
          ? (() => {
              const { start } = LeaderboardService.getPeriodBoundaries(period, periodOffset);
              return LeaderboardService.getPayoutsForPeriod(
                selectedClubId,
                period,
                metric,
                start.toISOString().split('T')[0]
              ).then((periodPayouts) => {
                if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) {
                  setPayouts(periodPayouts);
                }
              });
            })()
          : Promise.resolve();

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

      await Promise.allSettled([payoutPromise, rankPromise]);
    } catch (error) {
      reportError(error, 'LeaderboardPage.Failed_to_load_leaderboard');
      if (!silent) toast.error('Failed to load leaderboard');
    } finally {
      if (myReq === reqSeqRef.current && (!getIsMounted || getIsMounted())) setLoading(false);
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
            periodOffset
          )
        : await LeaderboardService.getClubLeaderboard(
            selectedClubId as string,
            metric,
            period,
            PAGE_SIZE,
            offset,
            periodOffset
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

  const loadTournamentStats = async (getIsMounted?: () => boolean) => {
    if (!selectedClubId) {
      setTournamentsLoading(false);
      return;
    }
    const myReq = ++tournReqSeqRef.current;
    setTournamentsLoading(true);
    try {
      const data = await retryFetch(
        () => LeaderboardService.getClubTournamentStats(selectedClubId, 50),
        { maxRetries: 2 }
      );
      if (myReq !== tournReqSeqRef.current) return;
      if (getIsMounted && !getIsMounted()) return;
      setTournamentStats(data);
      setLastUpdated(new Date());
    } catch (error) {
      reportError(error, 'LeaderboardPage.Failed_to_load_tournament_stats');
      if (myReq === tournReqSeqRef.current) toast.error('Failed to load tournament stats');
    } finally {
      if (myReq === tournReqSeqRef.current && (!getIsMounted || getIsMounted()))
        setTournamentsLoading(false);
    }
  };

  const formatValue = (value: number, m: LeaderboardMetric): string => {
    const precise = Math.trunc(value * 100) / 100;
    if (m === 'vpip' || m === 'pfr' || m === 'roi') {
      return `${precise}%`;
    }
    if (m === 'bb100') {
      return `${precise > 0 ? '+' : ''}${precise} bb/100`;
    }
    return precise.toLocaleString('en-US');
  };

  const getRankLabel = (rank: number): string => {
    const base = rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `#${rank}`;
    const isTie = entries.filter((entry) => entry.rank === rank).length > 1;
    return isTie ? `T-${base}` : base;
  };

  const isOwner = selectedClubId
    ? userClubs.find((c) => c.id === selectedClubId)?.role === 'owner'
    : false;

  const visibleMetricOptions = METRIC_OPTIONS.filter(
    (m) => scope === 'my-clubs' || m.globalSupported
  );

  const top3 = entries.slice(0, 3);
  const rest = entries.slice(3);

  // Rate metrics are meaningless without volume, so every row carries the hand
  // count for the selected period, and rows that fail the ROI qualifier say so
  // rather than silently sorting last.
  const renderRowContext = (entry: LeaderboardEntry) => {
    const bits: string[] = [];
    if (entry.hands != null && entry.hands > 0) {
      bits.push(`${entry.hands.toLocaleString('en-US')} hands`);
    }
    if ((metric === 'roi' || metric === 'bb100') && entry.qualified === false) {
      // The threshold itself lives only in SQL (v_min_hands). Restating it here
      // would be a second source of truth with nothing keeping the two in step,
      // so the row reports the RPC's `qualified` verdict rather than the number.
      bits.push('too few hands - unranked');
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
        {change > 0 ? '▲' : '▼'} {Math.abs(change)}
      </span>
    );
  };

  const renderPodiumPlace = (entry: LeaderboardEntry, place: 1 | 2 | 3) => {
    const awardRank = entry.rank <= 3 ? entry.rank : place;
    const cls = awardRank === 1 ? 'podium-1st' : awardRank === 2 ? 'podium-2nd' : 'podium-3rd';
    const barCls = awardRank === 1 ? 'gold-bar' : awardRank === 2 ? 'silver-bar' : 'bronze-bar';
    const textCls = awardRank === 1 ? 'gold-text' : awardRank === 2 ? 'silver-text' : 'bronze-text';
    const fallbackTier: VipTier = awardRank === 1 ? 'gold' : awardRank === 2 ? 'silver' : 'bronze';
    return (
      <div
        className={`podium-place podium-position-${place} ${cls}`}
        onClick={() => navigate(`/profile/${entry.userId}`)}
        onKeyDown={rowKeyActivate(entry.userId)}
        role="button"
        tabIndex={0}
        aria-label={`${getRankLabel(entry.rank)}, ${entry.username}, ${formatValue(entry.value, metric)}`}
      >
        {place === 1 && <div className="podium-crown">{'♛'}</div>}
        <PlayerAvatar
          src={entry.avatar}
          name={entry.username}
          size={place === 1 ? 'xl' : 'lg'}
          vipTier={(entry.vipTier as VipTier) || fallbackTier}
          level={entry.level || 1}
          showPresence={false}
          showLevelBadge={true}
          showVipRing={true}
        />
        {entry.isVIP && <span className="vip-badge">VIP</span>}
        {(entry.change || 0) >= 3 && (
          <span className="hot-streak-badge" title="Hot streak: climbing fast">
            {'↑'}
          </span>
        )}
        <span className="podium-name">{entry.username}</span>
        <span className={`podium-value ${textCls}`}>{formatValue(entry.value, metric)}</span>
        {(() => {
          const payout = payouts.find((p) => p.user_id === entry.userId);
          if (payout) {
            return (
              <span className="payout-badge">
                Paid {payout.payout_amount.toLocaleString()}{' '}
                {payout.payout_currency === 'diamonds' ? 'Diamonds' : 'Chips'}
              </span>
            );
          }
          return null;
        })()}
        {renderRowContext(entry)}
        <span className="podium-rank-emoji">{getRankLabel(entry.rank)}</span>
        <div className={`podium-bar ${barCls}`}></div>
      </div>
    );
  };

  // Period deltas are measured from a daily snapshot. If that job missed a day
  // the baseline is older than the label implies, so show the real span.
  const windowLabel = (() => {
    if (period === 'all_time') return 'since 2026-05-21';
    if (!baselineDate) return null;
    const days = Math.round(
      (Date.now() - new Date(`${baselineDate}T00:00:00Z`).getTime()) / 86400000
    );
    const expected = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
    return days > expected ? `${days}d window` : `since ${baselineDate}`;
  })();

  const activeMetric = METRIC_OPTIONS.find((option) => option.value === metric);
  const selectedClubName = userClubs.find((club) => club.id === selectedClubId)?.name;
  const canExport =
    (entries.length > 0 && activeTab === 'rankings') ||
    (tournamentStats.length > 0 && activeTab === 'tournaments');

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
      toast.success('Leaderboard exported');
    } catch (error) {
      reportError(error, 'LeaderboardPage.export');
      toast.error('Export failed');
    }
  };

  return (
    <div className="leaderboard-page" data-arena-surface="championship">
      <section className="lb-hero" aria-labelledby="leaderboard-title">
        <div className="lb-hero-art" aria-hidden="true" />
        <div className="lb-hero-copy">
          <span className="lb-eyebrow">Club Arena / Championship Deck</span>
          <h1 id="leaderboard-title">Every Hand Leaves A Mark.</h1>
          <p>
            Measure The Run, Read The Field, And See Who Owns The Room Across Every Club And Every
            Table.
          </p>
          <div className="lb-live-rail" aria-live="polite">
            <span className="live-dot" />
            <span>Live</span>
            <span className="lb-rail-divider" />
            <span>
              Updated {lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
            {activeTab === 'rankings' && windowLabel && (
              <span className="lb-window-label" title="The snapshot this period is measured from">
                {windowLabel}
              </span>
            )}
          </div>
        </div>
        <div className="lb-hero-telemetry" aria-label="Current leaderboard summary">
          <div>
            <span className="lb-telemetry-label">Field</span>
            <strong>{totalRanked != null ? totalRanked.toLocaleString('en-US') : '-'}</strong>
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
            <strong>{activeMetric?.icon || '◆'}</strong>
            <span>{activeMetric?.label || 'Profit'}</span>
          </div>
        </div>
      </section>

      <section className="lb-control-deck" aria-label="Leaderboard controls">
        <div className="lb-control-header">
          <div className="leaderboard-tabs" role="tablist" aria-label="Leaderboard views">
            <button
              className={`tab-btn ${activeTab === 'rankings' ? 'active' : ''}`}
              onClick={() => setActiveTab('rankings')}
              role="tab"
              aria-selected={activeTab === 'rankings'}
            >
              Rankings
            </button>
            {scope === 'my-clubs' && (
              <button
                className={`tab-btn ${activeTab === 'tournaments' ? 'active' : ''}`}
                onClick={() => setActiveTab('tournaments')}
                role="tab"
                aria-selected={activeTab === 'tournaments'}
              >
                Tournament Stats
              </button>
            )}
          </div>
          <div className="lb-control-actions">
            {isOwner && scope !== 'global' && activeTab === 'rankings' && (
              <>
                <button
                  className="lb-action-btn lb-action-prize"
                  onClick={() => setConfirmPayout(true)}
                  title="Pay Out Current Leaderboard"
                >
                  Pay Out
                </button>
                <button
                  className="lb-action-btn"
                  onClick={() => setShowSettings(true)}
                  title="Leaderboard Settings"
                >
                  Prize Settings
                </button>
              </>
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
                    value={selectedClubId || ''}
                    onChange={(e) => setSelectedClubId(e.target.value)}
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
                >
                  My Clubs
                </button>
                <button
                  className={scope === 'global' ? 'active' : ''}
                  onClick={() => setScope('global')}
                >
                  Global
                </button>
              </div>
            </div>
          </div>

          {/* Period Selector */}
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
                    {'‹'}
                  </button>
                  <span>
                    {periodOffset === 0
                      ? 'Current'
                      : periodOffset === -1
                        ? 'Last'
                        : `${periodOffset}`}
                  </span>
                  <button
                    className="lb-step-btn"
                    onClick={() => setPeriodOffset((o) => Math.min(0, o + 1))}
                    disabled={periodOffset >= 0}
                    title="Next Period"
                    aria-label="Next Period"
                  >
                    {'›'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Metric Selector */}
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
                  <span aria-hidden="true">{opt.icon}</span> {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Leaderboard Content */}
      <div className="leaderboard-list">
        {clubsLoading && scope === 'my-clubs' ? (
          <div className="lb-skeleton-wrapper">
            <div className="lb-skeleton-podium">
              <div className="lb-skel-pod" />
              <div className="lb-skel-pod tall" />
              <div className="lb-skel-pod" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="lb-skeleton-row" />
            ))}
          </div>
        ) : scope === 'my-clubs' && userClubs.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">{'♠'}</span>
            <p>Join A Club To See Leaderboard Rankings, Or Switch To Global.</p>
            <button className="join-club-btn" onClick={() => navigate('/clubs')}>
              Browse Clubs
            </button>
          </div>
        ) : activeTab === 'rankings' && loading ? (
          <div className="lb-skeleton-wrapper">
            <div className="lb-skeleton-podium">
              <div className="lb-skel-pod" />
              <div className="lb-skel-pod tall" />
              <div className="lb-skel-pod" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="lb-skeleton-row" />
            ))}
          </div>
        ) : activeTab === 'rankings' && entries.length === 0 ? (
          <div className="empty-state" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
            <span
              className="empty-icon"
              style={{ fontSize: '3rem', display: 'block', marginBottom: '0.75rem' }}
            >
              {'★'}
            </span>
            <p style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
              No Rankings Yet For This Period.
            </p>
            <p
              className="empty-sub"
              style={{
                color: 'var(--soft-white, #B0B3B8)',
                fontSize: '0.85rem',
                margin: '0 0 1.5rem',
              }}
            >
              Start Playing To Climb The Leaderboard.
            </p>
            <button className="join-club-btn" onClick={() => navigate('/')}>
              Find A Table
            </button>
          </div>
        ) : activeTab === 'tournaments' && tournamentsLoading ? (
          <div className="lb-skeleton-wrapper">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="lb-skeleton-row" />
            ))}
          </div>
        ) : activeTab === 'tournaments' && tournamentStats.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">{'★'}</span>
            <p>No Tournament Stats Yet.</p>
            <p className="empty-sub">Register For A Tournament To See Your Stats.</p>
          </div>
        ) : activeTab === 'rankings' && entries.length > 0 ? (
          <>
            {/* ── TOP 3 PODIUM ── */}
            {top3.length >= 3 && (
              <div className="podium-section" style={podiumAnimationStyle}>
                {renderPodiumPlace(top3[1], 2)}
                {renderPodiumPlace(top3[0], 1)}
                {renderPodiumPlace(top3[2], 3)}
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
                    {(() => {
                      const payout = payouts.find((p) => p.user_id === entry.userId);
                      if (payout) {
                        return (
                          <div className="payout-badge">
                            Paid {payout.payout_amount.toLocaleString()}{' '}
                            {payout.payout_currency === 'diamonds' ? 'Diamonds' : 'Chips'}
                          </div>
                        );
                      }
                      return null;
                    })()}
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
                        <span className="hot-streak-badge" title="Hot streak: climbing fast">
                          {'↑'}
                        </span>
                      )}
                    </span>
                    {renderRowContext(entry)}
                  </div>
                  <div className={`entry-value ${entry.value >= 0 ? 'positive' : 'negative'}`}>
                    {(() => {
                      const payout = payouts.find((p) => p.user_id === entry.userId);
                      if (payout) {
                        return (
                          <div className="payout-badge">
                            Paid {payout.payout_amount.toLocaleString()}{' '}
                            {payout.payout_currency === 'diamonds' ? 'Diamonds' : 'Chips'}
                          </div>
                        );
                      }
                      return null;
                    })()}
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
                aria-label={`Load more, showing ${entries.length} of ${totalRanked}`}
              >
                {loadingMore
                  ? 'Loading...'
                  : `Show more (${entries.length.toLocaleString('en-US')} of ${totalRanked.toLocaleString('en-US')})`}
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
                  aria-label={`Your position, ${getRankLabel(userRank.rank)}, ${formatValue(userRank.value, metric)}`}
                  style={{ cursor: 'pointer' }}
                >
                  <span className="entry-rank">{getRankLabel(userRank.rank)}</span>
                  <div className="entry-avatar">
                    <span>{'\u2605'}</span>
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
                  aria-label={`Rank ${index + 1}, ${stat.username}, ${stat.totalPrizes.toLocaleString()} total prizes`}
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
                  <div className="stats-cell">{stat.tournamentsPlayed}</div>
                  <div className="stats-cell wins">{stat.wins}</div>
                  <div className="stats-cell">{stat.finalTables}</div>
                  <div className="stats-cell">{stat.itmFinishes}</div>
                  <div className="stats-cell prizes">
                    {(Math.trunc(stat.totalPrizes * 100) / 100).toLocaleString()}
                  </div>
                  <div className={`stats-cell roi ${stat.roi >= 0 ? 'positive' : 'negative'}`}>
                    {Math.trunc(stat.roi * 100) / 100}%
                  </div>
                  <div className="stats-cell biggest">
                    {(Math.trunc(stat.biggestWin * 100) / 100).toLocaleString()}
                  </div>
                </div>
              )}
            />
          </div>
        ) : null}
      </div>

      {/* Settings Modal */}
      {showSettings && isOwner && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setShowSettings(false);
          }}
          style={{
            zIndex: 50,
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            className="modal-content glass-panel p-6 max-w-md w-full"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leaderboard-prize-settings-title"
            style={{
              background: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: '12px',
              padding: '24px',
            }}
          >
            <div
              className="flex justify-between items-center mb-6"
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '24px' }}
            >
              <h2
                id="leaderboard-prize-settings-title"
                className="text-xl font-bold font-display text-white"
                style={{ fontSize: '1.25rem', color: '#fff', margin: 0 }}
              >
                Prize Settings
              </h2>
              <button
                onClick={() => setShowSettings(false)}
                aria-label="Close Prize Settings"
                className="text-white/60 hover:text-white"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#aaa',
                  cursor: 'pointer',
                  fontSize: '1.2rem',
                }}
              >
                ✕
              </button>
            </div>

            <div
              className="space-y-4 text-white/90"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                maxHeight: '70vh',
                overflowY: 'auto',
                paddingRight: '8px',
              }}
            >
              <div className="form-group">
                <label
                  className="text-sm font-semibold mb-2 block"
                  style={{ display: 'block', marginBottom: '8px', color: '#fff' }}
                >
                  Payout Currency
                </label>
                <select
                  className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-white"
                  style={{
                    width: '100%',
                    background: 'rgba(0,0,0,0.4)',
                    color: '#fff',
                    border: '1px solid #444',
                    padding: '8px 12px',
                    borderRadius: '6px',
                  }}
                  value={settings?.payout_currency || 'diamonds'}
                  onChange={(e) =>
                    setSettings({
                      ...(settings as LeaderboardSettings),
                      payout_currency: e.target.value as 'diamonds' | 'chips',
                    })
                  }
                >
                  <option value="diamonds">Diamonds</option>
                  <option value="chips">Chips</option>
                </select>
                <p
                  className="text-xs text-white/50 mt-1"
                  style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}
                >
                  Diamonds Are Deducted From The Club Diamond Wallet. Chips Are Minted.
                </p>
              </div>

              <div className="form-group" style={{ marginTop: '16px' }}>
                <label
                  style={{
                    display: 'block',
                    marginBottom: '8px',
                    color: '#fff',
                    fontWeight: 'bold',
                  }}
                >
                  Weekly Prizes
                </label>
                {[1, 2, 3].map((rank) => {
                  const currentPrize =
                    settings?.weekly_prizes?.find((p) => p.rank === rank)?.amount || 0;
                  return (
                    <div
                      key={`weekly-${rank}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        marginBottom: '8px',
                        gap: '8px',
                      }}
                    >
                      <span style={{ width: '60px', color: '#aaa' }}>Rank {rank}</span>
                      <input
                        type="number"
                        style={{
                          flex: 1,
                          background: 'rgba(0,0,0,0.4)',
                          color: '#fff',
                          border: '1px solid #444',
                          padding: '6px',
                          borderRadius: '4px',
                        }}
                        value={currentPrize || ''}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          const newPrizes = (settings?.weekly_prizes || []).filter(
                            (p) => p.rank !== rank
                          );
                          if (val > 0) newPrizes.push({ rank, amount: val });
                          setSettings({ ...settings!, weekly_prizes: newPrizes });
                        }}
                        placeholder="Amount"
                      />
                    </div>
                  );
                })}
              </div>

              <div className="form-group" style={{ marginTop: '16px' }}>
                <label
                  style={{
                    display: 'block',
                    marginBottom: '8px',
                    color: '#fff',
                    fontWeight: 'bold',
                  }}
                >
                  Monthly Prizes
                </label>
                {[1, 2, 3].map((rank) => {
                  const currentPrize =
                    settings?.monthly_prizes?.find((p) => p.rank === rank)?.amount || 0;
                  return (
                    <div
                      key={`monthly-${rank}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        marginBottom: '8px',
                        gap: '8px',
                      }}
                    >
                      <span style={{ width: '60px', color: '#aaa' }}>Rank {rank}</span>
                      <input
                        type="number"
                        style={{
                          flex: 1,
                          background: 'rgba(0,0,0,0.4)',
                          color: '#fff',
                          border: '1px solid #444',
                          padding: '6px',
                          borderRadius: '4px',
                        }}
                        value={currentPrize || ''}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          const newPrizes = (settings?.monthly_prizes || []).filter(
                            (p) => p.rank !== rank
                          );
                          if (val > 0) newPrizes.push({ rank, amount: val });
                          setSettings({ ...settings!, monthly_prizes: newPrizes });
                        }}
                        placeholder="Amount"
                      />
                    </div>
                  );
                })}
              </div>

              <button
                className="btn-primary w-full mt-4"
                style={{
                  width: '100%',
                  background: '#4169E1',
                  color: '#fff',
                  border: 'none',
                  padding: '10px',
                  borderRadius: '6px',
                  fontWeight: 'bold',
                  marginTop: '16px',
                  cursor: 'pointer',
                }}
                onClick={async () => {
                  if (selectedClubId) {
                    const saved = await LeaderboardService.updateLeaderboardSettings(
                      selectedClubId,
                      {
                        payout_currency: settings?.payout_currency || 'diamonds',
                        weekly_prizes: settings?.weekly_prizes || [],
                        monthly_prizes: settings?.monthly_prizes || [],
                      }
                    );
                    if (saved) {
                      toast.success('Prize Settings Saved');
                      setShowSettings(false);
                    } else {
                      toast.error('Prize Settings Could Not Be Saved');
                    }
                  }
                }}
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payout confirmation (2026-08-28, replaced window.confirm). `loading`
          keeps the button latched while the payout RPC is in flight, so a
          double tap cannot issue two payouts. */}
      <ConfirmModal
        isOpen={confirmPayout}
        title="Pay Out Leaderboard"
        message={`Pay Out The ${period} ${metric} Leaderboard Now? This Issues Prizes To The Ranked Players And Cannot Be Undone.`}
        confirmText="Pay Out"
        cancelText="Cancel"
        variant="danger"
        loading={payingOut}
        onCancel={() => {
          if (!payingOut) setConfirmPayout(false);
        }}
        onConfirm={async () => {
          if (payingOut) return;
          setPayingOut(true);
          try {
            const { start, end } = LeaderboardService.getPeriodBoundaries(period, periodOffset);
            await LeaderboardService.payoutLeaderboardPeriod(
              selectedClubId as string,
              period,
              metric,
              start.toISOString().split('T')[0],
              end.toISOString().split('T')[0]
            );
            toast.success('Payouts Issued.');
            setConfirmPayout(false);
          } catch (err: any) {
            toast.error(err?.message || 'Payout Failed.');
          } finally {
            setPayingOut(false);
          }
        }}
      />
    </div>
  );
}
