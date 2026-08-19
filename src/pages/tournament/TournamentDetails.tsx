/**
 * ♠ CLUB ARENA — Tournament Details Page
 * premium-style tournament registration (PLAY CHIPS ONLY)
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { tournamentService } from '../../services/TournamentService';
import { WalletService } from '../../services/WalletService';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import type { Tournament } from '../../types/database.types';
import { useAuthUser } from '../../hooks/useAuthUser';
import TournamentStandings from '../../components/tournament/TournamentStandings';
import BlindLevelProgress from '../../components/tournament/BlindLevelProgress';
import LiveChipCounts from '../../components/tournament/LiveChipCounts';
import PayoutStructure from '../../components/tournament/PayoutStructure';
import TournamentStatsDashboard from '../../components/tournament/TournamentStatsDashboard';
import './TournamentDetails.css';
import { useToast } from '../../components/common/Toast';
import PageErrorBoundary from '../../components/common/PageErrorBoundary';
import { TournamentClock } from '../../components/tournament/TournamentClock';
import { HandForHandBanner } from '../../components/tournament/HandForHandBanner';
import { FinalTableOverlay } from '../../components/tournament/FinalTableOverlay';
import { reportError } from '../../utils/errorReporter';

type TabId =
  | 'detail'
  | 'blinds'
  | 'chips'
  | 'payouts'
  | 'entries'
  | 'ranking'
  | 'unions'
  | 'tables'
  | 'rewards';

interface TournamentEntry {
  id: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  position?: number;
  chips?: number;
  status: 'registered' | 'playing' | 'eliminated' | 'finished' | 'winner';
  table_id?: string | null;
}

interface TournamentTable {
  id: string;
  name: string;
  status: string;
  max_players: number;
  current_players: number;
  small_blind: number;
  big_blind: number;
}

/** Ordinal suffix helper (1st, 2nd, 3rd...) */
function getOrdinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

