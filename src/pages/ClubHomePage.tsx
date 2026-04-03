/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB HOME PAGE — PokerBros-Style Club Dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 * Main page after entering a club. Shows:
 * - Modified Club Arena header (No Search, Settings = Club Settings)
 * - Club card with avatar, name, ID, member count
 * - Wallet display (Gold + Diamond chips)
 * - Bad Beat Jackpot display
 * - Game type filters (ALL, Hold'em, Omaha, Mixed, MTT, SNG)
 * - "Create New Table" button for club owners
 * - Active tables/games grid
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import haptic from '../services/HapticService';
import ClubBottomNav from '../components/club/ClubBottomNav';
import {
  CashGameCard,
  TournamentCard,
  SNGCard,
  SpinCard,
} from '../components/lobby/DynamicGameCard';
import { getClubLevel, ClubLevelInfo } from '../utils/clubLevels';
import { BusToastBridge } from '../components/common/BusToastBridge';
import { DiamondService } from '../services/DiamondService';
import { useToast } from '../components/common/Toast';
import ConfirmModal from '../components/common/ConfirmModal';
import { retryFetch } from '../utils/retryFetch';
import './ClubHomePage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import GlobalUXIndicators from '../components/common/GlobalUXIndicators';
import DynamicWallet from '../components/wallet/DynamicWallet';
import { reportError } from '../utils/errorReporter';
import { SHARK_CLUB_ID } from '../lib/constants';

// Shark Club fallback logo — used when DB logo_url is null
const SHARK_CLUB_FALLBACK_LOGO = `${import.meta.env.BASE_URL || '/'}images/shark-club-card-v25.jpg`;

// SWR cache helpers for instant club data display
function getClubHomeCache(clubId: string) {
  try {
    const raw = sessionStorage.getItem(`club_home_cache_${clubId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setClubHomeCache(clubId: string, data: { club: any; tables: any[] }) {
  try {
    sessionStorage.setItem(`club_home_cache_${clubId}`, JSON.stringify(data));
  } catch {
    /* storage full */
  }
}

// Types
interface ClubData {
  id: string;
  club_id: number;
  name: string;
  description: string;
  avatar_url: string;
  logo_url?: string;
  member_count: number;
  online_count: number;
  owner_id: string;
  level: number;
  hierarchy_units_rounded_up: number;
  player_threshold_current: number;
  player_threshold_next: number;
  hierarchy_threshold_current: number;
  hierarchy_threshold_next: number;
  created_at: string;
}

interface TableData {
  id: string;
  name: string;
  game_variant: string;
  stakes: string;
  current_players: number;
  max_players: number;
  status: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  settings?: string;
}

interface TournamentData {
  id: string;
  name: string;
  game_type: string;
  buy_in_amount: number;
  buy_in_fee: number;
  guaranteed_prize: number | null;
  start_time: string;
  status: string;
  current_players: number;
  max_players: number;
  starting_chips: number;
}

interface WalletBalances {
  gold: number;
  diamonds: number;
}

type MainFilter = 'ALL' | 'CASH GAMES' | 'TOURNAMENTS';
type CashVariant = 'ALL' | "Hold'em" | 'Omaha';
type TournVariant = 'ALL' | 'MTT' | 'Spin-It' | 'SN';
type CashSubFilter = 'all' | 'live' | 'empty' | 'full';
type TournamentSubFilter = 'all' | 'running' | 'registering' | 'late_reg' | 'starting_soon';

export default function ClubHomePage() {
  const { clubId } = useParams<{ clubId: string }>();
  useVisibilityRefresh(() => loadClubData());
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();

  // Refs to avoid stale closures in realtime subscriptions
  const clubIdRef = useRef(clubId);

  const [club, setClub] = useState<ClubData | null>(null);
  const [tables, setTables] = useState<TableData[]>([]);
  const [tournaments, setTournaments] = useState<TournamentData[]>([]);
  const [wallet, setWallet] = useState<WalletBalances>({ gold: 0, diamonds: 0 });
  const [jackpotAmount, setJackpotAmount] = useState(0);
  const [activeMainFilter, setActiveMainFilter] = useState<MainFilter>('ALL');
  const [cashVariant, setCashVariant] = useState<CashVariant>('ALL');
  const [tournVariant, setTournVariant] = useState<TournVariant>('ALL');
  const [cashSubFilter, setCashSubFilter] = useState<CashSubFilter>('live');
  const [tournamentSubFilter, setTournamentSubFilter] = useState<TournamentSubFilter>('running');
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null);
  const [isInUnion, setIsInUnion] = useState(false);
  const [clubLevel, setClubLevel] = useState<ClubLevelInfo | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const toast = useToast();
  const hasDataRef = useRef(false);
  const loadingRef = useRef(false);
  const [wsConnected, setWsConnected] = useState(true);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  // React Router reuses the component when only the clubId param changes.
  useEffect(() => {
    setIsOwner(false);
    setUserRole('member');
    setIsInUnion(false);
    setDeletingTableId(null);
    setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
    setClubLevel(null);
    setWallet({ gold: 0, diamonds: 0 });
    setJackpotAmount(0);
    loadingRef.current = false;
    hasDataRef.current = false;
  }, [clubId]);

  // SWR: show cached club data instantly on mount
  useEffect(() => {
    if (!clubId) return;
    const cached = getClubHomeCache(clubId);
    if (cached && cached.club) {
      setClub(cached.club);
      if (cached.tables?.length) setTables(cached.tables);
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [clubId]);

  // Confirm modal state for table deletion
  const [deleteTableConfirm, setDeleteTableConfirm] = useState<{
    show: boolean;
    tableId: string | null;
    tableName: string | null;
  }>({ show: false, tableId: null, tableName: null });

  // Confirm modal state for table deletion

  useEffect(() => {
    if (clubId) {
      clubIdRef.current = clubId;
      let isMounted = true;
      loadClubData(() => isMounted);
      return () => {
        isMounted = false;
      };
    }
  }, [clubId]);

  // ── Realtime subscription: live table updates (player counts, status) ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      // Check if this club is in a union — if so, listen on union_id in addition to club_id
      let unionId: string | null = null;
      try {
        const { data: ucCheck } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (ucCheck?.union_id) {
          unionId = ucCheck.union_id;
        }
      } catch (e) {
        reportError(e, 'ClubHomePage.setupRealtime');
        /* standalone club — no union_id */
      }

      if (!isMounted) return;

      const channelKey = `club-tables-${clubId}`;
      let channel = masterBus.getOrCreateChannel(channelKey);

      const handleTableChange = (payload: any) => {
        if (!isMounted) return;
        if (payload.eventType === 'UPDATE' && payload.new) {
          setTables((prev) =>
            prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
          );
        } else if (payload.eventType === 'INSERT' && payload.new) {
          setTables((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [payload.new as any, ...prev];
          });
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setTables((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
        }
      };

      const handleTournamentChange = (payload: any) => {
        if (!isMounted) return;
        if (payload.eventType === 'UPDATE' && payload.new) {
          setTournaments((prev) =>
            prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
          );
        } else if (payload.eventType === 'INSERT' && payload.new) {
          setTournaments((prev) => {
            if (prev.some((t) => t.id === payload.new.id)) return prev;
            return [payload.new as any, ...prev];
          });
        } else if (payload.eventType === 'DELETE' && payload.old) {
          setTournaments((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
        }
      };

      // 1. Subscribe to Club Tables
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tables', filter: `club_id=eq.${resolvedId}` },
        handleTableChange
      );

      // 2. Subscribe to Club Tournaments
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournaments', filter: `club_id=eq.${resolvedId}` },
        handleTournamentChange
      );

      // 3. Dual-Channel: Subscribe to Union Tables and Tournaments if applicable
      if (unionId) {
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tables', filter: `union_id=eq.${unionId}` },
          handleTableChange
        );
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tournaments', filter: `union_id=eq.${unionId}` },
          handleTournamentChange
        );
      }

      channel
        .subscribe((status: string, err?: Error) => {
          setWsConnected(status === 'SUBSCRIBED');
          if (status === 'CHANNEL_ERROR') {
            reportError(err?.message || err, 'ClubHomePage._Tables_RT_channel_error');
          } else if (status === 'TIMED_OUT') {
            console.warn('[ClubHomePage] ⏱️ Tables RT channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[ClubHomePage] Table realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(`club-tables-${clubId}`);
    };
  }, [clubId]);

  // ── Realtime subscription: club member count updates ──
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);

  useEffect(() => {
    if (!clubId) {
      setResolvedClubId(null);
      return;
    }
    resolveClubUUID(clubId)
      .then(setResolvedClubId)
      .catch((e) => console.warn('[ClubHomePage] Failed to resolve clubId:', e));
  }, [clubId]);

  const handleMemberUpdate = useCallback(() => {
    loadClubData();
  }, []);

  useMasterBusChannel({
    channelName: clubId ? `club-members-${clubId}` : null,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: handleMemberUpdate,
    enabled: !!resolvedClubId,
  });

  // ── Bus Listeners: cross-page event reactivity (subscribeDebounced) ──
  useEffect(() => {
    let isMounted = true;
    const reload = () => {
      if (isMounted) loadClubData(() => isMounted);
    };

    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', reload, 300),
      masterBus.subscribeDebounced('CLUB_LEFT', reload, 300),
      masterBus.subscribeDebounced('TABLE_SEATED', reload, 300),
      masterBus.subscribeDebounced('TABLE_LEFT', reload, 300),
      masterBus.subscribeDebounced('BALANCE_UPDATED', reload, 300),
      masterBus.subscribeDebounced('DIAMOND_BALANCE_CHANGED', reload, 300),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', reload, 300),
      // Phase 11: Only reload for OUR club's updates (not every club in the platform)
      masterBus.subscribeDebounced(
        'CLUB_UPDATED',
        (event) => {
          if (!clubIdRef.current || event.payload?.clubId === clubIdRef.current) {
            reload();
          }
        },
        300
      ),
      masterBus.subscribeDebounced(
        'TABLE_UPDATED',
        () => {
          // Reload when any table linked to this club changes
          reload();
        },
        300
      ),
      masterBus.subscribeDebounced(
        'TOURNAMENT_UPDATED',
        () => {
          // Reload when any tournament changes — payload has tournamentId, not clubId
          reload();
        },
        300
      ),
      masterBus.subscribeDebounced(
        'CLUB_SETTINGS_UPDATED',
        (event) => {
          if (!clubIdRef.current || event.payload?.clubId === clubIdRef.current) {
            reload();
          }
        },
        300
      ),
      masterBus.subscribeDebounced(
        'TABLE_CREATED',
        (event) => {
          if (!clubIdRef.current || event.payload?.clubId === clubIdRef.current) {
            reload();
          }
        },
        300
      ),
      masterBus.subscribeDebounced(
        'TABLE_DELETED',
        (event) => {
          if (!clubIdRef.current || event.payload?.clubId === clubIdRef.current) {
            reload();
          }
        },
        300
      ),
      masterBus.subscribeDebounced('WAITLIST_PROMOTED', reload, 300),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadClubData = async (getIsMounted?: () => boolean) => {
    if (!clubId) return;
    // Request deduplication — skip if already loading
    if (loadingRef.current) return;
    loadingRef.current = true;
    // Only show loading spinner on initial load (no cached data), not background refreshes
    if (!hasDataRef.current && (!getIsMounted || getIsMounted())) setLoading(true);

    try {
      if (getIsMounted && !getIsMounted()) return;

      // Load club info — smart resolve: clubId may be UUID or integer club_id
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData, error: clubError } = await retryFetch(
        () =>
          supabase
            .from('clubs')
            .select(
              'id, club_id, name, description, avatar_url, logo_url, member_count, online_count, owner_id, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, created_at'
            )
            .eq(clubCol, clubVal)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef }
      );

      if (clubError || !clubData) {
        reportError(clubError, 'ClubHomePage.Failed_to_load_club');
        toast.error('Failed to load club details');
        if (!getIsMounted || getIsMounted()) setLoading(false);
        return;
      }

      if (getIsMounted && !getIsMounted()) return;
      setClub(clubData);

      // Use resolved UUID for all downstream FK queries
      const resolvedId = clubData.id;

      // Check if current user is owner
      const {
        data: { user: authUser },
      } = await getAuthUser();
      if (authUser) {
        if (getIsMounted && !getIsMounted()) return;
        setCurrentUserId(authUser.id);
        setIsOwner(clubData.owner_id === authUser.id);

        // ── Batch: member data + diamond wallet in parallel ──
        const [memberResult, diamondWallet] = await Promise.all([
          supabase
            .from('club_members')
            .select('chip_balance, role')
            .eq('club_id', resolvedId)
            .eq('user_id', authUser.id)
            .maybeSingle(),
          DiamondService.getBalance(authUser.id),
        ]);

        if (memberResult.data) {
          if (getIsMounted && !getIsMounted()) return;
          setWallet({
            gold: memberResult.data.chip_balance || 0,
            diamonds: diamondWallet.balance || 0,
          });
          setUserRole(memberResult.data.role || 'member');
        }
      }

      // Check if this club is inside a union
      let unionId: string | null = null;
      let unionClubIds: string[] = [resolvedId];
      try {
        const { data: ucRow, error: ucErr } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (!ucErr && ucRow) {
          if (getIsMounted && !getIsMounted()) return;
          setIsInUnion(true);
          unionId = ucRow.union_id;

          // Get ALL club IDs in this union + member count in parallel
          const [allUcResult, memberCountResult] = await Promise.all([
            supabase.from('union_clubs').select('club_id').eq('union_id', unionId),
            supabase
              .from('club_members')
              .select('user_id', { count: 'exact', head: true })
              .eq('club_id', resolvedId) // Will be updated below if union has multiple clubs
              .in('status', ['active', 'approved']),
          ]);

          if (allUcResult.data && allUcResult.data.length > 0) {
            unionClubIds = allUcResult.data.map((r) => r.club_id);

            // If union has multiple clubs, re-query with all club IDs
            if (unionClubIds.length > 1) {
              try {
                const { count: totalMembers } = await supabase
                  .from('club_members')
                  .select('user_id', { count: 'exact', head: true })
                  .in('club_id', unionClubIds)
                  .in('status', ['active', 'approved']);

                if (getIsMounted && !getIsMounted()) return;
                setClub((prev) =>
                  prev ? { ...prev, member_count: totalMembers || prev.member_count || 0 } : prev
                );
              } catch (e) {
                reportError(e, 'ClubHomePage.setClub');
                // Fall back to club-level counts
              }
            } else {
              // Single club — use the result from the parallel batch
              if (memberCountResult.count != null) {
                if (getIsMounted && !getIsMounted()) return;
                setClub((prev) =>
                  prev
                    ? { ...prev, member_count: memberCountResult.count || prev.member_count || 0 }
                    : prev
                );
              }
            }
          }
        }
      } catch (e) {
        reportError(e, 'ClubHomePage.setClub');
        // Query error — fail-open for standalone clubs
      }

      // ── Fix: Live member count for standalone clubs (not in a union) ──
      // Without this, standalone clubs display the stale clubs.member_count value
      if (!unionId) {
        try {
          const { count: liveCount } = await supabase
            .from('club_members')
            .select('user_id', { count: 'exact', head: true })
            .eq('club_id', resolvedId)
            .in('status', ['active', 'approved']);

          if (liveCount != null && liveCount > 0) {
            if (getIsMounted && !getIsMounted()) return;
            setClub((prev) => (prev ? { ...prev, member_count: liveCount } : prev));
            // Also update clubData so the level calculation below uses the live count
            clubData.member_count = liveCount;
          }
        } catch (e) {
          reportError(e, 'ClubHomePage.setClub');
          // Fall back to denormalized clubs.member_count
        }
      }

      // ── Batch: tables + tournaments + BBJ in parallel ──
      // Build table query: use union_id for union clubs, club_id for standalone
      const tableQuery = supabase
        .from('tables')
        .select(
          'id, name, game_variant, stakes, current_players, max_players, status, small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at'
        );
      if (unionId) {
        tableQuery.eq('union_id', unionId);
      } else {
        tableQuery.in('club_id', unionClubIds);
      }
      tableQuery.eq('is_deleted', false).order('created_at', { ascending: false });

      const [tableResult, clubTournamentResult, bbjResult, ...xmttResults] = await Promise.all([
        tableQuery,
        supabase
          .from('tournaments')
          .select(
            'id, name, game_type, buy_in_amount, buy_in_fee, guaranteed_prize, start_time, status, current_players, max_players, starting_chips, club_id'
          )
          .in('club_id', unionClubIds)
          .neq('status', 'COMPLETED')
          .order('start_time', { ascending: true }),
        (async () => {
          try {
            return await supabase
              .from('bbj_pools')
              .select('main_balance')
              .eq('club_id', resolvedId)
              .limit(1)
              .maybeSingle();
          } catch (e) {
            reportError(e, 'ClubHomePage.async');
            return { data: null, error: null };
          }
        })(),
        // Conditionally fetch XMTT tournaments if in a union
        ...(unionId
          ? [
              supabase
                .from('tournaments')
                .select(
                  'id, name, game_type, buy_in_amount, buy_in_fee, guaranteed_prize, start_time, status, current_players, max_players, starting_chips, club_id, union_id, is_xmtt'
                )
                .eq('union_id', unionId)
                .eq('is_xmtt', true)
                .neq('status', 'COMPLETED')
                .order('start_time', { ascending: true }),
            ]
          : []),
      ]);

      if (getIsMounted && !getIsMounted()) return;

      const tableData = tableResult.data;
      if (tableData) setTables(tableData);

      // SWR: cache club + tables for instant display on revisit
      if (clubId && clubData) {
        setClubHomeCache(clubId, { club: clubData, tables: tableData || [] });
      }
      hasDataRef.current = true;

      // Merge club tournaments + XMTT tournaments
      const allTournaments: TournamentData[] = clubTournamentResult.data
        ? [...clubTournamentResult.data]
        : [];
      if (xmttResults.length > 0 && xmttResults[0]?.data) {
        const existingIds = new Set(allTournaments.map((t) => t.id));
        for (const xmtt of xmttResults[0].data) {
          if (!existingIds.has(xmtt.id)) {
            allTournaments.push(xmtt);
          }
        }
      }
      setTournaments(allTournaments);

      // BBJ jackpot
      if (bbjResult?.data && !(bbjResult as any).error) {
        setJackpotAmount((bbjResult.data as any)?.main_balance || 0);
      }

      // Calculate Club Level from live metrics
      const activeTables = tableData
        ? tableData.filter((t: any) => t.status === 'running' || t.current_players > 0).length
        : 0;

      // Auto-recompute club level if stuck at default (1 or null)
      // The RPC updates clubs.level in-place and returns VOID,
      // so we re-read the level column after calling it.
      // Session dedup: only fire the RPC once per session per club to avoid waste
      let effectiveLevel = clubData.level || 1;
      const levelRecomputeKey = `level_recomputed_${resolvedId}`;
      if (effectiveLevel <= 1 && !sessionStorage.getItem(levelRecomputeKey)) {
        try {
          // Trigger server-side recompute (updates clubs.level in DB)
          const { error: rpcErr } = await supabase.rpc('recompute_club_levels', {
            p_club_id: resolvedId,
          });
          if (!rpcErr) {
            sessionStorage.setItem(levelRecomputeKey, '1');
            // Re-read the updated level from DB
            const { data: refreshedClub } = await supabase
              .from('clubs')
              .select(
                'level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
              )
              .eq('id', resolvedId)
              .maybeSingle();
            if (refreshedClub && refreshedClub.level > 1) {
              effectiveLevel = refreshedClub.level;
              // Also update threshold values for accurate progress bar
              clubData.hierarchy_units_rounded_up =
                refreshedClub.hierarchy_units_rounded_up ?? clubData.hierarchy_units_rounded_up;
              clubData.player_threshold_current =
                refreshedClub.player_threshold_current ?? clubData.player_threshold_current;
              clubData.player_threshold_next =
                refreshedClub.player_threshold_next ?? clubData.player_threshold_next;
              clubData.hierarchy_threshold_current =
                refreshedClub.hierarchy_threshold_current ?? clubData.hierarchy_threshold_current;
              clubData.hierarchy_threshold_next =
                refreshedClub.hierarchy_threshold_next ?? clubData.hierarchy_threshold_next;
            }
          }
        } catch (e) {
          reportError(e, 'ClubHomePage');
          // RPC not available — use default level
        }
      }

      const levelInfo = getClubLevel({
        level: effectiveLevel,
        playerCount: clubData.member_count || 0,
        hierarchyUnits: clubData.hierarchy_units_rounded_up || 0,
        playerThresholdCurrent: clubData.player_threshold_current || 0,
        playerThresholdNext: clubData.player_threshold_next || 0,
        hierarchyThresholdCurrent: clubData.hierarchy_threshold_current || 0,
        hierarchyThresholdNext: clubData.hierarchy_threshold_next || 0,
      });
      if (getIsMounted && !getIsMounted()) return;

      // Level-up celebration: detect when level increased vs previous render
      setClubLevel((prev) => {
        if (prev && prev.level > 0 && levelInfo.level > prev.level) {
          // Level went up — celebrate!
          toast.success(
            `🎉 Level Up! Your club reached Lv.${levelInfo.level} — ${levelInfo.tierLabel}!`
          );
          haptic.success();
        }
        return levelInfo;
      });
    } catch (error: any) {
      reportError(error, 'ClubHomePage.Error_loading_club_data');
      toast.error(error.message || 'Failed to load club data');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  // Filter tables
  const showTournaments = activeMainFilter === 'TOURNAMENTS';
  
  const filteredTables = useMemo(
    () =>
      tables.filter((table) => {
        if (activeMainFilter === 'TOURNAMENTS') return false;

        // Game variant filter
        let passesGameFilter = true;
        if (cashVariant === "Hold'em") {
          passesGameFilter =
            table.game_variant?.toLowerCase().includes('nlh') ||
            table.game_variant?.toLowerCase().includes('holdem');
        } else if (cashVariant === 'Omaha') {
          passesGameFilter =
            table.game_variant?.toLowerCase().includes('plo') ||
            table.game_variant?.toLowerCase().includes('omaha');
        }
        if (!passesGameFilter) return false;

        // Cash game status filter (skip if ALL tab is active)
        if (activeMainFilter === 'ALL') return true;
        
        if (cashSubFilter === 'live') return table.current_players > 0;
        if (cashSubFilter === 'empty') return table.current_players === 0;
        if (cashSubFilter === 'full') return table.current_players >= table.max_players;
        return true; 
      }),
    [tables, activeMainFilter, cashVariant, cashSubFilter]
  );

  // Filter tournaments
  const filteredTournaments = useMemo(
    () =>
      tournaments.filter((t) => {
        if (activeMainFilter === 'CASH GAMES') return false;

        const isSpin = t.name.toLowerCase().includes('spin');
        const isSNG = !isSpin && (t.name.toLowerCase().includes('sng') || t.max_players <= 10);
        const isMTT = !isSpin && !isSNG;

        // Tournament variant filter
        let passesGameFilter = true;
        if (tournVariant === 'MTT') passesGameFilter = isMTT;
        else if (tournVariant === 'SN') passesGameFilter = isSNG;
        else if (tournVariant === 'Spin-It') passesGameFilter = isSpin;
        
        if (!passesGameFilter) return false;

        // Tournament status filter (skip if ALL tab is active)
        if (activeMainFilter === 'ALL') return true;
        if (tournamentSubFilter === 'all') return true;
        const status = (t.status || '').toUpperCase();
        const startTime = new Date(t.start_time).getTime();
        const now = Date.now();
        const minutesUntilStart = (startTime - now) / 60000;

        if (tournamentSubFilter === 'running')
          return status === 'RUNNING' || status === 'IN_PROGRESS';
        if (tournamentSubFilter === 'registering')
          return status === 'REGISTERING' || status === 'OPEN' || status === 'PENDING';
        if (tournamentSubFilter === 'late_reg')
          return status === 'LATE_REG' || status === 'LATE_REGISTRATION';
        if (tournamentSubFilter === 'starting_soon')
          return (
            (status === 'REGISTERING' || status === 'OPEN' || status === 'PENDING') &&
            minutesUntilStart > 0 &&
            minutesUntilStart <= 60
          );
        return true;
      }),
    [tournaments, activeMainFilter, tournVariant, tournamentSubFilter]
  );

  const formatNumber = (num: number) => {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatJackpot = (num: number) => {
    if (num === 0) return '—';
    return num.toLocaleString();
  };

  if (loading) {
    return (
      <div className="club-home loading" style={{ padding: '1rem' }}>
        {/* Skeleton header */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: '60%',
                height: 20,
                borderRadius: 6,
                background: 'rgba(255,255,255,0.08)',
                marginBottom: 8,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
            <div
              style={{
                width: '40%',
                height: 14,
                borderRadius: 4,
                background: 'rgba(255,255,255,0.06)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          </div>
        </div>
        {/* Skeleton stat bar */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem' }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: 60,
                borderRadius: 10,
                background: 'rgba(255,255,255,0.05)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
        {/* Skeleton table cards */}
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: 80,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              marginBottom: 12,
              animation: 'pulse 1.5s ease-in-out infinite',
            }}
          />
        ))}
      </div>
    );
  }

  if (!club) {
    return (
      <div className="club-home error">
        <h2>Club Not Found</h2>
        <p style={{ color: '#888', fontSize: '0.9rem', margin: '0 0 1rem' }}>
          The club may have been moved or deleted.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            className="btn btn-primary"
            onClick={() => {
              loadingRef.current = false;
              loadClubData();
            }}
            style={{
              background: '#1877f2',
              border: 'none',
              color: 'white',
              padding: '0.6rem 1.2rem',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
          <Link
            to="/clubs"
            className="btn btn-primary"
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'white',
              padding: '0.6rem 1.2rem',
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            Back to Clubs
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="club-home">
      <GlobalUXIndicators wsConnected={wsConnected} />
      {/* Animations moved to ClubHomePage.css */}
      {/* ═══════════════════════════════════════════════════════════════════
                QUICK ACTION ICONS ROW
            ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__actions-row">
        <button
          className="club-home__back-btn"
          onClick={() => {
            haptic.light();
            navigate('/clubs');
          }}
        >
          ‹‹
        </button>
        <div className="club-home__quick-icons">
          <button
            className="quick-icon"
            title="Events"
            onClick={() => {
              haptic.selection();
              navigate(`/clubs/${clubId}/detail`);
            }}
          >
            <span className="icon-events"></span>
          </button>
          <button
            className="quick-icon"
            title="Leaderboard"
            onClick={() => {
              haptic.selection();
              navigate('/leaderboard');
            }}
          >
            <span className="icon-leaderboard"></span>
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
                CLUB CARD + WALLET DISPLAY (side-by-side layout)
            ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__club-section">
        <div className="club-home__club-card">
          <div className="club-card__avatar">
            {(club.logo_url || club.avatar_url) ? (
              <img src={club.logo_url || club.avatar_url} alt={club.name} loading="lazy" />
            ) : club.club_id === SHARK_CLUB_ID ? (
              <img src={SHARK_CLUB_FALLBACK_LOGO} alt="Shark Club" loading="lazy" />
            ) : (
              <span className="club-card__avatar-placeholder">&#9824;</span>
            )}
          </div>
          <div className="club-card__info">
            <h2 className="club-card__name">{club.name}</h2>
            <div className="club-card__meta">
              <span className="club-card__id">ID: {club.club_id}</span>
              <span className="club-card__members">
                {(club.member_count || 0).toLocaleString()}
                {club.online_count > 0 && (
                  <span className="club-card__online">
                    {' '}
                    / {club.online_count.toLocaleString()} online
                  </span>
                )}
              </span>
              <button
                className="club-card__share"
                title="Share"
                onClick={async () => {
                  haptic.medium();
                  const shareUrl = `${window.location.origin}/clubs/${clubId}`;
                  try {
                    if (navigator.share) {
                      await navigator.share({
                        title: club.name,
                        text: `Join ${club.name} on Smarter Poker!`,
                        url: shareUrl,
                      });
                    } else {
                      await navigator.clipboard.writeText(shareUrl);
                      toast.success('Club link copied!');
                    }
                  } catch (e) {
                    reportError(e, 'ClubHomePage.async');
                    /* user cancelled share */
                  }
                }}
              >
                <span className="icon-link"></span>
                </button>
              </div>
            </div>
          </div>

        {/* ── Wallet — upper-right, always rendered ── */}
        {currentUserId && resolvedClubId && (
          <div className="club-home__wallet-compact">
            <DynamicWallet
              userId={currentUserId}
              clubId={resolvedClubId}
              variant={isInUnion && isOwner ? 'union' : userRole === 'owner' ? 'owner' : 'player'}
              onBuyDiamonds={() => {
                haptic.medium();
                navigate(`/clubs/${clubId}/detail`);
              }}
              onMintChips={() => {
                haptic.medium();
                navigate(`/clubs/${clubId}/cashier`);
              }}
              onOpenBBJ={() => {
                haptic.medium();
                navigate(`/clubs/${clubId}/bbj`);
              }}
            />
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
                CLUB INTRODUCTION
            ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__intro">
        <p>{club.description || 'Enter the club introduction...(5000 characters limit).'}</p>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
                GAME TYPE FILTERS
            ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__filters">
        <button className="filter-search" onClick={() => haptic.light()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="M21 21l-4.3-4.3"></path>
          </svg>
        </button>
        {(['ALL', 'CASH GAMES', 'TOURNAMENTS'] as MainFilter[]).map((filter) => (
          <button
            key={filter}
            className={`filter-tab ${activeMainFilter === filter ? 'active' : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveMainFilter(filter);
            }}
          >
            {filter}
          </button>
        ))}
        <button className="filter-more" onClick={() => haptic.light()}>
          ▼
        </button>
      </div>

      {/* SUB-FILTERS: Variants */}
      {activeMainFilter !== 'ALL' && (
        <div className="club-home__sub-filters" style={{ marginTop: '0px', marginBottom: '8px' }}>
          {activeMainFilter === 'CASH GAMES' ? (
            <>
              {(['ALL', "Hold'em", 'Omaha'] as CashVariant[]).map((sf) => (
                <button
                  key={sf}
                  className={`sub-filter-tab ${cashVariant === sf ? 'active' : ''}`}
                  onClick={() => {
                    haptic.selection();
                    setCashVariant(sf);
                  }}
                >
                  {sf}
                </button>
              ))}
            </>
          ) : (
            <>
              {(['ALL', 'MTT', 'Spin-It', 'SN'] as TournVariant[]).map((sf) => (
                <button
                  key={sf}
                  className={`sub-filter-tab ${tournVariant === sf ? 'active' : ''}`}
                  onClick={() => {
                    haptic.selection();
                    setTournVariant(sf);
                  }}
                >
                  {sf}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* SUB-FILTERS: Status */}
      {activeMainFilter !== 'ALL' && (
        <div className="club-home__sub-filters" style={{ marginTop: '0px' }}>
          {activeMainFilter === 'CASH GAMES' ? (
            // Cash game status sub-filters
            <>
              {(
                [
                  { key: 'all', label: 'All Tables' },
                  { key: 'live', label: 'Live Games' },
                  { key: 'empty', label: 'Empty' },
                  { key: 'full', label: 'Full' },
                ] as { key: CashSubFilter; label: string }[]
              ).map((sf) => (
                <button
                  key={sf.key}
                  className={`sub-filter-tab ${cashSubFilter === sf.key ? 'active' : ''}`}
                  onClick={() => {
                    haptic.selection();
                    setCashSubFilter(sf.key);
                  }}
                >
                  {sf.label}
                </button>
              ))}
            </>
          ) : (
            // Tournament status sub-filters
            <>
              {(
                [
                  { key: 'all', label: 'All' },
                  { key: 'running', label: 'Running' },
                  { key: 'registering', label: 'Registering' },
                  { key: 'late_reg', label: 'Late Reg' },
                  { key: 'starting_soon', label: 'Starting Soon' },
                ] as { key: TournamentSubFilter; label: string }[]
              ).map((sf) => (
                <button
                  key={sf.key}
                  className={`sub-filter-tab ${tournamentSubFilter === sf.key ? 'active' : ''}`}
                  onClick={() => {
                    haptic.selection();
                    setTournamentSubFilter(sf.key);
                  }}
                >
                  {sf.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
                GAMES GRID - Tables & Create New Table Button
            ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__games">
        {/* CREATE NEW TABLE - Only visible to owners/admins of STANDALONE clubs (not in a union) */}
        {(isOwner || userRole === 'admin') && !isInUnion && (
          <Link to={`/clubs/${clubId}/create-table`} className="create-table-card">
            <div className="create-table-card__table">
              <div className="new-badge">NEW</div>
              <div className="plus-icon">+</div>
            </div>
            <span className="create-table-card__label">Create new table</span>
          </Link>
        )}

        {/* EXISTING TABLES — Dynamic PokerBros-style cards */}
        {filteredTables.map((table, idx) => (
          <div
            key={table.id}
            style={{
              animation: `slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${idx * 0.08}s both`,
            }}
          >
            <CashGameCard
              table={table}
              isAdmin={isOwner || userRole === 'admin'}
              onDelete={(id) => {
                setDeleteTableConfirm({ show: true, tableId: id, tableName: table.name });
              }}
            />
          </div>
        ))}

        {/* TOURNAMENT CARDS — Dynamic PokerBros-style cards */}
        {filteredTournaments.map((tournament, idx) => {
          const tName = (tournament.name || '').toLowerCase();
          const isSNG = tName.includes('sng') || tournament.max_players <= 10;
          const isSpin = tName.includes('spin');
          const staggerIdx = filteredTables.length + idx;

          return (
            <div
              key={tournament.id}
              style={{
                animation: `slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) ${staggerIdx * 0.08}s both`,
              }}
            >
              {isSpin && <SpinCard tournament={tournament} />}
              {isSNG && !isSpin && <SNGCard tournament={tournament} />}
              {!isSpin && !isSNG && <TournamentCard tournament={tournament} />}
            </div>
          );
        })}

        {/* EMPTY STATE */}
        {filteredTables.length === 0 && filteredTournaments.length === 0 && !isOwner && (
          <div className="empty-tables">
            <p>{showTournaments ? 'No tournaments available' : 'No tables available'}</p>
            <p className="empty-hint">
              Check back later or wait for the owner to create{' '}
              {showTournaments ? 'tournaments' : 'tables'}.
            </p>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
                BACKGROUND IMAGE (Premium Bar Scene)
            ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__background"></div>

      {/* ═══════════════════════════════════════════════════════════════════
                BOTTOM NAVIGATION BAR
            ═══════════════════════════════════════════════════════════════════ */}
      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} clubName={club?.name} />}

      {/* Confirm Modal for Table Deletion */}
      <ConfirmModal
        isOpen={deleteTableConfirm.show}
        title="Delete Table"
        message={`Delete table "${deleteTableConfirm.tableName || ''}"? This cannot be undone.`}
        variant="danger"
        confirmText="Delete"
        onConfirm={async () => {
          if (deleteTableConfirm.tableId) {
            const id = deleteTableConfirm.tableId;
            setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
            setDeletingTableId(id);
            try {
              // Defense-in-depth: scope delete to this club's tables
              const resolvedClubId = club?.id;
              let query = supabase
                .from('tables')
                .update({ status: 'deleted', is_active: false, is_deleted: true })
                .eq('id', id);
              if (resolvedClubId) query = query.eq('club_id', resolvedClubId);
              const { error } = await query;
              if (error) throw error;
              setTables((prev) => prev.filter((t) => t.id !== id));
              toast.success('Table deleted');
            } catch (err) {
              reportError(err, 'ClubHomePage.Failed_to_delete_table');
              toast.error('Failed to delete table');
            } finally {
              setDeletingTableId(null);
            }
          }
        }}
        onCancel={() => setDeleteTableConfirm({ show: false, tableId: null, tableName: null })}
      />
    </div>
  );
}
