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
import { registerReasonText } from '../../services/TournamentService';
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
// The old note here said "expected payout = 3x buy_in, club net = 10%". Neither
// number is the product: spinSpec.ts fixes E[multiplier] at 2.7638 and the house
// edge at 7.87%, and a comment quoting a 10% take beside a wheel that takes
// 7.87% is the same drift this file keeps being audited for.
// AUDIT FIX 2026-08-20: this was a hardcoded [2,3,5,10,25,50,100] — it omitted
// 4x and the top tier entirely, so the lobby advertised a shorter ladder than the
// engine actually draws from and never mentioned the top jackpot at all.
// Derived from the canonical spec so it cannot drift again.
const SPIN_MULTIPLIERS = SPIN_TIERS.map((t) => t.multiplier);

/** The top of the ladder, and therefore the largest prize that can be won. */
const SPIN_TOP_MULTIPLIER = SPIN_MULTIPLIERS.reduce((a, b) => Math.max(a, b), 0);

/**
 * DEFECT D10 (extended): these percentages were a hardcoded table, and it did
 * not match the ladder it was printed beside.
 *
 * It claimed 2x lands 76.19% of the time; the canonical frequencies in
 * spinSpec.ts put it at 47.72%. It had no entry for 4x at all, so a real tier
 * of the wheel rendered as "0%". These are odds shown to a player next to a
 * prize amount, which makes them a money-facing claim, and they were a third
 * stale copy of exactly the table spinSpec.ts was written to be the only one
 * of.
 *
 * Derived from SPIN_TIERS.freq now, so it cannot drift again.
 */
const SPIN_FREQ_TOTAL = SPIN_TIERS.reduce((s, t) => s + t.freq, 0);

const MULTIPLIER_PROBABILITIES: { [key: number]: number } = Object.fromEntries(
  SPIN_TIERS.map((t) => [t.multiplier, (t.freq / SPIN_FREQ_TOTAL) * 100])
);

/**
 * A probability read by a human. Rounds to whatever precision keeps the number
 * meaningful - "0%" beside a live 100x tier would be a lie of rounding.
 */
function formatProbability(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return '<0.01%';
}

/**
 * The one-line odds summary printed on every card. Names the four commonest
 * tiers with their real frequencies, then closes with the lowest of what is
 * left as "and up", rather than quoting a fifth number that would not fit.
 */
const prizeTierSummary = (() => {
  const byFreq = [...SPIN_TIERS].sort((a, b) => b.freq - a.freq);
  const head = byFreq
    .slice(0, 4)
    .map((t) => `${t.multiplier}X-${formatProbability((t.freq / SPIN_FREQ_TOTAL) * 100)}`)
    .join(', ');
  const rest = byFreq.slice(4).reduce((lo, t) => Math.min(lo, t.multiplier), Infinity);
  return Number.isFinite(rest) ? `${head}, ${rest}X+` : head;
})();

/**
 * The ladder to DISPLAY for one tournament: its own `multipliers` column,
 * narrowed to tiers the canonical spec can quote real odds for. A multiplier we
 * have no frequency for would render "0%" next to a prize, which is worse than
 * not showing it. Falls back to the canonical ladder if the column is empty or
 * entirely unrecognised.
 */
function displayLadder(multipliers: number[]): number[] {
  const known = (multipliers || []).filter((m) => MULTIPLIER_PROBABILITIES[m] !== undefined);
  return known.length > 0 ? known : SPIN_MULTIPLIERS;
}

/**
 * The compact chip row on a collapsed tile. Was a hardcoded [2, 5, 25, 100],
 * which silently disagreed with the tournament's own `multipliers` column.
 * Takes the bottom, the top, and two evenly spaced tiers between them, so the
 * preview always ends on the real jackpot.
 */
function previewMultipliers(all: number[]): number[] {
  const sorted = [...new Set(all)].sort((a, b) => a - b);
  if (sorted.length <= 4) return sorted;
  const picks = [0, Math.round((sorted.length - 1) / 3), Math.round((2 * (sorted.length - 1)) / 3)];
  const idx = [...new Set([...picks, sorted.length - 1])].sort((a, b) => a - b);
  return idx.map((i) => sorted[i]);
}

