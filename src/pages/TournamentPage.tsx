/**
 * ♠ CLUB ARENA — Tournament Lobby Page
 * Register and view upcoming tournaments
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { isClubStaff } from '../types/clubRoles';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  tournamentService,
  BLIND_STRUCTURES,
  PAYOUT_STRUCTURES,
} from '../services/TournamentService';
import type { Tournament } from '../types/database.types';
import CreateTournamentModal from '../components/club/CreateTournamentModal';
import './TournamentPage.css';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import EliminationOverlay from '../components/tournament/EliminationOverlay';
import { tableService } from '../services/TableService';
// Tournament registration/refunds handled via TournamentService → Player Wallet RPCs
import { useToast } from '../components/common/Toast';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import ClubBottomNav from '../components/club/ClubBottomNav';
import MysteryBountyChest, {
  type MysteryChestData,
} from '../components/tournament/MysteryBountyChest';
import { useAnimationQueue } from '../hooks/useAnimationQueue';
// LOBBY FIX 2026-08-15: the detail pane below showed a STATIC blind chart and
// a payout list and nothing else, no clock, no standings, no tables. All three
// components already existed and worked; two were rendered nowhere in the app.
import { TournamentClock } from '../components/tournament/TournamentClock';
import TournamentStandings from '../components/tournament/TournamentStandings';
import { reportError } from '../utils/errorReporter';
import { spinMultiplierLabel } from '../utils/spinReveal';
import { useMysteryBounty } from '../hooks/useMysteryBounty';
import MysteryBountyPanel from '../components/tournament/MysteryBountyPanel';
import {
  activationStatusLine,
  formatCents,
  topBountyCents,
} from '../services/MysteryBountyService';
// WHOLE-NUMBER TOURNAMENT MONEY (Dan 2026-08-20). Every buy-in / fee / prize
// figure on this page renders through these, never as a raw column value.
import { digitsOnly, formatBuyIn, money, splitBuyIn, totalBuyIn } from '../utils/buyIn';
import { relayTournamentEvent } from '../services/tournamentEventBridge';
import { useTournamentRegistration } from '../hooks/useTournamentRegistration';

type TournFilter = 'all' | 'freeroll' | 'micro' | 'highroller';

/**
 * Is late registration still open on a RUNNING tournament?
 *
 * Dan 2026-08-21 (item 3): "it's showing users with more chips than they start
 * with even though the tournament hasn't started yet." It HAD started — the
 * badge just said REGISTERING because the row was still taking entries, so the
 * live clock and the real chip counts underneath it read as a contradiction.
 * A tournament in late registration is running; it is not un-started, and the
 * two states now carry different labels.
 *
 * Levels take precedence over minutes when the tournament defines both, because
 * that is how the engine closes the window.
 */
function isLateRegOpen(t: {
  status?: string | null;
  current_level?: number | null;
  late_reg_levels?: number | null;
  late_reg_mins?: number | null;
  started_at?: string | null;
}): boolean {
  if (t.status !== 'RUNNING') return false;
  const levels = Number(t.late_reg_levels ?? 0);
  // 0-BASED (2026-08-23): current_level indexes blind_structure directly, so
  // "through level N" is indices 0..N-1 and N is the cutoff. `<=` here left
  // the Register button live for a level after the engine had closed late reg
  // and finalized the pool. Matches TournamentManagerBase.isLateRegClosed.
  if (levels > 0) return Number(t.current_level ?? 0) < levels;
  const mins = Number(t.late_reg_mins ?? 0);
  if (mins > 0 && t.started_at) {
    return Date.now() - new Date(t.started_at).getTime() <= mins * 60_000;
  }
  return false;
}

// Default fallback for unauthed (shouldn't happen in real app)
const GUEST_USER = { id: 'guest', username: 'Guest' };

