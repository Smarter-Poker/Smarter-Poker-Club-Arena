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

import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useWalletStore } from '../stores/useWalletStore';
import haptic from '../services/HapticService';
import ClubBottomNav from '../components/club/ClubBottomNav';
import {
  CashGameCard,
  TournamentCard,
  SNGCard,
  SpinCard,
} from '../components/lobby/DynamicGameCard';
import { getClubLevel, ClubLevelInfo } from '../utils/clubLevels';
import { useToast } from '../components/common/Toast';
import ConfirmModal from '../components/common/ConfirmModal';
import { retryFetch } from '../utils/retryFetch';
import './ClubHomePage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubIdFilter } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';

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
  member_count: number;
  online_count: number;
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

interface UserProfileData {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  player_number: number;
}

type GameFilter = 'ALL' | "Hold'em" | 'Omaha' | 'Mixed' | 'MTT' | 'Spin-It' | 'SN';
type CashSubFilter = 'all' | 'live' | 'empty' | 'full';
type TournamentSubFilter = 'all' | 'running' | 'registering' | 'late_reg' | 'starting_soon';

// Premium number animation hook
function useCountAnimation(target: number, duration: number = 1000) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let startTime: number;
    let animationFrame: number;
    const animate = (time: number) => {
      if (!startTime) startTime = time;
      const progress = Math.min((time - startTime) / duration, 1);
      setDisplay(Math.floor(target * progress));
      if (progress < 1) animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [target, duration]);
  return display;
}

