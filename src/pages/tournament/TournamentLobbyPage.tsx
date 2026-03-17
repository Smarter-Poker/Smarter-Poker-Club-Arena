/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LOBBY PAGE — Browse & Register for Tournaments
 * ═══════════════════════════════════════════════════════════════════════════════
 * Central hub for discovering and joining tournaments across all clubs
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusChannel } from '../../hooks/useMasterBusChannel';
import { tournamentService } from '../../services/TournamentService';
import TournamentLobbyCard from '../../components/tournament/TournamentLobbyCard';
import { CardSkeleton } from '../../components/skeletons/CardSkeleton';
import { useToast } from '../../components/common/Toast';

import { resolveClubUUID } from '../../utils/clubIdResolver';
import styles from './TournamentLobbyPage.module.css';

import { useIsMounted } from '../../hooks/useIsMounted';

type TournamentStatus = 'all' | 'upcoming' | 'REGISTERING' | 'RUNNING' | 'COMPLETED';
type TournamentTypeFilter = 'all' | 'mtt' | 'sng' | 'spin' | 'bounty' | 'pko' | 'mystery';

interface Tournament {
  id: string;
  name: string;
  clubId: string;
  clubName: string;
  buyIn: number;
  prizePool: number;
  guaranteedPrize: number;
  startTime: string;
  status: 'ANNOUNCED' | 'REGISTERING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
  currentPlayers: number;
  maxPlayers: number;
  startingChips: number;
  blindsUp: number;
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
}

