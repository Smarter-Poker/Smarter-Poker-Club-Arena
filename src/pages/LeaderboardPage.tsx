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

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { masterBus } from '../core/MasterBus';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
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
  animation: 'fadeInUp 0.7s ease-out forwards',
};

const rankingRowAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 60}ms forwards`,
});

type LeaderboardScope = 'my-clubs' | 'global';
type LeaderboardTab = 'rankings' | 'tournaments';

interface UserClub {
  id: string;
  name: string;
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

const PODIUM_MEDALS = ['1', '2', '3']; // place numerals; colour comes from the podium classes

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
  const [metric, setMetric] = useState<LeaderboardMetric>('profit');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
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

  // Load user's clubs on mount
  useEffect(() => {
    let isMounted = true;
    loadUserClubs(() => isMounted);
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Callback for tournament updates
  const handleTournamentLeaderboardUpdate = useCallback(() => {
    if (activeTabRef.current === 'tournaments')
      loadTournamentStatsRef.current(() => isMountedRef.current);
  }, []);

  useMasterBusChannel({
    channelName: 'tournament-leaderboard-updates',
    table: 'tournament_players',
    filter: null,
    event: '*',
    onPayload: handleTournamentLeaderboardUpdate,
    enabled: true,
  });

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
      loadLeaderboard(false, () => isMounted);
    } else if (scope === 'my-clubs' && !selectedClubId) {
      setEntries([]);
      setLoading(false);
    }
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, period, metric, selectedClubId, activeTab]);

  // Fetch Tournament Stats Data (club-scoped only)
  useEffect(() => {
    let isMounted = true;
    if (selectedClubId && activeTab === 'tournaments') {
      loadTournamentStats(() => isMounted);
    } else if (!selectedClubId) {
      setTournamentStats([]);
      setTournamentsLoading(false);
    }
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClubId, activeTab]);

  const loadUserClubs = async (getIsMounted?: () => boolean) => {
    setClubsLoading(true);
    try {
      const memberships = await getUserMemberships(user);
      const clubs = memberships
        .map((m) => ({
          id: (m.club?.id || m.club_id) as string,
          name: m.club?.name || 'Unknown Club',
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
    const myReq = ++reqSeqRef.current;  // also invalidates any in-flight loadMore

    // SWR: show cached data instantly
    const cacheKey = `${isGlobal ? 'global' : selectedClubId}_${metric}_${period}`;
    if (!silent) {
      const cached = getCachedEntries(cacheKey);
      if (cached && cached.length > 0) {
        setEntries(cached);
        setLoading(false);
      } else {
        setLoading(true);
      }
    }
    try {
      const data = await retryFetch(
        () =>
          isGlobal
            ? LeaderboardService.getGlobalLeaderboard(metric, period, PAGE_SIZE)
            : LeaderboardService.getClubLeaderboard(selectedClubId as string, metric, period, PAGE_SIZE),
        { maxRetries: 2 }
      );
      if (myReq !== reqSeqRef.current) return; // superseded by a newer request
      if (getIsMounted && !getIsMounted()) return;
      setEntries(data);
      setTotalRanked(data[0]?.totalRanked ?? null);
      setBaselineDate(data[0]?.baselineDate ?? null);
      setCachedEntries(cacheKey, data);
      setLastUpdated(new Date());

      // Get user's rank in the same scope
      if (user?.id) {
        const rank = isGlobal
          ? await LeaderboardService.getGlobalUserRank(user.id, metric, period)
          : await LeaderboardService.getUserRank(
              user.id,
              selectedClubId as string,
              metric,
              period
            );
        if (myReq !== reqSeqRef.current) return;
        if (getIsMounted && !getIsMounted()) return;
        setUserRank(rank);
      }
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
        ? await LeaderboardService.getGlobalLeaderboard(metric, period, PAGE_SIZE, offset)
        : await LeaderboardService.getClubLeaderboard(
            selectedClubId as string,
            metric,
            period,
            PAGE_SIZE,
            offset
          );
      if (myReq !== reqSeqRef.current) return; // filters moved on; drop this page
      if (more.length > 0) {
        setEntries((prev) => {
          // The list may have been replaced while this was in flight.
          if (prev.length !== offset) return prev;
          const seen = new Set(prev.map((e) => e.userId));
          return [...prev, ...more.filter((m) => !seen.has(m.userId))];
        });
      }
    } catch (e) {
      reportError(e, 'LeaderboardPage.loadMore');
      toast.error('Could not load more');
    } finally {
      if (myReq === reqSeqRef.current) setLoadingMore(false);
    }
  };

  const loadTournamentStats = async (getIsMounted?: () => boolean) => {
    if (!selectedClubId) {
      setTournamentsLoading(false);
      return;
    }
    setTournamentsLoading(true);
    try {
      const data = await retryFetch(
        () => LeaderboardService.getClubTournamentStats(selectedClubId, 50),
        { maxRetries: 2 }
      );
      if (getIsMounted && !getIsMounted()) return;
      setTournamentStats(data);
      setLastUpdated(new Date());
    } catch (error) {
      reportError(error, 'LeaderboardPage.Failed_to_load_tournament_stats');
      toast.error('Failed to load tournament stats');
    } finally {
      if (!getIsMounted || getIsMounted()) setTournamentsLoading(false);
    }
  };

  const formatValue = (value: number, m: LeaderboardMetric): string => {
    const precise = Math.trunc(value * 100) / 100;
    if (m === 'vpip' || m === 'roi') {
      return `${precise}%`;
    }
    if (m === 'bb100') {
      return `${precise > 0 ? '+' : ''}${precise} bb/100`;
    }
    return precise.toLocaleString('en-US');
  };

  const getRankLabel = (rank: number): string => {
    if (rank === 1) return '1st';
    if (rank === 2) return '2nd';
    if (rank === 3) return '3rd';
    return `#${rank}`;
  };

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
    const cls = place === 1 ? 'podium-1st' : place === 2 ? 'podium-2nd' : 'podium-3rd';
    const barCls = place === 1 ? 'gold-bar' : place === 2 ? 'silver-bar' : 'bronze-bar';
    const textCls = place === 1 ? 'gold-text' : place === 2 ? 'silver-text' : 'bronze-text';
    const fallbackTier: VipTier = place === 1 ? 'gold' : place === 2 ? 'silver' : 'bronze';
    return (
      <div
        className={`podium-place ${cls}`}
        onClick={() => navigate(`/profile/${entry.userId}`)}
        onKeyDown={rowKeyActivate(entry.userId)}
        role="button"
        tabIndex={0}
        aria-label={`Place ${place}, ${entry.username}, ${formatValue(entry.value, metric)}`}
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
        {renderRowContext(entry)}
        <span className="podium-rank-emoji">{PODIUM_MEDALS[place - 1]}</span>
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

  return (
    <div className="leaderboard-page">
      {/* Live Indicator */}
      <div className="live-indicator">
        <span className="live-dot"></span>
        <span>Live &bull; Updated {lastUpdated.toLocaleTimeString()}</span>
        {activeTab === 'rankings' && windowLabel && (
          <span className="lb-window-label" title="The snapshot this period is measured from">
            {windowLabel}
          </span>
        )}
      </div>

      {/* Tab Selector (tournament stats are per-club) */}
      <div className="leaderboard-tabs">
        <button
          className={`tab-btn ${activeTab === 'rankings' ? 'active' : ''}`}
          onClick={() => setActiveTab('rankings')}
        >
          Rankings
        </button>
        {scope === 'my-clubs' && (
          <button
            className={`tab-btn ${activeTab === 'tournaments' ? 'active' : ''}`}
            onClick={() => setActiveTab('tournaments')}
          >
            Tournament Stats
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="leaderboard-filters">
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

        {/* Scope Toggle */}
        <div className="filter-group scope-toggle">
          <button
            className={scope === 'my-clubs' ? 'active' : ''}
            onClick={() => setScope('my-clubs')}
          >
            My Clubs
          </button>
          <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>
            Global
          </button>
        </div>

        {/* Period Selector */}
        <div className="filter-group lb-chip-bar">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`lb-filter-chip ${period === opt.value ? 'active' : ''}`}
              onClick={() => setPeriod(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Metric Selector */}
        <div className="filter-group lb-chip-bar lb-chip-scroll">
          {visibleMetricOptions.map((opt) => (
            <button
              key={opt.value}
              className={`lb-filter-chip ${metric === opt.value ? 'active' : ''}`}
              title={opt.description}
              onClick={() => setMetric(opt.value)}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>

        {entries.length > 0 && activeTab === 'rankings' && (
          <button
            className="lb-csv-btn"
            style={{
              background: 'rgba(65,105,225,0.15)',
              color: '#4169E1',
              border: '1px solid rgba(65,105,225,0.3)',
              padding: '6px 14px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => {
              try {
                exportToCSV(entries, `leaderboard_${scope}_${metric}_${period}.csv`, [
                  { key: 'rank', label: 'Rank' },
                  { key: 'username', label: 'Username' },
                  {
                    key: 'value',
                    label: METRIC_OPTIONS.find((m) => m.value === metric)?.label || 'Value',
                  },
                  { key: 'hands', label: 'Hands' },
                  { key: 'change', label: 'Change' },
                  { key: 'userId', label: 'User ID' },
                ]);
                toast.success('Leaderboard exported');
              } catch (e) {
                reportError(e, 'LeaderboardPage.export');
                toast.error('Export failed');
              }
            }}
          >
            Export CSV
          </button>
        )}
      </div>

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
            <p>Join a club to see leaderboard rankings, or switch to Global.</p>
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
              No rankings yet for this period.
            </p>
            <p
              className="empty-sub"
              style={{
                color: 'var(--soft-white, #B0B3B8)',
                fontSize: '0.85rem',
                margin: '0 0 1.5rem',
              }}
            >
              Start playing to climb the leaderboard.
            </p>
            <button className="join-club-btn" onClick={() => navigate('/')}>
              Find a Table
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
            <p>No tournament stats yet.</p>
            <p className="empty-sub">Register for a tournament to see your stats.</p>
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
            {rest.map((entry, index) => (
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
                  {formatValue(entry.value, metric)}
                  {renderChangeBadge(entry.change)}
                </div>
              </div>
            ))}

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
                  <span>Your position</span>
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
                      of {userRank.total.toLocaleString('en-US')} ranked
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
          <>
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
            {tournamentStats.map((stat, index) => (
              <div
                key={stat.userId}
                className={`tournament-stats-entry animate-fade-in-up stagger-${Math.min(index + 1, 10)} ${stat.userId === user?.id ? 'current-user' : ''}`}
                onClick={() => navigate(`/profile/${stat.userId}`)}
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
            ))}
          </>
        ) : null}
      </div>

      {/* Sticky User Rank Card (Bottom) */}
      {userRank && activeTab === 'rankings' && (
        <div className="user-rank-card sticky-bottom">
          <div className="user-rank-position">
            <span className="rank-number">{getRankLabel(userRank.rank)}</span>
            <span className="rank-label">Your Rank{scope === 'global' ? ' (Global)' : ''}</span>
          </div>
          <div className="rank-context">
            <span>out of {userRank.total.toLocaleString()} players</span>
            {userRank.value !== 0 && (
              <span className="rank-own-value">{formatValue(userRank.value, metric)}</span>
            )}
            {!entries.some((e) => e.userId === user?.id) && entries.length > 0 && (
              <span className="rank-offlist">not in the top {entries.length}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