export default function ClubHomePage() {
  const { clubId } = useParams<{ clubId: string }>();
  useVisibilityRefresh(() => loadClubData());
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const { diamonds } = useWalletStore();
  const isMountedRef = useIsMounted();

  // Refs to avoid stale closures in realtime subscriptions
  const clubIdRef = useRef(clubId);

  const [club, setClub] = useState<ClubData | null>(null);
  const [tables, setTables] = useState<TableData[]>([]);
  const [tournaments, setTournaments] = useState<TournamentData[]>([]);
  const [wallet, setWallet] = useState<WalletBalances>({ gold: 0, diamonds: 0 });
  const [jackpotAmount, setJackpotAmount] = useState(0);
  const [activeFilter, setActiveFilter] = useState<GameFilter>('ALL');
  const [cashSubFilter, setCashSubFilter] = useState<CashSubFilter>('live');
  const [tournamentSubFilter, setTournamentSubFilter] = useState<TournamentSubFilter>('running');
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null);
  const [isInUnion, setIsInUnion] = useState(false);
  const [clubLevel, setClubLevel] = useState<ClubLevelInfo | null>(null);
  const toast = useToast();
  const hasDataRef = useRef(false);

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

  // User profile data
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [playerNumber, setPlayerNumber] = useState<string>('0000000');

  const filters: GameFilter[] = ['ALL', "Hold'em", 'Omaha', 'Mixed', 'MTT', 'Spin-It', 'SN'];

  // Premium number animations for stats
  const animatedMemberCount = useCountAnimation(club?.member_count || 0, 800);
  const animatedTableCount = useCountAnimation(
    club ? tables.filter((t) => t.status === 'running').length : 0,
    800
  );

  // Load user profile on mount
  useEffect(() => {
    let isMounted = true;
    loadUserProfile(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, []);

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

    const channelKey = `club-tables-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          if (payload.eventType === 'UPDATE' && payload.new) {
            setTables((prev) =>
              prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
            );
          } else if (payload.eventType === 'INSERT' && payload.new) {
            setTables((prev) => [payload.new as any, ...prev]);
          } else if (payload.eventType === 'DELETE' && payload.old) {
            setTables((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          if (payload.eventType === 'UPDATE' && payload.new) {
            setTournaments((prev) =>
              prev.map((t) => (t.id === payload.new.id ? { ...t, ...payload.new } : t))
            );
          } else if (payload.eventType === 'INSERT' && payload.new) {
            setTournaments((prev) => [payload.new as any, ...prev]);
          } else if (payload.eventType === 'DELETE' && payload.old) {
            setTournaments((prev) => prev.filter((t) => t.id !== (payload.old as any).id));
          }
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // ── Realtime subscription: club member count updates ──
  useEffect(() => {
    if (!clubId) return;

    const memberChannelKey = `club-members-${clubId}`;
    const memberChannel = masterBus.getOrCreateChannel(memberChannelKey);
    memberChannel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'club_members',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'DELETE') {
            loadClubData();
          }
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(memberChannelKey);
    };
  }, [clubId]);

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
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadUserProfile = async (getIsMounted?: () => boolean) => {
    try {
      const {
        data: { user: authUser },
      } = await supabase.auth.getUser();
      if (!authUser) return;

      const { data: profileData } = await retryFetch(
        () =>
          supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url, player_number')
            .eq('id', authUser.id)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef }
      );

      if (getIsMounted && !getIsMounted()) return;
      if (profileData) {
        setUserProfile(profileData as UserProfileData);
        const pNum =
          (profileData as any).player_number ||
          Math.abs(
            [...profileData.id].reduce((h, c) => (h << 5) - h + c.charCodeAt(0), 0) % 9999999
          ) + 1;
        setPlayerNumber(pNum.toString());
      }
    } catch (err: any) {
      console.error('[ClubHomePage] loadUserProfile error:', err);
      // Non-critical — profile data is supplementary; toast as warning
    }
  };

  const loadClubData = async (getIsMounted?: () => boolean) => {
    if (!clubId) return;
    if (!getIsMounted || getIsMounted()) setLoading(true);

    try {
      // In iframe context, wait for auth to be set by the parent via postMessage.
      const inIframe = window.parent !== window;
      if (inIframe) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (session?.user) break;
          if (getIsMounted && !getIsMounted()) return;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (getIsMounted && !getIsMounted()) return;
      }

      // Load club info — smart resolve: clubId may be UUID or integer club_id
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData, error: clubError } = await retryFetch(
        () =>
          supabase
            .from('clubs')
            .select(
              'id, club_id, name, description, avatar_url, member_count, online_count, owner_id, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next, created_at'
            )
            .eq(clubCol, clubVal)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef }
      );

      if (clubError || !clubData) {
        console.error('Failed to load club:', clubError);
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
      } = await supabase.auth.getUser();
      if (authUser) {
        if (getIsMounted && !getIsMounted()) return;
        setIsOwner(clubData.owner_id === authUser.id);

        // ── Batch: member data + diamond wallet in parallel ──
        const [memberResult, diamondResult] = await Promise.all([
          supabase
            .from('club_members')
            .select('chip_balance, role')
            .eq('club_id', resolvedId)
            .eq('user_id', authUser.id)
            .maybeSingle(),
          supabase
            .from('diamond_wallets')
            .select('balance')
            .eq('user_id', authUser.id)
            .maybeSingle(),
        ]);

        if (memberResult.data) {
          if (getIsMounted && !getIsMounted()) return;
          setWallet({
            gold: memberResult.data.chip_balance || 0,
            diamonds: diamondResult.data?.balance || 0,
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
              .select('id', { count: 'exact', head: true })
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
                  .select('id', { count: 'exact', head: true })
                  .in('club_id', unionClubIds)
                  .in('status', ['active', 'approved']);

                if (getIsMounted && !getIsMounted()) return;
                setClub((prev) =>
                  prev ? { ...prev, member_count: totalMembers || prev.member_count || 0 } : prev
                );
              } catch {
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
      } catch {
        // Query error — fail-open for standalone clubs
      }

      // ── Batch: tables + tournaments + BBJ in parallel ──
      const [tableResult, clubTournamentResult, bbjResult, ...xmttResults] = await Promise.all([
        supabase
          .from('tables')
          .select(
            'id, name, game_variant, stakes, current_players, max_players, status, small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at'
          )
          .in('club_id', unionClubIds)
          .eq('is_deleted', false)
          .order('created_at', { ascending: false }),
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
            return await supabase.from('bbj_pools').select('main_balance').limit(1).maybeSingle();
          } catch {
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

      const levelInfo = getClubLevel({
        level: clubData.level || 1,
        playerCount: clubData.member_count || 0,
        hierarchyUnits: clubData.hierarchy_units_rounded_up || 0,
        playerThresholdCurrent: clubData.player_threshold_current || 0,
        playerThresholdNext: clubData.player_threshold_next || 0,
        hierarchyThresholdCurrent: clubData.hierarchy_threshold_current || 0,
        hierarchyThresholdNext: clubData.hierarchy_threshold_next || 0,
      });
      if (getIsMounted && !getIsMounted()) return;
      setClubLevel(levelInfo);
    } catch (error: any) {
      console.error('Error loading club data:', error);
      toast.error(error.message || 'Failed to load club data');
    } finally {
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  // Filter tables (hide tables when MTT/Spin-It/SN tab is active)
  const showTournaments =
    activeFilter === 'MTT' || activeFilter === 'SN' || activeFilter === 'Spin-It';
  const filteredTables = tables.filter((table) => {
    if (showTournaments) return false; // Hide tables when viewing tournaments

    // Game type filter
    let passesGameFilter = true;
    if (activeFilter === "Hold'em")
      passesGameFilter =
        table.game_variant?.toLowerCase().includes('nlh') ||
        table.game_variant?.toLowerCase().includes('holdem');
    else if (activeFilter === 'Omaha')
      passesGameFilter =
        table.game_variant?.toLowerCase().includes('plo') ||
        table.game_variant?.toLowerCase().includes('omaha');
    else if (activeFilter === 'Mixed') {
      const v = table.game_variant?.toLowerCase() || '';
      passesGameFilter =
        v.includes('pineapple') ||
        v.includes('short_deck') ||
        v.includes('ofc') ||
        v.includes('mixed') ||
        v.includes('double');
    }
    if (!passesGameFilter) return false;

    // Cash game sub-filter
    if (cashSubFilter === 'live') return table.current_players > 0;
    if (cashSubFilter === 'empty') return table.current_players === 0;
    if (cashSubFilter === 'full') return table.current_players >= table.max_players;
    return true; // 'all'
  });

  // Filter tournaments for MTT/SN/Spin-It tabs
  const filteredTournaments = tournaments.filter((t) => {
    const isSpin = t.name.toLowerCase().includes('spin');
    const isSNG = !isSpin && (t.name.toLowerCase().includes('sng') || t.max_players <= 10);
    const isMTT = !isSpin && !isSNG;

    // Game type filter
    let passesGameFilter = false;
    if (activeFilter === 'MTT') passesGameFilter = isMTT;
    else if (activeFilter === 'SN') passesGameFilter = isSNG;
    else if (activeFilter === 'Spin-It') passesGameFilter = isSpin;
    else if (activeFilter === 'ALL') passesGameFilter = true;
    if (!passesGameFilter) return false;

    // Tournament sub-filter
    if (tournamentSubFilter === 'all') return true;
    const status = (t.status || '').toUpperCase();
    const startTime = new Date(t.start_time).getTime();
    const now = Date.now();
    const minutesUntilStart = (startTime - now) / 60000;

    if (tournamentSubFilter === 'running') return status === 'RUNNING' || status === 'IN_PROGRESS';
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
  });

  const formatNumber = (num: number) => {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatTournamentTime = (isoTime: string) => {
    const d = new Date(isoTime);
    const now = new Date();
    const diff = d.getTime() - now.getTime();
    if (diff < 0) return 'LIVE';
    if (diff < 3600000) return `${Math.ceil(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.ceil(diff / 3600000)}h`;
    return d.toLocaleDateString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
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
        <Link to="/clubs" className="btn btn-primary">
          Back to Clubs
        </Link>
      </div>
    );
  }

  return (
    <div className="club-home">
      <style>{`
                @keyframes slideInUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes slideInLeft { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: translateX(0); } }
                .club-home__stats-animated { animation: slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
                .club-home__games-item-animated { animation: slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; opacity: 0; }
                @keyframes shimmer { 0% { background-position: -1000px 0; } 100% { background-position: 1000px 0; } }
                .club-home__skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.1) 25%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.1) 75%, rgba(255,255,255,0.1)); background-size: 1000px 100%; animation: shimmer 2s infinite; }
            `}</style>
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
          <button className="quick-icon" title="Events" onClick={() => haptic.selection()}>
            <span className="icon-events"></span>
          </button>
          <button className="quick-icon" title="Leaderboard" onClick={() => haptic.selection()}>
            <span className="icon-leaderboard"></span>
          </button>
        </div>
        <div
          className="club-home__bbj"
          style={{ animation: `slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s both` }}
        >
          <div className="bbj-label">
            BAD BEAT
            <br />
            JACKPOT
          </div>
          <div className="bbj-amount">{formatJackpot(jackpotAmount)}</div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
                CLUB CARD + WALLET DISPLAY
            ═══════════════════════════════════════════════════════════════════ */}
      <div className="club-home__club-section">
        <div className="club-home__club-card">
          <div className="club-card__avatar">
            {club.avatar_url ? (
              <img src={club.avatar_url} alt={club.name} loading="lazy" />
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
              <button className="club-card__share" title="Share" onClick={() => haptic.medium()}>
                <span className="icon-link"></span>
              </button>
            </div>
            {clubLevel && (
              <div className="club-card__level">
                <div className="club-level-badge" style={{ background: clubLevel.gradient }}>
                  <span className="club-level-badge__number">Lv.{clubLevel.level}</span>
                  <span className="club-level-badge__tier">{clubLevel.tierLabel}</span>
                </div>
                <div className="club-level-progress">
                  <div className="club-level-progress__bar">
                    <div
                      className="club-level-progress__fill"
                      style={{
                        width: `${clubLevel.progressPercent}%`,
                        background: clubLevel.gradient,
                      }}
                    />
                  </div>
                  <span className="club-level-progress__text">{clubLevel.progressPercent}%</span>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="club-home__wallet">
          <div className="wallet-row gold">
            <span className="wallet-icon gold-icon"></span>
            <span className="wallet-amount">{formatNumber(wallet.gold)}</span>
            <button className="wallet-add-btn" onClick={() => haptic.medium()}>
              +
            </button>
          </div>
          <div className="wallet-row diamond">
            <span className="wallet-icon diamond-icon"></span>
            <span className="wallet-amount">{formatNumber(wallet.diamonds)}</span>
            <button className="wallet-add-btn" onClick={() => haptic.medium()}>+</button>
          </div>
        </div>
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
        {filters.map((filter) => (
          <button
            key={filter}
            className={`filter-tab ${activeFilter === filter ? 'active' : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveFilter(filter);
              // Reset sub-filters when switching game type (default to active games)
              setCashSubFilter('live');
              setTournamentSubFilter('running');
            }}
          >
            {filter}
          </button>
        ))}
        <button className="filter-more" onClick={() => haptic.light()}>
          ▼
        </button>
      </div>

      {/* SUB-FILTERS: Cash Game status or Tournament status */}
      <div className="club-home__sub-filters">
        {!showTournaments ? (
          // Cash game sub-filters
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
          // Tournament sub-filters
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
          const isSNG =
            tournament.name.toLowerCase().includes('sng') || tournament.max_players <= 10;
          const isSpin = tournament.name.toLowerCase().includes('spin');
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
              const { error } = await supabase
                .from('tables')
                .update({ status: 'deleted', is_active: false, is_deleted: true })
                .eq('id', id);
              if (error) throw error;
              setTables((prev) => prev.filter((t) => t.id !== id));
              toast.success('Table deleted');
            } catch (err) {
              console.error('Failed to delete table:', err);
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