export default function TournamentDetails() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const navigate = useNavigate();
  const { user, isHydrating } = useAuthUser();
  const toast = useToast();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('detail');
  const [entries, setEntries] = useState<TournamentEntry[]>([]);
  const [isRegistered, setIsRegistered] = useState(false);
  /** Fires the auto-open-my-table navigation exactly once per tournament. */
  const autoOpenedTableRef = useRef(false);
  const [tables, setTables] = useState<TournamentTable[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showSignUpModal, setShowSignUpModal] = useState(false);
  const [countdown, setCountdown] = useState({ hours: 0, minutes: 0, seconds: 0 });

  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [lateRegCountdown, setLateRegCountdown] = useState<string>('');
  // SWEEP #6: 1s tick to drive the live level countdown in the quick-stats grid.
  const [clockTick, setClockTick] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [unionName, setUnionName] = useState<string>('');

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lateRegTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [visibleEntries, setVisibleEntries] = useState<Set<string>>(new Set());

  useEffect(() => {
    let isMounted = true;
    if (tournamentId) {
      loadTournament(() => isMounted);
    }
    if (user?.id) {
      loadWalletBalance();
    }
    return () => {
      isMounted = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    };
  }, [tournamentId, user?.id]);

  const loadWalletBalance = async () => {
    if (!user?.id) return;
    try {
      const balance = await WalletService.getPlayerBalance(user.id);
      setWalletBalance(balance);
    } catch (e) {
      reportError(e, 'TournamentDetails.loadWalletBalance');
      /* ignore */
    }
  };

  // ── Late-reg level-based status ──
  useEffect(() => {
    if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    const lateRegLevels =
      (tournament as any)?.late_reg_levels || (tournament as any)?.late_reg_mins || 0;
    if (tournament?.status !== 'RUNNING' || !lateRegLevels) return;

    const tick = () => {
      const currentLevel = (tournament as any)?.current_level || 0;
      if (currentLevel >= lateRegLevels) {
        setLateRegCountdown('');
        if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
        return;
      }
      const levelsRemaining = lateRegLevels - currentLevel;
      setLateRegCountdown(`${levelsRemaining} level${levelsRemaining !== 1 ? 's' : ''} remaining`);
    };
    tick();
    // Check every 10 seconds for level updates
    lateRegTimerRef.current = setInterval(tick, 10000);
    return () => {
      if (lateRegTimerRef.current) clearInterval(lateRegTimerRef.current);
    };
  }, [
    tournament?.status,
    (tournament as any)?.current_level,
    (tournament as any)?.late_reg_levels,
  ]);

  // SWEEP #6: drive a live 1-second countdown for the quick-stats level chip while
  // the tournament is RUNNING. getCurrentLevelState reads the server-authoritative
  // level clock, so this stays in sync with the engine's real timer.
  useEffect(() => {
    if (tournament?.status !== 'RUNNING') return;
    const id = setInterval(() => setClockTick((n) => (n + 1) % 3600), 1000);
    return () => clearInterval(id);
  }, [tournament?.status]);

  /**
   * Dan 2026-08-19: registering for a tournament must TAKE YOU TO IT the moment
   * it starts. Until now the page only rendered a manual "go to table" link
   * once the entry flipped to 'playing' — a registered player watching the
   * countdown was left sitting on the details screen while their table dealt
   * without them, blinding off.
   *
   * The realtime subscription below already streams both the tournament status
   * and this player's tournament_players row, so the moment the engine seats
   * them (a table_id appears) we open that table. Guarded by a ref so it fires
   * exactly once per tournament — re-navigating on every realtime tick would
   * trap the player on the table route and break the back button.
   */
  useEffect(() => {
    if (tournament?.status !== 'RUNNING') return;
    if (!user?.id) return;
    if (autoOpenedTableRef.current) return;

    const myEntry = entries.find((e) => e.user_id === user.id);
    if (!myEntry?.table_id) return;
    // Only seat-bound states: an eliminated or finished player must never be
    // yanked into a table they are no longer sitting at.
    if (myEntry.status !== 'playing' && myEntry.status !== 'registered') return;

    autoOpenedTableRef.current = true;
    navigate(`/table/${myEntry.table_id}`);
  }, [tournament?.status, entries, user?.id, navigate]);

  // ── Realtime subscription: live tournament updates ──
  useEffect(() => {
    if (!tournamentId) return;

    const channelKey = `tournament-${tournamentId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          filter: `id=eq.${tournamentId}`,
        },
        (payload) => {
          if (payload.eventType === 'UPDATE' && payload.new) {
            setTournament((prev) => (prev ? { ...prev, ...payload.new } : null));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            // New player registered
            const newPlayer = payload.new as {
              id: string;
              user_id: string;
              username?: string | null;
              chips?: number;
              status: string;
              position?: number | null;
              table_id?: string | null;
            };
            setEntries((prev) => [
              ...prev,
              {
                id: newPlayer.id,
                user_id: newPlayer.user_id,
                username: newPlayer.username || 'Player',
                avatar_url: null,
                // BUG FIX: do NOT read tournament.starting_chips here — this
                // handler is in a closure that captured `tournament` at the time
                // the effect ran (tournamentId dep), which may be null if the
                // subscription was set up before loadTournament completed.
                // Use newPlayer.chips if present; the next loadTournament() call
                // (triggered by TOURNAMENT_UPDATED) will hydrate the full entry.
                chips: newPlayer.chips || 0,
                position: newPlayer.position || undefined,
                status: newPlayer.status as TournamentEntry['status'],
                table_id: newPlayer.table_id || null,
              },
            ]);
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            // Player status or chips updated
            const updatedPlayer = payload.new as {
              id: string;
              user_id: string;
              username?: string | null;
              chips?: number;
              status: string;
              position?: number | null;
              table_id?: string | null;
            };
            setEntries((prev) =>
              prev.map((e) =>
                e.id === updatedPlayer.id
                  ? {
                      ...e,
                      chips: updatedPlayer.chips,
                      status: updatedPlayer.status as TournamentEntry['status'],
                      position: updatedPlayer.position || undefined,
                      table_id:
                        updatedPlayer.table_id !== undefined ? updatedPlayer.table_id : e.table_id,
                    }
                  : e
              )
            );
          } else if (payload.eventType === 'DELETE' && payload.old) {
            // Player unregistered or eliminated
            setEntries((prev) => prev.filter((e) => e.id !== (payload.old as any).id));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            const t = payload.new as any;
            setTables((prev) => [
              ...prev,
              {
                id: t.id,
                name: t.name || `Table ${prev.length + 1}`,
                status: t.status,
                max_players: t.max_players,
                current_players: t.current_players || 0,
                small_blind: t.small_blind,
                big_blind: t.big_blind,
              },
            ]);
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            const t = payload.new as any;
            setTables((prev) =>
              prev.map((tbl) =>
                tbl.id === t.id
                  ? {
                      ...tbl,
                      current_players: t.current_players,
                      small_blind: t.small_blind,
                      big_blind: t.big_blind,
                      status: t.status,
                    }
                  : tbl
              )
            );
          } else if (payload.eventType === 'DELETE' && payload.old) {
            setTables((prev) => prev.filter((tbl) => tbl.id !== (payload.old as any).id));
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'TournamentDetails._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[TournamentDetails] ⏱️ Realtime channel timed out');
        }
      });

    // ── Bus event subscriptions for faster local updates ──
    const unsubElim = masterBus.subscribeDebounced(
      'PLAYER_ELIMINATED',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        // Immediately update entries list when a player is eliminated
        setEntries((prev) =>
          prev.map((e) =>
            e.user_id === event.payload.userId
              ? { ...e, status: 'eliminated' as const, position: event.payload.position }
              : e
          )
        );
        // BUG FIX: guard against undefined position — getOrdinal(undefined) would
        // produce "undefinedth" which reads as a broken toast message.
        const pos = event.payload.position;
        const posText = pos != null ? `${pos}${getOrdinal(pos)} place` : 'eliminated';
        toast.info(`${event.payload.username} ${posText}`);
      },
      300
    );

    const unsubMerge = masterBus.subscribeDebounced(
      'TABLE_MERGED',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        // Remove the closed source table from the tables list
        setTables((prev) => prev.filter((t) => t.id !== event.payload.sourceTableId));
        toast.info(`Table merged — ${event.payload.playersMoved} players moved`);
      },
      300
    );

    // ── Blind level changes: update tournament state immediately ──
    const unsubBlind = masterBus.subscribeDebounced(
      'BLIND_LEVEL_CHANGE',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        setTournament((prev: any) =>
          prev ? { ...prev, current_level: event.payload.level } : prev
        );
      },
      300
    );

    // ── Tournament break notifications ──
    const unsubBreak = masterBus.subscribeDebounced(
      'TOURNAMENT_BREAK',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        toast.info('Tournament break — play resumes shortly');
      },
      300
    );

    const unsubBreakEnd = masterBus.subscribeDebounced(
      'TOURNAMENT_BREAK_END',
      (event) => {
        if (event.payload.tournamentId !== tournamentId) return;
        toast.info('Break over — play resuming');
      },
      300
    );

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubElim();
      unsubMerge();
      unsubBlind();
      unsubBreak();
      unsubBreakEnd();
    };
  }, [tournamentId]);

  // ── Refresh wallet balance when BALANCE_UPDATED fires ──
  useEffect(() => {
    if (!user?.id) return;
    const unsub = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadWalletBalance();
      },
      500
    );
    return () => unsub();
  }, [user?.id]);

  // ── Refresh tournament data when tournament is updated ──
  useMasterBusSubscription(
    'TOURNAMENT_UPDATED',
    () => {
      if (tournamentId) {
        loadTournament();
      }
    },
    { debounce: 500 }
  );

  useEffect(() => {
    if (tournament?.start_time) {
      startCountdown();
    }
  }, [tournament]);

  // Re-check registration status when user hydrates after tournament loaded
  useEffect(() => {
    if (user && tournament && entries.length > 0) {
      const registered = entries.some((e) => e.user_id === user.id);
      setIsRegistered(registered);
    }
  }, [user, entries]);

  // Stagger animation for entries
  useEffect(() => {
    if (entries.length === 0) return;
    setVisibleEntries(new Set());
    entries.forEach((entry, index) => {
      setTimeout(() => {
        setVisibleEntries((prev) => new Set(prev).add(entry.id));
      }, index * 60);
    });
  }, [entries]);

  const loadTournament = async (getIsMounted?: () => boolean) => {
    if (!tournamentId) return;
    if (!getIsMounted || getIsMounted()) setIsLoading(true);
    try {
      const data = await tournamentService.getTournament(tournamentId);
      if (getIsMounted && !getIsMounted()) return;
      setTournament(data);

      if (data) {
        // Fetch tournament entries from supabase
        const { data: playersData, error } = await supabase
          .from('tournament_players')
          .select('id, user_id, username, chips, status, position, table_id')
          .eq('tournament_id', data.id)
          .order('registered_at', { ascending: true });

        if (getIsMounted && !getIsMounted()) return;

        if (!error && playersData) {
          setEntries(
            playersData.map(
              (e: {
                id: string;
                user_id: string;
                username?: string | null;
                chips?: number;
                status: string;
                position?: number | null;
                club_id?: string | null;
                table_id?: string | null;
              }) => ({
                id: e.id,
                user_id: e.user_id,
                username: e.username || 'Player',
                avatar_url: null,
                chips: e.chips || data.starting_chips,
                position: e.position || undefined,
                status: e.status as TournamentEntry['status'],
                club_id: e.club_id || undefined,
                table_id: e.table_id || null,
              })
            )
          );

          // Check if current user is registered
          if (user) {
            const isUserRegistered = playersData.some(
              (e: { user_id: string }) => e.user_id === user.id
            );
            setIsRegistered(isUserRegistered);
          }
        } else {
          setEntries([]);
        }

        // Fetch tournament tables
        if (data.status === 'RUNNING') {
          const { data: tablesData } = await supabase
            .from('tables')
            .select('id, name, status, max_players, current_players, small_blind, big_blind')
            .eq('tournament_id', data.id);
          if (!getIsMounted || getIsMounted()) {
            setTables((tablesData || []) as TournamentTable[]);
          }
        }

        // Fetch union name for XMTT tournaments
        if ((data as any).is_xmtt && (data as any).union_id) {
          try {
            const { data: unionData } = await supabase
              .from('unions')
              .select('name')
              .eq('id', (data as any).union_id)
              .maybeSingle();
            if (unionData?.name && (!getIsMounted || getIsMounted())) setUnionName(unionData.name);
          } catch (e) {
            reportError(e, 'TournamentDetails');
            /* non-critical */
          }
        }
      }
    } catch (error) {
      reportError(error, 'TournamentDetails.Failed_to_load_tournament');
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load tournament details');
    }
    if (!getIsMounted || getIsMounted()) setIsLoading(false);
  };

  const startCountdown = () => {
    if (timerRef.current) clearInterval(timerRef.current);

    const updateCountdown = () => {
      if (!tournament) return;

      const now = new Date().getTime();

      // For RUNNING tournaments, show elapsed time since start
      if (tournament.status === 'RUNNING' && tournament.started_at) {
        const started = new Date(tournament.started_at).getTime();
        const elapsed = now - started;

        const hours = Math.floor(elapsed / (1000 * 60 * 60));
        const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);

        setCountdown({ hours, minutes, seconds });
        return;
      }

      // For COMPLETED tournaments, show total duration
      if (tournament.status === 'COMPLETED' && tournament.started_at && tournament.ended_at) {
        const started = new Date(tournament.started_at).getTime();
        const ended = new Date(tournament.ended_at).getTime();
        const duration = ended - started;

        const hours = Math.floor(duration / (1000 * 60 * 60));
        const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((duration % (1000 * 60)) / 1000);

        setCountdown({ hours, minutes, seconds });
        if (timerRef.current) clearInterval(timerRef.current);
        return;
      }

      // For upcoming tournaments, countdown to start
      if (!tournament.start_time) return;
      const start = new Date(tournament.start_time).getTime();
      const diff = start - now;

      if (diff <= 0) {
        setCountdown({ hours: 0, minutes: 0, seconds: 0 });
        if (timerRef.current) clearInterval(timerRef.current);
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setCountdown({ hours, minutes, seconds });
    };

    updateCountdown();
    timerRef.current = setInterval(updateCountdown, 1000);
  };

  const handleRegister = async () => {
    if (isProcessing || !tournament) return;
    if (!user) {
      toast.error('Loading your profile... please try again in a moment');
      return;
    }
    setShowSignUpModal(false);
    setIsProcessing(true);

    try {
      await tournamentService.registerPlayer(tournament.id, user.id, user.username || 'Player');
      setIsRegistered(true);
      // Defer reload so the UI updates instantly (fixes INP)
      setTimeout(() => loadTournament(), 50);
    } catch (error) {
      reportError(error, 'TournamentDetails.Registration_failed');
      const msg = (error as Error).message || 'Unknown error';
      toast.error(`Registration failed: ${msg}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnregister = async () => {
    if (isProcessing || !tournament) return;
    if (!user) {
      toast.error('Loading your profile... please try again in a moment');
      return;
    }
    setIsProcessing(true);

    try {
      await tournamentService.unregisterPlayer(tournament.id, user.id);
      setIsRegistered(false);
      toast.success('Unregistered — buy-in refunded to your wallet');
      // Defer reload so the UI updates instantly (fixes INP)
      setTimeout(() => loadTournament(), 50);
    } catch (error) {
      reportError(error, 'TournamentDetails.Unregistration_failed');
      const msg = (error as Error).message || 'Unknown error';
      toast.error(`Unregister failed: ${msg}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatCountdown = () => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(countdown.hours)}:${pad(countdown.minutes)}:${pad(countdown.seconds)}`;
  };

  const formatDate = (date: string | null | undefined) => {
    if (!date) return 'TBD';
    return new Date(date)
      .toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      .replace(',', '');
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: 'detail', label: 'Detail' },
    { id: 'entries', label: 'Entries' },
    { id: 'ranking', label: 'Ranking' },
    { id: 'unions', label: 'Unions' },
    { id: 'tables', label: 'Tables' },
    { id: 'rewards', label: 'Rewards' },
  ];

  if (isLoading) {
    return (
      <div className="tournament-details loading">
        <div className="loader-spinner" />
        <p>Loading tournament...</p>
      </div>
    );
  }

  if (!tournament) {
    return (
      <div className="tournament-details error">
        <h2>Tournament not found</h2>
        <Link to="/clubs" className="btn btn-primary">
          Back to Clubs
        </Link>
      </div>
    );
  }

  return (
    <PageErrorBoundary pageName="TournamentDetails">
      <div className="tournament-details">
        {/* Header */}
        <div className="details-header">
          <h1>Game Details</h1>
        </div>

        {/* Tabs */}
        <div className="details-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tournament Title */}
        <div className="tournament-title">
          <h2>{tournament.name}</h2>
          <span className="tournament-id">ID:{tournament.id.slice(0, 8)}</span>
          <button className="qr-btn">⊞</button>
        </div>

        {/* Tournament Description */}
        <div className="tournament-desc">
          <p>{tournament.name}</p>
          <p>
            {tournament.buy_in_amount}+{tournament.buy_in_fee || 0} CHIPS BUY-IN
          </p>
          <p>
            {(tournament as any).variant === 'sng'
              ? 'SIT & GO'
              : (tournament as any).variant === 'spin'
                ? 'SPIN & GO'
                : (tournament as any).is_bounty &&
                    !(tournament as any).is_pko &&
                    !(tournament as any).is_mystery_bounty
                  ? 'BOUNTY KO'
                  : (tournament as any).is_pko
                    ? 'PROGRESSIVE KO'
                    : (tournament as any).is_mystery_bounty
                      ? 'MYSTERY BOUNTY'
                      : 'FREEZEOUT'}
            {' / '}
            {(tournament as any).is_rebuy ? 'REBUY' : 'NO REBUY'}
            {' / '}
            {(tournament as any).add_on_available ? 'ADD-ON' : 'NO ADD-ON'}
          </p>
          {(tournament as any).is_bounty && (
            <p style={{ color: '#f87171', fontWeight: 600 }}>
              BOUNTY: {(tournament as any).bounty_amount || 0} CHIPS PER KO
              {(tournament as any).is_pko && ' (50/50 SPLIT)'}
            </p>
          )}
          {(tournament as any).is_multi_day && (
            <p style={{ color: '#22d3ee' }}>
              MULTI-DAY: {(tournament as any).total_days || 2} DAYS
            </p>
          )}
          {(tournament as any).is_xmtt && (
            <p style={{ color: '#a78bfa' }}>UNION TOURNAMENT (XMTT)</p>
          )}
          {((tournament as any).variant === 'spin' ||
            (tournament as any).tournament_type === 'SPIN') && (
            <p style={{ color: '#fbbf24', fontWeight: 700 }}>
              SPIN & GO{' '}
              {(tournament as any).spin_multiplier
                ? `— ${(tournament as any).spin_multiplier}x MULTIPLIER`
                : '— Multiplier revealed at start'}
            </p>
          )}
        </div>

        {activeTab === 'detail' && (
          <>
            {/* Tournament Results (for completed tournaments) */}
            {tournament.status === 'COMPLETED' && entries.length > 0 && (
              <div className="results-summary">
                <h3>Final Results</h3>
                <div className="results-podium">
                  {entries
                    .filter((e) => e.position && e.position <= 3)
                    .sort((a, b) => (a.position || 99) - (b.position || 99))
                    .map((player) => {
                      const payoutArr = (() => {
                        const raw = tournament.payout_structure;
                        if (!raw) return [];
                        if (Array.isArray(raw)) return raw;
                        if (typeof raw === 'string') {
                          try {
                            return JSON.parse(raw);
                          } catch {
                            return [];
                          }
                        }
                        return [];
                      })();
                      const payoutEntry = payoutArr.find(
                        (p: any) => (p.place || p.position) === player.position
                      );
                      const prize = payoutEntry
                        ? Math.trunc(
                            (tournament.prize_pool || 0) * (payoutEntry as any).percentage
                          ) / 100
                        : 0;
                      return (
                        <div
                          key={player.user_id}
                          className={`podium-card place-${player.position}`}
                        >
                          <span className="podium-medal">
                            {player.position === 1 && '🥇'}
                            {player.position === 2 && '🥈'}
                            {player.position === 3 && '🥉'}
                          </span>
                          <span className="podium-name">{player.username}</span>
                          <span className="podium-prize">
                            {prize > 0 ? `${prize.toLocaleString()} chips` : ''}
                          </span>
                        </div>
                      );
                    })}
                </div>
                <div className="results-full-list">
                  {entries
                    .filter((e) => e.position)
                    .sort((a, b) => (a.position || 99) - (b.position || 99))
                    .slice(0, 10)
                    .map((player) => (
                      <div key={player.user_id} className="result-row">
                        <span className="result-position">#{player.position}</span>
                        <span className="result-name">{player.username}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Countdown Timer */}
            <div className="countdown-section">
              <div className="countdown-display">{formatCountdown()}</div>
              <div className="start-time">
                {tournament.status === 'RUNNING' ? (
                  <span>Running since {formatDate(tournament.started_at)}</span>
                ) : tournament.status === 'COMPLETED' ? (
                  <span>Completed — Total Duration</span>
                ) : (
                  <span>Starts {formatDate(tournament.start_time)}</span>
                )}
              </div>
            </div>

            {/* Tournament Clock (live blind level timer) */}
            {tournament.status === 'RUNNING' && tournamentId && (
              <TournamentClock tournamentId={tournamentId} />
            )}

            {/* Hand-for-Hand Banner (bubble play active) */}
            {tournament.status === 'RUNNING' && (tournament as any).hand_for_hand && (
              <HandForHandBanner
                active={(tournament as any).hand_for_hand}
                playersRemaining={entries.filter((e) => e.status === 'playing').length}
                paidPositions={(() => {
                  const raw = tournament.payout_structure;
                  if (!raw) return 0;
                  if (Array.isArray(raw)) return raw.length;
                  if (typeof raw === 'string') {
                    try {
                      return JSON.parse(raw).length;
                    } catch {
                      return 0;
                    }
                  }
                  return 0;
                })()}
              />
            )}

            {/* Quick Stats */}
            <div className="quick-stats">
              <div className="stat">
                <span className="stat-label">Status</span>
                <span className="stat-value">{tournament.status}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Current Level</span>
                <span className="stat-value">
                  {(() => {
                    // Reference clockTick so this re-renders every second.
                    void clockTick;
                    if (tournament.status !== 'RUNNING') {
                      return tournament.current_level || '-';
                    }
                    try {
                      const ls = tournamentService.getCurrentLevelState(tournament);
                      const secs = Math.max(0, Math.floor(ls.timeRemainingSeconds));
                      const mm = Math.floor(secs / 60);
                      const ss = (secs % 60).toString().padStart(2, '0');
                      const label = ls.currentLevel?.isBreak ? 'Break' : `Lv ${ls.levelIndex + 1}`;
                      return `${label} · ${mm}:${ss}`;
                    } catch {
                      return tournament.current_level || 1;
                    }
                  })()}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Remaining</span>
                <span className="stat-value">
                  {
                    entries.filter((e) => e.status === 'playing' || e.status === 'registered')
                      .length
                  }
                  {tournament.max_players ? `/${tournament.max_players}` : ''}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Avg. Stack</span>
                <span className="stat-value">
                  {entries.filter((e) => e.status === 'playing').length > 0
                    ? Math.trunc(
                        entries
                          .filter((e) => e.status === 'playing')
                          .reduce((s, e) => s + (e.chips || 0), 0) /
                          entries.filter((e) => e.status === 'playing').length
                      ).toLocaleString()
                    : tournament.starting_chips
                      ? tournament.starting_chips.toLocaleString()
                      : '—'}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Tables</span>
                <span className="stat-value">{tables.length}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Eliminated</span>
                <span className="stat-value">
                  {entries.filter((e) => e.status === 'eliminated').length}
                </span>
              </div>
            </div>

            {/* Game Info */}
            <div className="game-info-section">
              <div className="info-row">
                <span className="info-label">Game Type:</span>
                <span className="info-value highlight">
                  {(tournament.game_type || 'nlh').toUpperCase()}
                  {tournament.max_players ? ` (${tournament.max_players} max)` : ''}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">Buy-in:</span>
                <span className="info-value">
                  {tournament.buy_in_amount}+{tournament.buy_in_fee || 0} chips
                  {(tournament as any).is_rebuy && <span className="badge-reentry">Rebuy</span>}
                </span>
              </div>
              {(() => {
                // TOURNEY-AUDIT 2026-07-24 (sweep 4): DB pool is authoritative
                // (fee-stripped, horse-free); buy_in × entries over-advertised.
                const hasGuarantee = (tournament.guaranteed_prize || 0) > 0;
                const effectivePrizePool = hasGuarantee
                  ? Math.max(tournament.prize_pool || 0, tournament.guaranteed_prize || 0)
                  : tournament.prize_pool || 0;
                return (
                  <div className="info-row">
                    <span className="info-label">Prize Pool:</span>
                    <span className="info-value">
                      {effectivePrizePool > 0
                        ? effectivePrizePool.toLocaleString()
                        : 'Based on entries'}
                      {hasGuarantee && (
                        <>
                          {' '}
                          <span className="badge-gtd">
                            {(tournament.guaranteed_prize || 0).toLocaleString()} GTD
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                );
              })()}
              <div className="info-half-grid">
                <div className="info-row half">
                  <span className="info-label">Entries:</span>
                  <span className="info-value">{entries.length}</span>
                </div>
                <div className="info-row half">
                  <span className="info-label">Max Entries:</span>
                  <span className="info-value">{tournament.max_players || 'Unlimited'}</span>
                </div>
                <div className="info-row half">
                  <span className="info-label">Rebuy:</span>
                  <span className="info-value">
                    {(tournament as any).is_rebuy
                      ? `${((tournament as any).rebuy_chips || tournament.starting_chips || 0).toLocaleString()} chips — through Level ${(tournament as any).late_reg_levels ?? (tournament as any).rebuy_levels ?? 8}`
                      : (tournament as any).is_reentry
                        ? `Re-Entry — through Level ${(tournament as any).late_reg_levels ?? (tournament as any).rebuy_levels ?? 8}`
                        : 'Not Available'}
                  </span>
                </div>
                <div className="info-row half">
                  <span className="info-label">Add-on:</span>
                  <span className="info-value">
                    {(tournament as any).add_on_available
                      ? `${((tournament as any).addon_chips || tournament.starting_chips || 0).toLocaleString()} chips — Level ${(tournament as any).late_reg_levels ?? (tournament as any).rebuy_levels ?? 8} to ${((tournament as any).late_reg_levels ?? (tournament as any).rebuy_levels ?? 8) + ((tournament as any).addon_levels ?? 1)}`
                      : 'Not Available'}
                  </span>
                </div>
                <div className="info-row half">
                  <span className="info-label">Starting Chips:</span>
                  <span className="info-value">
                    {tournament.starting_chips ? tournament.starting_chips.toLocaleString() : '—'}
                  </span>
                </div>
                <div className="info-row half">
                  <span className="info-label">Big Blind Ante:</span>
                  <span className="info-value">
                    {(() => {
                      const blinds =
                        typeof tournament.blind_structure === 'string'
                          ? (() => {
                              try {
                                return JSON.parse(tournament.blind_structure);
                              } catch {
                                return [];
                              }
                            })()
                          : tournament.blind_structure || [];
                      return blinds.some((b: any) => (b.ante || 0) > 0) ? 'Yes' : 'No';
                    })()}
                  </span>
                </div>
                {((tournament as any).late_reg_levels || (tournament as any).late_reg_mins || 0) >
                  0 && (
                  <div className="info-row half">
                    <span className="info-label">Late Registration:</span>
                    <span className="info-value">
                      Through Level{' '}
                      {(tournament as any).late_reg_levels || (tournament as any).late_reg_mins}
                    </span>
                  </div>
                )}
              </div>
              {(tournament as any).is_bounty && (
                <div className="info-row">
                  <span className="info-label">Bounty:</span>
                  <span className="info-value" style={{ color: '#f87171' }}>
                    {(tournament as any).bounty_amount || 0} chips per knockout
                    {(tournament as any).is_pko &&
                      ' (Progressive: 50% to knocker, 50% added to bounty)'}
                    {(tournament as any).is_mystery_bounty &&
                      (tournament as any).mystery_bounty_min != null &&
                      ` (Mystery: ${(tournament as any).mystery_bounty_min}x - ${(tournament as any).mystery_bounty_max}x)`}
                  </span>
                </div>
              )}
              <div className="info-row">
                <span className="info-label">Blind Structure:</span>
                <span className="info-value">
                  {(() => {
                    const blinds =
                      typeof tournament.blind_structure === 'string'
                        ? (() => {
                            try {
                              return JSON.parse(tournament.blind_structure);
                            } catch {
                              return [];
                            }
                          })()
                        : tournament.blind_structure || [];
                    if (blinds.length === 0) return 'Standard';
                    const dur = blinds[0]?.duration_minutes || blinds[0]?.durationMinutes || 0;
                    return dur <= 5 ? 'Turbo' : dur <= 10 ? 'Regular' : 'Deep Stack';
                  })()}
                </span>
              </div>
              {((tournament as any).variant === 'spin' ||
                (tournament as any).tournament_type === 'SPIN') && (
                <div className="info-row">
                  <span className="info-label">Spin Multiplier:</span>
                  <span className="info-value" style={{ color: '#fbbf24', fontWeight: 700 }}>
                    {(tournament as any).spin_multiplier
                      ? `${(tournament as any).spin_multiplier}x`
                      : 'Revealed at game start'}
                  </span>
                </div>
              )}
              {(tournament as any).is_multi_day && (
                <div className="info-row">
                  <span className="info-label">Multi-Day:</span>
                  <span className="info-value" style={{ color: '#22d3ee' }}>
                    Day {(tournament as any).day_number || 1} of{' '}
                    {(tournament as any).total_days || 2}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'entries' &&
          (() => {
            const isRunning = tournament.status === 'RUNNING';
            // Sort: playing players by chips (desc), then eliminated by position (asc), then registered
            const sorted = [...entries].sort((a, b) => {
              const statusOrder: Record<string, number> = {
                playing: 0,
                registered: 1,
                winner: -1,
                eliminated: 2,
              };
              const aOrder = statusOrder[a.status] ?? 3;
              const bOrder = statusOrder[b.status] ?? 3;
              if (aOrder !== bOrder) return aOrder - bOrder;
              if (a.status === 'playing' || a.status === 'registered')
                return (b.chips || 0) - (a.chips || 0);
              if (a.status === 'eliminated') return (a.position || 999) - (b.position || 999);
              return 0;
            });

            // ITM (in the money) calculation
            const payoutCount = tournament.payout_structure
              ? typeof tournament.payout_structure === 'string'
                ? (() => {
                    try {
                      return JSON.parse(tournament.payout_structure).length;
                    } catch {
                      return 0;
                    }
                  })()
                : Array.isArray(tournament.payout_structure)
                  ? tournament.payout_structure.length
                  : 0
              : 0;
            const playingCount = entries.filter((e) => e.status === 'playing').length;
            const isBubble = isRunning && payoutCount > 0 && playingCount === payoutCount + 1;

            return (
              <div className="entries-list">
                {isRunning && (
                  <div
                    className="chip-leader-header"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <span>Rank</span>
                    <span>Player</span>
                    <span>Chips</span>
                    <span>Status</span>
                  </div>
                )}
                {isBubble && (
                  <div
                    style={{
                      background: 'rgba(245,158,11,0.15)',
                      color: '#f59e0b',
                      padding: '8px 12px',
                      fontSize: 13,
                      textAlign: 'center',
                      borderRadius: 8,
                      margin: '8px 0',
                    }}
                  >
                    BUBBLE — {playingCount} players left, {payoutCount} get paid
                  </div>
                )}
                {sorted.length === 0 ? (
                  <div className="empty-state">
                    <p>No entries yet. Be the first to register!</p>
                  </div>
                ) : (
                  sorted.map((entry, idx) => {
                    const isPlaying = entry.status === 'playing';
                    const rank = isPlaying ? idx + 1 : entry.position || '—';
                    return (
                      <div
                        key={entry.id}
                        className={`entry-row ${entry.status === 'eliminated' ? 'eliminated-row' : ''} ${visibleEntries.has(entry.id) ? 'fadeInUp' : 'hidden'}`}
                        style={
                          visibleEntries.has(entry.id)
                            ? entry.status === 'eliminated'
                              ? { opacity: 0.5 }
                              : undefined
                            : { opacity: 0, transform: 'translateY(8px)' }
                        }
                      >
                        <span
                          className="entry-rank"
                          style={
                            isPlaying && idx === 0
                              ? { color: '#fbbf24', fontWeight: 700 }
                              : undefined
                          }
                        >
                          {rank}
                        </span>
                        <div className="entry-avatar"></div>
                        <div className="entry-info">
                          <span className="entry-name">{entry.username}</span>
                          <span className="entry-chips">
                            {isPlaying
                              ? `${(entry.chips || 0).toLocaleString()} chips`
                              : entry.status === 'eliminated'
                                ? `Eliminated ${entry.position ? `#${entry.position}` : ''}`
                                : entry.status === 'winner'
                                  ? 'WINNER'
                                  : 'Registered'}
                          </span>
                        </div>
                        <span className={`entry-status ${entry.status}`}>{entry.status}</span>
                      </div>
                    );
                  })
                )}
              </div>
            );
          })()}

        {activeTab === 'ranking' && (
          <div className="ranking-section">
            <TournamentStandings
              tournamentId={tournamentId || ''}
              totalPlayers={
                tournament.max_players || entries.length || tournament.current_players || 0
              }
            />
          </div>
        )}

        {activeTab === 'unions' && (
          <div className="unions-section">
            {(tournament as any).is_xmtt && (tournament as any).union_id ? (
              <div className="union-info">
                <h3>Union Tournament (XMTT)</h3>
                <div className="info-row">
                  <span className="info-label">Union:</span>
                  <span className="info-value">
                    {unionName || ((tournament as any).union_id || '').slice(0, 8)}
                  </span>
                </div>
                <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 8 }}>
                  This tournament spans multiple clubs within the union. Players from all member
                  clubs can participate.
                </p>
                <div className="info-row">
                  <span className="info-label">Participating Clubs:</span>
                  <span className="info-value">
                    {(() => {
                      const uniqueClubs = new Set(
                        entries.map((e) => (e as any).club_id).filter(Boolean)
                      );
                      return uniqueClubs.size > 0
                        ? `${uniqueClubs.size} clubs`
                        : 'All union clubs eligible';
                    })()}
                  </span>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <p>This is a club tournament, not a union (XMTT) event.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'tables' && (
          <div className="tables-section">
            <div className="tables-header">
              <h3>Active Tables ({tables.length})</h3>
              <span className="table-balance-indicator">Auto-balancing enabled</span>
            </div>
            <div className="tables-grid">
              {tables.length === 0 ? (
                <div className="empty-state">
                  <p>
                    {tournament.status === 'RUNNING'
                      ? 'Loading tables...'
                      : 'Tables will be created when the tournament starts.'}
                  </p>
                </div>
              ) : (
                tables.map((table, idx) => (
                  <Link
                    key={table.id}
                    to={`/table/${table.id}`}
                    className="table-card"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <div className="table-num">{table.name || `Table ${idx + 1}`}</div>
                    <div className="table-players">
                      {table.current_players}/{table.max_players} players
                    </div>
                    <div className="table-blinds">
                      {table.small_blind}/{table.big_blind}
                    </div>
                    <div className="table-status">{table.status}</div>
                  </Link>
                ))
              )}
            </div>
            <div className="balance-info">
              <p>Tables are automatically balanced when player counts differ by 2+</p>
            </div>
          </div>
        )}

        {activeTab === 'rewards' &&
          (() => {
            const entryCount = entries.length || tournament.current_players || 0;
            const dbPrizePool = tournament.prize_pool || 0; // Live from DB (updated on reg, rebuy, addon)
            const hasGuarantee = (tournament.guaranteed_prize || 0) > 0;
            // TOURNEY-AUDIT 2026-07-24 (sweep 4): the DB pool is authoritative
            // (server recalculates it on every registration/rebuy/add-on, fee
            // stripped, horses excluded). The old `buy_in × entries` overlay
            // counted FREE horse entries and ignored the fee split, so the
            // rewards tab advertised prizes larger than what would be paid.
            const effectivePrizePool = hasGuarantee
              ? Math.max(dbPrizePool, tournament.guaranteed_prize || 0)
              : dbPrizePool;

            // Resolve payout structure — use DB if available, otherwise auto-select by entry count
            const resolvePayouts = (): { place: number; percentage: number }[] => {
              const raw = tournament.payout_structure;
              if (raw) {
                const parsed =
                  typeof raw === 'string'
                    ? (() => {
                        try {
                          return JSON.parse(raw);
                        } catch {
                          return [];
                        }
                      })()
                    : raw;
                if (Array.isArray(parsed) && parsed.length > 0) {
                  return parsed.map((p: any) => ({
                    place: p.place || p.position || 0,
                    percentage: p.percentage || 0,
                  }));
                }
              }
              // Auto-select based on entry count (matches TournamentEngine logic)
              if (entryCount <= 3)
                return [
                  { place: 1, percentage: 65 },
                  { place: 2, percentage: 35 },
                ];
              if (entryCount <= 6)
                return [
                  { place: 1, percentage: 65 },
                  { place: 2, percentage: 35 },
                ];
              if (entryCount <= 9)
                return [
                  { place: 1, percentage: 50 },
                  { place: 2, percentage: 30 },
                  { place: 3, percentage: 20 },
                ];
              if (entryCount <= 18)
                return [
                  { place: 1, percentage: 50 },
                  { place: 2, percentage: 30 },
                  { place: 3, percentage: 20 },
                ];
              if (entryCount <= 35)
                return [
                  { place: 1, percentage: 38 },
                  { place: 2, percentage: 27 },
                  { place: 3, percentage: 18 },
                  { place: 4, percentage: 10 },
                  { place: 5, percentage: 7 },
                ];
              return [
                { place: 1, percentage: 28 },
                { place: 2, percentage: 18 },
                { place: 3, percentage: 13 },
                { place: 4, percentage: 10 },
                { place: 5, percentage: 8 },
                { place: 6, percentage: 6 },
                { place: 7, percentage: 5 },
                { place: 8, percentage: 4.5 },
                { place: 9, percentage: 4 },
                { place: 10, percentage: 3.5 },
              ];
            };
            const payouts = resolvePayouts();
            const isAutoResolved =
              !tournament.payout_structure ||
              (typeof tournament.payout_structure === 'string'
                ? (() => {
                    try {
                      return JSON.parse(tournament.payout_structure).length === 0;
                    } catch {
                      return true;
                    }
                  })()
                : !Array.isArray(tournament.payout_structure) ||
                  tournament.payout_structure.length === 0);

            return (
              <div className="rewards-section">
                <h3>Payout Structure</h3>
                <div className="prize-pool-display">
                  <span className="prize-label">Total Prize Pool</span>
                  <span className="prize-amount">
                    {effectivePrizePool > 0
                      ? `${effectivePrizePool.toLocaleString()} chips`
                      : 'Based on entries'}
                  </span>
                  {hasGuarantee && (
                    <span className="prize-gtd">
                      {(tournament.guaranteed_prize || 0).toLocaleString()} GTD
                    </span>
                  )}
                </div>
                {isAutoResolved && entryCount > 0 && (
                  <p
                    style={{
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      fontStyle: 'italic',
                      margin: '4px 0 8px',
                    }}
                  >
                    Estimated payouts based on {entryCount} entries — final structure determined at
                    start
                  </p>
                )}
                <div className="payout-table">
                  {payouts.length > 0 ? (
                    payouts.map((payout) => (
                      <div key={payout.place} className="payout-row">
                        <span className="payout-place">
                          {payout.place === 1 && '1st'}
                          {payout.place === 2 && '2nd'}
                          {payout.place === 3 && '3rd'}
                          {payout.place > 3 && `#${payout.place}`}
                        </span>
                        <span className="payout-percent">{payout.percentage}%</span>
                        <span className="payout-chips">
                          {effectivePrizePool > 0
                            ? (
                                Math.trunc(effectivePrizePool * payout.percentage) / 100
                              ).toLocaleString()
                            : '—'}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div
                      className="payout-row"
                      style={{
                        justifyContent: 'center',
                        color: 'var(--text-muted)',
                        fontStyle: 'italic',
                      }}
                    >
                      <span>Register to see estimated payouts</span>
                    </div>
                  )}
                </div>
                {tournament.blind_structure &&
                  (() => {
                    const blinds =
                      typeof tournament.blind_structure === 'string'
                        ? (() => {
                            try {
                              return JSON.parse(tournament.blind_structure);
                            } catch {
                              return [];
                            }
                          })()
                        : tournament.blind_structure;
                    return blinds.length > 0 ? (
                      <>
                        <h3 style={{ marginTop: '24px' }}>Blind Structure</h3>
                        <div className="blinds-table">
                          <div className="blinds-header">
                            <span>Level</span>
                            <span>Blinds</span>
                            <span>Ante</span>
                            <span>Duration</span>
                          </div>
                          {blinds.slice(0, 10).map((level: any) => (
                            <div
                              key={level.level}
                              className={`blinds-row ${tournament.current_level === level.level ? 'current-level' : ''}`}
                            >
                              <span className="level-num">{level.level}</span>
                              <span className="level-blinds">
                                {level.small_blind || level.smallBlind}/
                                {level.big_blind || level.bigBlind}
                              </span>
                              <span className="level-ante">{level.ante || '-'}</span>
                              <span className="level-duration">
                                {level.duration_minutes || level.durationMinutes}m
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null;
                  })()}
              </div>
            );
          })()}

        {/* Footer Actions */}
        <div className="details-footer">
          <button className="btn btn-share">Share</button>
          {(() => {
            const myEntry = entries.find((e) => e.user_id === user?.id);

            if (tournament.status === 'RUNNING') {
              if (myEntry?.status === 'playing' && myEntry.table_id) {
                return (
                  <Link
                    to={`/table/${myEntry.table_id}`}
                    className="btn btn-primary"
                    style={{
                      flex: 1,
                      backgroundColor: '#10b981',
                      textDecoration: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                    }}
                  >
                    ENTER TABLE
                  </Link>
                );
              }
              if (myEntry?.status === 'registered') {
                return (
                  <span
                    className="tournament-status-badge running"
                    style={{ color: '#fbbf24', borderColor: '#fbbf24' }}
                  >
                    WAITING FOR SEAT...
                  </span>
                );
              }
              if (myEntry?.status === 'eliminated') {
                return <span className="tournament-status-badge cancelled">ELIMINATED</span>;
              }
              if (!isRegistered && lateRegCountdown) {
                return (
                  <button
                    className="btn btn-register late-reg"
                    onClick={() => setShowSignUpModal(true)}
                  >
                    Late Register ({lateRegCountdown})
                  </button>
                );
              }
              return <span className="tournament-status-badge running">In Progress</span>;
            }

            if (tournament.status === 'COMPLETED') {
              return <span className="tournament-status-badge completed">Completed</span>;
            }
            if (tournament.status === 'CANCELLED') {
              return <span className="tournament-status-badge cancelled">Cancelled</span>;
            }

            if (isRegistered) {
              return (
                <button
                  className="btn btn-unregister"
                  onClick={handleUnregister}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Processing...' : 'Unregister'}
                </button>
              );
            }

            return (
              <button className="btn btn-register" onClick={() => setShowSignUpModal(true)}>
                Register
              </button>
            );
          })()}
        </div>

        {/* Sign Up Modal */}
        {showSignUpModal && (
          <div className="modal-overlay" onClick={() => setShowSignUpModal(false)}>
            <div className="signup-modal" onClick={(e) => e.stopPropagation()}>
              <button className="modal-close" onClick={() => setShowSignUpModal(false)}>
                ✕
              </button>
              <h2>Sign Up</h2>
              <div className="signup-row">
                <span className="signup-label">Buy-in:</span>
                <span className="signup-value">{tournament.buy_in_amount} chips</span>
              </div>
              <div className="signup-row">
                <span className="signup-label">Rake (fee):</span>
                <span className="signup-value">{tournament.buy_in_fee || 0} chips</span>
              </div>
              <div className="signup-row total">
                <span className="signup-label">Total:</span>
                <span className="signup-value">
                  {tournament.buy_in_amount + (tournament.buy_in_fee || 0)} chips
                </span>
              </div>
              {(tournament as any).is_bounty && (
                <div className="signup-row">
                  <span className="signup-label">Bounty:</span>
                  <span className="signup-value" style={{ color: '#f87171' }}>
                    {(tournament as any).bounty_amount || 0} chips
                    {(tournament as any).is_pko && ' (PKO)'}
                    {(tournament as any).is_mystery_bounty && ' (Mystery)'}
                  </span>
                </div>
              )}
              <div className="signup-row">
                <span className="signup-label">Start time:</span>
                <span className="signup-value">{formatDate(tournament.start_time)}</span>
              </div>
              <div
                className="signup-row"
                style={{
                  borderTop: '1px solid rgba(255,255,255,0.1)',
                  paddingTop: 8,
                  marginTop: 4,
                }}
              >
                <span className="signup-label">Your Balance:</span>
                <span
                  className="signup-value"
                  style={{
                    color:
                      walletBalance >= tournament.buy_in_amount + (tournament.buy_in_fee || 0)
                        ? '#10b981'
                        : '#ef4444',
                  }}
                >
                  {walletBalance.toLocaleString()} chips
                </span>
              </div>
              {walletBalance < tournament.buy_in_amount + (tournament.buy_in_fee || 0) && (
                <p className="signup-note" style={{ color: '#ef4444' }}>
                  Insufficient balance. Please add chips via your Cashier.
                </p>
              )}
              <p className="signup-note">Cannot unregister within 1 minute of the start time</p>
              <div className="signup-actions">
                <button className="btn btn-cancel" onClick={() => setShowSignUpModal(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-confirm"
                  onClick={handleRegister}
                  disabled={
                    isProcessing ||
                    walletBalance < tournament.buy_in_amount + (tournament.buy_in_fee || 0)
                  }
                >
                  {isProcessing ? 'Processing...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Final Table Overlay */}
      {tournament.status === 'RUNNING' && tournamentId && (
        <FinalTableOverlay
          tournamentId={tournamentId}
          tournamentName={tournament.name || 'Tournament'}
          prizePool={tournament.prize_pool || 0}
        />
      )}
    </PageErrorBoundary>
  );
}

export { TournamentDetails };
