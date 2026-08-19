/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB DASHBOARD — Comprehensive Club Analytics
 * ═══════════════════════════════════════════════════════════════════════════════
 * Full analytics dashboard for club owners and admins
 * Features:
 * - Club Stats Cards with key metrics (single ca_club_dashboard_stats RPC)
 * - Activity Feed synthesized from real events (ca_club_activity RPC)
 * - Leaderboard with real profit/hands and working time-range filter
 *   (ca_club_top_players RPC over club_member_daily_stats aggregates)
 * - Tables tab with live table list
 * - Quick actions for club management
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusChannel } from '../../hooks/useMasterBusChannel';
import { getLocalStorage, setLocalStorage } from '../../lib/storage';
import ClubStatsCards, { DashboardStats } from '../../components/club/ClubStatsCards';
import ClubActivityFeed from '../../components/club/ClubActivityFeed';
import ClubBottomNav from '../../components/club/ClubBottomNav';
import PageSkeleton from '../../components/common/PageSkeleton';
import { useToast } from '../../components/common/Toast';
import ClubMemberManagement from '../../components/admin/ClubMemberManagement';
import { useVisibilityRefresh } from '../../hooks/useVisibilityRefresh';
import { resolveClubIdFilter, resolveClubUUID } from '../../utils/clubIdResolver';
import { getClubLevel } from '../../utils/clubLevels';
import ClubChat from '../../components/club/ClubChat';
import styles from './ClubDashboard.module.css';
import { reportError } from '../../utils/errorReporter';

interface ClubInfo {
  id: string;
  name: string;
  avatarUrl?: string;
  memberCount: number;
  tableCount: number;
  createdAt: string;
  levelInfo?: any;
}

interface TopPlayer {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  totalProfit: number;
  totalWon: number;
  handsPlayed: number;
  biggestPot: number;
  rank: number;
}

interface ClubTable {
  id: string;
  name: string;
  gameType?: string;
  gameVariant?: string;
  stakes?: string;
  smallBlind: number;
  bigBlind: number;
  status: string;
  currentPlayers: number;
  maxPlayers: number;
  createdAt: string;
}

type TabId = 'overview' | 'activity' | 'players' | 'tables';
type RangeId = 'today' | 'week' | 'month' | 'all';

const VALID_TABS: TabId[] = ['overview', 'activity', 'players', 'tables'];

