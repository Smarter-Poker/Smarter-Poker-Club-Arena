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

import { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import { isClubStaff, type ClubRole } from '../../types/clubRoles';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusChannel } from '../../hooks/useMasterBusChannel';
import { getLocalStorage, setLocalStorage } from '../../lib/storage';
import ClubStatsCards, { DashboardStats } from '../../components/club/ClubStatsCards';
import ClubActivityFeed from '../../components/club/ClubActivityFeed';
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
  formatAgo,
  isAuthzError,
  isLiveTableStatus,
  sortClubTables,
  tableStatusLabel,
  type RangeId,
  type SortId,
} from '../../utils/clubDashboard';
import { getClubLevel } from '../../utils/clubLevels';
import ClubChat from '../../components/club/ClubChat';
import styles from './ClubDashboard.module.css';
import { reportError } from '../../utils/errorReporter';
import { clubGamesOrFilter } from '../../utils/unionScope';
import { lazyWithRetry } from '../../utils/lazyWithRetry';

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
  /** Hands the profit figure could actually be proven on — see migration 20260819c. */
  handsAttributed: number;
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
  isOnline: boolean;
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

// Recharts is ~390KB; keep it out of the dashboard's initial chunk and pull it
// in only when a tab that actually plots something is opened.
const ClubActivityChart = lazyWithRetry(() => import('../../components/club/ClubActivityChart'));

type TabId = 'overview' | 'activity' | 'players' | 'tables' | 'revenue' | 'tournaments';

const VALID_TABS: TabId[] = ['overview', 'activity', 'players', 'tables', 'revenue', 'tournaments'];

interface RevenueData {
  totals: {
    hands: number;
    rake: number;
    bbj: number;
    pot_total: number;
    avg_pot: number;
    rake_per_hand: number;
  };
  /**
   * INSURANCE P&L 2026-08-27 (Dan): settled all-in insurance contracts at
   * this club's tables. `bank` says where the money actually settles -
   * 'union' for affiliated clubs, 'club' for standalone - so the label can
   * be honest about whose profit it is.
   */
  insurance?: {
    contracts: number;
    premiums: number;
    payouts: number;
    net: number;
    bank: 'union' | 'club';
  };
  daily: Array<{
    d: string;
    hands: number;
    rake: number;
    bbj: number;
    pot_total: number;
    ins_net?: number;
  }>;
  by_table: Array<{
    table_id: string;
    name: string;
    status: string;
    stakes: string;
    hands: number;
    players: number;
  }>;
}

interface TournamentData {
  live: Array<{
    id: string;
    name: string;
    status: string;
    variant: string;
    buy_in: number;
    prize_pool: number;
    players: number;
    max_players: number;
    start_time: string;
  }>;
  recent: Array<{
    id: string;
    name: string;
    status: string;
    variant: string;
    buy_in: number;
    prize_pool: number;
    players: number;
    ended_at: string;
  }>;
  summary: { live_count: number; completed_30d: number; prize_pool_30d: number };
}
const MEMBER_PAGE_SIZE = 25;
const LEADERBOARD_VISIBLE = 10;
type MemberSortId = 'hands' | 'profit' | 'name' | 'joined' | 'last_active';

