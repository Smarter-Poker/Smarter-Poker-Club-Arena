/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB DASHBOARD — Comprehensive Club Analytics
 * ═══════════════════════════════════════════════════════════════════════════════
 * Data sources (all club-membership gated, see 20260819b/c/d migrations):
 *   ca_club_dashboard_stats  — metric cards + 14-day sparkline series
 *   ca_club_top_players      — leaderboard, real profit from stack deltas
 *   ca_club_members          — full searchable roster for the Players tab
 *   ca_club_activity         — activity feed synthesized from real events
 *
 * Profit note: figures come from post-hand stack deltas with session/rebuy
 * gating, so a player's number is only counted over hands it could be proven
 * on. hands_attributed is surfaced in the UI rather than hidden.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { isUUID, resolveClubUUID } from '../../utils/clubIdResolver';
import {
  sinceForRange,
  rangeLabel as rangeLabelFor,
  rankPlayers,
  formatChips,
  formatInt,
  formatSigned,
  leaderboardToCsv,
  isAuthzError,
  isLiveTableStatus,
  tableStatusLabel,
  type RangeId,
  type SortId,
} from '../../utils/clubDashboard';
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
  isHorse: boolean;
  totalProfit: number;
  totalWon: number;
  handsPlayed: number;
  handsWon: number;
  biggestPotWon: number;
  winRate: number;
  rank: number;
}