export default function TournamentPage() {
  const { register: registerMtt, isRegistering: isRegisteringMtt } = useTournamentRegistration();

  useEffect(() => {
    document.title = 'Tournaments | Smarter Poker';
  }, []);

  const { clubId, tournamentId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  // Mystery-bounty reveals seen from the lobby. Queued for the same reason the
  // table queues them: one broadcast per elimination, and a multi-way all-in
  // produces several within milliseconds.
  const lobbyChestQueue = useAnimationQueue<MysteryChestData>();
  const lobbyChest = lobbyChestQueue.current;
  const toast = useToast();
  const currentUser = user || GUEST_USER;

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);
  /** Tables in the selected RUNNING tournament (see the live pane below). */
  const [tourneyTables, setTourneyTables] = useState<
    Array<{
      id: string;
      name: string | null;
      current_players: number | null;
      max_players: number | null;
      small_blind: number | null;
      big_blind: number | null;
    }>
  >([]);
  const [filter, setFilter] = useState<TournFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [isInUnion, setIsInUnion] = useState(false);
  const [canRebuyNow, setCanRebuyNow] = useState(false);
  const [canAddOnNow, setCanAddOnNow] = useState(false);
  const [isProcessingRebuy, setIsProcessingRebuy] = useState(false);
  const selectedTournamentRef = useRef<Tournament | null>(null);
  const [visibleTournaments, setVisibleTournaments] = useState<Set<string>>(new Set());

  /**
   * MYSTERY BOUNTY (sections 10, 31 to 36, 68, 73) for whichever event is open
   * in the detail pane. Enabled only for a mystery event, so browsing the lobby
   * costs nothing for every other format.
   */
  const selectedIsMystery = Boolean((selectedTournament as any)?.is_mystery_bounty);
  const mysteryBounty = useMysteryBounty(selectedTournament?.id ?? null, selectedIsMystery);
  /**
   * Mirror of `visibleTournaments` for the stagger effect below to read without
   * taking a dependency on it — depending on the state it also SETS is how that
   * effect would re-enter itself on every card it reveals.
   */
  const visibleTournamentsRef = useRef<Set<string>>(new Set());
  visibleTournamentsRef.current = visibleTournaments;

  /**
   * Dan 2026-08-21 (item 1): the other half of "the page is glitching and
   * restarting over and over."
   *
   * `getTournaments` returns a brand-new array of brand-new objects every call,
   * so `setTournaments(data)` re-rendered the entire list even when not one
   * displayed value had changed — and this page refetches on EVERY realtime row
   * change for the club, on a 20s poll, and on tab focus. With dozens of live
   * tournaments writing `current_level` and `level_started_at` constantly, that
   * was a full list re-render every couple of seconds.
   *
   * Compare on the fields the list actually renders and keep the previous array
   * identity when they match. React then skips the re-render, the stagger
   * effect above sees no change, and the cards hold still.
   */
  const tournamentSignature = (list: Tournament[]): string =>
    list
      .map((t) =>
        [
          t.id,
          t.status,
          t.current_players,
          t.max_players,
          t.prize_pool,
          t.buy_in_amount,
          t.buy_in_fee,
          t.start_time,
          t.current_level,
        ].join(':')
      )
      .join('|');

  const applyTournaments = useCallback((data: Tournament[]) => {
    setTournaments((prev) =>
      tournamentSignature(prev) === tournamentSignature(data) ? prev : data
    );
  }, []);

  // Keep ref in sync with state
  useEffect(() => {
    selectedTournamentRef.current = selectedTournament;
  }, [selectedTournament]);

  // Check club ownership
  useEffect(() => {
    let isMounted = true;
    async function checkOwnership() {
      if (!clubId || !currentUser.id || currentUser.id === 'guest') {
        setIsOwner(false);
        return;
      }
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data, error } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', resolvedId)
          .eq('user_id', currentUser.id)
          .maybeSingle();

        if (!isMounted) return;
        setIsOwner(isClubStaff(data?.role));
      } catch (e) {
        reportError(e, 'TournamentPage.checkOwnership');
        if (isMounted) setIsOwner(false);
      }
    }
    checkOwnership();
    return () => {
      isMounted = false;
    };
  }, [clubId, currentUser.id]);

  // Check if club is in a union (unions manage their own tournaments)
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    (async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data, error } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (!isMounted) return;
        if (!error && data) setIsInUnion(true);
      } catch (e) {
        reportError(e, 'TournamentPage.async');
        // Query error — fail-open
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [clubId]);

  // Load tournaments
  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setFilter('all');
    setSelectedTournament(null);
    setShowCreateModal(false);
    setIsRegistered(false);
    setIsOwner(false);
    setIsInUnion(false);
    setCanRebuyNow(false);
    setCanAddOnNow(false);
    setIsProcessingRebuy(false);
    setVisibleTournaments(new Set());
    loadingRef.current = false;
  }, [clubId]);
  useEffect(() => {
    let isMounted = true;
    async function loadTournaments() {
      if (!clubId) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (isMounted) setIsLoading(true);
      try {
        // SWR: show cached tournaments instantly
        const swrKey = `tourn_cache_${clubId}`;
        try {
          const cached = sessionStorage.getItem(swrKey);
          if (cached) {
            const c = JSON.parse(cached);
            if (Array.isArray(c)) {
              setTournaments(c);
              setIsLoading(false);
            }
          }
        } catch (e) {
          reportError(e, 'TournamentPage.loadTournaments');
          /* corrupt cache */
        }

        const data = await tournamentService.getTournaments(clubId);
        if (!isMounted) return;
        applyTournaments(data);

        // SWR: cache successful fetch
        try {
          sessionStorage.setItem(swrKey, JSON.stringify(data.slice(0, 20)));
        } catch {
          /* storage full */
        }

        if (tournamentId) {
          const tourn = data.find((t) => t.id === tournamentId);
          if (tourn) setSelectedTournament(tourn);
        }
      } catch (error) {
        reportError(error, 'TournamentPage.Failed_to_load_tournaments');
      } finally {
        loadingRef.current = false;
        if (isMounted) setIsLoading(false);
      }
    }
    loadTournaments();
    return () => {
      isMounted = false;
    };
  }, [clubId, tournamentId]);

  /**
   * Stagger the cards in — ONCE per card, not once per data refresh.
   *
   * Dan 2026-08-21 (second batch, item 1): "the page is glitching and
   * restarting over and over."
   *
   * This effect was the restart. It depended on the `tournaments` ARRAY, and
   * `setTournaments` is called with a freshly-fetched array on every realtime
   * `postgres_changes` event for the club, on a 20s poll, and on tab focus. A
   * RUNNING tournament writes `current_level`, `level_started_at`, `prize_pool`
   * and `current_players` continuously, and there were 31 of them running under
   * this club — so the identity of `tournaments` changed every couple of
   * seconds. Each time, `setVisibleTournaments(new Set())` wiped every card to
   * invisible and re-ran the whole 60ms-per-card entrance animation. The list
   * blanked and re-dealt itself, over and over, exactly as reported.
   *
   * Two changes: the dependency is now the ID LIST (a stable string, so a
   * refetch that returns the same tournaments is a no-op), and cards are only
   * ADDED to the visible set — nothing that is already on screen is ever taken
   * off it. A genuinely new tournament still animates in; the ones already
   * there stay put.
   */
  const tournamentIdList = useMemo(() => tournaments.map((t) => t.id).join(','), [tournaments]);
  useEffect(() => {
    if (tournaments.length === 0) return;
    const unseen = tournaments.filter((t) => !visibleTournamentsRef.current.has(t.id));
    if (unseen.length === 0) return;
    const timers = unseen.map((tourn, index) =>
      setTimeout(() => {
        setVisibleTournaments((prev) => new Set(prev).add(tourn.id));
      }, index * 60)
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentIdList]);

  // Refresh tournament list when user returns to tab
  useVisibilityRefresh(async () => {
    if (!clubId) return;
    const data = await tournamentService.getTournaments(clubId);
    applyTournaments(data);
    const updated = data.find((t) => t.id === selectedTournamentRef.current?.id);
    if (updated) setSelectedTournament(updated);
  });

  // ── Realtime subscription: live tournament updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;

    const channelKey = `tournament-page-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournaments',
            filter: `club_id=eq.${resolvedId}`,
          },
          (payload) => {
            // Refresh tournaments on any change
            (async () => {
              try {
                const data = await tournamentService.getTournaments(clubId);
                if (!isMounted) return;
                applyTournaments(data);
                // Update selected tournament if it changed
                const updated = data.find((t) => t.id === selectedTournamentRef.current?.id);
                if (updated) setSelectedTournament(updated);
              } catch (error) {
                reportError(error, 'TournamentPage.Failed_to_refresh_tournaments');
              }
            })();
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'TournamentPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[TournamentPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[TournamentPage] Realtime setup failed:', e));

    // Refresh profile/wallet when balance changes (e.g., after register/unregister/rebuy)
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        masterBus.emit('PROFILE_UPDATED', { userId: currentUser.id, updates: {} });
      },
      500
    );

    // ── Ported from World Hub tournaments.js: refresh on cross-page actions ──
    const unsubChipsDistributed = masterBus.subscribeDebounced(
      'CHIPS_DISTRIBUTED',
      async () => {
        try {
          const data = await tournamentService.getTournaments(clubId);
          if (!isMounted) return;
          applyTournaments(data);
        } catch (e) {
          reportError(e, 'TournamentPage.async');
          /* silent */
        }
      },
      500
    );
    const unsubTournamentUpdated = masterBus.subscribeDebounced(
      'TOURNAMENT_UPDATED',
      async () => {
        try {
          const data = await tournamentService.getTournaments(clubId);
          if (!isMounted) return;
          applyTournaments(data);
          const updated = data.find((t) => t.id === selectedTournamentRef.current?.id);
          if (updated) setSelectedTournament(updated);
        } catch (e) {
          reportError(e, 'TournamentPage.find');
          /* silent */
        }
      },
      500
    );

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
      unsubBalance();
      unsubChipsDistributed();
      unsubTournamentUpdated();
    };
  }, [clubId, currentUser.id]);

  // ─── Sync registration state when selected tournament changes ───
  useEffect(() => {
    if (!selectedTournament || !currentUser.id || currentUser.id === 'guest') {
      setIsRegistered(false);
      return;
    }
    let isMounted = true;
    (async () => {
      try {
        const { data } = await supabase
          .from('tournament_players')
          .select('id')
          .eq('tournament_id', selectedTournament.id)
          .eq('user_id', currentUser.id)
          .maybeSingle();
        if (isMounted) setIsRegistered(!!data);
      } catch (e) {
        reportError(e, 'TournamentPage.Registration_sync_error');
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [selectedTournament?.id, currentUser.id]);

  // Helper to notify of a balance change
  const notifyWalletChange = (amount: number, isDeduction: boolean) => {
    try {
      masterBus.emit('BALANCE_UPDATED', {
        source: 'tournament',
        userId: currentUser.id,
        amount: amount,
        isDeduction: isDeduction,
        timestamp: Date.now(),
      });
    } catch (e) {
      reportError(e, 'TournamentPage.Failed_to_notify_of_wallet_change');
    }
  };

  // Register for tournament
  const handleRegister = () => {
    if (!selectedTournament) return;
    registerMtt(
      {
        id: selectedTournament.id,
        name: selectedTournament.name,
        buy_in_amount: selectedTournament.buy_in_amount,
        buy_in_fee: selectedTournament.buy_in_fee,
      },
      () => {
        setIsRegistered(true);
        const prizeContribution = Math.round(Number(selectedTournament.buy_in_amount) || 0);
        setTournaments((prev) =>
          prev.map((t) =>
            t.id === selectedTournament.id
              ? {
                  ...t,
                  current_players: (t.current_players || 0) + 1,
                  prize_pool: (t.prize_pool || 0) + prizeContribution,
                }
              : t
          )
        );
        if (selectedTournament) {
          setSelectedTournament({
            ...selectedTournament,
            current_players: (selectedTournament.current_players || 0) + 1,
            prize_pool: (selectedTournament.prize_pool || 0) + prizeContribution,
          });
        }
      }
    );
  };

  const handleStart = async () => {
    if (!selectedTournament || !clubId) return;
    try {
      await tournamentService.startTournament(selectedTournament.id);
      // Refresh
      const data = await tournamentService.getTournaments(clubId);
      applyTournaments(data);
      const updated = data.find((t) => t.id === selectedTournament.id);
      if (updated) setSelectedTournament(updated);
    } catch (error) {
      toast.error('Failed to start: ' + (error as Error).message);
    }
  };

  const handleJoinTable = async () => {
    if (!selectedTournament || !currentUser.id) return;
    try {
      const { data: tables, error: tablesErr } = await supabase
        .from('tables')
        .select('id')
        .eq('tournament_id', selectedTournament.id);
      if (tablesErr) {
        toast.error('Failed to load tables');
        return;
      }
      if (!tables?.length) {
        toast.warning('No tables found for this tournament');
        return;
      }

      const tableIds = tables.map((t) => t.id);
      const { data: seat, error: seatErr } = await supabase
        .from('table_seats')
        .select('table_id')
        .eq('user_id', currentUser.id)
        .in('table_id', tableIds)
        .is('left_at', null)
        .maybeSingle();
      if (seatErr) {
        toast.error('Failed to check seat status');
        return;
      }

      if (seat) {
        navigate(`/table/${seat.table_id}`); // FIX: was /clubs/:clubId/table/:tableId which is not a defined route
      } else {
        toast.warning(
          'You are registered but not seated. Please wait for the tournament to start fully.'
        );
      }
    } catch (e) {
      reportError(e, 'TournamentPage.error');
      toast.error('Failed to join tournament table');
    }
  };

  // Unregister
  const handleUnregister = async () => {
    if (!selectedTournament) return;
    if (currentUser.id === 'guest') {
      toast.error('You must be logged in to unregister');
      return;
    }
    try {
      // unregisterPlayer handles the full refund to Player Wallet via credit_player_wallet RPC
      await tournamentService.unregisterPlayer(selectedTournament.id, currentUser.id);

      setIsRegistered(false);

      // Mirror of the registration debit: the pool gives back the prize half,
      // the wallet gets the whole total back. Same integers both directions.
      const prizeContribution = Math.round(Number(selectedTournament.buy_in_amount) || 0);
      const refundedTotal = totalBuyIn(
        selectedTournament.buy_in_amount,
        selectedTournament.buy_in_fee
      );
      setTournaments((prev) =>
        prev.map((t) =>
          t.id === selectedTournament.id
            ? {
                ...t,
                current_players: Math.max(0, t.current_players - 1),
                prize_pool: Math.max(0, t.prize_pool - prizeContribution),
              }
            : t
        )
      );
      setSelectedTournament((prev) =>
        prev
          ? {
              ...prev,
              current_players: Math.max(0, prev.current_players - 1),
              prize_pool: Math.max(0, prev.prize_pool - prizeContribution),
            }
          : null
      );

      notifyWalletChange(refundedTotal, false);

      toast.success(`Unregistered! ${money(refundedTotal)} chips refunded.`);
    } catch (error) {
      toast.error('Unregister failed: ' + (error as Error).message);
    }
  };

  // Check rebuy/add-on eligibility when tournament changes
  useEffect(() => {
    let isMounted = true;
    async function checkRebuyAddOn() {
      if (!selectedTournament || !currentUser.id || currentUser.id === 'guest') {
        if (isMounted) {
          setCanRebuyNow(false);
          setCanAddOnNow(false);
        }
        return;
      }
      if (selectedTournament.status === 'RUNNING') {
        const [rebuyCheck, addOnCheck] = await Promise.all([
          tournamentService.canRebuy(selectedTournament.id, currentUser.id),
          tournamentService.canAddOn(selectedTournament.id),
        ]);
        if (!isMounted) return;
        setCanRebuyNow(rebuyCheck.allowed);
        setCanAddOnNow(addOnCheck.allowed);
      } else {
        if (isMounted) {
          setCanRebuyNow(false);
          setCanAddOnNow(false);
        }
      }
    }
    checkRebuyAddOn();
    return () => {
      isMounted = false;
    };
    // Dan 2026-08-21 (item 1): was `[selectedTournament, currentUser.id]`, i.e.
    // the OBJECT. Every refetch handed it a new object identity and fired two
    // more round trips, which then re-rendered, on a page that refetches on
    // every realtime row change. Keyed on the identity that actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTournament?.id, selectedTournament?.status, currentUser.id]);

  /**
   * Keep the OPEN detail pane honest, on its own.
   *
   * Dan 2026-08-21 (item 3): the header said REGISTERING / 19-of-60 while the
   * live pane directly below it showed a running clock and real chip counts.
   * Two different data paths: `TournamentClock` and `TournamentStandings` query
   * their tournament by id, but the header renders `selectedTournament`, which
   * is only ever refreshed as a side effect of the whole-list refetch —
   * `data.find(...)` inside handlers that can miss, race, or (for a union-hosted
   * tournament viewed from a club) not be subscribed to that row at all.
   *
   * A detail pane that stays open on one tournament now watches THAT ROW, so it
   * cannot disagree with the panel underneath it. Cheap: one row, by primary
   * key, only while the pane is open.
   */
  useEffect(() => {
    const id = selectedTournament?.id;
    if (!id) return;
    let alive = true;

    const pull = async () => {
      const { data, error } = await supabase
        .from('tournaments')
        .select(
          'id, name, status, current_players, max_players, prize_pool, buy_in_amount, buy_in_fee, starting_chips, current_level, late_reg_levels, late_reg_mins, start_time, started_at'
        )
        .eq('id', id)
        .maybeSingle();
      if (!alive || error || !data) return;
      setSelectedTournament((prev) =>
        prev && prev.id === id ? ({ ...prev, ...data } as Tournament) : prev
      );
    };

    const channelKey = `tournament-detail-${id}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournaments', filter: `id=eq.${id}` },
        () => {
          void pull();
        }
      )
      .subscribe();

    // Backstop for the case realtime is degraded — the pane is open and being
    // read, so a slow poll here is worth it.
    const iv = setInterval(() => void pull(), 15_000);
    void pull();

    return () => {
      alive = false;
      clearInterval(iv);
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [selectedTournament?.id]);

  // ── Broadcast: Tournament events (level_up, player_eliminated, etc) ──
  useEffect(() => {
    if (!selectedTournament?.id) return;

    const channelKey = `t-break-${selectedTournament.id}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('broadcast', { event: 'tournament_event' }, (payload) => {
        const eventType = payload.payload?.type;
        const data = payload.payload?.payload;

        /* Put the break events on MasterBus. TournamentClock and
           TournamentDetails have always subscribed to them there and nothing
           ever emitted them, so the clock never flipped to break and the
           toasts never fired. See tournamentEventBridge. */
        relayTournamentEvent(selectedTournament.id, payload.payload);

        switch (eventType) {
          case 'level_up':
            // Refresh tournament data
            (async () => {
              try {
                const updated = await tournamentService.getTournament(selectedTournament.id);
                if (updated) setSelectedTournament(updated);
              } catch (error) {
                reportError(error, 'TournamentPage.Failed_to_refresh_tournament_on_level_up');
              }
            })();
            break;

          case 'player_eliminated':
            // Refresh tournament data and show toast
            (async () => {
              try {
                const updated = await tournamentService.getTournament(selectedTournament.id);
                if (updated) setSelectedTournament(updated);
              } catch (error) {
                reportError(error, 'TournamentPage.Failed_to_refresh_tournament_on_player_e');
              }
            })();
            if (data?.playerName) {
              toast.info(`${data.playerName} has been eliminated`);
            }
            break;

          case 'tournament_break':
            toast.warning('Tournament on break');
            break;

          case 'break_ended':
            toast.success('Break ended - play resumes');
            break;

          case 'hand_for_hand':
            toast.info('Hand-for-hand play activated');
            break;

          case 'bubble_burst':
            toast.success('Bubble burst! All remaining players in the money');
            break;

          case 'late_reg_closed':
            toast.info('Late registration closed');
            // Refresh tournament data
            (async () => {
              try {
                const updated = await tournamentService.getTournament(selectedTournament.id);
                if (updated) setSelectedTournament(updated);
              } catch (error) {
                reportError(error, 'TournamentPage.Failed_to_refresh_tournament_on_late_reg');
              }
            })();
            break;

          case 'mystery_bounty_revealed':
            // TOURNEY-AUDIT 2026-07-24 (sweep 4): relay the server reveal so
            // the overlay can show it — previously nothing emitted this.
            // 2026-08-20: feed the chest directly as well. QUEUED, because a
            // multi-way all-in busts more than one player and the engine
            // broadcasts once per elimination; a single state slot would drop
            // all but the last.
            if (data?.playerName && data?.amount) {
              masterBus.emit('MYSTERY_BOUNTY_REVEALED', data);
              lobbyChestQueue.enqueue({
                knockerUserId: data.knockerUserId || '',
                knockerName: data.knockerName || 'Player',
                eliminatedName: data.eliminatedName || data.playerName || 'Player',
                amount: Number(data.amount) || 0,
                tierLabel: data.tierLabel,
                isJackpot: !!data.isJackpot,
                avgBounty: Number(data.avgBounty) || undefined,
              });
            }
            break;

          case 'ADDON_PERIOD_START':
            setCanAddOnNow(true);
            toast.success('Add-on period now available');
            break;

          case 'ADDON_PERIOD_END':
            setCanAddOnNow(false);
            toast.info('Add-on period has ended');
            break;

          case 'table_rebalance':
            // Refresh tournament data
            (async () => {
              try {
                const updated = await tournamentService.getTournament(selectedTournament.id);
                if (updated) setSelectedTournament(updated);
              } catch (error) {
                reportError(error, 'TournamentPage.Failed_to_refresh_tournament_on_table_re');
              }
            })();
            break;
        }
      })
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'TournamentPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[TournamentPage] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [selectedTournament?.id, toast]);

  // Handle Rebuy
  const handleRebuy = async () => {
    if (!selectedTournament) return;
    setIsProcessingRebuy(true);
    try {
      const result = await tournamentService.processRebuy(selectedTournament.id, currentUser.id);
      if (result.success) {
        toast.success(`Rebuy successful! New stack: ${result.newStack?.toLocaleString()}`);
        setCanRebuyNow(false);
        // Refresh tournament
        const updated = await tournamentService.getTournament(selectedTournament.id);
        if (updated) setSelectedTournament(updated);
      } else {
        toast.error('Rebuy failed');
      }
    } catch (error) {
      toast.error('Rebuy failed: ' + (error as Error).message);
    }
    setIsProcessingRebuy(false);
  };

  // Handle Add-On
  const handleAddOn = async () => {
    if (!selectedTournament) return;
    setIsProcessingRebuy(true);
    try {
      const result = await tournamentService.processAddOn(selectedTournament.id, currentUser.id);
      if (result.success) {
        toast.success(`Add-on successful! New stack: ${result.newStack?.toLocaleString()}`);
        setCanAddOnNow(false);
        // Refresh tournament
        const updated = await tournamentService.getTournament(selectedTournament.id);
        if (updated) setSelectedTournament(updated);
      } else {
        toast.error('Add-on failed');
      }
    } catch (error) {
      toast.error('Add-on failed: ' + (error as Error).message);
    }
    setIsProcessingRebuy(false);
  };

  const filteredTournaments = useMemo(() => {
    return (
      tournaments
        .filter((t) => {
          if (filter === 'freeroll') return t.buy_in_amount === 0;
          if (filter === 'micro') return t.buy_in_amount > 0 && t.buy_in_amount <= 1000;
          if (filter === 'highroller') return t.buy_in_amount >= 10000;
          return true;
        })
        // Featured (is_pinned) first — same rule as the main tournament lobby.
        .sort(
          (a, b) => Number(Boolean((b as any).is_pinned)) - Number(Boolean((a as any).is_pinned))
        )
    );
  }, [tournaments, filter]);

  // ─── Countdown Timer Hook (Initiative 2) ───────────────────────────
  const [countdownStr, setCountdownStr] = useState<Record<string, string>>({});
  // SWEEP #6: live blind-level chip per RUNNING tournament in the lobby list.
  // Derived from the SERVER-authoritative current_level / level_started_at now
  // included in the tournament selects, via tournamentService.getCurrentLevelState,
  // so the lobby countdown matches the engine timer (and survives breaks/pauses).
  const [levelChip, setLevelChip] = useState<Record<string, string>>({});

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const times: Record<string, string> = {};
      const levels: Record<string, string> = {};
      tournaments.forEach((t) => {
        if (t.status === 'REGISTERING' && t.start_time) {
          const diff = new Date(t.start_time).getTime() - now;
          if (diff > 0) {
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            times[t.id] =
              `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
          } else {
            times[t.id] = 'Starting...';
          }
        } else if (t.status === 'RUNNING') {
          try {
            const ls = tournamentService.getCurrentLevelState(t);
            const secs = Math.max(0, Math.floor(ls.timeRemainingSeconds));
            const mm = Math.floor(secs / 60);
            const ss = secs % 60;
            const label = ls.currentLevel?.isBreak ? 'Break' : `Lv ${ls.levelIndex + 1}`;
            levels[t.id] = `${label} · ${mm}:${ss.toString().padStart(2, '0')}`;
          } catch {
            /* leave chip empty if level state can't be derived */
          }
        }
      });
      setCountdownStr(times);
      setLevelChip(levels);
    }, 1000);
    return () => clearInterval(interval);
  }, [tournaments]);

  // Live pane: which tables the selected RUNNING tournament is playing on.
  // Only fetched while a RUNNING tournament is selected, so browsing upcoming
  // events costs nothing extra.
  useEffect(() => {
    const t = selectedTournament;
    if (!t || t.status !== 'RUNNING') {
      setTourneyTables([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('tables')
          .select('id, name, current_players, max_players, small_blind, big_blind')
          .eq('tournament_id', t.id)
          .order('name', { ascending: true });
        if (error) throw error;
        if (!cancelled) setTourneyTables(data || []);
      } catch (e) {
        if (!cancelled) reportError(e, 'TournamentPage.loadTournamentTables');
      }
    };
    load();
    // Tables merge and break as the field shrinks; 20s tracks that without
    // hammering the lobby.
    const iv = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [selectedTournament]);

  if (isLoading) {
    return (
      <div className="tournament-page">
        <div className="tournament-header">
          <div className="header-left">
            <h1> Tournaments</h1>
          </div>
        </div>
        <div className="tournament-content">
          <div className="tournament-list">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="tournament-skeleton-card">
                <div className="skel-header" />
                <div className="skel-body">
                  <div className="skel-line" style={{ width: '60%' }} />
                  <div className="skel-line" style={{ width: '40%' }} />
                  <div className="skel-line" style={{ width: '75%' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tournament-page">
      {/* Header */}
      <div className="tournament-header">
        <div className="header-left">
          <h1> Tournaments</h1>
        </div>
        {isOwner && !isInUnion && (
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            + Create Tournament
          </button>
        )}
      </div>

      <div className="tournament-content">
        {/* Tournament List */}
        <div className="tournament-list">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <h2 style={{ margin: 0 }}>Upcoming</h2>
            <div className="tourn-filter-chips">
              {[
                { value: 'all', label: 'All Stakes' },
                { value: 'freeroll', label: 'Freerolls' },
                { value: 'micro', label: 'Micro' },
                { value: 'highroller', label: 'High Roller' },
              ].map((f) => (
                <button
                  key={f.value}
                  className={`tourn-filter-chip ${filter === f.value ? 'active' : ''}`}
                  onClick={() => setFilter(f.value as TournFilter)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {filteredTournaments.length === 0 ? (
            <div className="empty-state">
              <p>No Tournaments Match Your Filters</p>
            </div>
          ) : (
            filteredTournaments.map((tourn) => (
              <div
                key={tourn.id}
                className={`tournament-card ${selectedTournament?.id === tourn.id ? 'selected' : ''} ${visibleTournaments.has(tourn.id) ? 'fadeInUp' : 'hidden'}`}
                style={
                  visibleTournaments.has(tourn.id)
                    ? { cursor: 'pointer' }
                    : { opacity: 0, transform: 'translateY(8px)', cursor: 'pointer' }
                }
                onClick={() => {
                  setSelectedTournament(tourn);
                  // On mobile, navigate to full detail page
                  if (window.innerWidth <= 768) {
                    navigate(`/tournaments/${tourn.id}`);
                  }
                }}
              >
                <div className="tourn-header">
                  <span className="tourn-name">{tourn.name}</span>
                  <span className={`tourn-status ${tourn.status}`}>
                    {tourn.status === 'REGISTERING'
                      ? ' Open'
                      : tourn.status === 'RUNNING'
                        ? isLateRegOpen(tourn)
                          ? ' Late Reg'
                          : ' Running'
                        : ' Soon'}
                  </span>
                </div>
                <div className="tourn-info">
                  <span className="tourn-type">
                    {(
                      {
                        NLH: 'NLH',
                        FLH: 'FLH',
                        PLO4: 'PLO4',
                        PLO5: 'PLO5',
                        PLO6: 'PLO6',
                        PLO8: 'PLO8',
                        PLO_HILO: 'PLO Hi-Lo',
                        SHORT_DECK: 'Short Deck',
                        PINEAPPLE: 'Pineapple',
                        MIXED: 'Mixed',
                        CRAZY_PINEAPPLE: 'Crazy Pine',
                        DOUBLE_BOARD: 'Double Board',
                      } as Record<string, string>
                    )[(tourn.game_type || tourn.variant || 'NLH').toUpperCase()] ||
                      tourn.game_type ||
                      'NLH'}
                  </span>
                  <span className="tourn-buyin">
                    {formatBuyIn(tourn.buy_in_amount, tourn.buy_in_fee)}
                  </span>
                </div>
                <div className="tourn-meta">
                  <span>
                    {' '}
                    {tourn.current_players}/{tourn.max_players}
                  </span>
                  <span> {money(tourn.prize_pool)}</span>
                </div>
                {/* Registration Progress Bar (Initiative 2) */}
                {(tourn.max_players ?? 0) > 0 && (
                  <div className="tourn-progress-bar">
                    <div
                      className="tourn-progress-fill"
                      style={{
                        width: `${Math.min(100, (tourn.current_players / (tourn.max_players ?? 1)) * 100)}%`,
                      }}
                    />
                  </div>
                )}
                {/* Countdown Timer (Initiative 2) */}
                {countdownStr[tourn.id] && (
                  <div
                    className={`tourn-countdown ${countdownStr[tourn.id] === 'Starting...' ? 'starting' : ''}`}
                  >
                    {countdownStr[tourn.id]}
                  </div>
                )}
                {/* SWEEP #6: live blind level + countdown for RUNNING tournaments */}
                {tourn.status === 'RUNNING' && levelChip[tourn.id] && (
                  <div
                    className="tourn-level-chip"
                    style={{
                      marginTop: 4,
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                      background: 'rgba(79,195,247,0.14)',
                      color: '#4fc3f7',
                      border: '1px solid rgba(79,195,247,0.28)',
                    }}
                  >
                    {levelChip[tourn.id]}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Tournament Details */}
        <div className="tournament-details">
          {selectedTournament ? (
            <>
              <div className="detail-header">
                <h2>{selectedTournament.name}</h2>
                {/* Dan 2026-08-21 (item 3): a RUNNING tournament that is still
                    taking entries said "REGISTERING" — next to a live clock and
                    real chip counts. That is what "it hasn't started yet" was
                    reading off. Late registration and not-yet-started are two
                    different things and now say so. */}
                <span className={`status-badge ${selectedTournament.status}`}>
                  {selectedTournament.status === 'RUNNING' && isLateRegOpen(selectedTournament)
                    ? 'LATE REG'
                    : selectedTournament.status}
                </span>
              </div>

              <div className="detail-stats">
                <div className="stat">
                  <span className="stat-label">Buy-In</span>
                  <span className="stat-value">
                    {formatBuyIn(selectedTournament.buy_in_amount, selectedTournament.buy_in_fee)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Starting Stack</span>
                  <span className="stat-value">
                    {selectedTournament.starting_chips
                      ? selectedTournament.starting_chips.toLocaleString()
                      : '-'}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Players</span>
                  <span className="stat-value">
                    {selectedTournament.current_players}
                    {selectedTournament.max_players ? `/${selectedTournament.max_players}` : ''}
                  </span>
                </div>
                <div className="stat highlight">
                  <span className="stat-label">Prize Pool</span>
                  <span className="stat-value gold">{money(selectedTournament.prize_pool)}</span>
                </div>

                {/* Bounty Info */}
                {selectedTournament.is_bounty &&
                  !selectedTournament.is_pko &&
                  !selectedTournament.is_mystery_bounty && (
                    <div className="stat">
                      <span className="stat-label">Bounty</span>
                      <span className="stat-value">
                        {money(selectedTournament.bounty_amount)} Chips
                      </span>
                    </div>
                  )}

                {/* PKO Info */}
                {selectedTournament.is_pko && (
                  <div className="stat">
                    <span className="stat-label">PKO</span>
                    <span className="stat-value">
                      {money(selectedTournament.bounty_amount)} Chips Starting Bounty
                    </span>
                  </div>
                )}
                {selectedTournament.is_pko && (
                  <div className="stat">
                    <span className="stat-label">PKO Payout</span>
                    <span
                      className="stat-value"
                      style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)' }}
                    >
                      50% To Knocker / 50% Added To Your Bounty
                    </span>
                  </div>
                )}

                {/* MYSTERY BOUNTY (sections 10 and 73).
                    This used to print `mystery_bounty_min` / `mystery_bounty_max`,
                    a per-head range drawn at REGISTRATION time. The engine no
                    longer reads either column: the draw happens once, when the
                    mystery phase opens, and produces an inventory of real
                    chests. What is advertised now is the biggest chest that
                    exists, from fn_mystery_bounty_inventory. */}
                {selectedIsMystery && (
                  <>
                    <div className="stat">
                      <span className="stat-label">Top Mystery Bounty</span>
                      <span className="stat-value">
                        {topBountyCents(mysteryBounty.inventory) > 0
                          ? formatCents(topBountyCents(mysteryBounty.inventory))
                          : 'Drawn When The Mystery Phase Opens'}
                      </span>
                    </div>
                    <div className="stat">
                      <span className="stat-label">Mystery Status</span>
                      <span className="stat-value">
                        {activationStatusLine(mysteryBounty.inventory)}
                      </span>
                    </div>
                  </>
                )}

                {/* Spin Info */}
                {selectedTournament.variant === 'spin' && (
                  <div className="stat">
                    <span className="stat-label">Multiplier</span>
                    <span className="stat-value">
                      {spinMultiplierLabel(selectedTournament as any) ?? 'TBD'}
                    </span>
                  </div>
                )}
              </div>

              {/* Live pane, RUNNING only. Until now, opening a tournament
                  that was actually in progress showed exactly what an
                  unstarted one showed: a static blind chart and a payout
                  list. No clock, no standings, no idea which tables were
                  running or how many players were left. All three components
                  below were ALREADY BUILT and working: TournamentClock was
                  rendered only on the separate mobile details route, and
                  TournamentStandings only behind a tab there, so the lobby
                  was the one place you could not see the tournament you were
                  actually playing. */}
              {selectedTournament.status === 'RUNNING' && (
                <div className="tourney-live-pane">
                  <TournamentClock tournamentId={selectedTournament.id} compact />

                  <div className="tourney-live-section">
                    <h3>Chip Counts</h3>
                    <TournamentStandings
                      tournamentId={selectedTournament.id}
                      totalPlayers={selectedTournament.current_players || 0}
                    />
                  </div>

                  <div className="tourney-live-section">
                    <h3>Tables ({tourneyTables.length})</h3>
                    {tourneyTables.length === 0 ? (
                      <p className="tourney-live-empty">No Tables Running Yet.</p>
                    ) : (
                      <div className="tourney-table-list">
                        {tourneyTables.map((tb) => (
                          <div key={tb.id} className="tourney-table-row">
                            <span className="tourney-table-name">{tb.name || 'Table'}</span>
                            <span className="tourney-table-blinds">
                              {tb.small_blind ?? 0}/{tb.big_blind ?? 0}
                            </span>
                            <span className="tourney-table-seats">
                              {tb.current_players ?? 0}/{tb.max_players ?? 9}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Blind Structure */}
              <div className="blind-structure">
                <h3>Blind Structure</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Level</th>
                      <th>Blinds</th>
                      <th>Ante</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let blinds = selectedTournament.blind_structure;
                      if (typeof blinds === 'string') {
                        try {
                          blinds = JSON.parse(blinds);
                        } catch {
                          blinds = [];
                        }
                      }
                      if (!Array.isArray(blinds)) blinds = [];
                      return blinds.slice(0, 5).map((level: any, i: number) => (
                        <tr key={i}>
                          <td>{level.level}</td>
                          <td>
                            {level.smallBlind || level.small_blind}/
                            {level.bigBlind || level.big_blind}
                          </td>
                          <td>{level.ante || '-'}</td>
                          <td>{level.durationMinutes || level.duration_minutes || 15} Min</td>
                        </tr>
                      ));
                    })()}
                    {(() => {
                      let blinds = selectedTournament.blind_structure;
                      if (typeof blinds === 'string') {
                        try {
                          blinds = JSON.parse(blinds);
                        } catch {
                          blinds = [];
                        }
                      }
                      if (!Array.isArray(blinds)) blinds = [];
                      return blinds.length > 5 ? (
                        <tr className="more-row">
                          <td colSpan={4}>+ {blinds.length - 5} More Levels</td>
                        </tr>
                      ) : null;
                    })()}
                  </tbody>
                </table>
              </div>

              {/* MYSTERY BOUNTY (sections 31 to 36, 41). The same three sections
                  the tournament details page shows, on the other lobby surface,
                  fed by the same page-level hook. */}
              {selectedIsMystery && (
                <MysteryBountyPanel
                  tournamentId={selectedTournament.id}
                  isMysteryBounty
                  data={mysteryBounty}
                  currentUserId={currentUser.id === 'guest' ? null : currentUser.id}
                  isCompleted={selectedTournament.status === 'COMPLETED'}
                />
              )}

              {/* Payout Structure */}
              <div className="payout-structure">
                <h3>Payouts</h3>
                <div className="payout-list">
                  {(Array.isArray(selectedTournament.payout_structure)
                    ? selectedTournament.payout_structure
                    : (() => {
                        try {
                          return typeof selectedTournament.payout_structure === 'string'
                            ? JSON.parse(selectedTournament.payout_structure)
                            : [];
                        } catch {
                          return [];
                        }
                      })()
                  )
                    .slice(0, 5)
                    .map((payout: any, i: number) => {
                      const pos = payout.place || payout.position || i + 1;
                      return (
                        <div key={i} className="payout-item">
                          <span className="payout-place">
                            {pos === 1 ? '' : pos === 2 ? '' : pos === 3 ? '' : `${pos}th`}
                          </span>
                          <span className="payout-percent">{payout.percentage}%</span>
                          <span className="payout-amount">
                            {Math.trunc(
                              ((selectedTournament.prize_pool * payout.percentage) / 100) * 100
                            ) / 100}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Actions */}
              <div className="detail-actions">
                {selectedTournament.status === 'REGISTERING' ||
                selectedTournament.status === 'ANNOUNCED' ? (
                  isRegistered ? (
                    <button className="btn btn-danger btn-block" onClick={handleUnregister}>
                      Unregister
                    </button>
                  ) : (
                    <button className="btn btn-primary btn-block" onClick={handleRegister}>
                      Register (
                      {money(
                        totalBuyIn(selectedTournament.buy_in_amount, selectedTournament.buy_in_fee)
                      )}
                      )
                    </button>
                  )
                ) : selectedTournament.status === 'RUNNING' ? (
                  <>
                    <button
                      className="btn btn-primary btn-block"
                      disabled={!isRegistered}
                      onClick={handleJoinTable}
                    >
                      {isRegistered ? 'Go to Table' : 'Tournament in Progress'}
                    </button>

                    {/* Rebuy Button */}
                    {canRebuyNow && (
                      <button
                        className="btn btn-warning btn-block"
                        style={{ marginTop: '0.5rem' }}
                        onClick={handleRebuy}
                        disabled={isProcessingRebuy}
                      >
                        {isProcessingRebuy
                          ? ' Processing...'
                          : /* Quote the price actually charged (base + fee),
                               as whole chips, not the raw buy-in column. */
                            ` Rebuy (${money(
                              tournamentService.quoteFromTournament(selectedTournament, 'rebuy')
                                .totalCost
                            )})`}
                      </button>
                    )}

                    {/* Add-On Button */}
                    {canAddOnNow && (
                      <button
                        className="btn btn-success btn-block"
                        style={{ marginTop: '0.5rem' }}
                        onClick={handleAddOn}
                        disabled={isProcessingRebuy}
                      >
                        {isProcessingRebuy
                          ? ' Processing...'
                          : /* Add-ons are not raked (Dan 2026-08-20), so the
                               quote is the face value, in whole chips. */
                            `Add-On (${money(
                              tournamentService.quoteFromTournament(selectedTournament, 'addon')
                                .totalCost
                            )})`}
                      </button>
                    )}
                  </>
                ) : null}

                {isOwner &&
                  (selectedTournament.status === 'REGISTERING' ||
                    selectedTournament.status === 'ANNOUNCED') && (
                    <button
                      className="btn btn-warning btn-block"
                      style={{ marginTop: '1rem' }}
                      onClick={handleStart}
                      /* TOURNEY-AUDIT 2026-07-24: minimum is 3 — the service
                         AUTO-CANCELS at start with < 3 registered, so enabling
                         this button at 2 players cancelled the tournament the
                         moment the owner clicked Start. */
                      disabled={selectedTournament.current_players < 3}
                    >
                      Start Tournament
                    </button>
                  )}
              </div>

              {/* Tournament Results Overlay (Initiative 13) */}
              {selectedTournament.status === 'COMPLETED' && (
                <div className="tourn-results-overlay">
                  <div className="results-header">Final Standings</div>
                  <div className="results-podium">
                    {(Array.isArray(selectedTournament.payout_structure)
                      ? selectedTournament.payout_structure
                      : (() => {
                          try {
                            return typeof selectedTournament.payout_structure === 'string'
                              ? JSON.parse(selectedTournament.payout_structure)
                              : [];
                          } catch {
                            return [];
                          }
                        })()
                    )
                      .slice(0, 3)
                      .map((p: any, i: number) => (
                        <div key={i} className={`podium-place podium-${i + 1}`}>
                          <div className="podium-icon">{i === 0 ? '★' : i === 1 ? '☆' : '✧'}</div>
                          <div className="podium-payout">
                            {Math.trunc(
                              ((selectedTournament.prize_pool * (p.percentage || 0)) / 100) * 100
                            ) / 100}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty-detail">
              <div className="empty-icon">♛</div>
              <h3>Select A Tournament</h3>
              <p>Click On A Tournament To View Details And Register.</p>
            </div>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && clubId && (
        <CreateTournamentModal
          clubId={clubId}
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setShowCreateModal(false);
            tournamentService
              .getTournaments(clubId)
              .then(setTournaments)
              .catch((e) => console.warn('[TournamentPage] Refresh after create failed:', e));
          }}
        />
      )}

      {/* ── Mystery bounty (2026-08-20) ─────────────────────────────────────
          Was MysteryBountyReveal: a purple ENVELOPE that opened itself after
          1200ms. Replaced with the same chest the table uses, so a player who
          is watching from the tournament page and one who is sitting at the
          table see the same event the same way. Two different reveals for one
          prize is how a product starts feeling assembled rather than built. */}
      <MysteryBountyChest
        data={lobbyChest}
        viewerUserId={user?.id ?? null}
        queuedBehind={lobbyChestQueue.pending}
        onDone={lobbyChestQueue.complete}
      />

      {/* Bottom Navigation */}
      {clubId && <ClubBottomNav clubId={clubId} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE TOURNAMENT MODAL
// ═══════════════════════════════════════════════════════════════════════════════

interface CreateModalProps {
  clubId: string;
  onClose: () => void;
  onCreate: (tournament: Tournament) => void;
}

function LegacyCreateTournamentModal({ clubId, onClose, onCreate }: CreateModalProps) {
  const toast = useToast();
  // WHOLE-DOLLAR BUY-IN (Dan 2026-08-20): `buyIn` is the TOTAL the player pays
  // and is always a whole number. The fee is a cut OUT of it, derived, never
  // typed - the old free-form Rake field let an owner author a second number
  // that disagreed with the 10% house rule and turned the advertised price into
  // 1.1x a round number.
  const [form, setForm] = useState({
    name: '',
    type: 'sng' as 'sng' | 'mtt',
    buyIn: '10',
    startingStack: 1500,
    maxPlayers: 6,
    blindSpeed: 'turbo' as 'turbo' | 'regular' | 'deepStack',
  });

  const split = splitBuyIn(Number(form.buyIn) || 0);

  const handleCreate = async () => {
    if (!form.name) return;
    if (!Number.isInteger(Number(form.buyIn)) || Number(form.buyIn) <= 0) {
      toast.error('Buy-in must be a whole number of chips, with no decimals.');
      return;
    }

    const payoutKey =
      form.type === 'sng'
        ? form.maxPlayers === 6
          ? 'sng6'
          : 'sng9'
        : form.maxPlayers <= 10
          ? 'mtt10'
          : form.maxPlayers <= 20
            ? 'mtt20'
            : 'mtt50';

    const tournament = await tournamentService.createTournament(clubId, {
      name: form.name,
      type: form.type,
      buyIn: split.total,
      rake: split.fee,
      startingStack: form.startingStack,
      maxPlayers: form.maxPlayers,
      minPlayers: form.type === 'sng' ? form.maxPlayers : 2,
      blindStructure: BLIND_STRUCTURES[form.blindSpeed],
      payoutStructure: PAYOUT_STRUCTURES[payoutKey],
      lateRegistrationLevels: 0,
      isRebuy: false,
      addOnAvailable: false,
    });

    onCreate(tournament);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create Tournament</h2>

        <div className="form-group">
          <label>Tournament Name</label>
          <input
            type="text"
            placeholder="Enter name..."
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Type</label>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as 'sng' | 'mtt' })}
            >
              <option value="sng">Heads Up</option>
              <option value="mtt">Tournament</option>
            </select>
          </div>

          <div className="form-group">
            <label>Max Players</label>
            <select
              value={form.maxPlayers}
              onChange={(e) => setForm({ ...form, maxPlayers: Number(e.target.value) })}
            >
              <option value={6}>6 Players</option>
              <option value={9}>9 Players</option>
              {form.type === 'mtt' && <option value={20}>20 Players</option>}
              {form.type === 'mtt' && <option value={50}>50 Players</option>}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Buy-In</label>
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={form.buyIn}
              onChange={(e) => setForm({ ...form, buyIn: digitsOnly(e.target.value) })}
            />
            <small>Whole Chips Only. The Total The Player Pays.</small>
          </div>

          <div className="form-group">
            <label>Fee (10% Of Buy-In)</label>
            <input type="number" min={0} step={1} value={split.fee} readOnly disabled />
            <small>
              {split.total > 0
                ? `${money(split.prize)} to the prize pool + ${money(split.fee)} fee`
                : 'Taken out of the buy-in, not added on top'}
            </small>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Starting Stack</label>
            <input
              type="number"
              min={500}
              step={500}
              value={form.startingStack}
              onChange={(e) => setForm({ ...form, startingStack: Number(e.target.value) })}
            />
          </div>

          <div className="form-group">
            <label>Blind Speed</label>
            <select
              value={form.blindSpeed}
              onChange={(e) =>
                setForm({
                  ...form,
                  blindSpeed: e.target.value as 'turbo' | 'regular' | 'deepStack',
                })
              }
            >
              <option value="turbo">Turbo (3 Min)</option>
              <option value="regular">Regular (8 Min)</option>
              <option value="deepStack">Deep Stack (15 Min)</option>
            </select>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={!form.name}>
            Create Tournament
          </button>
        </div>
      </div>
    </div>
  );
}
