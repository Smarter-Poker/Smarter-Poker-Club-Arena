/**
 * ♠ CLUB ARENA — Tournament Lobby Page
 * Register and view upcoming tournaments
 */

import { useState, useEffect, useRef, useMemo } from 'react';
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
import HandReplayViewer from '../components/gameplay/HandReplayViewer';
import { tableService } from '../services/TableService';
// Tournament registration/refunds handled via TournamentService → Player Wallet RPCs
import { useToast } from '../components/common/Toast';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import ClubBottomNav from '../components/club/ClubBottomNav';
import MysteryBountyReveal from '../components/tournament/MysteryBountyReveal';
import { reportError } from '../utils/errorReporter';

type TournFilter = 'all' | 'freeroll' | 'micro' | 'highroller';

// Default fallback for unauthed (shouldn't happen in real app)
const GUEST_USER = { id: 'guest', username: 'Guest' };

export default function TournamentPage() {
  useEffect(() => {
    document.title = 'Tournaments | Smarter Poker';
  }, []);

  const { clubId, tournamentId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const currentUser = user || GUEST_USER;

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);
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
        setIsOwner(data?.role === 'owner' || data?.role === 'admin');
      } catch {
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
      } catch {
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
        } catch {
          /* corrupt cache */
        }

        const data = await tournamentService.getTournaments(clubId);
        if (!isMounted) return;
        setTournaments(data);

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

  // Stagger animation for tournament cards
  useEffect(() => {
    if (tournaments.length === 0) return;
    setVisibleTournaments(new Set());
    const timers = tournaments.map((tourn, index) =>
      setTimeout(() => {
        setVisibleTournaments((prev) => new Set(prev).add(tourn.id));
      }, index * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [tournaments]);

  // Refresh tournament list when user returns to tab
  useVisibilityRefresh(async () => {
    if (!clubId) return;
    const data = await tournamentService.getTournaments(clubId);
    setTournaments(data);
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
                setTournaments(data);
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
            reportError(err?.message || err, 'TournamentPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[TournamentPage] ⏱️ Realtime channel timed out');
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
          setTournaments(data);
        } catch {
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
          setTournaments(data);
          const updated = data.find((t) => t.id === selectedTournamentRef.current?.id);
          if (updated) setSelectedTournament(updated);
        } catch {
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
  const handleRegister = async () => {
    if (!selectedTournament) return;
    if (currentUser.id === 'guest') {
      toast.error('You must be logged in to register');
      return;
    }
    try {
      // NOTE: Do NOT call WalletService.lockForBuyIn here — registerPlayer()
      // already handles wallet deduction atomically (buy_in + rake).
      // Calling both would double-deduct the player's chips.

      await tournamentService.registerPlayer(
        selectedTournament.id,
        currentUser.id,
        currentUser.username
      );
      setIsRegistered(true);

      // Update tournament in list (prize pool = buy_in + rake)
      const prizeContribution = selectedTournament.buy_in_amount;
      setTournaments((prev) =>
        prev.map((t) =>
          t.id === selectedTournament.id
            ? {
                ...t,
                current_players: t.current_players + 1,
                prize_pool: t.prize_pool + prizeContribution,
              }
            : t
        )
      );
      setSelectedTournament((prev) =>
        prev
          ? {
              ...prev,
              current_players: prev.current_players + 1,
              prize_pool: prev.prize_pool + prizeContribution,
            }
          : null
      );

      notifyWalletChange(selectedTournament.buy_in_amount, true);

      toast.success(`Registered! ${selectedTournament.buy_in_amount} chips deducted.`);
    } catch (error) {
      toast.error('Registration failed: ' + (error as Error).message);
    }
  };

  const handleStart = async () => {
    if (!selectedTournament || !clubId) return;
    try {
      await tournamentService.startTournament(selectedTournament.id);
      // Refresh
      const data = await tournamentService.getTournaments(clubId);
      setTournaments(data);
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

      const prizeContribution = selectedTournament.buy_in_amount;
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

      notifyWalletChange(selectedTournament.buy_in_amount, false);

      toast.success(`Unregistered! ${selectedTournament.buy_in_amount} chips refunded.`);
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
  }, [selectedTournament, currentUser.id]);

  // ── Broadcast: Tournament events (level_up, player_eliminated, etc) ──
  useEffect(() => {
    if (!selectedTournament?.id) return;

    const channelKey = `t-break-${selectedTournament.id}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('broadcast', { event: 'tournament_event' }, (payload) => {
        const eventType = payload.payload?.type;
        const data = payload.payload?.data;

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
            toast.success('Break ended — play resumes');
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
          reportError(err?.message || err, 'TournamentPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[TournamentPage] ⏱️ Realtime channel timed out');
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
    return tournaments.filter((t) => {
      if (filter === 'freeroll') return t.buy_in_amount === 0;
      if (filter === 'micro') return t.buy_in_amount > 0 && t.buy_in_amount <= 1000;
      if (filter === 'highroller') return t.buy_in_amount >= 10000;
      return true;
    });
  }, [tournaments, filter]);

  // ─── Countdown Timer Hook (Initiative 2) ───────────────────────────
  const [countdownStr, setCountdownStr] = useState<Record<string, string>>({});

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const times: Record<string, string> = {};
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
        }
      });
      setCountdownStr(times);
    }, 1000);
    return () => clearInterval(interval);
  }, [tournaments]);

  if (isLoading) {
    return (
      <div className="tournament-page">
        <div className="tournament-header">
          <div className="header-left">
            <Link to={`/clubs/${clubId}`} className="back-link">
              ← Back to Club
            </Link>
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
          <Link to={`/clubs/${clubId}`} className="back-link">
            ← Back to Club
          </Link>
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
              <p>No tournaments match your filters</p>
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
                        ? ' Running'
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
                        OFC_PINEAPPLE: 'OFC Pineapple',
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
                    {tourn.buy_in_amount} + {tourn.buy_in_fee}
                  </span>
                </div>
                <div className="tourn-meta">
                  <span>
                    {' '}
                    {tourn.current_players}/{tourn.max_players}
                  </span>
                  <span> {tourn.prize_pool?.toLocaleString?.() || tourn.prize_pool}</span>
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
                    ⏱ {countdownStr[tourn.id]}
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
                <span className={`status-badge ${selectedTournament.status}`}>
                  {selectedTournament.status}
                </span>
              </div>

              <div className="detail-stats">
                <div className="stat">
                  <span className="stat-label">Buy-in</span>
                  <span className="stat-value">
                    {selectedTournament.buy_in_amount} + {selectedTournament.buy_in_fee}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Starting Stack</span>
                  <span className="stat-value">
                    {selectedTournament.starting_chips
                      ? selectedTournament.starting_chips.toLocaleString()
                      : '—'}
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
                  <span className="stat-value gold">{selectedTournament.prize_pool}</span>
                </div>

                {/* Bounty Info */}
                {selectedTournament.is_bounty &&
                  !selectedTournament.is_pko &&
                  !selectedTournament.is_mystery_bounty && (
                    <div className="stat">
                      <span className="stat-label">Bounty</span>
                      <span className="stat-value">{selectedTournament.bounty_amount} chips</span>
                    </div>
                  )}

                {/* PKO Info */}
                {selectedTournament.is_pko && (
                  <div className="stat">
                    <span className="stat-label">PKO</span>
                    <span className="stat-value">
                      {selectedTournament.bounty_amount} chips starting bounty
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
                      50% to knocker / 50% added to your bounty
                    </span>
                  </div>
                )}

                {/* Mystery Bounty Info */}
                {selectedTournament.is_mystery_bounty && (
                  <div className="stat">
                    <span className="stat-label">Mystery Bounty Range</span>
                    <span className="stat-value">
                      {selectedTournament.mystery_bounty_min || '1'}x -{' '}
                      {selectedTournament.mystery_bounty_max || '100'}x multiplier
                    </span>
                  </div>
                )}

                {/* Spin Info */}
                {selectedTournament.variant === 'spin' && (
                  <div className="stat">
                    <span className="stat-label">Multiplier</span>
                    <span className="stat-value">
                      {selectedTournament.spin_multiplier
                        ? `${selectedTournament.spin_multiplier}x`
                        : 'TBD'}
                    </span>
                  </div>
                )}
              </div>

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
                          <td>{level.durationMinutes || level.duration_minutes || 15} min</td>
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
                          <td colSpan={4}>+ {blinds.length - 5} more levels</td>
                        </tr>
                      ) : null;
                    })()}
                  </tbody>
                </table>
              </div>

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
                      Register ({selectedTournament.buy_in_amount + selectedTournament.buy_in_fee})
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
                          : ` Rebuy (${selectedTournament.buy_in_amount})`}
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
                          : `➕ Add-On (${selectedTournament.buy_in_amount})`}
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
                      disabled={selectedTournament.current_players < 2}
                    >
                      Start Tournament
                    </button>
                  )}
              </div>

              {/* Tournament Results Overlay (Initiative 13) */}
              {selectedTournament.status === 'COMPLETED' && (
                <div className="tourn-results-overlay">
                  <div className="results-header">🏆 Final Standings</div>
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
                          <div className="podium-icon">
                            {i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}
                          </div>
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
              <h3>Select a Tournament</h3>
              <p>Click on a tournament to view details and register.</p>
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

      {/* Mystery Bounty Reveal Overlay — auto-listens via masterBus */}
      <MysteryBountyReveal />

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
  const [form, setForm] = useState({
    name: '',
    type: 'sng' as 'sng' | 'mtt',
    buyIn: 10,
    rake: 1,
    startingStack: 1500,
    maxPlayers: 6,
    blindSpeed: 'turbo' as 'turbo' | 'regular' | 'deepStack',
  });

  const handleCreate = async () => {
    if (!form.name) return;

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
      buyIn: form.buyIn,
      rake: form.rake,
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
              <option value="sng">Sit & Go</option>
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
            <label>Buy-in</label>
            <input
              type="number"
              min={1}
              value={form.buyIn}
              onChange={(e) => setForm({ ...form, buyIn: Number(e.target.value) })}
            />
          </div>

          <div className="form-group">
            <label>Rake</label>
            <input
              type="number"
              min={0}
              value={form.rake}
              onChange={(e) => setForm({ ...form, rake: Number(e.target.value) })}
            />
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
              <option value="turbo">Turbo (3 min)</option>
              <option value="regular">Regular (8 min)</option>
              <option value="deepStack">Deep Stack (15 min)</option>
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