const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  color: 'inherit',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '5px 10px',
  fontSize: '0.78rem',
  cursor: 'pointer',
};

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
  // Background refreshes are deliberately silent, so without this the page
  // gives no signal at all about how current its numbers are.
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab && VALID_TABS.includes(urlTab as TabId)) return urlTab as TabId;
    return getLocalStorage('ca_dashboard_tab', 'overview');
  });
  const [dateRange, setDateRange] = useState<RangeId>(() =>
    getLocalStorage('ca_dashboard_range', 'week')
  );
  const [sortBy, setSortBy] = useState<SortId>(() =>
    getLocalStorage('ca_dashboard_sort', 'profit')
  );
  const [hideHorses, setHideHorses] = useState<boolean>(() =>
    getLocalStorage('ca_dashboard_hide_horses', false)
  );

  const [visiblePlayers, setVisiblePlayers] = useState<Set<string>>(new Set());
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [userRole, setUserRole] = useState<ClubRole>('player');

  // Members tab
  const [members, setMembers] = useState<ClubMemberRow[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [memberPage, setMemberPage] = useState(0);
  const [memberSearch, setMemberSearch] = useState('');
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberSort, setMemberSort] = useState<MemberSortId>(() =>
    getLocalStorage('ca_dashboard_member_sort', 'hands')
  );
  const [memberRole, setMemberRole] = useState<string>('');
  const memberRequestIdRef = useRef(0);
  // Drives the "Updated Xs ago" label without re-fetching anything.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNowTick(Date.now());
    }, 15_000);
    return () => clearInterval(id);
  }, []);

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
  useEffect(() => {
    setLocalStorage('ca_dashboard_member_sort', memberSort);
  }, [memberSort]);

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

  // Leaderboard stagger animation.
  //
  // Keyed on a CONTENT signature rather than array identity: every refresh
  // builds a fresh array, so an identity dep re-ran this on each one and the
  // rows permanently re-faded from nothing.
  //
  // Visibility is tracked by userId, not list index. The rendered list is
  // sorted and optionally horse-filtered, so an index into the raw array does
  // not identify the same row — the activity feed had exactly this bug, where
  // filtering left rows stuck at opacity 0. Only the rows actually rendered
  // are staggered, so a 100-row payload no longer schedules 100 timers.
  const topPlayersRef = useRef(topPlayers);
  useEffect(() => {
    topPlayersRef.current = topPlayers;
  }, [topPlayers]);
  const topPlayersSignature = topPlayers.map((p) => p.userId).join('|');
  useEffect(() => {
    setVisiblePlayers(new Set());
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = topPlayersRef.current
      .slice(0, LEADERBOARD_VISIBLE)
      .map((p, i) =>
        setTimeout(() => setVisiblePlayers((prev) => new Set(prev).add(p.userId)), i * 60)
      );
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];
    };
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
      // COLLUSION_DETECTED removed 2026-08-28: nothing emits it client-side.
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
      // Clear a stale "Members Only" verdict carried over from a previously
      // viewed club before this club's own authorization result comes back.
      setNotAMember(false);

      // P2-1: union games carry the union container as club_id
      const gamesScope = await clubGamesOrFilter(uuid);
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
          .or(gamesScope)
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
      // These two were previously swallowed: a failed clubs read rendered the
      // "Club Not Found" screen for a club that exists, and a failed tables
      // read rendered an empty Tables tab, both indistinguishable from real
      // emptiness.
      if (clubResult.error) reportError(clubResult.error, 'ClubDashboard.club_read_error');
      if (tablesResult.error) reportError(tablesResult.error, 'ClubDashboard.tables_read_error');
      if (roleResult?.error) reportError(roleResult.error, 'ClubDashboard.role_read_error');
      if (clubResult.error && !club) {
        setLoadError(true);
        return;
      }

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
        handsAttributed: Number(p.hands_attributed) || 0,
        handsWon: Number(p.hands_won) || 0,
        biggestPotWon: Number(p.biggest_pot_won) || 0,
        winRate: Number(p.win_rate) || 0,
        rank: 0,
      }));
      setTopPlayers(players);
      setLastUpdated(Date.now());
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
    async (page: number, search: string, sort: MemberSortId, role: string) => {
      if (!resolvedClubId) return;
      // Out-of-order guard: typing in the search box fires overlapping
      // requests, and without this a slower earlier response could land last
      // and show results for a query the user has already moved past.
      const reqId = ++memberRequestIdRef.current;
      setMembersLoading(true);
      try {
        const { data, error } = await supabase.rpc('ca_club_members', {
          p_club_id: resolvedClubId,
          p_search: search || null,
          p_since: sinceForRange(dateRange),
          p_limit: MEMBER_PAGE_SIZE,
          p_offset: page * MEMBER_PAGE_SIZE,
          p_sort: sort,
          p_role: role || null,
        });
        if (error) throw error;
        if (reqId !== memberRequestIdRef.current) return;
        const rows: ClubMemberRow[] = (data || []).map((m: any) => ({
          userId: m.user_id,
          displayName: m.display_name || 'Player',
          avatarUrl: m.avatar_url,
          isHorse: !!m.is_horse,
          isOnline: !!m.is_online,
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
        setMembersReady(true);
      } catch (err: any) {
        if (reqId !== memberRequestIdRef.current) return;
        if (!isAuthzError(err)) reportError(err, 'ClubDashboard.members_rpc_error');
        setMembers([]);
        setMemberTotal(0);
      } finally {
        if (reqId === memberRequestIdRef.current) setMembersLoading(false);
      }
    },
    [resolvedClubId, dateRange]
  );

  // Debounced member search / paging, only while the Players tab is open.
  useEffect(() => {
    if (activeTab !== 'players' || !resolvedClubId) return;
    const t = setTimeout(() => loadMembers(memberPage, memberSearch, memberSort, memberRole), 250);
    return () => clearTimeout(t);
  }, [activeTab, resolvedClubId, memberPage, memberSearch, memberSort, memberRole, loadMembers]);

  // A new search / filter / range must restart at page 1. Guarded so it does
  // not queue a redundant fetch when already on the first page.
  useEffect(() => {
    setMemberPage((p) => (p === 0 ? p : 0));
  }, [memberSearch, memberSort, memberRole, dateRange]);

  // ── Derived leaderboard (filter + sort applied client-side on <=100 rows) ──
  const rankedPlayers = useMemo(
    () => rankPlayers(topPlayers, sortBy, hideHorses),
    [topPlayers, hideHorses, sortBy]
  );

  // Tables tab: live tables first, then fullest, then newest. The raw query is
  // ordered by created_at alone, which buries a running table under dead ones.
  const sortedTables = useMemo(() => sortClubTables(clubTables), [clubTables]);
  const liveTableCount = useMemo(
    () => clubTables.filter((t) => isLiveTableStatus(t.status)).length,
    [clubTables]
  );
  const seatedAcrossTables = useMemo(
    () => clubTables.reduce((s, t) => (isLiveTableStatus(t.status) ? s + t.currentPlayers : s), 0),
    [clubTables]
  );

  // ── Revenue + tournaments: loaded only when their tab is opened ──────────
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);
  const [tournaments, setTournaments] = useState<TournamentData | null>(null);
  const [tournamentsLoading, setTournamentsLoading] = useState(false);

  const revenueDays = useMemo(
    () => (dateRange === 'today' ? 1 : dateRange === 'week' ? 7 : dateRange === 'month' ? 30 : 90),
    [dateRange]
  );

  useEffect(() => {
    if (activeTab !== 'revenue' || !resolvedClubId) return;
    let cancelled = false;
    setRevenueLoading(true);
    supabase
      .rpc('ca_club_revenue', { p_club_id: resolvedClubId, p_days: revenueDays })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          if (!isAuthzError(error)) reportError(error, 'ClubDashboard.revenue_rpc_error');
          setRevenue(null);
        } else {
          setRevenue(data as RevenueData);
        }
        setRevenueLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, resolvedClubId, revenueDays]);

  useEffect(() => {
    if (activeTab !== 'tournaments' || !resolvedClubId) return;
    let cancelled = false;
    setTournamentsLoading(true);
    supabase
      .rpc('ca_club_tournaments', { p_club_id: resolvedClubId, p_limit: 25 })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          if (!isAuthzError(error)) reportError(error, 'ClubDashboard.tournaments_rpc_error');
          setTournaments(null);
        } else {
          setTournaments(data as TournamentData);
        }
        setTournamentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, resolvedClubId]);

  // True once the roster RPC has answered at least once, so the heading can
  // tell "not loaded yet" apart from a genuine zero.
  const [membersReady, setMembersReady] = useState(false);
  const memberFiltered = memberSearch.trim().length > 0 || memberRole !== '';

  // Derived from the RANKED set, so with "Humans only" on the caption
  // describes the rows actually on screen rather than quietly including the
  // horses the user just filtered out.
  useEffect(() => {
    const played = rankedPlayers.reduce((s, p) => s + p.handsPlayed, 0);
    const attributed = rankedPlayers.reduce((s, p) => s + p.handsAttributed, 0);
    setAttribution(played > 0 ? { played, attributed } : null);
  }, [rankedPlayers]);

  const downloadCsv = (csv: string, suffix: string) => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(club?.name || 'club').replace(/[^\w-]+/g, '-')}-${suffix}-${dateRange}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /** Exports the page currently on screen — labelled as such, not as the roster. */
  const exportMembersCsv = () => {
    const header = [
      'display_name',
      'role',
      'status',
      'is_horse',
      'is_online',
      'joined_at',
      'last_active',
      'chip_balance',
      'hands_played',
      'profit',
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = members.map((m) =>
      [
        esc(m.displayName),
        esc(m.role),
        esc(m.status),
        m.isHorse,
        m.isOnline,
        esc(m.joinedAt ?? ''),
        esc(m.lastActive ?? ''),
        m.chipBalance,
        m.handsPlayed,
        m.profit,
      ].join(',')
    );
    downloadCsv([header.join(','), ...rows].join('\n'), `members-page${memberPage + 1}`);
  };

  const exportLeaderboardCsv = () => downloadCsv(leaderboardToCsv(rankedPlayers), 'leaderboard');

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
          Club Analytics Are Visible To Members Of This Club.
        </p>
        <Link to="/clubs">Back To Clubs</Link>
      </div>
    );
  }

  if (loadError && !loading && !club) {
    return (
      <div className={styles.dashboard}>
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Failed To Load Dashboard</p>
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
      </div>
    );
  }

  if (!club) {
    return (
      <div className={styles.error}>
        <h2>Club Not Found</h2>
        <Link to="/clubs">Back To Clubs</Link>
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
              {formatInt(club.memberCount)} Members {'•'} {club.tableCount} Active{' '}
              {club.tableCount === 1 ? 'table' : 'tables'}
              {dashStats && dashStats.seatedNow > 0 && (
                <>
                  {' '}
                  {'•'} {formatInt(dashStats.seatedNow)} Seated Now
                </>
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
          {isClubStaff(userRole) && (
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

      {/* Tab Navigation — real tablist semantics so screen readers announce
          the selected tab and arrow keys move between them. */}
      <nav className={styles.tabNav} role="tablist" aria-label="Club Dashboard Sections">
        {(
          [
            { id: 'overview', label: 'Overview' },
            { id: 'activity', label: 'Activity' },
            { id: 'players', label: 'Players' },
            { id: 'tables', label: 'Tables' },
            { id: 'revenue', label: 'Revenue' },
            { id: 'tournaments', label: 'Tournaments' },
          ] as const
        ).map((tab, i, arr) => (
          <button
            key={tab.id}
            role="tab"
            id={`ca-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls="ca-tabpanel"
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`${styles.tab} ${activeTab === tab.id ? styles.active : ''}`}
            onClick={() => switchTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const next = arr[(i + (e.key === 'ArrowRight' ? 1 : arr.length - 1)) % arr.length];
              switchTab(next.id);
              document.getElementById(`ca-tab-${next.id}`)?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Freshness. Background refreshes are silent by design, so state the
          age of the numbers and offer an explicit refresh. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 10,
          padding: '0 4px 6px',
          fontSize: '0.7rem',
          color: 'var(--text-secondary, #8a8f98)',
        }}
      >
        <span aria-live="polite">
          {loading
            ? 'Refreshing...'
            : lastUpdated
              ? `Updated ${formatAgo(lastUpdated, nowTick)}`
              : ''}
        </span>
        <button
          onClick={() => loadDashboardData()}
          disabled={loading}
          aria-label="Refresh Dashboard Data"
          style={{
            background: 'rgba(255,255,255,0.06)',
            color: 'inherit',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: '3px 10px',
            fontSize: '0.7rem',
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          Refresh
        </button>
      </div>

      {/* Tab Content */}
      <div
        className={styles.content}
        id="ca-tabpanel"
        role="tabpanel"
        aria-labelledby={`ca-tab-${activeTab}`}
      >
        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            <section className={styles.statsSection}>
              <h2>Club Metrics</h2>
              {clubId && <ClubStatsCards clubId={clubId} stats={dashStats} />}
              {dashStats && dashStats.dailySeries.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h2 style={{ fontSize: '0.95rem', marginBottom: 4 }}>Last 14 Days</h2>
                  <Suspense
                    fallback={
                      <div
                        style={{
                          height: 240,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-secondary, #8a8f98)',
                          fontSize: '0.85rem',
                        }}
                      >
                        Loading Chart...
                      </div>
                    }
                  >
                    <ClubActivityChart data={dashStats.dailySeries} />
                  </Suspense>
                </div>
              )}
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
                    aria-label="Sort Leaderboard"
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
                    <option value="winrate">Win Rate</option>
                    <option value="biggest">Biggest Pot</option>
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
                    Humans Only
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
                  rankedPlayers.slice(0, LEADERBOARD_VISIBLE).map((player) => (
                    <Link
                      key={player.userId}
                      to={`/profile/${player.userId}`}
                      className={styles.playerRow}
                      title={`View ${player.displayName}'S Profile`}
                      style={{
                        textDecoration: 'none',
                        color: 'inherit',
                        opacity: visiblePlayers.has(player.userId) ? 1 : 0,
                        transform: visiblePlayers.has(player.userId)
                          ? 'translateY(0)'
                          : 'translateY(8px)',
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
                          {formatInt(player.handsPlayed)} Hands {'•'} {player.winRate}% Won
                        </span>
                      </span>
                      <span
                        className={`${styles.profit} ${player.totalProfit >= 0 ? styles.positive : styles.negative}`}
                      >
                        {formatSigned(player.totalProfit)}
                      </span>
                    </Link>
                  ))
                )}
                {rankedPlayers.length > LEADERBOARD_VISIBLE && (
                  <button
                    onClick={() => switchTab('players')}
                    className={styles.viewAllLink}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      marginTop: 4,
                    }}
                  >
                    See All {formatInt(rankedPlayers.length)} Ranked Players {'→'}
                  </button>
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
                  Profit Measured From Post-Hand Stack Movement On{' '}
                  {formatInt(attribution.attributed)} Of {formatInt(attribution.played)}{' '}
                  Player-Hands {rangeLabel}
                  {attribution.played > 0 && (
                    <> ({Math.round((attribution.attributed / attribution.played) * 100)}%)</>
                  )}
                  . Hands Spanning A Re-Buy Or A Table Re-Join Cannot Be Attributed And Are
                  Excluded.
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
              {/* `memberTotal || club.memberCount` was wrong on two counts: a
                  search matching nothing gives 0, which is falsy, so the
                  heading fell back to the full roster size and read "Club
                  Members (327)" directly above "No members matching"; and with
                  a filter applied the total describes the filtered set, not the
                  club. Say which one is being counted. */}
              <h2>
                {memberFiltered ? 'Matching Members' : 'Club Members'} (
                {formatInt(membersReady ? memberTotal : club.memberCount)})
              </h2>
              <Link to={`/clubs/${clubId}/members`} className={styles.manageLink}>
                Manage Members {'→'}
              </Link>
            </div>

            <input
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Search Members By Name"
              aria-label="Search Members"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                margin: '8px 0 8px',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.05)',
                color: 'inherit',
                fontSize: '0.9rem',
              }}
            />

            {/* Sorting and role filtering are applied SERVER-side: the list is
                paged, so ordering 25 rows in the browser would present one
                page as if it were the ranking of the whole roster. */}
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <select
                value={memberSort}
                onChange={(e) => setMemberSort(e.target.value as MemberSortId)}
                aria-label="Sort Members"
                style={selectStyle}
              >
                <option value="hands">Most Hands</option>
                <option value="profit">Most Profit</option>
                <option value="name">Name (A-Z)</option>
                <option value="joined">Recently Joined</option>
                <option value="last_active">Recently Active</option>
              </select>
              <select
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value)}
                aria-label="Filter Members By Role"
                style={selectStyle}
              >
                <option value="">All Roles</option>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="agent">Agent</option>
                <option value="player">Player</option>
                <option value="member">Member</option>
              </select>
              {members.length > 0 && (
                <button onClick={exportMembersCsv} style={selectStyle}>
                  Export CSV
                </button>
              )}
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #8a8f98)' }}>
                {membersLoading
                  ? 'Loading...'
                  : memberFiltered
                    ? `${formatInt(memberTotal)} of ${formatInt(club.memberCount)} match`
                    : `${formatInt(memberTotal)} members`}
              </span>
            </div>

            <div className={styles.playersList}>
              {membersLoading && members.length === 0 ? (
                <p className={styles.empty}>Loading Members...</p>
              ) : members.length === 0 ? (
                <p className={styles.empty}>
                  {memberSearch ? `No members matching "${memberSearch}"` : 'No members yet'}
                </p>
              ) : (
                members.map((m) => (
                  <Link
                    key={m.userId}
                    to={`/profile/${m.userId}`}
                    className={styles.playerCard}
                    title={`View ${m.displayName}'S Profile`}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <div className={styles.playerAvatar} style={{ position: 'relative' }}>
                      {m.avatarUrl ? (
                        <img src={m.avatarUrl} alt="" loading="lazy" />
                      ) : (
                        <span>{m.displayName.charAt(0)}</span>
                      )}
                      {m.isOnline && (
                        <span
                          title="Online"
                          aria-label="Online"
                          style={{
                            position: 'absolute',
                            right: -1,
                            bottom: -1,
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: '#10b981',
                            border: '2px solid rgba(15,15,30,0.9)',
                          }}
                        />
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
                        {formatInt(m.handsPlayed)} Hands {rangeLabel} {'•'} Balance{' '}
                        {formatChips(m.chipBalance)}
                      </span>
                    </div>
                    <span
                      className={`${styles.profit} ${m.profit >= 0 ? styles.positive : styles.negative}`}
                    >
                      {formatSigned(m.profit)}
                    </span>
                  </Link>
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
                  Page {memberPage + 1} Of {Math.max(1, Math.ceil(memberTotal / MEMBER_PAGE_SIZE))}
                </span>
                <button
                  onClick={() =>
                    setMemberPage((p) => ((p + 1) * MEMBER_PAGE_SIZE < memberTotal ? p + 1 : p))
                  }
                  disabled={(memberPage + 1) * MEMBER_PAGE_SIZE >= memberTotal || membersLoading}
                  className={styles.actionBtn}
                >
                  Next
                </button>
              </div>
            )}

            {clubId && isClubStaff(userRole) && (
              <ClubMemberManagement clubId={clubId} isAdmin={true} />
            )}
          </div>
        )}

        {activeTab === 'tables' && (
          <div className={styles.tablesSection}>
            <div className={styles.sectionHeader}>
              <h2>
                Club Tables ({sortedTables.length})
                {liveTableCount > 0 && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      color: '#10b981',
                    }}
                  >
                    {liveTableCount} Live {'•'} {seatedAcrossTables} Seated
                  </span>
                )}
              </h2>
              <Link to={`/clubs/${clubId}/create-table`} className={styles.createBtn}>
                + Create Table
              </Link>
            </div>
            {clubTables.length === 0 ? (
              <p className={styles.empty}>No Tables Yet. Create One To Get The Club Playing.</p>
            ) : (
              <div className={styles.playersList}>
                {sortedTables.map((t) => {
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
                          {'•'} {t.currentPlayers}/{t.maxPlayers} Seated
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

        {activeTab === 'revenue' && (
          <div className={styles.tablesSection}>
            <div className={styles.sectionHeader}>
              <h2>Revenue ({rangeLabel})</h2>
            </div>
            {revenueLoading && !revenue ? (
              <p className={styles.empty}>Loading Revenue...</p>
            ) : !revenue ? (
              <p className={styles.empty}>No Revenue Data Available</p>
            ) : (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: 10,
                    marginBottom: 16,
                  }}
                >
                  {[
                    { label: 'Rake collected', value: formatChips(revenue.totals.rake) },
                    { label: 'Bad beat drop', value: formatChips(revenue.totals.bbj) },
                    { label: 'Hands dealt', value: formatInt(revenue.totals.hands) },
                    { label: 'Rake per hand', value: formatChips(revenue.totals.rake_per_hand) },
                    { label: 'Average pot', value: formatChips(revenue.totals.avg_pot) },
                    { label: 'Total pots', value: formatChips(revenue.totals.pot_total) },
                    // INSURANCE P&L 2026-08-27 (Dan): net = premiums - payouts
                    // over the window. The bank suffix says whose profit it is
                    // - a union-affiliated club's insurance settles to the
                    // union bank, a standalone club keeps it.
                    ...(revenue.insurance
                      ? [
                          {
                            label:
                              revenue.insurance.bank === 'union'
                                ? 'Insurance net (to union)'
                                : 'Insurance net (club bank)',
                            value: formatChips(revenue.insurance.net),
                          },
                          {
                            label: 'Insurance premiums / payouts',
                            value: `${formatChips(revenue.insurance.premiums)} / ${formatChips(revenue.insurance.payouts)}`,
                          },
                        ]
                      : []),
                  ].map((m) => (
                    <div
                      key={m.label}
                      style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 10,
                        padding: '10px 12px',
                      }}
                    >
                      <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{m.value}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary, #8a8f98)' }}>
                        {m.label}
                      </div>
                    </div>
                  ))}
                </div>

                {/* INSURANCE REPORT 2026-08-28: the headline net above raises
                    questions only the funnel can answer — take rate, timeouts,
                    cashouts, per-day money. That lives on its own page. */}
                {revenue.insurance && (
                  <Link
                    to={`/clubs/${clubId}/insurance-report`}
                    style={{
                      display: 'inline-block',
                      marginBottom: 14,
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      color: '#1877f2',
                      textDecoration: 'none',
                    }}
                  >
                    View Full Insurance Report
                  </Link>
                )}

                {/* BOMB POT REPORT 2026-08-29. Unconditional, unlike the
                    insurance link above: that one is gated on the club HAVING
                    insurance revenue, but the first question about bomb pots is
                    whether to run them at all, and an owner who has never
                    switched them on is exactly who needs to see the page. It
                    tells them plainly when there is nothing to show yet. */}
                <Link
                  to={`/clubs/${clubId}/bomb-pot-report`}
                  style={{
                    display: 'inline-block',
                    marginBottom: 14,
                    marginLeft: revenue.insurance ? 14 : 0,
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    color: '#1877f2',
                    textDecoration: 'none',
                  }}
                >
                  View Bomb Pot Report
                </Link>

                <Suspense fallback={<p className={styles.empty}>Loading Chart...</p>}>
                  <ClubActivityChart
                    data={revenue.daily.map((d) => ({ d: d.d, hands: d.hands, rake: d.rake }))}
                    height={260}
                  />
                </Suspense>

                <h2 style={{ fontSize: '0.95rem', margin: '18px 0 8px' }}>Busiest Tables</h2>
                <div className={styles.playersList}>
                  {revenue.by_table.length === 0 ? (
                    <p className={styles.empty}>No Table Activity In This Period</p>
                  ) : (
                    revenue.by_table.map((t) => (
                      <Link
                        key={t.table_id}
                        to={`/table/${t.table_id}`}
                        className={styles.playerCard}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <div className={styles.playerInfo}>
                          <span className={styles.playerName}>{t.name}</span>
                          <span className={styles.playerStats}>
                            {t.stakes} {'•'} {formatInt(t.players)} Players
                          </span>
                        </div>
                        <span className={styles.playerStats}>{formatInt(t.hands)} Hands</span>
                      </Link>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'tournaments' && (
          <div className={styles.tablesSection}>
            <div className={styles.sectionHeader}>
              <h2>
                Tournaments
                {tournaments && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      color: 'var(--text-secondary, #8a8f98)',
                    }}
                  >
                    {formatInt(tournaments.summary.completed_30d)} Finished In 30D {'•'}{' '}
                    {formatChips(tournaments.summary.prize_pool_30d)} In Prizes
                  </span>
                )}
              </h2>
            </div>
            {tournamentsLoading && !tournaments ? (
              <p className={styles.empty}>Loading Tournaments...</p>
            ) : !tournaments ? (
              <p className={styles.empty}>No Tournament Data Available</p>
            ) : (
              <>
                <h2 style={{ fontSize: '0.95rem', margin: '4px 0 8px' }}>
                  Live And Upcoming ({tournaments.live.length})
                </h2>
                <div className={styles.playersList}>
                  {tournaments.live.length === 0 ? (
                    <p className={styles.empty}>Nothing Scheduled Right Now</p>
                  ) : (
                    tournaments.live.map((t) => (
                      <Link
                        key={t.id}
                        to={`/tournaments/${t.id}`}
                        className={styles.playerCard}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <div className={styles.playerInfo}>
                          <span className={styles.playerName}>{t.name}</span>
                          <span className={styles.playerStats}>
                            {(t.variant || 'NLH').toUpperCase()} {'•'} Buy-In{' '}
                            {formatChips(t.buy_in)} {'•'} {formatInt(t.players)}
                            {t.max_players ? `/${formatInt(t.max_players)}` : ''} Entered
                          </span>
                        </div>
                        <span
                          style={{
                            padding: '4px 10px',
                            borderRadius: 10,
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            background: 'rgba(16,185,129,0.15)',
                            color: '#10b981',
                          }}
                        >
                          {tableStatusLabel(t.status)}
                        </span>
                      </Link>
                    ))
                  )}
                </div>

                <h2 style={{ fontSize: '0.95rem', margin: '18px 0 8px' }}>
                  Recently Finished ({tournaments.recent.length})
                </h2>
                <div className={styles.playersList}>
                  {tournaments.recent.length === 0 ? (
                    <p className={styles.empty}>No Tournaments Finished In The Last 30 Days</p>
                  ) : (
                    tournaments.recent.map((t) => (
                      <Link
                        key={t.id}
                        to={`/tournaments/${t.id}`}
                        className={styles.playerCard}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <div className={styles.playerInfo}>
                          <span className={styles.playerName}>{t.name}</span>
                          <span className={styles.playerStats}>
                            {(t.variant || 'NLH').toUpperCase()} {'•'} {formatInt(t.players)}{' '}
                            Entered
                            {'•'} Prize Pool {formatChips(t.prize_pool)}
                          </span>
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

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
