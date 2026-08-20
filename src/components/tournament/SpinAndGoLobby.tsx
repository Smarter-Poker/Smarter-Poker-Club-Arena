/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN & GO LOBBY — Quick Tournament Registration
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { SPIN_TIERS } from '../../config/spinSpec';
import './SpinAndGoLobby.css';
import { retryAsync } from '../../utils/retryAsync';
import { reportError } from '../../utils/errorReporter';

interface SpinAndGoLobbyProps {
  clubId: string;
  onRegister?: (tournamentId: string) => void;
}

interface SpinTournament {
  id: string;
  buyIn: number;
  players: number;
  maxPlayers: number;
  multipliers: number[];
  prizePool: number;
  status: 'registering' | 'spinning' | 'running' | 'complete';
  startAt?: Date;
}

// Pool-based multipliers — display values for the wheel UI.
// Balanced probabilities: expected payout = 3× buy_in, club net = 10%.
// AUDIT FIX 2026-08-20: this was a hardcoded [2,3,5,10,25,50,100] — it omitted
// 4x and 500x entirely, so the lobby advertised a shorter ladder than the
// engine actually draws from and never mentioned the top jackpot at all.
// Derived from the canonical spec so it cannot drift again.
const SPIN_MULTIPLIERS = SPIN_TIERS.map((t) => t.multiplier);

const MULTIPLIER_PROBABILITIES: { [key: number]: number } = {
  2: 76.19,
  3: 14.29,
  5: 5.71,
  10: 2.38,
  25: 0.95,
  50: 0.38,
  100: 0.1,
};

export function SpinAndGoLobby({ clubId, onRegister }: SpinAndGoLobbyProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [tournaments, setTournaments] = useState<SpinTournament[]>([]);
  const isMounted = useIsMounted();
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState<string | null>(null);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    loadTournaments();

    // Subscribe to updates — resolve club UUID for realtime filter
    const channelKey = `spin-tournaments-${clubId}`;
    let isMounted = true;

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
            table: 'spin_tournaments',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => loadTournaments()
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'SpinAndGoLobby._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[SpinAndGoLobby] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[SpinAndGoLobby] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  const loadTournaments = async () => {
    setLoading(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('spin_tournaments')
        .select(
          'id, buy_in_amount:buy_in, player_count, max_players, multipliers, prize_pool, status, start_at'
        )
        .eq('club_id', resolvedId)
        .in('status', ['registering', 'spinning'])
        .order('buy_in', { ascending: true });

      if (!error && data) {
        setTournaments(
          data.map((t) => ({
            id: t.id,
            buyIn: t.buy_in_amount,
            players: t.player_count || 0,
            maxPlayers: t.max_players || 3,
            multipliers: t.multipliers || SPIN_MULTIPLIERS,
            prizePool: t.prize_pool || 0,
            status: t.status,
            startAt: t.start_at ? new Date(t.start_at) : undefined,
          }))
        );
        setVisibleItems(new Set());
        staggerTimersRef.current.forEach((t) => clearTimeout(t));
        staggerTimersRef.current = data.map((_, i) =>
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
        );
      }
    } catch (error) {
      toast.error('Failed to load spin tournaments');
    }
    if (isMounted.current) setLoading(false);
  };

  const handleRegister = async (tournament: SpinTournament) => {
    if (!user?.id) {
      toast.error('Please log in');
      return;
    }

    setRegistering(tournament.id);
    try {
      const { error } = await retryAsync(
        () =>
          supabase.rpc('register_for_tournament', {
            p_tournament_id: tournament.id,
            p_user_id: user.id,
          }),
        3
      );

      if (error) throw error;

      toast.success(`Registered for ${tournament.buyIn} Spin!`);
      onRegister?.(tournament.id);
      loadTournaments();
    } catch (error: any) {
      toast.error(error.message || 'Registration failed');
    }
    setRegistering(null);
  };

  if (loading) {
    return <div className="spin-lobby loading">Loading...</div>;
  }

  return (
    <div className="spin-lobby">
      <div className="spin-lobby__header">
        <h3>Spin & Go</h3>
        <span className="spin-lobby__subtitle">Win up to 1000x your buy-in!</span>
      </div>

      {tournaments.length === 0 ? (
        <div className="empty-state">No spin tournaments available</div>
      ) : (
        <div className="spin-grid">
          {tournaments.map((t, i) => (
            <div
              key={t.id}
              className={`spin-card ${t.status} ${expandedCard === t.id ? 'spin-card--expanded' : ''}`}
              onClick={() => setExpandedCard(expandedCard === t.id ? null : t.id)}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="spin-card__buyin">
                <span className="value">{Math.trunc(t.buyIn).toLocaleString()}</span>
                <span className="label">Buy-In</span>
              </div>

              <div className="spin-card__multipliers">
                {[2, 5, 25, 100].map((m) => (
                  <span key={m} className="multiplier">
                    {m}x
                  </span>
                ))}
              </div>

              <div className="spin-card__players">
                <span className="count">
                  {t.players}/{t.maxPlayers}
                </span>
                <span className="label">Waiting</span>
              </div>

              {/* Expanded Prize Wheel */}
              {expandedCard === t.id && (
                <div className="spin-card__prize-wheel">
                  <div className="prize-wheel">
                    {SPIN_MULTIPLIERS.map((multiplier) => {
                      const prob = MULTIPLIER_PROBABILITIES[multiplier] || 0;
                      // AUDIT FIX 2026-08-20: this reconstructed the prize from
                      // a hardcoded bonusBuyIns ladder belonging to the retired
                      // pool model. It happened to agree for the tiers it listed
                      // (2 + bonus == multiplier) but silently had no answer for
                      // 4x or 500x. The prize IS buy-in x multiplier.
                      const prize = Math.trunc(t.buyIn * multiplier);
                      return (
                        <div key={multiplier} className="prize-tier">
                          <span className="prize-multiplier">{multiplier}x</span>
                          <span className="prize-amount">
                            {multiplier === 2 ? '' : 'Up to '}
                            {Math.trunc(prize).toLocaleString()}
                          </span>
                          <span className="prize-prob">{prob}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Probability Info */}
              <div className="spin-card__info">
                <span className="info-label">Prize Tiers</span>
                <span className="info-text">2x-76%, 3x-14%, 5x-6%, 10x-2.4%, 25x+</span>
              </div>

              {t.status === 'registering' && (
                <button
                  className="spin-card__register"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRegister(t);
                  }}
                  disabled={registering === t.id}
                >
                  {registering === t.id ? 'Registering...' : 'Spin Now'}
                </button>
              )}

              {t.status === 'spinning' && (
                <div className="spin-card__spinning">
                  <span className="spinner"></span>
                  <span>Spinning...</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SpinAndGoLobby;