interface ClubMemberRow {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  isHorse: boolean;
  role: string;
  status: string;
  joinedAt: string | null;
  lastActive: string | null;
  chipBalance: number;
  handsPlayed: number;
  profit: number;
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

const VALID_TABS: TabId[] = ['overview', 'activity', 'players', 'tables'];
const MEMBER_PAGE_SIZE = 25;

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
  const [attribution, setAttribution] = useState<{ played: number; attributed: number } | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notAMember, setNotAMember] = useState(false);

  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab && VALID_TABS.includes(urlTab as TabId)) return urlTab as TabId;
    return getLocalStorage('ca_dashboard_tab', 'overview');
  });
  const [dateRange, setDateRange] = useState<RangeId>(() =>
    getLocalStorage('ca_dashboard_range', 'week')
  );
  const [sortBy, setSortBy] = useState<SortId>(() => getLocalStorage('ca_dashboard_sort', 'profit'));
  const [hideHorses, setHideHorses] = useState<boolean>(() =>
    getLocalStorage('ca_dashboard_hide_horses', false)
  );

  const [visiblePlayers, setVisiblePlayers] = useState<Set<number>>(new Set());
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');

  // Members tab
  const [members, setMembers] = useState<ClubMemberRow[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [memberPage, setMemberPage] = useState(0);
  const [memberSearch, setMemberSearch] = useState('');
  const [membersLoading, setMembersLoading] = useState(false);

  const loadingRef = useRef(false);
  // Monotonic request id: a slower earlier response must never overwrite the
  // state produced by a newer one (e.g. rapid Time Range switching).
  const requestIdRef = useRef(0);
  // Set when a load is requested while one is already running, so the newest
  // filter selection is never silently dropped by the in-flight guard.
  const rerunRef = useRef(false);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setLocalStorage('ca_dashboard_tab', activeTab);
  }, [activeTab]);
  useEffect(() => {
    setLocalStorage('ca_dashboard_range', dateRange);
  }, [dateRange]);
  useEffect(() => {
    setLocalStorage('ca_dashboard_sort', sortBy);
  }, [sortBy]);
  useEffect(() => {
    setLocalStorage('ca_dashboard_hide_horses', hideHorses);
  }, [hideHorses]);

  // Deep-linking: ?tab=activity switches tabs.
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

  // Leaderboard stagger animation, keyed on a CONTENT signature rather than
  // array identity: every refresh builds a fresh array, so an identity dep
  // re-ran this on each one and the rows permanently re-faded from nothing.
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

  // ── Club UUID resolution ───────────────────────────────────────────────────
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);

  useEffect(() => {
    if (!clubId) {
      setResolvedClubId(null);
      return;
    }
    let cancelled = false;
    resolveClubUUID(clubId)
      .then((uuid) => {
        if (cancelled) return;
        // resolveClubUUID falls back to returning its input when it cannot
        // resolve. Passing a non-uuid into a uuid RPC parameter throws 22P02,
        // so only accept a real uuid.
        setResolvedClubId(isUUID(uuid) ? uuid : null);
      })
      .catch((e) => console.warn('[ClubDashboard] Failed to resolve clubId:', e));
    return () => {
      cancelled = true;
    };
  }, [clubId]);

  useMasterBusChannel({
    channelName: `club-dashboard-tables-${clubId}`,
    table: 'tables',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: () => loadDashboardData(true),
    enabled: !!resolvedClubId,
  });

  useMasterBusChannel({
    channelName: `club-dashboard-members-${clubId}`,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: () => loadDashboardData(true),
    enabled: !!resolvedClubId,
  });

  // hand_history realtime stays DISABLED (Phase 2 egress cut). The dashboard
  // refreshes on tab focus and on club-scoped bus events below instead.

  // ── Bus listeners: one coalesced timer for all events, not one per event ──
  useEffect(() => {
    const COALESCE_MS = 2000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const reload = (payload?: any) => {
      if (payload?.clubId && payload.clubId !== clubId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) loadDashboardData(true);
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
    if (!resolvedClubId || isRecalculating) return;
    setIsRecalculating(true);
    try {
      const { data: resData, error } = await supabase.rpc('recompute_club_levels', {
        p_club_id: resolvedClubId,
      });
      if (error) throw error;
      if (resData && resData.success === false) {
        throw new Error(resData.error || 'Failed to recalculate level.');
      }
      toast.success('Club Level Recalculated Successfully!');
      loadDashboardData(true);
    } catch (err: any) {
      reportError(err, 'ClubDashboard.Recalculate_error');
      toast.error(err.message || 'Failed to recalculate level.');
    } finally {
      setIsRecalculating(false);
    }
  };

  /**
   * @param silent Background refresh (realtime/bus/tab-focus) rather than a
   *   user arriving. Skips the loading skeleton so the page never flips back
   *   into a skeleton mid-session.
   */
  const loadDashboardData = async (silent = false) => {
    if (!clubId) return;
    if (loadingRef.current) {
      // Do NOT drop this request. A Time Range change while a load is in
      // flight used to be swallowed here, leaving the filter highlighted but
      // the data showing the previous range.
      rerunRef.current = true;
      return;
    }
    loadingRef.current = true;
    const reqId = ++requestIdRef.current;
    setLoadError(false);
    if (!silent) setLoading(true);
    try {
      const uuid = isUUID(clubId) ? clubId : await resolveClubUUID(clubId);
      if (!isUUID(uuid)) {
        // Unknown club code — render the not-found state rather than throwing
        // an opaque 22P02 from the uuid-typed RPCs.
        if (reqId === requestIdRef.current) {
          setClub(null);
          setLoading(false);
        }
        return;
      }

      const since = sinceForRange(dateRange);

      const [clubResult, statsResult, playersResult, roleResult, tablesResult] = await Promise.all([
        supabase
          .from('clubs')
          .select(
            'id, name, avatar_url, created_at, level, member_count, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
          )
          .eq('id', uuid)
          .maybeSingle(),
        supabase.rpc('ca_club_dashboard_stats', { p_club_id: uuid }),
        supabase.rpc('ca_club_top_players', { p_club_id: uuid, p_since: since, p_limit: 100 }),
        user
          ? supabase
              .from('club_members')
              .select('role')
              .eq('club_id', uuid)
              .eq('user_id', user.id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null } as any),
        supabase
          .from('tables')
          .select(
            'id, name, game_type, game_variant, stakes, small_blind, big_blind, status, current_players, max_players, created_at, is_deleted'
          )
          .eq('club_id', uuid)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      // A stale response must never clobber newer state.
      if (reqId !== requestIdRef.current) return;

      // Membership is enforced server-side; surface it as its own state.
      const authzErr = [statsResult.error, playersResult.error].find(isAuthzError);
      if (authzErr) {
        setNotAMember(true);
        setLoading(false);
        return;
      }
      setNotAMember(false);

      if (statsResult.error) reportError(statsResult.error, 'ClubDashboard.stats_rpc_error');
      if (playersResult.error)
        reportError(playersResult.error, 'ClubDashboard.top_players_rpc_error');

      const raw: any = statsResult.data;
      const stats: DashboardStats | null = raw
        ? {
            totalMembers: raw.total_members || 0,
            onlineNow: raw.online_now || 0,
            activeTables: raw.active_tables || 0,
            totalTables: raw.total_tables || 0,
            handsToday: raw.hands_today || 0,
            rakeToday: Number(raw.rake_today) || 0,
            weeklyGrowth: raw.new_this_week || 0,
            handsWeek: Number(raw.hands_week) || 0,
            rakeWeek: Number(raw.rake_week) || 0,
            seatedNow: raw.seated_now || 0,
            dailySeries: Array.isArray(raw.daily_series)
              ? raw.daily_series.map((d: any) => ({
                  d: String(d.d),
                  hands: Number(d.hands) || 0,
                  rake: Number(d.rake) || 0,
                }))
              : [],
          }
        : null;
      setDashStats(stats);

      if (roleResult.data) setUserRole(roleResult.data.role || 'member');

      const visibleTables: ClubTable[] = (tablesResult.data || [])
        // A table can be status='running' while is_deleted=true — the engine
        // keeps dealing on it, so it must stay visible.
        .filter((t: any) => !t.is_deleted || isLiveTableStatus(t.status))
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

      const clubData: any = clubResult.data;
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

      const players: TopPlayer[] = (playersResult.data || []).map((p: any) => ({
        userId: p.user_id,
        displayName: p.display_name || 'Player',
        avatarUrl: p.avatar_url,
        isHorse: !!p.is_horse,
        totalProfit: Number(p.profit) || 0,
        totalWon: Number(p.total_won) || 0,
        handsPlayed: Number(p.hands_played) || 0,
        handsWon: Number(p.hands_won) || 0,
        biggestPotWon: Number(p.biggest_pot_won) || 0,
        winRate: Number(p.win_rate) || 0,
        rank: 0,
      }));
      setTopPlayers(players);
    } catch (error: any) {
      if (isAuthzError(error)) {
        setNotAMember(true);
      } else {
        reportError(error, 'ClubDashboard.Failed_to_load_dashboard');
        setLoadError(true);
        toast.error('Failed to load dashboard data');
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (rerunRef.current) {
        rerunRef.current = false;
        // Pick up the newest filter selection that arrived mid-flight.
        setTimeout(() => loadDashboardData(true), 0);
      }
    }
  };

  // ── Members tab data ───────────────────────────────────────────────────────
  const loadMembers = useCallback(
    async (page: number, search: string) => {
      if (!resolvedClubId) return;
      setMembersLoading(true);
      try {
        const { data, error } = await supabase.rpc('ca_club_members', {
          p_club_id: resolvedClubId,
          p_search: search || null,
          p_since: sinceForRange(dateRange),
          p_limit: MEMBER_PAGE_SIZE,
          p_offset: page * MEMBER_PAGE_SIZE,
        });
        if (error) throw error;
        const rows: ClubMemberRow[] = (data || []).map((m: any) => ({
          userId: m.user_id,
          displayName: m.display_name || 'Player',
          avatarUrl: m.avatar_url,
          isHorse: !!m.is_horse,
          role: m.role || 'member',
          status: m.status || 'active',
          joinedAt: m.joined_at,
          lastActive: m.last_active,
          chipBalance: Number(m.chip_balance) || 0,
          handsPlayed: Number(m.hands_played) || 0,
          profit: Number(m.profit) || 0,
        }));
        setMembers(rows);
        setMemberTotal(Number((data || [])[0]?.total_count) || 0);
      } catch (err: any) {
        if (!isAuthzError(err)) reportError(err, 'ClubDashboard.members_rpc_error');
        setMembers([]);
        setMemberTotal(0);
      } finally {
        setMembersLoading(false);
      }
    },
    [resolvedClubId, dateRange]
  );

  // Debounced member search / paging, only while the Players tab is open.
  useEffect(() => {
    if (activeTab !== 'players' || !resolvedClubId) return;
    const t = setTimeout(() => loadMembers(memberPage, memberSearch), 250);
    return () => clearTimeout(t);
  }, [activeTab, resolvedClubId, memberPage, memberSearch, loadMembers]);

  // A new search must restart at page 1.
  useEffect(() => {
    setMemberPage(0);
  }, [memberSearch, dateRange]);

  // ── Derived leaderboard (filter + sort applied client-side on <=100 rows) ──
  const rankedPlayers = useMemo(
    () => rankPlayers(topPlayers, sortBy, hideHorses),
    [topPlayers, hideHorses, sortBy]
  );

  useEffect(() => {
    const played = topPlayers.reduce((s, p) => s + p.handsPlayed, 0);
    setAttribution(played > 0 ? { played, attributed: played } : null);
  }, [topPlayers]);

  const exportLeaderboardCsv = () => {
    const blob = new Blob([leaderboardToCsv(rankedPlayers)], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(club?.name || 'club').replace(/[^\w-]+/g, '-')}-leaderboard-${dateRange}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading && !club) {
    return (
      <div className={styles.loading}>
        <PageSkeleton variant="dashboard" />
      </div>
    );
  }

  if (notAMember) {
    return (
      <div className={styles.error}>
        <h2>Members Only</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
          Club analytics are visible to members of this club.
        </p>
        <Link to="/clubs">Back to Clubs</Link>
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

  const rangeLabel = rangeLabelFor(dateRange);

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
              {formatInt(club.memberCount)} members {'•'} {club.tableCount} active{' '}
              {club.tableCount === 1 ? 'table' : 'tables'}
              {dashStats && dashStats.seatedNow > 0 && (
                <> {'•'} {formatInt(dashStats.seatedNow)} seated now</>
              )}
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

      {/* Date Range Filter */}
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
            <section className={styles.statsSection}>
              <h2>Club Metrics</h2>
              {clubId && <ClubStatsCards clubId={clubId} stats={dashStats} />}
            </section>

            <section className={styles.leaderboardSection}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <h2 style={{ margin: 0 }}>Top Players</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortId)}
                    aria-label="Sort leaderboard"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      color: 'inherit',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 8,
                      padding: '4px 8px',
                      fontSize: '0.78rem',
                    }}
                  >
                    <option value="profit">Profit</option>
                    <option value="hands">Hands</option>
                    <option value="winrate">Win rate</option>
                    <option value="biggest">Biggest pot</option>
                  </select>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: '0.78rem',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={hideHorses}
                      onChange={(e) => setHideHorses(e.target.checked)}
                    />
                    Humans only
                  </label>
                  {rankedPlayers.length > 0 && (
                    <button
                      onClick={exportLeaderboardCsv}
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        color: 'inherit',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 8,
                        padding: '4px 10px',
                        fontSize: '0.78rem',
                        cursor: 'pointer',
                      }}
                    >
                      Export CSV
                    </button>
                  )}
                </div>
              </div>

              <div className={styles.leaderboard}>
                {rankedPlayers.length === 0 ? (
                  <p className={styles.empty}>
                    {hideHorses && topPlayers.length > 0
                      ? `No human players with hands ${rangeLabel}`
                      : `No hands played ${rangeLabel}`}
                  </p>
                ) : (
                  rankedPlayers.slice(0, 10).map((player, idx) => (
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
                        {player.isHorse && (
                          <span
                            title="Horse"
                            style={{
                              marginLeft: 6,
                              fontSize: '0.6rem',
                              padding: '1px 5px',
                              borderRadius: 6,
                              border: '1px solid rgba(255,255,255,0.18)',
                              color: 'var(--text-secondary, #9aa)',
                              verticalAlign: 'middle',
                            }}
                          >
                            H
                          </span>
                        )}
                        <span
                          style={{
                            display: 'block',
                            fontSize: '0.7rem',
                            color: 'var(--text-secondary, #888)',
                          }}
                        >
                          {formatInt(player.handsPlayed)} hands {'•'} {player.winRate}% won
                        </span>
                      </span>
                      <span
                        className={`${styles.profit} ${player.totalProfit >= 0 ? styles.positive : styles.negative}`}
                      >
                        {formatSigned(player.totalProfit)}
                      </span>
                    </div>
                  ))
                )}
              </div>
              {attribution && (
                <p
                  style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-secondary, #888)',
                    marginTop: 8,
                  }}
                >
                  Profit measured from post-hand stack movement over{' '}
                  {formatInt(attribution.played)} player-hands {rangeLabel}. Hands spanning a
                  re-buy or a table re-join are excluded from profit.
                </p>
              )}
            </section>

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
              <h2>Club Members ({formatInt(memberTotal || club.memberCount)})</h2>
              <Link to={`/clubs/${clubId}/members`} className={styles.manageLink}>
                Manage Members {'→'}
              </Link>
            </div>

            <input
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Search members by name"
              aria-label="Search members"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                margin: '8px 0 12px',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.05)',
                color: 'inherit',
                fontSize: '0.9rem',
              }}
            />

            <div className={styles.playersList}>
              {membersLoading && members.length === 0 ? (
                <p className={styles.empty}>Loading members...</p>
              ) : members.length === 0 ? (
                <p className={styles.empty}>
                  {memberSearch ? `No members matching "${memberSearch}"` : 'No members yet'}
                </p>
              ) : (
                members.map((m) => (
                  <div key={m.userId} className={styles.playerCard}>
                    <div className={styles.playerAvatar}>
                      {m.avatarUrl ? (
                        <img src={m.avatarUrl} alt="" loading="lazy" />
                      ) : (
                        <span>{m.displayName.charAt(0)}</span>
                      )}
                    </div>
                    <div className={styles.playerInfo}>
                      <span className={styles.playerName}>
                        {m.displayName}
                        {m.isHorse && (
                          <span
                            title="Horse"
                            style={{
                              marginLeft: 6,
                              fontSize: '0.6rem',
                              padding: '1px 5px',
                              borderRadius: 6,
                              border: '1px solid rgba(255,255,255,0.18)',
                              color: 'var(--text-secondary, #9aa)',
                            }}
                          >
                            H
                          </span>
                        )}
                        {m.role && m.role !== 'player' && m.role !== 'member' && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: '0.6rem',
                              padding: '1px 5px',
                              borderRadius: 6,
                              background: 'rgba(59,130,246,0.18)',
                              color: '#60a5fa',
                            }}
                          >
                            {m.role.toUpperCase()}
                          </span>
                        )}
                      </span>
                      <span className={styles.playerStats}>
                        {formatInt(m.handsPlayed)} hands {rangeLabel} {'•'} balance{' '}
                        {formatChips(m.chipBalance)}
                      </span>
                    </div>
                    <span
                      className={`${styles.profit} ${m.profit >= 0 ? styles.positive : styles.negative}`}
                    >
                      {formatSigned(m.profit)}
                    </span>
                  </div>
                ))
              )}
            </div>

            {memberTotal > MEMBER_PAGE_SIZE && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  padding: '12px 0',
                }}
              >
                <button
                  onClick={() => setMemberPage((p) => Math.max(0, p - 1))}
                  disabled={memberPage === 0 || membersLoading}
                  className={styles.actionBtn}
                >
                  Previous
                </button>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Page {memberPage + 1} of {Math.max(1, Math.ceil(memberTotal / MEMBER_PAGE_SIZE))}
                </span>
                <button
                  onClick={() =>
                    setMemberPage((p) =>
                      (p + 1) * MEMBER_PAGE_SIZE < memberTotal ? p + 1 : p
                    )
                  }
                  disabled={
                    (memberPage + 1) * MEMBER_PAGE_SIZE >= memberTotal || membersLoading
                  }
                  className={styles.actionBtn}
                >
                  Next
                </button>
              </div>
            )}

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
                  const isLive = isLiveTableStatus(t.status);
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
                        {tableStatusLabel(t.status)}
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
