/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT REGISTRATION — Player Registration List
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import './TournamentRegistration.css';
import { reportError } from '../../utils/errorReporter';
import { adminActionReasonText } from '../../services/TableService';

interface TournamentRegistrationProps {
  tournamentId: string;
  isAdmin?: boolean;
  onUnregister?: () => void;
}

interface RegisteredPlayer {
  id: string;
  username: string;
  avatarUrl: string;
  registeredAt: Date;
  tableNumber?: number;
  seatNumber?: number;
  chipCount?: number;
  isEliminated: boolean;
}

export function TournamentRegistration({
  tournamentId,
  isAdmin,
  onUnregister,
}: TournamentRegistrationProps) {
  const isMounted = useIsMounted();
  const toast = useToast();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // CA-23 BUG FIX: staggerTimersRef was cleared between re-runs but had no
  // unmount-guard. If the component unmounts mid-stagger (user leaves tournament
  // lobby), all pending setVisibleActive/setVisibleEliminated calls fire on an
  // unmounted component.
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, []);
  const [players, setPlayers] = useState<RegisteredPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [visibleActive, setVisibleActive] = useState<boolean[]>([]);
  const [visibleEliminated, setVisibleEliminated] = useState<boolean[]>([]);

  useEffect(() => {
    loadPlayers();

    const channelKey = `tournament-${tournamentId}-players`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_players',
          filter: `tournament_id=eq.${tournamentId}`,
        },
        () => loadPlayers()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'TournamentRegistration._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[TournamentRegistration] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [tournamentId]);

  const loadPlayers = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tournament_players')
        .select('*, player:profiles!user_id(username, avatar_url)')
        .eq('tournament_id', tournamentId)
        .order('created_at', { ascending: true });

      if (!isMounted.current) return;

      if (!error && data) {
        setPlayers(
          data.map((p: any) => ({
            id: p.user_id,
            username: p.player?.username || p.username || 'Unknown',
            avatarUrl: p.player?.avatar_url || '',
            registeredAt: new Date(p.created_at),
            tableNumber: p.table_id || null,
            seatNumber: p.seat_number,
            chipCount: p.chips || 0,
            isEliminated: p.status === 'eliminated',
          }))
        );
      }
    } catch (error) {
      if (isMounted.current) toast.error('Failed to load players');
    }
    if (isMounted.current) setLoading(false);
  };

  const handleRemovePlayer = async (playerId: string) => {
    if (!isAdmin) return;

    try {
      // AUDIT M17: this used to be five client round trips — read the tournament,
      // check its status, delete the registration, credit
      // buy_in_amount + buy_in_fee computed HERE, and re-insert the player if the
      // credit failed. The credit was permission-denied every time (42501 on the
      // wallets RLS) and the delete matched zero rows (tournament_registrations
      // is service-role write-only), so nothing happened and the UI said
      // "Player removed and refunded".
      //
      // fn_admin_remove_tournament_player does all of it in one transaction:
      // club-admin check, pre-start status gate, delete, and a refund read from
      // the tournaments row rather than computed by the caller. The
      // re-insert-on-failure compensation is gone because it is no longer
      // needed — a failed refund un-removes the player by rolling back.
      const { data, error } = await supabase.rpc('fn_admin_remove_tournament_player', {
        p_tournament_id: tournamentId,
        p_user_id: playerId,
      });

      if (error) {
        reportError(error, 'TournamentRegistration.removePlayer', { tournamentId, playerId });
        if (isMounted.current) toast.error('Could not remove the player');
        return;
      }

      const res = data as { ok: boolean; reason?: string; refunded?: number } | null;

      if (!res?.ok) {
        if (isMounted.current) toast.error(adminActionReasonText(res?.reason));
        return;
      }

      if ((res.refunded ?? 0) > 0) {
        masterBus.emit('BALANCE_UPDATED', {
          source: 'tournament_admin_refund',
          userId: playerId,
        });
      }

      // Player-count upkeep is display state, so it stays on the client: a
      // stale count is cosmetic, and it must never be able to fail the removal.
      const { data: t } = await supabase
        .from('tournaments')
        .select('current_players')
        .eq('id', tournamentId)
        .maybeSingle();

      if (t) {
        const { error: updateErr } = await supabase
          .from('tournaments')
          .update({ current_players: Math.max((t.current_players || 1) - 1, 0) })
          .eq('id', tournamentId);

        if (updateErr) {
          reportError(updateErr, 'TournamentRegistration.Failed_to_decrement_player_count');
        }
      }

      if (isMounted.current)
        toast.success(
          (res.refunded ?? 0) > 0
            ? `Player removed and refunded ${(res.refunded ?? 0).toLocaleString()} chips`
            : 'Player removed'
        );
      loadPlayers();
    } catch (err) {
      reportError(err, 'TournamentRegistration.Error');
      if (isMounted.current) toast.error('Failed to remove player');
    }
  };

  const filteredPlayers = players.filter((p) =>
    p.username.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const activePlayers = filteredPlayers.filter((p) => !p.isEliminated);
  const eliminatedPlayers = filteredPlayers.filter((p) => p.isEliminated);

  useEffect(() => {
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    setVisibleActive([]);
    staggerTimersRef.current.push(
      ...activePlayers.map((_, i) =>
        setTimeout(() => setVisibleActive((prev) => [...prev, true]), i * 60)
      )
    );
  }, [activePlayers]);

  useEffect(() => {
    setVisibleEliminated([]);
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    staggerTimersRef.current.push(
      ...eliminatedPlayers.map((_, i) =>
        setTimeout(() => setVisibleEliminated((prev) => [...prev, true]), i * 60)
      )
    );
  }, [eliminatedPlayers]);

  if (loading) {
    return <div className="tournament-registration loading">Loading...</div>;
  }

  return (
    <div className="tournament-registration">
      <div className="registration__header">
        <h3> Registered Players ({players.length})</h3>
        <input
          type="text"
          placeholder="Search..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
      </div>

      {activePlayers.length > 0 && (
        <div className="player-list">
          {activePlayers.map((player, idx) => (
            <div
              key={player.id}
              className="player-row"
              style={{
                opacity: visibleActive[idx] ? 1 : 0,
                transform: visibleActive[idx] ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="rank">#{idx + 1}</span>
              <span className="avatar">{player.avatarUrl}</span>
              <span className="username">{player.username}</span>
              {player.tableNumber && (
                <span className="seat">
                  T{player.tableNumber}/S{player.seatNumber}
                </span>
              )}
              {player.chipCount !== undefined && (
                <span className="chips">{player.chipCount.toLocaleString()}</span>
              )}
              {isAdmin && (
                <button className="remove-btn" onClick={() => handleRemovePlayer(player.id)}>
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {eliminatedPlayers.length > 0 && (
        <div className="eliminated-section">
          <h4>Eliminated ({eliminatedPlayers.length})</h4>
          <div className="player-list eliminated">
            {eliminatedPlayers.map((player, idx) => (
              <div
                key={player.id}
                className="player-row eliminated"
                style={{
                  opacity: visibleEliminated[idx] ? 1 : 0,
                  transform: visibleEliminated[idx] ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <span className="avatar">{player.avatarUrl}</span>
                <span className="username">{player.username}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {players.length === 0 && <div className="empty-state">No Players Registered Yet</div>}
    </div>
  );
}

export default TournamentRegistration;
