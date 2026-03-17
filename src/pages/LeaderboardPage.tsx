/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD PAGE — Global Rankings with Real-Time Updates
 * ═══════════════════════════════════════════════════════════════════════════════
 * Full-page leaderboard with club/union rankings, podium display, and live updates.
 * Supports Clubs, Charities, and Home Game venue types with appropriate metrics.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
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
import PageSkeleton from '../components/common/PageSkeleton';
import { retryFetch } from '../utils/retryFetch';

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

// Metric definitions with labels and icons for each metric type
const METRIC_OPTIONS: {
  value: LeaderboardMetric;
  label: string;
  icon: string;
  description: string;
}[] = [
  { value: 'profit', label: 'Profit', icon: '💰', description: 'Total profit earned' },
  { value: 'hands_played', label: 'Hands Played', icon: '🃏', description: 'Total hands dealt in' },
  {
    value: 'tournaments_won',
    label: 'Tournaments Won',
    icon: '🏆',
    description: 'Tournament victories',
  },
  { value: 'vpip', label: 'VPIP', icon: '📊', description: 'Voluntarily put chips in pot %' },
  { value: 'roi', label: 'ROI', icon: '📈', description: 'Return on investment %' },
];

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
  const [metric, setMetric] = useState<LeaderboardMetric>('profit');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRank, setUserRank] = useState<{ rank: number; total: number } | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Club selection
  const [userClubs, setUserClubs] = useState<UserClub[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string | null>(null);
  const [clubsLoading, setClubsLoading] = useState(true);

  // Tournament stats
  const [activeTab, setActiveTab] = useState<LeaderboardTab>('rankings');
  const activeTabRef = useRef<LeaderboardTab>('rankings');
  const [tournamentStats, setTournamentStats] = useState<TournamentStats[]>([]);
  const [tournamentsLoading, setTournamentsLoading] = useState(false);

  // Refs for realtime callbacks to avoid stale closures
  const loadLeaderboardRef = useRef(async (silent?: boolean, getIsMounted?: () => boolean) => {});
  const loadTournamentStatsRef = useRef(async (getIsMounted?: () => boolean) => {});

  // Load user's clubs on mount
  useEffect(() => {
    let isMounted = true;
    loadUserClubs(() => isMounted);
    return () => {
      isMounted = false;
    };
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
    // Phase 4: Cross-page sync events (ported from World Hub leaderboard.js)
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

  // Callback for leaderboard updates
  const handleLeaderboardUpdate = useCallback(() => {
    if (activeTabRef.current === 'rankings') loadLeaderboardRef.current(true, () => true);
  }, []);

  useMasterBusChannel({
    channelName: 'leaderboard-updates',
    table: 'promotion_leaderboards',
    filter: null,
    event: '*',
    onPayload: handleLeaderboardUpdate,
    enabled: true,
  });

  // Callback for tournament updates
  const handleTournamentLeaderboardUpdate = useCallback(() => {
    if (activeTabRef.current === 'tournaments') loadTournamentStatsRef.current(() => true);
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
        loadLeaderboardRef.current(true, () => true);
      } else {
        loadTournamentStatsRef.current(() => true);
      }
    }, 30000);

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, []);

  // Fetch Rankings Data
  useEffect(() => {
    let isMounted = true;
    if (selectedClubId) {
      if (activeTab === 'rankings') {
        loadLeaderboard(false, () => isMounted);
      }
    } else {
      setEntries([]);
      setLoading(false);
    }
    return () => {
      isMounted = false;
    };
  }, [scope, period, metric, selectedClubId, activeTab]);

  // Fetch Tournament Stats Data
  useEffect(() => {
    let isMounted = true;
    if (selectedClubId) {
      if (activeTab === 'tournaments') {
        loadTournamentStats(() => isMounted);
      }
    } else {
      setTournamentStats([]);
      setTournamentsLoading(false);
    }
    return () => {
      isMounted = false;
    };
  }, [selectedClubId, activeTab]);

  const loadUserClubs = async (getIsMounted?: () => boolean) => {
    setClubsLoading(true);
    try {
      const memberships = await getUserMemberships(user);
      const clubs = memberships
        .map((m: any) => ({
          id: m.club?.id || m.club_id,
          name: m.club?.name || 'Unknown Club',
        }))
        .filter((c: UserClub) => c.id);

      if (getIsMounted && !getIsMounted()) return;
      setUserClubs(clubs);
      if (clubs.length > 0 && !selectedClubId) {
        setSelectedClubId(clubs[0].id);
      }
    } catch (error) {
      console.error('Failed to load clubs:', error);
      toast.error('Failed to load clubs');
    }
    if (getIsMounted && !getIsMounted()) return;
    setClubsLoading(false);
  };

  const loadingRef = useRef(false);

  const loadLeaderboard = async (silent = false, getIsMounted?: () => boolean) => {
    if (!selectedClubId) {
      setLoading(false);
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    // SWR: show cached data instantly
    const cacheKey = `${selectedClubId}_${metric}_${period}`;
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
        () => LeaderboardService.getClubLeaderboard(selectedClubId, metric, period, 50),
        { maxRetries: 2 }
      );
      if (getIsMounted && !getIsMounted()) return;
      setEntries(data);
      setCachedEntries(cacheKey, data);
      setLastUpdated(new Date());

      // Get user's rank
      if (user?.id) {
        const rank = await LeaderboardService.getUserRank(user.id, selectedClubId, metric, period);
        if (getIsMounted && !getIsMounted()) return;
        setUserRank(rank);
      }
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
      if (!silent) toast.error('Failed to load leaderboard');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
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
      console.error('Failed to load tournament stats:', error);
      toast.error('Failed to load tournament stats');
    } finally {
      if (!getIsMounted || getIsMounted()) setTournamentsLoading(false);
    }
  };

  const formatValue = (value: number, m: LeaderboardMetric): string => {
    const precise = Math.trunc(value * 100) / 100;
    if (m === 'profit' || m === 'hands_played' || m === 'tournaments_won') {
      return precise.toLocaleString('en-US');
    }
    if (m === 'vpip' || m === 'roi') {
      return `${precise}%`;
    }
    return precise.toLocaleString('en-US');
  };

  const getRankBadge = (rank: number): string => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  };

  const getRankLabel = (rank: number): string => {
    if (rank === 1) return '1st';
    if (rank === 2) return '2nd';
    if (rank === 3) return '3rd';
    return `#${rank}`;
  };

  const top3 = entries.slice(0, 3);
  const rest = entries.slice(3);

  return (
    <div className="leaderboard-page">
      {/* Live Indicator */}
      <div className="live-indicator">
        <span className="live-dot"></span>
        <span>Live • Updated {lastUpdated.toLocaleTimeString()}</span>
      </div>

      {/* Tab Selector */}
      <div className="leaderboard-tabs">
        <button
          className={`tab-btn ${activeTab === 'rankings' ? 'active' : ''}`}
          onClick={() => setActiveTab('rankings')}
        >
          Rankings
        </button>
        <button
          className={`tab-btn ${activeTab === 'tournaments' ? 'active' : ''}`}
          onClick={() => setActiveTab('tournaments')}
        >
          Tournament Stats
        </button>
      </div>

      {/* Filters */}
      <div className="leaderboard-filters">
        {/* Club Selector (only shown when multiple clubs) */}
        {userClubs.length > 1 && (
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

        {/* Period Selector — Pill Chips (Initiative 2) */}
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

        {/* Metric Selector — Pill Chips (Initiative 2) */}
        <div className="filter-group lb-chip-bar lb-chip-scroll">
          {METRIC_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`lb-filter-chip ${metric === opt.value ? 'active' : ''}`}
              onClick={() => setMetric(opt.value)}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>

        {entries.length > 0 && (
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
                exportToCSV(entries, `leaderboard_${metric}_${period}.csv`, [
                  { key: 'rank', label: 'Rank' },
                  { key: 'username', label: 'Username' },
                  {
                    key: 'value',
                    label: METRIC_OPTIONS.find((m) => m.value === metric)?.label || 'Value',
                  },
                  { key: 'change', label: 'Change' },
                  { key: 'userId', label: 'User ID' },
                ]);
                toast.success('Leaderboard exported!');
              } catch {
                toast.error('Export failed');
              }
            }}
          >
            📥 Export CSV
          </button>
        )}
      </div>

      {/* Leaderboard Content */}
      <div className="leaderboard-list">
        {clubsLoading ? (
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
        ) : userClubs.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">♠</span>
            <p>Join a club to see leaderboard rankings!</p>
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
          <div className="empty-state">
            <span className="empty-icon">🏆</span>
            <p>No rankings yet for this period.</p>
            <p className="empty-sub">Start playing to climb the leaderboard!</p>
          </div>
        ) : activeTab === 'tournaments' && tournamentsLoading ? (
          <div className="lb-skeleton-wrapper">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="lb-skeleton-row" />
            ))}
          </div>
        ) : activeTab === 'tournaments' && tournamentStats.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">🏅</span>
            <p>No tournament stats yet.</p>
            <p className="empty-sub">Register for a tournament to see your stats!</p>
          </div>
        ) : activeTab === 'rankings' && entries.length > 0 ? (
          <>
            {/* ── TOP 3 PODIUM ── */}
            {top3.length >= 3 && (
              <div className="podium-section" style={podiumAnimationStyle}>
                {/* 2nd Place */}
                <div
                  className="podium-place podium-2nd"
                  onClick={() => navigate(`/profile/${top3[1].userId}`)}
                >
                  <PlayerAvatar
                    src={top3[1].avatar}
                    name={top3[1].username}
                    size="lg"
                    vipTier={(top3[1].vipTier as VipTier) || 'silver'}
                    level={top3[1].level || 1}
                    xpProgress={50}
                    showPresence={false}
                    showLevelBadge={true}
                    showXpRing={true}
                    showVipRing={true}
                  />
                  {top3[1].isVIP && <span className="vip-badge">VIP</span>}
                  {(top3[1].change || 0) >= 3 && (
                    <span className="hot-streak-badge" title="Hot Streak!">
                      🔥
                    </span>
                  )}
                  <span className="podium-name">{top3[1].username}</span>
                  <span className="podium-value silver-text">
                    {formatValue(top3[1].value, metric)}
                  </span>
                  <span className="podium-rank-emoji">🥈</span>
                  <div className="podium-bar silver-bar"></div>
                </div>

                {/* 1st Place */}
                <div
                  className="podium-place podium-1st"
                  onClick={() => navigate(`/profile/${top3[0].userId}`)}
                >
                  <div className="podium-crown">👑</div>
                  <PlayerAvatar
                    src={top3[0].avatar}
                    name={top3[0].username}
                    size="xl"
                    vipTier={(top3[0].vipTier as VipTier) || 'gold'}
                    level={top3[0].level || 1}
                    xpProgress={75}
                    showPresence={false}
                    showLevelBadge={true}
                    showXpRing={true}
                    showVipRing={true}
                  />
                  {top3[0].isVIP && <span className="vip-badge">VIP</span>}
                  {(top3[0].change || 0) >= 3 && (
                    <span className="hot-streak-badge" title="Hot Streak!">
                      🔥
                    </span>
                  )}
                  <span className="podium-name">{top3[0].username}</span>
                  <span className="podium-value gold-text">
                    {formatValue(top3[0].value, metric)}
                  </span>
                  <span className="podium-rank-emoji">🥇</span>
                  <div className="podium-bar gold-bar"></div>
                </div>

                {/* 3rd Place */}
                <div
                  className="podium-place podium-3rd"
                  onClick={() => navigate(`/profile/${top3[2].userId}`)}
                >
                  <PlayerAvatar
                    src={top3[2].avatar}
                    name={top3[2].username}
                    size="lg"
                    vipTier={(top3[2].vipTier as VipTier) || 'bronze'}
                    level={top3[2].level || 1}
                    xpProgress={30}
                    showPresence={false}
                    showLevelBadge={true}
                    showXpRing={true}
                    showVipRing={true}
                  />
                  {top3[2].isVIP && <span className="vip-badge">VIP</span>}
                  {(top3[2].change || 0) >= 3 && (
                    <span className="hot-streak-badge" title="Hot Streak!">
                      🔥
                    </span>
                  )}
                  <span className="podium-name">{top3[2].username}</span>
                  <span className="podium-value bronze-text">
                    {formatValue(top3[2].value, metric)}
                  </span>
                  <span className="podium-rank-emoji">🥉</span>
                  <div className="podium-bar bronze-bar"></div>
                </div>
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
                  <span className={`entry-rank top-3`}>{getRankBadge(entry.rank)}</span>
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
                      <span className="hot-streak-badge" title="Hot Streak!">
                        🔥
                      </span>
                    )}
                  </span>
                </div>
                <div className={`entry-value ${entry.value >= 0 ? 'positive' : 'negative'}`}>
                  {formatValue(entry.value, metric)}
                  {entry.change !== 0 && (
                    <span className={`change rank-change-anim ${entry.change > 0 ? 'up' : 'down'}`}>
                      {entry.change > 0 ? '▲' : '▼'} {Math.abs(entry.change)}
                    </span>
                  )}
                </div>
              </div>
            ))}

            {/* Motivational CTA when leaderboard is sparse */}
            {entries.length < 10 && (
              <div className="lb-motivational-cta">
                <div className="lb-motivational-icon">🎯</div>
                <div className="lb-motivational-text">
                  <strong>Keep climbing!</strong>
                  <span>Play more hands to move up the rankings and unlock bragging rights.</span>
                </div>
              </div>
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
      {userRank && (
        <div className="user-rank-card sticky-bottom">
          <div className="user-rank-position">
            <span className="rank-number">{getRankLabel(userRank.rank)}</span>
            <span className="rank-label">Your Rank</span>
          </div>
          <div className="rank-context">out of {userRank.total.toLocaleString()} players</div>
        </div>
      )}
    </div>
  );
}