/** Maps the time-range filter to a `p_since` timestamp for the leaderboard RPC. */
function sinceForRange(range: RangeId): string | null {
  const now = Date.now();
  switch (range) {
    case 'today': {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case 'week':
      return new Date(now - 7 * 86400000).toISOString();
    case 'month':
      return new Date(now - 30 * 86400000).toISOString();
    default:
      return null;
  }
}

const RANK_COLORS: Record<number, string> = {
  1: 'linear-gradient(135deg, #f5c518, #b8860b)',
  2: 'linear-gradient(135deg, #d7d7d7, #8e8e8e)',
  3: 'linear-gradient(135deg, #cd7f32, #8b5a2b)',
};

export default function ClubDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(() => loadDashboardData(true));
  const [club, setClub] = useState<ClubInfo | null>(null);
  const [topPlayers, setTopPlayers] = useState<TopPlayer[]>([]);
  const [clubTables, setClubTables] = useState<ClubTable[]>([]);
  const [dashStats, setDashStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab && VALID_TABS.includes(urlTab as TabId)) return urlTab as TabId;
    return getLocalStorage('ca_dashboard_tab', 'overview');
  });
  const [dateRange, setDateRange] = useState<RangeId>(() =>
    getLocalStorage('ca_dashboard_range', 'week')
  );
  const [visiblePlayers, setVisiblePlayers] = useState<Set<number>>(new Set());
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadingRef = useRef(false);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    setLocalStorage('ca_dashboard_tab', activeTab);
  }, [activeTab]);
  useEffect(() => {
    setLocalStorage('ca_dashboard_range', dateRange);
  }, [dateRange]);
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');

  // Deep-linking: ?tab=activity (used by "View All Activity") switches tabs.
  useEffect(() => {
    const urlTab = searchParams.get('tab');
    if (urlTab && VALID_TABS.includes(urlTab as TabId) && urlTab !== activeTab) {
      setActiveTab(urlTab as TabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const switchTab = useCallback(
    (tab: TabId) => {
      setActiveTab(tab);
      // Keep the URL shareable/back-button friendly
      const next = new URLSearchParams(searchParams);
      next.set('tab', tab);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  useEffect(() => {
    if (clubId) {
      loadDashboardData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, dateRange]);

  // Leaderboard player stagger animation (with cleanup to prevent zombie timeouts)
  //
  // Keyed on a CONTENT signature, not on the topPlayers array identity. Every
  // refresh builds a fresh array, so an identity dep re-ran this on each one:
  // visiblePlayers was cleared and all rows faded back in from nothing. With
  // refreshes arriving about once a second the leaderboard was permanently
  // mid-animation. A refresh returning the same players in order is a no-op.
  const topPlayersRef = useRef(topPlayers);
  useEffect(() => {
    topPlayersRef.current = topPlayers;
  }, [topPlayers]);
  const topPlayersSignature = topPlayers.map((p) => p.userId).join('|');
  useEffect(() => {
    setVisiblePlayers(new Set());
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = topPlayersRef.current.map((_, i) =>
      setTimeout(() => setVisiblePlayers((prev) => new Set(prev).add(i)), i * 60)
    );
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topPlayersSignature]);

  // Real-time subscription for table and member changes
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);

  useEffect(() => {
    if (!clubId) {
      setResolvedClubId(null);
      return;
    }
    resolveClubUUID(clubId)
      .then(setResolvedClubId)
      .catch((e) => console.warn('[ClubDashboard] Failed to resolve clubId:', e));
  }, [clubId]);

  // Tables channel
  useMasterBusChannel({
    channelName: `club-dashboard-tables-${clubId}`,
    table: 'tables',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: () => loadDashboardData(true),
    enabled: !!resolvedClubId,
  });

  // Members channel
  useMasterBusChannel({
    channelName: `club-dashboard-members-${clubId}`,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: () => loadDashboardData(true),
    enabled: !!resolvedClubId,
  });

  // Hand history channel — DISABLED (Phase 2 cost cut).
  // hand_history is dropped from supabase_realtime to save egress. The
  // dashboard refreshes on tab-focus (useVisibilityRefresh) and on every
  // club-scoped bus event below, so hand counts are eventually consistent.

  // ── Bus Listeners: cross-page event reactivity (coalesced, scoped by clubId) ──
  useEffect(() => {
    // ONE debounce shared by every event, not one per event type.
    // subscribeDebounced debounces each event NAME independently, so fifteen
    // subscriptions meant fifteen independent timers that could out-run each
    // other and reload several times a second on a busy club. Coalescing to
    // one trailing timer means a burst of twenty events costs ONE reload.
    const COALESCE_MS = 2000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const reload = (payload?: any) => {
      if (payload?.clubId && payload.clubId !== clubId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) loadDashboardData(true); // silent: no loading skeleton
      }, COALESCE_MS);
    };

    const EVENTS = [
      'CLUB_UPDATED',
      'CLUB_JOINED',
      'CLUB_LEFT',
      'BALANCE_UPDATED',
      'TABLE_SEATED',
      'TABLE_LEFT',
      'TABLE_CREATED',
      'CHIPS_ADDED',
      'CHIPS_WITHDRAWN',
      'ANNOUNCEMENT_CHANGED',
      'HAND_COMPLETED',
      'SETTLEMENT_CYCLE_COMPLETED',
      'COLLUSION_DETECTED',
      // Level recompute: role promotions trigger SQL level recalc
      'AGENT_UPDATED',
      'MEMBER_ROLE_CHANGED',
    ] as const;
    const unsubs = EVENTS.map((evt) => masterBus.subscribe(evt, reload));

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubs.forEach((unsub) => unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  const handleRecalculateLevel = async () => {
    if (!clubId || isRecalculating) return;
    setIsRecalculating(true);
    try {
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      let resolvedId = clubId;
      if (clubCol === 'club_id') {
        const { data } = await supabase
          .from('clubs')
          .select('id')
          .eq('club_id', clubVal)
          .maybeSingle();
        if (data) resolvedId = data.id;
      }

      const { data: resData, error } = await supabase.rpc('recompute_club_levels', {
        p_club_id: resolvedId,
      });
      if (error) throw error;
      if (resData && resData.success === false) {
        throw new Error(resData.error || 'Failed to recalculate level.');
      }
      toast.success('Club Level Recalculated Successfully!');
      loadDashboardData();
    } catch (err: any) {
      reportError(err, 'ClubDashboard.Recalculate_error');
      toast.error(err.message || 'Failed to recalculate level.');
    } finally {
      setIsRecalculating(false);
    }
  };

  /**
   * @param silent  Background refresh triggered by a realtime/bus event rather
   *   than by the user arriving. Skips setLoading(true) so the page never
   *   flips back into its skeleton state mid-session.
   */
  const loadDashboardData = async (silent = false) => {
    if (!clubId) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadError(false);
    if (!silent) setLoading(true);
    try {
      // Load club info
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData } = await supabase
        .from('clubs')
        .select(
          'id, name, avatar_url, created_at, level, member_count, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
        )
        .eq(clubCol, clubVal)
        .maybeSingle();

      // Use resolved UUID for all FK queries — clubId from URL may be integer
      const resolvedId = clubData?.id || clubId;

      // One stats RPC + leaderboard RPC + role lookup + table list, in parallel
      const [statsResult, playersResult, roleResult, tablesResult] = await Promise.all([
        supabase.rpc('ca_club_dashboard_stats', { p_club_id: resolvedId }),
        supabase.rpc('ca_club_top_players', {
          p_club_id: resolvedId,
          p_since: sinceForRange(dateRange),
          p_limit: 50,
        }),
        user
          ? supabase
              .from('club_members')
              .select('role')
              .eq('club_id', resolvedId)
              .eq('user_id', user.id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null } as any),
        supabase
          .from('tables')
          .select(
            'id, name, game_type, game_variant, stakes, small_blind, big_blind, status, current_players, max_players, created_at, is_deleted'
          )
          .eq('club_id', resolvedId)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      if (statsResult.error) {
        reportError(statsResult.error, 'ClubDashboard.stats_rpc_error');
      }
      if (playersResult.error) {
        reportError(playersResult.error, 'ClubDashboard.top_players_rpc_error');
      }

      const stats: DashboardStats | null = statsResult.data
        ? {
            totalMembers: statsResult.data.total_members || 0,
            onlineNow: statsResult.data.online_now || 0,
            activeTables: statsResult.data.active_tables || 0,
            totalTables: statsResult.data.total_tables || 0,
            handsToday: statsResult.data.hands_today || 0,
            rakeToday: Number(statsResult.data.rake_today) || 0,
            weeklyGrowth: statsResult.data.new_this_week || 0,
          }
        : null;
      setDashStats(stats);

      if (roleResult.data) {
        setUserRole(roleResult.data.role || 'member');
      }

      // Live tables (a running table counts even if flagged deleted)
      const visibleTables: ClubTable[] = (tablesResult.data || [])
        .filter(
          (t: any) => !t.is_deleted || ['running', 'waiting', 'active'].includes(t.status)
        )
        .map((t: any) => ({
          id: t.id,
          name: t.name || 'Unnamed Table',
          gameType: t.game_type,
          gameVariant: t.game_variant,
          stakes: t.stakes,
          smallBlind: Number(t.small_blind) || 0,
          bigBlind: Number(t.big_blind) || 0,
          status: t.status || 'unknown',
          currentPlayers: t.current_players || 0,
          maxPlayers: t.max_players || 9,
          createdAt: t.created_at,
        }));
      setClubTables(visibleTables);

      if (clubData) {
        setClub({
          id: clubData.id,
          name: clubData.name,
          avatarUrl: clubData.avatar_url,
          memberCount: stats?.totalMembers ?? clubData.member_count ?? 0,
          tableCount: stats?.activeTables ?? visibleTables.length,
          createdAt: clubData.created_at,
          levelInfo: getClubLevel({
            level: clubData.level || 1,
            playerCount: clubData.member_count || 0,
            hierarchyUnits: clubData.hierarchy_units_rounded_up || 0,
            playerThresholdCurrent: clubData.player_threshold_current || 0,
            playerThresholdNext: clubData.player_threshold_next || 0,
            hierarchyThresholdCurrent: clubData.hierarchy_threshold_current || 0,
            hierarchyThresholdNext: clubData.hierarchy_threshold_next || 0,
          }),
        });
      }

      // Leaderboard from real hand data (profit = won - invested, per range)
      const players: TopPlayer[] = (playersResult.data || []).map((p: any, idx: number) => ({
        userId: p.user_id,
        displayName: p.display_name || 'Player',
        avatarUrl: p.avatar_url,
        totalProfit: Number(p.profit) || 0,
        totalWon: Number(p.total_won) || 0,
        handsPlayed: Number(p.hands_played) || 0,
        biggestPot: Number(p.biggest_pot) || 0,
        rank: idx + 1,
      }));
      setTopPlayers(players);
    } catch (error) {
      reportError(error, 'ClubDashboard.Failed_to_load_dashboard');
      setLoadError(true);
      toast.error('Failed to load dashboard data');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const formatChips = (num: number): string => {
    return (Math.trunc(num * 100) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const formatInt = (num: number): string => {
    return Math.trunc(num).toLocaleString('en-US');
  };

  const statusLabel = (status: string): string => {
    switch (status) {
      case 'running':
        return 'Running';
      case 'waiting':
        return 'Waiting';
      case 'active':
        return 'Active';
      case 'finished':
      case 'closed':
        return 'Closed';
      default:
        return status.charAt(0).toUpperCase() + status.slice(1);
    }
  };

  if (loading && !club) {
    return (
      <div className={styles.loading}>
        <PageSkeleton variant="dashboard" />
      </div>
    );
  }

  if (loadError && !loading && !club) {
    return (
      <div className={styles.dashboard}>
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Failed to load dashboard</p>
          <button
            onClick={() => loadDashboardData()}
            style={{
              padding: '10px 24px',
              borderRadius: '8px',
              background: 'var(--accent-blue, #3b82f6)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.95rem',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
        {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
      </div>
    );
  }

  if (!club) {
    return (
      <div className={styles.error}>
        <h2>Club Not Found</h2>
        <Link to="/clubs">Back to Clubs</Link>
      </div>
    );
  }

  return (
    <div className={styles.dashboard}>
      {/* Dashboard Header */}
      <header className={styles.header}>
        <div className={styles.clubInfo}>
          <div className={styles.clubAvatar}>
            {club.avatarUrl ? (
              <img src={club.avatarUrl} alt={club.name} loading="lazy" />
            ) : (
              <span>{club.name.charAt(0)}</span>
            )}
          </div>
          <div className={styles.clubMeta}>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {club.name}
              {club.levelInfo && (
                <span
                  style={{
                    fontSize: '0.8rem',
                    padding: '4px 10px',
                    borderRadius: '12px',
                    background: club.levelInfo.gradient,
                    color: '#fff',
                    fontWeight: 700,
                    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                  }}
                >
                  Lv.{club.levelInfo.level}
                </span>
              )}
            </h1>
            <p>
              {club.memberCount} members {'•'} {club.tableCount} active{' '}
              {club.tableCount === 1 ? 'table' : 'tables'}
            </p>
          </div>
        </div>
        <div className={styles.quickActions}>
          <Link to={`/clubs/${clubId}/create-table`} className={styles.actionBtn}>
            New Table
          </Link>
          <Link to={`/clubs/${clubId}/financials`} className={styles.actionBtn}>
            Financials
          </Link>
          <Link to={`/clubs/${clubId}/disputes`} className={styles.actionBtn}>
            Disputes
          </Link>
          <Link to={`/clubs/${clubId}/announcements`} className={styles.actionBtn}>
            Announce
          </Link>
          <Link to={`/financial-health`} className={styles.actionBtn}>
            Health
          </Link>
          <Link to={`/financial-admin`} className={styles.actionBtn}>
            Admin Hub
          </Link>
          <Link to={`/clubs/${clubId}/settings`} className={styles.actionBtn}>
            Settings
          </Link>
          {(userRole === 'owner' || userRole === 'admin') && (
            <button
              onClick={handleRecalculateLevel}
              className={styles.actionBtn}
              style={{
                backgroundColor: 'var(--accent-blue)',
                color: 'white',
                border: 'none',
                cursor: 'pointer',
              }}
              disabled={isRecalculating}
            >
              {isRecalculating ? 'Processing...' : 'Recalculate Level'}
            </button>
          )}
        </div>
      </header>

      {/* Date Range Filter (drives the Top Players leaderboard) */}
      <div className={styles.filterBar}>
        <span className={styles.filterLabel}>Time Range:</span>
        <div className={styles.filterButtons}>
          {(['today', 'week', 'month', 'all'] as const).map((range) => (
            <button
              key={range}
              className={`${styles.filterBtn} ${dateRange === range ? styles.active : ''}`}
              onClick={() => setDateRange(range)}
            >
              {range.charAt(0).toUpperCase() + range.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Navigation */}
      <nav className={styles.tabNav}>
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'activity', label: 'Activity' },
          { id: 'players', label: 'Players' },
          { id: 'tables', label: 'Tables' },
        ].map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeTab === tab.id ? styles.active : ''}`}
            onClick={() => switchTab(tab.id as TabId)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div className={styles.content}>
        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            {/* Stats Cards */}
            <section className={styles.statsSection}>
              <h2>Club Metrics</h2>
              {clubId && <ClubStatsCards clubId={clubId} stats={dashStats} />}
            </section>

            {/* Top Players Leaderboard */}
            <section className={styles.leaderboardSection}>
              <h2>Top Players</h2>
              <div className={styles.leaderboard}>
                {topPlayers.length === 0 ? (
                  <p className={styles.empty}>
                    No hands played {dateRange === 'all' ? 'yet' : `this ${dateRange}`}
                  </p>
                ) : (
                  topPlayers.slice(0, 10).map((player, idx) => (
                    <div
                      key={player.userId}
                      className={styles.playerRow}
                      style={{
                        opacity: visiblePlayers.has(idx) ? 1 : 0,
                        transform: visiblePlayers.has(idx) ? 'translateY(0)' : 'translateY(8px)',
                        transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                      }}
                    >
                      <span className={styles.rank}>
                        {player.rank <= 3 ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '22px',
                              height: '22px',
                              borderRadius: '50%',
                              background: RANK_COLORS[player.rank],
                              color: '#fff',
                              fontWeight: 800,
                              fontSize: '0.75rem',
                              textShadow: '0 1px 1px rgba(0,0,0,0.4)',
                            }}
                          >
                            {player.rank}
                          </span>
                        ) : (
                          `#${player.rank}`
                        )}
                      </span>
                      <div className={styles.playerAvatar}>
                        {player.avatarUrl ? (
                          <img src={player.avatarUrl} alt="" loading="lazy" />
                        ) : (
                          <span>{player.displayName.charAt(0)}</span>
                        )}
                      </div>
                      <span className={styles.playerName}>
                        {player.displayName}
                        <span
                          style={{
                            display: 'block',
                            fontSize: '0.7rem',
                            color: 'var(--text-secondary, #888)',
                          }}
                        >
                          {formatInt(player.handsPlayed)} hands
                        </span>
                      </span>
                      <span
                        className={`${styles.profit} ${player.totalProfit >= 0 ? styles.positive : styles.negative}`}
                      >
                        {player.totalProfit >= 0 ? '+' : ''}
                        {formatChips(player.totalProfit)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Quick Activity Preview */}
            <section className={styles.activityPreview}>
              <h2>Recent Activity</h2>
              {clubId && <ClubActivityFeed clubId={clubId} limit={5} />}
              <button
                onClick={() => switchTab('activity')}
                className={styles.viewAllLink}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                View All Activity {'→'}
              </button>
            </section>
          </div>
        )}

        {activeTab === 'activity' && (
          <div className={styles.activityFull}>
            <h2>Club Activity Feed</h2>
            {clubId && <ClubActivityFeed clubId={clubId} limit={50} showFilter />}
          </div>
        )}

        {activeTab === 'players' && (
          <div className={styles.playersSection}>
            <div className={styles.sectionHeader}>
              <h2>Club Members ({club.memberCount})</h2>
              <Link to={`/clubs/${clubId}/members`} className={styles.manageLink}>
                Manage Members {'→'}
              </Link>
            </div>
            <div className={styles.playersList}>
              {topPlayers.length === 0 ? (
                <p className={styles.empty}>
                  No hands played {dateRange === 'all' ? 'yet' : `this ${dateRange}`}
                </p>
              ) : (
                topPlayers.map((player) => (
                  <div key={player.userId} className={styles.playerCard}>
                    <div className={styles.playerAvatar}>
                      {player.avatarUrl ? (
                        <img src={player.avatarUrl} alt="" loading="lazy" />
                      ) : (
                        <span>{player.displayName.charAt(0)}</span>
                      )}
                    </div>
                    <div className={styles.playerInfo}>
                      <span className={styles.playerName}>{player.displayName}</span>
                      <span className={styles.playerStats}>
                        {formatInt(player.handsPlayed)} hands {'•'} biggest pot{' '}
                        {formatChips(player.biggestPot)}
                      </span>
                    </div>
                    <span
                      className={`${styles.profit} ${player.totalProfit >= 0 ? styles.positive : styles.negative}`}
                    >
                      {player.totalProfit >= 0 ? '+' : ''}
                      {formatChips(player.totalProfit)}
                    </span>
                  </div>
                ))
              )}
            </div>
            {clubId && (userRole === 'owner' || userRole === 'admin') && (
              <ClubMemberManagement clubId={clubId} isAdmin={true} />
            )}
          </div>
        )}

        {activeTab === 'tables' && (
          <div className={styles.tablesSection}>
            <div className={styles.sectionHeader}>
              <h2>Club Tables ({clubTables.length})</h2>
              <Link to={`/clubs/${clubId}/create-table`} className={styles.createBtn}>
                + Create Table
              </Link>
            </div>
            {clubTables.length === 0 ? (
              <p className={styles.empty}>No tables yet. Create one to get the club playing.</p>
            ) : (
              <div className={styles.playersList}>
                {clubTables.map((t) => {
                  const isLive = ['running', 'waiting', 'active'].includes(t.status);
                  return (
                    <Link
                      key={t.id}
                      to={`/table/${t.id}`}
                      className={styles.playerCard}
                      style={{ textDecoration: 'none' }}
                    >
                      <div className={styles.playerInfo}>
                        <span className={styles.playerName}>{t.name}</span>
                        <span className={styles.playerStats}>
                          {(t.gameVariant || t.gameType || 'NLH').toUpperCase()} {'•'}{' '}
                          {t.stakes || `${formatChips(t.smallBlind)}/${formatChips(t.bigBlind)}`}{' '}
                          {'•'} {t.currentPlayers}/{t.maxPlayers} seated
                        </span>
                      </div>
                      <span
                        style={{
                          padding: '4px 10px',
                          borderRadius: '10px',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          background: isLive
                            ? 'rgba(16, 185, 129, 0.15)'
                            : 'rgba(148, 163, 184, 0.15)',
                          color: isLive ? '#10b981' : '#94a3b8',
                        }}
                      >
                        {statusLabel(t.status)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
            <Link to={`/clubs/${clubId}/lobby`} className={styles.lobbyLink}>
              View Table Lobby {'→'}
            </Link>
          </div>
        )}
      </div>

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}

      {/* Club-Wide Chat Panel (floating, collapsible) */}
      {clubId && user?.id && (
        <div style={{ padding: '0 16px 80px', maxWidth: '100%' }}>
          <ClubChat
            clubId={clubId}
            userId={user.id}
            userName={user.display_name || user.username || 'Player'}
          />
        </div>
      )}
    </div>
  );
}
