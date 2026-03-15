/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOURNAMENT BRACKET — Visual Tournament Display
 * Shows tournament structure, matchups, and progression
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import styles from './TournamentBracket.module.css';

interface BracketPlayer {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  chips: number;
  eliminated: boolean;
  finishPosition?: number;
}

interface BracketMatch {
  id: string;
  round: number;
  matchNumber: number;
  player1?: BracketPlayer;
  player2?: BracketPlayer;
  winner?: string;
  status: 'pending' | 'active' | 'complete';
}

interface TournamentBracketProps {
  tournamentId: string;
  totalPlayers: number;
}

export default function TournamentBracket({ tournamentId, totalPlayers }: TournamentBracketProps) {
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [players, setPlayers] = useState<BracketPlayer[]>([]);
  const isMounted = useIsMounted();
  const [loading, setLoading] = useState(true);
  const [visibleActive, setVisibleActive] = useState<Set<number>>(new Set());
  const [visibleEliminated, setVisibleEliminated] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadPlayers();

    // Subscribe to realtime updates on tournament_players
    const channelKey = `bracket-${tournamentId}`;

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
        () => {
          loadPlayers();
        }
      )
      .subscribe();

    // Also poll every 15s as backup
    const pollInterval = setInterval(loadPlayers, 15000);

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      clearInterval(pollInterval);
    };
  }, [tournamentId]);

  const loadPlayers = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('tournament_players')
        .select('user_id, username, chips, status, position')
        .eq('tournament_id', tournamentId);

      if (error) {
        console.error('[TournamentBracket] Failed to load players:', error.message);
        setPlayers([]);
        setLoading(false);
        return;
      }

      const mapped: BracketPlayer[] = (data || []).map((p: any) => ({
        userId: p.user_id,
        displayName: p.username || 'Unknown',
        avatarUrl: undefined,
        chips: p.chips || 0,
        eliminated: p.status === 'eliminated',
        finishPosition: p.position,
      }));

      // Sort by chips (active) or finish position (eliminated)
      mapped.sort((a, b) => {
        if (a.eliminated && !b.eliminated) return 1;
        if (!a.eliminated && b.eliminated) return -1;
        if (a.eliminated && b.eliminated) {
          return (a.finishPosition || 99) - (b.finishPosition || 99);
        }
        return b.chips - a.chips;
      });

      setPlayers(mapped);
      const active = mapped.filter((p) => !p.eliminated);
      const elim = mapped.filter((p) => p.eliminated);
      setVisibleActive(new Set());
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = active.map((_, i) =>
        setTimeout(() => setVisibleActive((prev) => new Set(prev).add(i)), i * 60)
      );
      setVisibleEliminated(new Set());
      const elimTimers = elim.map((_, i) =>
        setTimeout(() => setVisibleEliminated((prev) => new Set(prev).add(i)), i * 60)
      );
      staggerTimersRef.current.push(...elimTimers);
    } catch (error) {
      console.error('Failed to load bracket:', error);
    }
    setLoading(false);
  };

  const formatChips = (chips: number): string => {
    return chips.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const getPositionBadge = (pos?: number): string => {
    if (!pos) return '';
    if (pos === 1) return '1st';
    if (pos === 2) return '2nd';
    if (pos === 3) return '3rd';
    return `#${pos}`;
  };

  const activePlayers = players.filter((p) => !p.eliminated);
  const eliminatedPlayers = players.filter((p) => p.eliminated);

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading bracket...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <h3> Tournament Standings</h3>
        <div className={styles.stats}>
          <span className={styles.stat}>
            <span className={styles.statValue}>{activePlayers.length}</span>
            <span className={styles.statLabel}>Remaining</span>
          </span>
          <span className={styles.stat}>
            <span className={styles.statValue}>{eliminatedPlayers.length}</span>
            <span className={styles.statLabel}>Eliminated</span>
          </span>
        </div>
      </div>

      {/* Active Players */}
      <div className={styles.section}>
        <h4>Still In ({activePlayers.length})</h4>
        <div className={styles.playerGrid}>
          {activePlayers.map((player, index) => (
            <div
              key={player.userId}
              className={styles.playerCard}
              style={{
                opacity: visibleActive.has(index) ? 1 : 0,
                transform: visibleActive.has(index) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className={styles.rank}>{index + 1}</span>
              <div className={styles.avatar}>
                {player.avatarUrl ? <img src={player.avatarUrl} alt="" /> : <span>●</span>}
              </div>
              <div className={styles.info}>
                <span className={styles.name}>{player.displayName}</span>
                <span className={styles.chips}> {formatChips(player.chips)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Eliminated Players */}
      {eliminatedPlayers.length > 0 && (
        <div className={styles.section}>
          <h4>Finished ({eliminatedPlayers.length})</h4>
          <div className={styles.eliminatedList}>
            {eliminatedPlayers.map((player, index) => (
              <div
                key={player.userId}
                className={styles.eliminatedRow}
                style={{
                  opacity: visibleEliminated.has(index) ? 1 : 0,
                  transform: visibleEliminated.has(index) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <span className={styles.position}>{getPositionBadge(player.finishPosition)}</span>
                <div className={styles.avatar}>
                  {player.avatarUrl ? <img src={player.avatarUrl} alt="" /> : <span>●</span>}
                </div>
                <span className={styles.name}>{player.displayName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