export default function TournamentLobbyPage() {
  const { clubId } = useParams<{ clubId?: string }>();
  const { user } = useAuthUser();
  const toast = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TournamentStatus>('upcoming');
  const [typeFilter, setTypeFilter] = useState<TournamentTypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleTournaments, setVisibleTournaments] = useState<Set<string>>(new Set());
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
      } catch {
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

  // Stagger animation for tournament cards
  useEffect(() => {
    if (tournaments.length === 0) return;
    setVisibleTournaments(new Set());
    tournaments.forEach((tourn, index) => {
      setTimeout(() => {
        setVisibleTournaments((prev) => new Set(prev).add(tourn.id));
      }, index * 60);
    });
  }, [tournaments]);

  useEffect(() => {
    loadTournaments();
  }, [clubId, statusFilter]);

  // Callback for tournament updates
  const handleTournamentUpdate = useCallback((payload: any) => {
    if (payload.eventType === 'UPDATE' && payload.new) {
      // Update tournament in list
      setTournaments((prev) =>
        prev.map((t) =>
          t.id === payload.new.id
            ? {
                ...t,
                currentPlayers: payload.new.current_players,
                prizePool: payload.new.prize_pool,
                status: payload.new.status,
              }
            : t
        )
      );
    } else if (payload.eventType === 'INSERT') {
      // Reload to get new tournament with club name (uses ref to get current filter)
      loadTournamentsRef.current();
    }
  }, []);

  useMasterBusChannel({
    channelName: 'tournament-lobby-updates',
    table: 'tournaments',
    filter: null,
    event: '*',
    onPayload: handleTournamentUpdate,
    enabled: true,
  });

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

    const unsubMerge = masterBus.subscribeDebounced(
      'TABLE_MERGED',
      () => {
        // Refresh tournament list to reflect table changes
        loadTournamentsRef.current();
      },
      500
    );

    // Refresh profile/wallet when balance changes (e.g., after register/unregister)
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        masterBus.emit('PROFILE_UPDATED', { userId: user?.id || '', updates: {} });
      },
      500
    );

    return () => {
      unsubElim();
      unsubMerge();
      unsubBalance();
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
          const data = payload.payload?.data;

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
        .subscribe();

      channelMap.set(tournamentId, channel);
    });

    return () => {
      // Cleanup all channels on unmount
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

      // Union-aware filtering: if club is in a union, show ALL union club tournaments
      let filterClubIds: string[] = clubId ? [clubId] : [];
      if (clubId) {
        try {
          const resolvedId = await resolveClubUUID(clubId);
          const { data: ucRow } = await supabase
            .from('union_clubs')
            .select('union_id')
            .eq('club_id', resolvedId)
            .limit(1)
            .maybeSingle();
          if (ucRow?.union_id) {
            const { data: allUcRows } = await supabase
              .from('union_clubs')
              .select('club_id')
              .eq('union_id', ucRow.union_id);
            if (allUcRows && allUcRows.length > 0) {
              filterClubIds = allUcRows.map((r) => r.club_id);
            }
          }
        } catch {
          // Fail-open: just use the single clubId
        }
      }

      if (filterClubIds.length > 0) {
        activeQuery = activeQuery.in('club_id', filterClubIds);
        pinnedQuery = pinnedQuery.in('club_id', filterClubIds);
        completedQuery = completedQuery.in('club_id', filterClubIds);
      }

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
        if (filterClubIds.length > 0) q = q.in('club_id', filterClubIds);
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
        if (filterClubIds.length > 0) q = q.in('club_id', filterClubIds);
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
        if (filterClubIds.length > 0) q = q.in('club_id', filterClubIds);
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
          clubName: (t.clubs as any)?.name || 'Club',
          buyIn: t.buy_in_amount || 0,
          prizePool: t.prize_pool || 0,
          startTime: t.start_time,
          status: t.status,
          currentPlayers: t.current_players || 0,
          maxPlayers: t.max_players || 0, // 0 = unlimited (only SNG/Spin have caps)
          startingChips: t.starting_chips || 0,
          blindsUp: (() => {
            // Extract blind level duration from structure
            let blinds: any[] = [];
            if (Array.isArray(t.blind_structure)) blinds = t.blind_structure;
            else if (typeof t.blind_structure === 'string') {
              try {
                const parsed = JSON.parse(t.blind_structure);
                if (Array.isArray(parsed)) blinds = parsed;
              } catch {
                /* noop — fall through to named structure check */
              }
              if (blinds.length === 0) {
                // Named structure — estimate duration
                const key = (t.blind_structure || '').toLowerCase();
                if (key.includes('turbo')) return 3;
                if (key.includes('deep')) return 15;
                return 8; // regular
              }
            }
            return blinds.length > 0 && blinds[0]
              ? blinds[0].durationMinutes || blinds[0].duration || 8
              : 8;
          })(),
          isRegistered: registrations.includes(t.id),
          gameType: t.game_type || 'NLH',
          lateRegMins: t.late_reg_mins || 0,
          late_reg_levels: t.late_reg_levels || t.late_reg_mins || 0,
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
        }));

        setTournaments(mapped);
      }
    } catch (error) {
      if (!isMounted.current) return;
      console.error('Failed to load tournaments:', error);
    }
    if (isMounted.current) setLoading(false);
  };

  const handleRegister = async (tournamentId: string) => {
    if (!user?.id) return;
    try {
      await tournamentService.registerPlayer(tournamentId, user.id, user.username || 'Player');
      toast.success('Registered! Buy-in deducted from your wallet');
      loadTournaments();
    } catch (error) {
      console.error('Registration failed:', error);
      const msg = (error as Error).message || 'Unknown error';
      toast.error(`Registration failed: ${msg}`);
      throw error; // Re-throw so card can react
    }
  };

  const handleUnregister = async (tournamentId: string) => {
    if (!user?.id) return;
    try {
      await tournamentService.unregisterPlayer(tournamentId, user.id);
      toast.success('Unregistered — buy-in refunded to your wallet');
      loadTournaments();
    } catch (error) {
      console.error('Unregistration failed:', error);
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
      return { label: 'Starting Soon (< 30 min)', order: 1 };
    } else if (diffMins < 120) {
      return { label: 'Next Hour (30 min - 2 hours)', order: 2 };
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
    <div className={styles.page}>
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
          placeholder="Search tournaments..."
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
            <p>No tournaments found</p>
            {clubId && !isInUnion && (
              <Link to={`/clubs/${clubId}/create-tournament`} className={styles.createBtn}>
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
                <div
                  key={tournament.id}
                  className={`${visibleTournaments.has(tournament.id) ? styles.fadeInUp : styles.hidden}`}
                  style={
                    visibleTournaments.has(tournament.id)
                      ? undefined
                      : { opacity: 0, transform: 'translateY(8px)' }
                  }
                >
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
                      blindStructure: `${tournament.blindsUp}m`,
                      gameType: tournament.gameType,
                      startingChips: tournament.startingChips,
                      lateRegMins: tournament.lateRegMins,
                      isRebuy: tournament.isRebuy,
                      guaranteedPrize: tournament.guaranteedPrize,
                      isBounty: tournament.isBounty,
                      isPko: tournament.isPko,
                      isMysteryBounty: tournament.isMysteryBounty,
                      bountyAmount: tournament.bountyAmount,
                      isMultiDay: tournament.isMultiDay,
                      isPinned: tournament.isPinned,
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
