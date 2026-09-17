import type { TournamentEntryWindowRow } from '../../utils/tournamentEntryWindow';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LOBBY PAGE — Browse & Register for Tournaments
 * ═══════════════════════════════════════════════════════════════════════════════
 * Central hub for discovering and joining tournaments across all clubs
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { readClubContextParam } from '../../utils/clubScopedPath';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import {
  tournamentService,
  tournamentUnregisterSuccessText,
} from '../../services/TournamentService';
import TournamentLobbyCard from '../../components/tournament/TournamentLobbyCard';
import {
  describeStoredMttStructure,
  type MttStructureDescription,
} from '../../../server/src/tournament/mttStructureDescription';
import { CardSkeleton } from '../../components/skeletons/CardSkeleton';
import { useToast } from '../../components/common/Toast';

import { resolveClubUUID } from '../../utils/clubIdResolver';
import styles from './TournamentLobbyPage.module.css';

import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
// Whole-number tournament money (Dan 2026-08-20).
import { totalBuyIn } from '../../utils/buyIn';
import { relayTournamentEvent } from '../../services/tournamentEventBridge';
import { useTournamentRegistration } from '../../hooks/useTournamentRegistration';
import CasinoSurfaceHeader from '../../components/rewards/RewardsSurfaceHeader';

type TournamentStatus = 'all' | 'upcoming' | 'REGISTERING' | 'RUNNING' | 'COMPLETED';
type TournamentTypeFilter = 'all' | 'mtt' | 'sng' | 'spin' | 'bounty' | 'pko' | 'mystery';

interface Tournament extends TournamentEntryWindowRow {
  id: string;
  name: string;
  clubId: string;
  clubName: string;
  buyIn: number;
  /* The two halves behind `buyIn`, kept so the Sign Up card can print the
     "20 (18 + 2)" split the rest of the app uses. `buyIn` alone is the rounded
     total and cannot be un-summed (2026-08-25). */
  buyInPrize: number;
  buyInFee: number;
  prizePool: number;
  guaranteedPrize: number;
  startTime: string;
  status: 'ANNOUNCED' | 'REGISTERING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
  currentPlayers: number;
  maxPlayers: number;
  startingChips: number;
  structureFacts: MttStructureDescription;
  isRegistered: boolean;
  gameType: string;
  lateRegMins: number;
  isRebuy: boolean;
  variant: string;
  tournamentType: string;
  isBounty: boolean;
  isPko: boolean;
  isMysteryBounty: boolean;
  bountyAmount: number;
  isMultiDay: boolean;
  isPinned: boolean;
  // PokerBros parity (2026-08-22)
  isNew: boolean;
  isVipOnly: boolean;
  isAllInOrFold: boolean;
}

