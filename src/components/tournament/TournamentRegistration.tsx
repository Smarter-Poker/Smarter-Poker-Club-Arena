/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT REGISTRATION — Player Registration List
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import './TournamentRegistration.css';
import { retryAsync } from '../../utils/retryAsync';

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
      .subscribe();

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
    setLoading(false);
  };

  const handleRemovePlayer = async (playerId: string) => {
    if (!isAdmin) return;

    try {
      // Fetch tournament to calculate refund amount
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('buy_in_amount, buy_in_fee, status')
        .eq('id', tournamentId)
        .maybeSingle();

      // Only allow admin removal before tournament starts (ANNOUNCED or REGISTERING)
      if (tournament && !['ANNOUNCED', 'REGISTERING'].includes(tournament.status)) {
        toast.error('Cannot remove players after tournament has started');
        return;
      }

      // Delete the tournament_players entry first
      const { error: delErr } = await supabase
        .from('tournament_players')
        .delete()
        .eq('tournament_id', tournamentId)
        .eq('user_id', playerId);

      if (delErr) throw delErr;

      // Refund the player's buy-in + fee
      if (tournament) {
        const refundAmount =
          Math.trunc(((tournament.buy_in_amount || 0) + (tournament.buy_in_fee || 0)) * 100) / 100;
        if (refundAmount > 0) {
          const { error: refundErr } = await retryAsync(
            () =>
              supabase.rpc('atomic_credit_wallet_and_log', {
                p_user_id: playerId,
                p_amount: refundAmount,
                p_category: 'refund',
                p_description: `Admin removed from tournament — refund`,
                p_table_id: null,
                p_hand_id: null,
                p_related_entity_id: tournamentId,
              }),
            3
          );

          if (refundErr) {
            console.error('[AdminRemove] Refund failed — re-inserting player:', refundErr);
            // Re-insert the player since refund failed — preserve tournament integrity
            try {
              const playerEntry = players.find((p) => p.id === playerId);
              await supabase.from('tournament_players').insert({
                tournament_id: tournamentId,
                user_id: playerId,
                username: playerEntry?.username || 'Player',
                status: 'registered',
              });
              toast.error('Removal cancelled — refund failed, player re-inserted');
            } catch (reinsertErr) {
              console.error(
                '[AdminRemove] CRITICAL: Re-insert failed after refund failure:',
                reinsertErr
              );
              if (isMounted.current)
                toast.error('CRITICAL: Player removed but refund failed — contact support');
            }
            return;
          }

          // Emit balance update to sync Global Headers across pages
          masterBus.emit('BALANCE_UPDATED', {
            source: 'tournament_admin_refund',
            userId: playerId,
          });
        }

        // Decrement current_players
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
            console.error('[AdminRemove] Failed to decrement player count:', updateErr);
          }
        }
      }

      toast.success('Player removed and refunded');
      loadPlayers();
    } catch {
      if (isMounted.current) toast.error('Failed to remove player');
    }
  };

  const filteredPlayers = players.filter((p) =>
    p.username.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const activePlayers = filteredPlayers.filter((p) => !p.isEliminated);
  const eliminatedPlayers = filteredPlayers.filter((p) => p.isEliminated);

  useEffect(() => {
    setVisibleActive([]);
    activePlayers.forEach((_, i) => {
      setTimeout(() => {
        setVisibleActive((prev) => [...prev, true]);
      }, i * 60);
    });
  }, [activePlayers]);

  useEffect(() => {
    setVisibleEliminated([]);
    eliminatedPlayers.forEach((_, i) => {
      setTimeout(() => {
        setVisibleEliminated((prev) => [...prev, true]);
      }, i * 60);
    });
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

      {players.length === 0 && <div className="empty-state">No players registered yet</div>}
    </div>
  );
}

export default TournamentRegistration;
