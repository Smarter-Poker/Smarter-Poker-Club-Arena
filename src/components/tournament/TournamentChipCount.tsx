/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT CHIP COUNT — Live Chip Leader Display
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import './TournamentChipCount.css';

interface TournamentChipCountProps {
  tournamentId: string;
  limit?: number;
}

interface ChipLeader {
  userId: string;
  username: string;
  avatarUrl: string;
  chipCount: number;
  tableNumber: number;
  rank: number;
}

export function TournamentChipCount({ tournamentId, limit = 10 }: TournamentChipCountProps) {
  const [leaders, setLeaders] = useState<ChipLeader[]>([]);
  const isMounted = useIsMounted();
  const [totalChips, setTotalChips] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTimeout(() => setMounted(true), 50);
  }, []);

  useEffect(() => {
    loadChipCounts();

    const interval = setInterval(loadChipCounts, 10000);

    return () => clearInterval(interval);
  }, [tournamentId]);

  const loadChipCounts = async () => {
    try {
      const { data, error } = await supabase
        .from('tournament_players')
        .select(
          'user_id, chips, table_id, seat_number, player:profiles!user_id(username, avatar_url)'
        )
        .eq('tournament_id', tournamentId)
        .neq('status', 'eliminated')
        .order('chips', { ascending: false })
        .limit(limit);

      if (!error && data) {
        let total = 0;
        const mapped = data.map((p: any, idx: number) => {
          total += p.chips || 0;
          const player = Array.isArray(p.player) ? p.player[0] : p.player;
          return {
            userId: p.user_id,
            username: player?.username || 'Unknown',
            avatarUrl: player?.avatar_url || '',
            chipCount: p.chips || 0,
            tableNumber: p.seat_number || 0,
            rank: idx + 1,
          };
        });
        setLeaders(mapped);
        setTotalChips(total);
      }
    } catch (error) {
      console.error('Failed to load chip counts:', error);
    }
    if (isMounted.current) setLoading(false);
  };

  const avgStack = leaders.length > 0 ? totalChips / leaders.length : 0;

  if (loading) {
    return <div className="chip-count loading">Loading...</div>;
  }

  return (
    <div
      className="chip-count"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      <div className="chip-count__header">
        <h3> Chip Counts</h3>
        <span className="avg-stack">Avg: {avgStack.toLocaleString()}</span>
      </div>

      <div className="chip-count__list">
        {leaders.map((leader, i) => (
          <div
            key={leader.userId}
            className={`leader-row rank-${leader.rank}`}
            style={{
              opacity: mounted ? 1 : 0,
              transform: mounted ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              transitionDelay: `${0.1 + i * 0.06}s`,
            }}
          >
            <span className="rank">{leader.rank}</span>
            <span className="avatar">{leader.avatarUrl}</span>
            <div className="player-info">
              <span className="username">{leader.username}</span>
              <span className="table">Table {leader.tableNumber}</span>
            </div>
            <span className="chips">{leader.chipCount.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default TournamentChipCount;