export default function TournamentLobbyPage() {
  const { register: registerMtt, isRegistering: isRegisteringMtt } = useTournamentRegistration();

  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const { user } = useAuthUser();
  const toast = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TournamentStatus>('upcoming');
  const [searchParams] = useSearchParams();
  /* The global `/tournaments` route used to mount with no club at all, so
     the hamburger's Tournaments link from inside a club showed the arena-wide
     public list rather than the club's schedule. The nav stamps `?club=` on
     that link now; honour it as the club when the path has none, so the
     scoping rules below (union games + this club's own private ones) apply
     to the club the player is actually in. */
  const clubId = routeClubId || readClubContextParam(searchParams) || undefined;
  const initialType = (searchParams.get('type') as TournamentTypeFilter) || 'all';
  const [typeFilter, setTypeFilter] = useState<TournamentTypeFilter>(initialType);

  useEffect(() => {
    const currentType = (searchParams.get('type') as TournamentTypeFilter) || 'all';
    setTypeFilter(currentType);
  }, [searchParams]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isInUnion, setIsInUnion] = useState(false);

  const isMounted = useIsMounted();

  // Check if club is in a union (clubs in unions cannot create tournaments)
  useEffect(() => {
    if (!clubId) return;
    (async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (isMounted.current && data) setIsInUnion(true);
      } catch (e) {
        reportError(e, 'TournamentLobbyPage.async');
        /* fail-open */
      }
    })();
  }, [clubId]);

  // Ref to avoid stale closure in subscription callback
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;

  const loadTournamentsRef = useRef<() => void>(() => {});
  const tournamentsRef = useRef<Tournament[]>([]);
  const channelRefsRef = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    tournamentsRef.current = tournaments;
  }, [tournaments]);

  useEffect(() => {
    loadTournaments();
  }, [clubId, statusFilter]);

  // 2026-08-24: a useMasterBusChannel({ table: 'tournaments', filter: null })
  // used to sit here and NEVER SUBSCRIBED - the hook early-returns on a null
  // filter (useMasterBusChannel.ts:93), so it was silently inert while reading
  // as live coverage. The bus subscriptions and the poll below are what have
  // actually been keeping this page current.
  //
  // Not repaired, for the same reason as LeaderboardPage: the repair is an
  // unfiltered subscription to `tournaments`, i.e. every tournament row change
  // platform-wide pushed to every client sitting in the lobby.

  // Subscribe to realtime tournament updates
  useEffect(() => {
    // ── Bus event subscriptions for faster local updates ──
    const unsubElim = masterBus.subscribeDebounced(
      'PLAYER_ELIMINATED',
      (event) => {
        // Decrement player count for the specific tournament
        setTournaments((prev) =>
          prev.map((t) =>
            t.id === event.payload.tournamentId
              ? { ...t, currentPlayers: Math.max(0, t.currentPlayers - 1) }
              : t
          )
        );
      },
      300
    );

    // TABLE_MERGED listener removed 2026-08-28: nothing emits it client-side
    // (see TournamentDetails for the full note).

    // Refresh profile/wallet when balance changes (e.g., after register/unregister)
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        masterBus.emit('PROFILE_UPDATED', { userId: user?.id || '', updates: {} });
      },
      500
    );

    // New tournament table created - refresh list to show it
    const unsubTableCreated = masterBus.subscribeDebounced(
      'TABLE_CREATED',
      () => {
        loadTournamentsRef.current();
      },
      500
    );

    return () => {
      unsubElim();
      unsubBalance();
      unsubTableCreated();
    };
  }, [clubId]);

  // ── Broadcast: Subscribe to tournament events for all running tournaments ──
  useEffect(() => {
    // Get all running tournament IDs from current tournaments
    const runningTournamentIds = tournamentsRef.current
      .filter((t) => ['ANNOUNCED', 'REGISTERING', 'RUNNING'].includes(t.status))
      .map((t) => t.id);

    // Cleanup old channels for tournaments no longer running
    const channelMap = channelRefsRef.current;
    for (const [tourneyId, channel] of channelMap.entries()) {
      if (!runningTournamentIds.includes(tourneyId)) {
        masterBus.removeRegisteredChannel(`t-break-${tourneyId}`);
        channelMap.delete(tourneyId);
      }
    }

    // Subscribe to new tournaments
    runningTournamentIds.forEach((tournamentId) => {
      if (channelMap.has(tournamentId)) return; // Already subscribed

      const channelKey = `t-break-${tournamentId}`;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on('broadcast', { event: 'tournament_event' }, (payload) => {
          const eventType = payload.payload?.type;
          const data = payload.payload?.payload;

          /* Break events onto MasterBus — see tournamentEventBridge. */
          relayTournamentEvent(tournamentId, payload.payload);

          // Update the tournament in the list
          setTournaments((prev) =>
            prev.map((t) => {
              if (t.id !== tournamentId) return t;

              // Common updates for multiple event types
              let updated = { ...t };

              switch (eventType) {
                case 'level_up':
                case 'table_rebalance':
                  // Just trigger a lightweight update if needed
                  // The postgres_changes subscription should handle most of this
                  break;

                case 'player_eliminated':
                  // Decrement player count
                  if (data?.playerName) {
                    updated = {
                      ...updated,
                      currentPlayers: Math.max(0, updated.currentPlayers - 1),
                    };
                  }
                  break;

                case 'late_reg_closed':
                  // Status may have changed, no immediate UI change needed
                  break;

                case 'ADDON_PERIOD_START':
                case 'ADDON_PERIOD_END':
                  // No player count change
                  break;

                case 'tournament_break':
                case 'break_ended':
                case 'hand_for_hand':
                case 'bubble_burst':
                  // Status notifications, no state update needed
                  break;
              }

              return updated;
            })
          );
        })
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err)
              reportError(err?.message || err, 'TournamentLobbyPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[TournamentLobbyPage] Realtime channel timed out');
          }
        });

      channelMap.set(tournamentId, channel);
    });

    return () => {
      // Cleanup all channels on unmount
      for (const [, channel] of channelRefsRef.current.entries()) {
        // Unsubscribe the channel properly
        if (channel?.unsubscribe) {
          channel.unsubscribe();
        }
      }
      for (const [tourneyId] of channelRefsRef.current.entries()) {
        masterBus.removeRegisteredChannel(`t-break-${tourneyId}`);
      }
      channelRefsRef.current.clear();
    };
  }, [tournaments]);

  const loadTournaments = async () => {
    loadTournamentsRef.current = loadTournaments;
    setLoading(true);
    try {
      // Fetch active tournaments first (REGISTERING/RUNNING/ANNOUNCED), then completed
      // Two queries to ensure active tournaments always appear regardless of limit
      const fields = `
                    id,
                    name,
                    club_id,
                    buy_in_amount,
                    buy_in_fee,
                    prize_pool,
                    guaranteed_prize,
                    start_time,
                    status,
                    current_players,
                    max_players,
                    starting_chips,
                    game_type,
                    variant,
                    tournament_type,
                    late_reg_mins,
                    late_reg_levels,
                    rebuy_levels,
                    prize_pool_finalized,
                    started_at,
                    current_level,
                    is_rebuy,
                    is_reentry,
                    addon_levels,
                    is_bounty,
                    is_pko,
                    is_mystery_bounty,
                    bounty_amount,
                    is_multi_day,
                    is_pinned,
                    label_as_new,
                    is_vip_only,
                    all_in_or_fold,
                    hide_club_name,
                    blind_structure,
                    clubs!club_id(name)
                `;

      // 72-hour display window: only show tournaments starting within 72h (or already running)
      const now = new Date();
      const seventyTwoHoursOut = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();

      let activeQuery = supabase
        .from('tournaments')
        .select(fields)
        .in('status', ['ANNOUNCED', 'REGISTERING', 'RUNNING'])
        .lte('start_time', seventyTwoHoursOut)
        .order('is_pinned', { ascending: false })
        .order('start_time', { ascending: true });

      // Also fetch pinned tournaments regardless of start_time
      let pinnedQuery = supabase
        .from('tournaments')
        .select(fields)
        .eq('is_pinned', true)
        .in('status', ['ANNOUNCED', 'REGISTERING', 'RUNNING'])
        .gt('start_time', seventyTwoHoursOut)
        .order('start_time', { ascending: true });

      let completedQuery = supabase
        .from('tournaments')
        .select(fields)
        .in('status', ['COMPLETED', 'CANCELLED'])
        .order('start_time', { ascending: false })
        .limit(30);

      // ── SCOPING (rewritten 2026-08-19) ───────────────────────────────────
      // This previously listed tournaments with `.in('club_id', <every club in
      // the union>)`, which exposed each club's PRIVATE tournaments to every
      // other club in the union. Worse, `/tournaments` and `/tournament-lobby`
      // mount this page with NO clubId, which made filterClubIds empty and
      // skipped the filter entirely — a platform-wide listing of every
      // tournament, private ones included.
      //
      // Correct scoping under union governance:
      //   union club  -> the UNION's tournaments (union_id) + this club's OWN
      //                  private ones. Sibling clubs' private games never show.
      //   standalone  -> this club's own tournaments.
      //   no club     -> nothing club-specific; show only union/public games
      //                  the viewer can actually reach (never private).
      let unionId: string | null = null;
      let resolvedClubId: string | null = null;
      if (clubId) {
        try {
          resolvedClubId = await resolveClubUUID(clubId);
          const { data: ucRow } = await supabase
            .from('union_clubs')
            .select('union_id')
            .eq('club_id', resolvedClubId)
            .limit(1)
            .maybeSingle();
          unionId = ucRow?.union_id ?? null;
        } catch (e) {
          reportError(e, 'TournamentLobbyPage.map');
          // Fail closed on scope: fall back to this club only.
          unionId = null;
        }
      }

      const applyScope = (q: any) => {
        if (unionId && resolvedClubId) {
          return q.or(
            `union_id.eq.${unionId},and(club_id.eq.${resolvedClubId},is_private.eq.true)`
          );
        }
        if (resolvedClubId) {
          return q.eq('club_id', resolvedClubId);
        }
        // No club context: public/union games only, never private.
        return q.or('is_private.is.null,is_private.eq.false');
      };

      activeQuery = applyScope(activeQuery);
      pinnedQuery = applyScope(pinnedQuery);
      completedQuery = applyScope(completedQuery);

      // Apply status filter
      let data: any[] = [];
      let error: any = null;
      if (statusFilter === 'all' || statusFilter === 'upcoming') {
        const [activeRes, pinnedRes, completedRes] = await Promise.all([
          activeQuery,
          pinnedQuery,
          completedQuery,
        ]);
        error = activeRes.error || pinnedRes.error || completedRes.error;
        const active = activeRes.data || [];
        const pinned = pinnedRes.data || [];
        const completed = statusFilter === 'upcoming' ? [] : completedRes.data || [];
        // Merge pinned (beyond 72h) with active, deduplicate by id
        const seen = new Set<string>();
        const merged: any[] = [];
        for (const t of [...pinned, ...active]) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            merged.push(t);
          }
        }
        data = [...merged, ...completed];
      } else if (statusFilter === 'REGISTERING') {
        let q = supabase
          .from('tournaments')
          .select(fields)
          .eq('status', 'REGISTERING')
          .order('start_time', { ascending: true })
          .limit(50);
        q = applyScope(q);
        const res = await q;
        data = res.data || [];
        error = res.error;
      } else if (statusFilter === 'RUNNING') {
        let q = supabase
          .from('tournaments')
          .select(fields)
          .eq('status', 'RUNNING')
          .order('start_time', { ascending: true })
          .limit(50);
        q = applyScope(q);
        const res = await q;
        data = res.data || [];
        error = res.error;
      } else if (statusFilter === 'COMPLETED') {
        let q = supabase
          .from('tournaments')
          .select(fields)
          .eq('status', 'COMPLETED')
          .order('start_time', { ascending: false })
          .limit(50);
        q = applyScope(q);
        const res = await q;
        data = res.data || [];
        error = res.error;
      }

      if (!error && data) {
        // Check which tournaments user is registered for
        let registrations: string[] = [];
        if (user?.id) {
          const { data: regData } = await supabase
            .from('tournament_players')
            .select('tournament_id')
            .eq('user_id', user.id);
          registrations = regData?.map((r) => r.tournament_id) || [];
        }

        if (!isMounted.current) return;

        const mapped: Tournament[] = data.map((t: any) => ({
          id: t.id,
          name: t.name,
          clubId: t.club_id,
          // hide_club_name (2026-08-22): the owner chose to keep the club off
          // the lobby card and out of club-name search.
          clubName: t.hide_club_name ? '' : (t.clubs as any)?.name || 'Club',
          // The card advertises and charges the TOTAL, not the prize half of
          // the split - buy_in_amount alone understated every price by the fee.
          // totalBuyIn also rounds, so no decimal reaches the lobby.
          buyIn: totalBuyIn(t.buy_in_amount || 0, t.buy_in_fee),
          buyInPrize: Number(t.buy_in_amount) || 0,
          buyInFee: Number(t.buy_in_fee) || 0,
          prizePool: Math.round(Number(t.prize_pool) || 0),
          startTime: t.start_time,
          status: t.status,
          currentPlayers: t.current_players || 0,
          maxPlayers: t.max_players || 0, // 0 = unlimited (only SNG/Spin have caps)
          startingChips: t.starting_chips || 0,
          structureFacts: describeStoredMttStructure(t.blind_structure, t.starting_chips),
          isRegistered: registrations.includes(t.id),
          gameType: t.game_type || 'NLH',
          lateRegMins: t.late_reg_mins || 0,
          late_reg_levels: t.late_reg_levels,
          late_reg_mins: t.late_reg_mins,
          rebuy_levels: t.rebuy_levels,
          prize_pool_finalized: t.prize_pool_finalized,
          started_at: t.started_at,
          current_level: t.current_level || 0,
          is_reentry: t.is_reentry || false,
          addon_levels: t.addon_levels || 1,
          isRebuy: t.is_rebuy || false,
          guaranteedPrize: t.guaranteed_prize || 0,
          variant: t.variant || 'freezeout',
          tournamentType: t.tournament_type || 'MTT',
          isBounty: t.is_bounty || t.bounty_amount > 0 || /bounty/i.test(t.name) || false,
          isPko: t.is_pko || /\bpko\b/i.test(t.name) || /progressive\s*k/i.test(t.name) || false,
          isMysteryBounty: t.is_mystery_bounty || /mystery/i.test(t.name) || false,
          bountyAmount: t.bounty_amount || 0,
          isMultiDay: t.is_multi_day || false,
          isPinned: t.is_pinned || false,
          isNew: t.label_as_new || false,
          isVipOnly: t.is_vip_only || false,
          isAllInOrFold: t.all_in_or_fold || false,
        }));

        setTournaments(mapped);
      }
    } catch (error) {
      if (!isMounted.current) return;
      reportError(error, 'TournamentLobbyPage.Failed_to_load_tournaments');
    }
    if (isMounted.current) setLoading(false);
  };

  /**
   * Dan 2026-08-25 (binding): "you don't need a secondary confirmation for buy
   * ins" — but you do need ONE, and this surface had NONE.
   *
   * This is the GLOBAL tournament lobby, the busiest register button in the
   * app, and it called `tournamentService.registerPlayer` directly: one tap on
   * a card and the buy-in was gone, no price confirmed, no balance shown, no
   * way back. The hook was already imported at the top of this file and its
   * return value was never used — so the page LOOKED wired to the shared path
   * and was not.
   *
   * It now goes through `useTournamentRegistration`, which is the only thing
   * that shows the Sign Up card, and which also handles the re-entrancy guard
   * (a double-tapped card used to debit twice) and the post-registration seat
   * lookup. The list refresh stays, as the hook's onSuccess.
   */
  const handleRegister = async (tournamentId: string) => {
    if (!user?.id) return;
    const t = tournamentsRef.current.find((x) => x.id === tournamentId);
    if (!t) {
      toast.error('That Tournament Is No Longer Listed');
      return;
    }
    await registerMtt(
      {
        id: t.id,
        name: t.name,
        // This page's row shape is camelCase and carries the split separately
        // from the rounded total — see `buyInPrize` / `buyInFee` above.
        buy_in_amount: t.buyInPrize,
        buy_in_fee: t.buyInFee,
        bounty_amount: t.isBounty ? t.bountyAmount || 0 : 0,
        is_pko: !!t.isPko,
        is_mystery_bounty: !!t.isMysteryBounty,
        start_time: t.startTime,
        club_id: t.clubId ?? null,
        // The hook derives late-registration from status — one definition for
        // every surface, because five hand-rolled copies all missed LATE_REG.
        status: t.status,
      },
      () => loadTournaments()
    );
  };

  const handleUnregister = async (tournamentId: string) => {
    if (!user?.id) return;
    try {
      const result = await tournamentService.unregisterPlayer(tournamentId, user.id);
      toast.success(tournamentUnregisterSuccessText(result));
      loadTournaments();
    } catch (error) {
      reportError(error, 'TournamentLobbyPage.Unregistration_failed');
      const msg = (error as Error).message || 'Unknown error';
      toast.error(`Unregistration failed: ${msg}`);
    }
  };

  const filteredTournaments = tournaments
    .filter((t) => {
      // Text search
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        if (
          !(t.name || '').toLowerCase().includes(query) &&
          !(t.clubName || '').toLowerCase().includes(query)
        ) {
          return false;
        }
      }
      // Type filter
      if (typeFilter !== 'all') {
        switch (typeFilter) {
          case 'mtt':
            return (
              (t.variant === 'freezeout' || t.tournamentType === 'MTT') &&
              !t.isBounty &&
              !t.isPko &&
              !t.isMysteryBounty
            );
          case 'sng':
            return t.variant === 'sng';
          case 'spin':
            return t.variant === 'spin';
          case 'bounty':
            return t.isBounty && !t.isPko && !t.isMysteryBounty;
          case 'pko':
            return t.isPko;
          case 'mystery':
            return t.isMysteryBounty;
          default:
            return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      // Pinned tournaments always first
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      // Then by status priority: RUNNING > REGISTERING > ANNOUNCED > COMPLETED
      const statusPriority: Record<string, number> = {
        RUNNING: 0,
        REGISTERING: 1,
        ANNOUNCED: 2,
        COMPLETED: 3,
        CANCELLED: 4,
      };
      const aPriority = statusPriority[a.status] ?? 5;
      const bPriority = statusPriority[b.status] ?? 5;
      if (aPriority !== bPriority) return aPriority - bPriority;
      // Then by start time
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    });

  // Group tournaments by time window
  const getTimeGroup = (startTime: string): { label: string; order: number } => {
    const now = Date.now();
    const start = new Date(startTime).getTime();
    const diffMs = start - now;
    const diffMins = diffMs / (1000 * 60);
    const diffHours = diffMins / 60;

    if (diffMs < 0) {
      // Already started or completed
      return { label: 'Now', order: 0 };
    } else if (diffMins < 30) {
      return { label: 'Starting Soon (< 30 Min)', order: 1 };
    } else if (diffMins < 120) {
      return { label: 'Next Hour (30 Min - 2 Hours)', order: 2 };
    } else if (diffHours < 6) {
      return { label: 'Later Today', order: 3 };
    } else if (diffHours < 24) {
      return { label: 'Tomorrow', order: 4 };
    } else {
      return { label: 'Coming Soon', order: 5 };
    }
  };

  const groupedTournaments = filteredTournaments
    .reduce(
      (acc, t) => {
        const group = getTimeGroup(t.startTime);
        const existing = acc.find((g) => g.label === group.label);
        if (existing) {
          existing.tournaments.push(t);
        } else {
          acc.push({ ...group, tournaments: [t] });
        }
        return acc;
      },
      [] as Array<{ label: string; order: number; tournaments: Tournament[] }>
    )
    .sort((a, b) => a.order - b.order);

  const upcomingCount = tournaments.filter((t) =>
    ['ANNOUNCED', 'REGISTERING'].includes(t.status)
  ).length;
  const runningCount = tournaments.filter((t) => t.status === 'RUNNING').length;

  return (
    <div className={styles.page} data-arena-surface="play">
      <CasinoSurfaceHeader
        crest="vip"
        eyebrow="Play & Review / Tournament Lobby"
        title="Tournament Command"
        description="Discover Scheduled Fields, Inspect Live Events, And Enter Registration Through The Existing Tournament Service And Server-Authoritative Buy-In Flow."
        artPath="assets/club-buttons/lobby/shark-club-championship-ad-v2.png"
        status="TOURNAMENT NETWORK // LIVE"
        metrics={[
          { label: 'Upcoming', value: upcomingCount, tone: 'attention' },
          { label: 'Live Now', value: runningCount, tone: 'live' },
          { label: 'Loaded', value: tournaments.length },
        ]}
      />
      {/* Quick Stats */}
      <div className={styles.quickStats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{upcomingCount}</span>
          <span className={styles.statLabel}>Upcoming</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{runningCount}</span>
          <span className={styles.statLabel}>Live Now</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{tournaments.length}</span>
          <span className={styles.statLabel}>Total</span>
        </div>
      </div>

      {/* Search */}
      <div className={styles.searchBar}>
        <input
          type="text"
          placeholder="Search Tournaments..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={styles.searchInput}
        />
      </div>

      {/* Status Filters */}
      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          {(['all', 'upcoming', 'REGISTERING', 'RUNNING', 'COMPLETED'] as TournamentStatus[]).map(
            (status) => (
              <button
                key={status}
                className={`${styles.filterBtn} ${statusFilter === status ? styles.active : ''}`}
                onClick={() => setStatusFilter(status as TournamentStatus)}
              >
                {status === 'all'
                  ? 'All'
                  : status === 'upcoming'
                    ? 'Upcoming'
                    : status === 'REGISTERING'
                      ? 'Registering'
                      : status === 'RUNNING'
                        ? 'Live'
                        : 'Completed'}
              </button>
            )
          )}
        </div>
      </div>

      {/* Type Filters */}
      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          {(
            ['all', 'mtt', 'sng', 'spin', 'bounty', 'pko', 'mystery'] as TournamentTypeFilter[]
          ).map((tf) => (
            <button
              key={tf}
              className={`${styles.filterBtn} ${styles.typeBtn} ${typeFilter === tf ? styles.active : ''}`}
              onClick={() => setTypeFilter(tf as TournamentTypeFilter)}
            >
              {tf === 'all'
                ? 'All Types'
                : tf === 'mtt'
                  ? 'MTT'
                  : tf === 'sng'
                    ? 'SNG'
                    : tf === 'spin'
                      ? 'Spin'
                      : tf === 'bounty'
                        ? 'Bounty'
                        : tf === 'pko'
                          ? 'PKO'
                          : 'Mystery'}
            </button>
          ))}
        </div>
      </div>

      {/* Tournament List */}
      <div className={styles.tournamentList}>
        {loading ? (
          <div className={styles.skeletonGrid}>
            {[1, 2, 3, 4].map((i) => (
              <CardSkeleton key={i} hasImage={false} lines={4} />
            ))}
          </div>
        ) : filteredTournaments.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}></span>
            <p>No Tournaments Found</p>
            {clubId && !isInUnion && (
              /* 2026-08-27: this linked to /clubs/:id/create-tournament, a
                 route that has never existed — the button 404'd into the
                 catch-all. The create-table picker is the real entry: its
                 SNG/MTT tabs build tournaments. */
              <Link to={`/clubs/${clubId}/create-table`} className={styles.createBtn}>
                + Create Tournament
              </Link>
            )}
          </div>
        ) : (
          groupedTournaments.map((group) => (
            <div key={group.label}>
              {/* Time Group Header */}
              <div className={styles.groupHeader}>
                <span className={styles.groupLabel}>{group.label}</span>
                <span className={styles.groupCount}>{group.tournaments.length}</span>
              </div>

              {/* Tournaments in Group */}
              {group.tournaments.map((tournament) => (
                <div key={tournament.id} className={styles.fadeInUp}>
                  <TournamentLobbyCard
                    tournament={{
                      id: tournament.id,
                      name: tournament.name,
                      type:
                        tournament.variant === 'sng'
                          ? 'sng'
                          : tournament.variant === 'spin'
                            ? 'spin'
                            : tournament.isMysteryBounty
                              ? 'mystery'
                              : tournament.isPko
                                ? 'pko'
                                : tournament.isBounty
                                  ? 'bounty'
                                  : 'mtt',
                      buyIn: tournament.buyIn,
                      prizePool: tournament.prizePool,
                      maxPlayers: tournament.maxPlayers,
                      registeredPlayers: tournament.currentPlayers,
                      startsAt: tournament.startTime,
                      status:
                        tournament.status === 'COMPLETED'
                          ? 'finished'
                          : tournament.status === 'ANNOUNCED'
                            ? 'registering'
                            : tournament.status === 'REGISTERING'
                              ? 'registering'
                              : tournament.status === 'RUNNING'
                                ? 'running'
                                : 'cancelled',
                      blindStructure: tournament.structureFacts.speedLabel ?? 'Unconfirmed',
                      structureFacts: tournament.structureFacts,
                      gameType: tournament.gameType,
                      startingChips: tournament.startingChips,
                      lateRegMins: tournament.lateRegMins,
                      late_reg_levels: tournament.late_reg_levels,
                      late_reg_mins: tournament.late_reg_mins,
                      rebuy_levels: tournament.rebuy_levels,
                      prize_pool_finalized: tournament.prize_pool_finalized,
                      current_level: tournament.current_level,
                      started_at: tournament.started_at,
                      isRebuy: tournament.isRebuy,
                      guaranteedPrize: tournament.guaranteedPrize,
                      isBounty: tournament.isBounty,
                      isPko: tournament.isPko,
                      isMysteryBounty: tournament.isMysteryBounty,
                      bountyAmount: tournament.bountyAmount,
                      isMultiDay: tournament.isMultiDay,
                      isPinned: tournament.isPinned,
                      isNew: tournament.isNew,
                      isVipOnly: tournament.isVipOnly,
                      isAllInOrFold: tournament.isAllInOrFold,
                    }}
                    onRegister={() => handleRegister(tournament.id)}
                  />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