export function SpinAndGoLobby({ clubId, onRegister }: SpinAndGoLobbyProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [tournaments, setTournaments] = useState<SpinTournament[]>([]);
  const isMounted = useIsMounted();
  const [loading, setLoading] = useState(true);
  /**
   * DEFECT D6b: a failed load used to be indistinguishable from an empty
   * lobby. `if (!error && data)` left `tournaments` at [], nothing was
   * reported, and the render fell through to "No Spin Tournaments Available".
   * A player whose query was denied by RLS, or who was offline, was told the
   * club runs no Spins. This flag is what separates "we asked and there are
   * none" from "we could not ask".
   */
  const [loadFailed, setLoadFailed] = useState(false);
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

      // D6b: the error branch has to exist. It did not.
      if (error) {
        reportError(error, 'SpinAndGoLobby.loadTournaments', { clubId });
        if (isMounted.current) {
          setLoadFailed(true);
          setLoading(false);
        }
        return;
      }

      if (data) {
        setLoadFailed(false);
        setTournaments(
          data.map((t) => ({
            id: t.id,
            // Whole chips only (Dan 2026-08-20) - no decimal Spin buy-ins.
            buyIn: Math.max(0, Math.round(Number(t.buy_in_amount) || 0)),
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
    } catch (err) {
      // D6b, second half: `resolveClubUUID` throws, and this catch used to
      // toast and then fall through to the same "no tournaments" render.
      reportError(err, 'SpinAndGoLobby.loadTournaments_threw', { clubId });
      if (isMounted.current) setLoadFailed(true);
    }
    if (isMounted.current) setLoading(false);
  };

  const handleRegister = async (tournament: SpinTournament) => {
    if (!user?.id) {
      toast.error('Please Log In');
      return;
    }

    setRegistering(tournament.id);
    try {
      // 2026-08-20: this used to call the legacy `register_for_tournament`
      // RPC — with the wrong arity, so it could never have succeeded, and
      // pointing at a function that seated players WITHOUT CHARGING them
      // (now dropped from the database entirely). The paid path derives the
      // cost server-side, debits the wallet, and writes the buy-in ledger
      // row the spin start gate requires.
      const { data, error } = await retryAsync(
        () => supabase.rpc('fn_register_for_tournament', { p_tournament_id: tournament.id }),
        3
      );

      if (error) throw error;

      // SAME DEFECT AS D6a, ON THIS SURFACE. Only the PostgREST `error` was
      // checked. `fn_register_for_tournament` answers an ordinary refusal -
      // insufficient balance, tournament full, already registered - with
      // `{ ok: false, reason }` and no error at all, so every one of those
      // rendered a green "Registered for ... Spin!" while the wallet was never
      // debited and no seat was ever taken.
      const res = data as { ok?: boolean; reason?: string; registration_id?: string } | null;
      if (!res?.ok || !res.registration_id) {
        throw new Error(registerReasonText(res?.reason));
      }

      toast.success(`Registered For ${Math.round(tournament.buyIn).toLocaleString('en-US')} Spin`);
      onRegister?.(tournament.id);
      loadTournaments();
    } catch (err: any) {
      // The catch used to swallow the cause entirely: no report, and a
      // `.message` read off an unknown value.
      reportError(err, 'SpinAndGoLobby.handleRegister', { tournamentId: tournament.id });
      toast.error(err instanceof Error ? err.message : 'Registration Failed, Please Try Again');
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
        {/*
          DEFECT D10: this read "Win Up To 1000X Your Buy-In!" while the ladder
          in spinSpec.ts tops out at 100x - and 500x was retired on 2026-08-21,
          so 1000x has never been a prize this product could pay. Advertising a
          prize that cannot be won is a money-facing claim. Derived from the
          spec so the headline moves with the ladder.
        */}
        <span className="spin-lobby__subtitle">
          Win Up To {SPIN_TOP_MULTIPLIER.toLocaleString()}X Your Buy-In
        </span>
      </div>

      {loadFailed ? (
        // D6b: a failed load says so, and offers the retry that an empty lobby
        // has no use for.
        <div className="empty-state">
          <div>Could Not Load Spin Tournaments</div>
          <button className="spin-card__register" onClick={() => loadTournaments()}>
            Try Again
          </button>
        </div>
      ) : tournaments.length === 0 ? (
        <div className="empty-state">No Spin Tournaments Available</div>
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

              {/*
                DEFECT D10: the chips were a hardcoded [2, 5, 25, 100] and so
                could not follow either the shared ladder or this tournament's
                own `multipliers` column. Derived from the tier list the card
                actually draws from.
              */}
              <div className="spin-card__multipliers">
                {previewMultipliers(displayLadder(t.multipliers)).map((m) => (
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
                    {displayLadder(t.multipliers).map((multiplier) => {
                      const prob = MULTIPLIER_PROBABILITIES[multiplier] || 0;
                      // AUDIT FIX 2026-08-20: this reconstructed the prize from
                      // a hardcoded bonusBuyIns ladder belonging to the retired
                      // pool model. It happened to agree for the tiers it listed
                      // (2 + bonus == multiplier) but silently had no answer for
                      // 4x or 100x. The prize IS buy-in x multiplier.
                      const prize = Math.trunc(t.buyIn * multiplier);
                      return (
                        <div key={multiplier} className="prize-tier">
                          <span className="prize-multiplier">{multiplier}x</span>
                          <span className="prize-amount">
                            {multiplier === 2 ? '' : 'Up to '}
                            {Math.trunc(prize).toLocaleString()}
                          </span>
                          <span className="prize-prob">{formatProbability(prob)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Probability Info */}
              {/*
                DEFECT D10: this summary was hardcoded and wrong in the same
                way the probability table was - "2X-76%" against a real 47.7%.
                Derived, so the odds a player reads are the odds the wheel
                draws.
              */}
              <div className="spin-card__info">
                <span className="info-label">Prize Tiers</span>
                <span className="info-text">{prizeTierSummary}</span>
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
