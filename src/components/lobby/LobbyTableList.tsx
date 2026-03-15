/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LOBBY TABLE LIST — Browse Available Tables
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './LobbyTableList.css';

interface LobbyTableListProps {
  clubId?: string;
  gameType?: string;
  onJoinTable?: (tableId: string) => void;
}

interface TableInfo {
  id: string;
  name: string;
  gameType: string;
  stakes: string;
  players: number;
  maxPlayers: number;
  avgPot: number;
  waitlist: number;
  isPrivate: boolean;
  features: string[];
}

const GAME_TYPE_LABELS: Record<string, string> = {
  nlh: 'NLH',
  plo: 'PLO',
  plo5: 'PLO5',
  mixed: 'Mixed',
};

export function LobbyTableList({ clubId, gameType, onJoinTable }: LobbyTableListProps) {
  const toast = useToast();

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const [sortBy, setSortBy] = useState<'stakes' | 'players' | 'pot'>('stakes');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadTables();

    const channelKey = 'lobby-tables';

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
        },
        () => loadTables()
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, gameType]);

  const loadTables = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('tables')
        .select(
          'id, name, game_type, game_variant, small_blind, big_blind, max_players, current_players, status, stakes, player_count, avg_pot, waitlist_count, is_private, settings'
        )
        .eq('status', 'active');

      if (clubId) {
        const resolvedId = await resolveClubUUID(clubId);
        query = query.eq('club_id', resolvedId);
      }
      if (gameType) query = query.eq('game_type', gameType);

      const { data, error } = await query;

      if (!error && data && isMounted.current) {
        setTables(
          data.map((t) => ({
            id: t.id,
            name: t.name,
            gameType: t.game_type || 'nlh',
            stakes: `${t.small_blind}/${t.big_blind}`,
            players: t.player_count || 0,
            maxPlayers: t.max_players || 9,
            avgPot: t.avg_pot || 0,
            waitlist: t.waitlist_count || 0,
            isPrivate: t.is_private || false,
            features: t.settings?.features || [],
          }))
        );
        setVisibleItems(new Set());
        data.forEach((_, i) => {
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        });
      }
    } catch (error) {
      if (isMounted.current) toast.error('Failed to load tables');
    }
    if (isMounted.current) setLoading(false);
  };

  const sortedTables = [...tables].sort((a, b) => {
    switch (sortBy) {
      case 'players':
        return b.players - a.players;
      case 'pot':
        return b.avgPot - a.avgPot;
      default: {
        const aStakes = parseInt(a.stakes.split('/')[1]);
        const bStakes = parseInt(b.stakes.split('/')[1]);
        return aStakes - bStakes;
      }
    }
  });

  if (loading) {
    return <div className="lobby-tables loading">Loading...</div>;
  }

  return (
    <div className="lobby-tables">
      <div className="lobby-tables__header">
        <h3> Cash Games</h3>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
          <option value="stakes">Sort by Stakes</option>
          <option value="players">Sort by Players</option>
          <option value="pot">Sort by Avg Pot</option>
        </select>
      </div>

      {sortedTables.length === 0 ? (
        <div className="empty-state">No tables available</div>
      ) : (
        <div className="lobby-tables__list">
          {sortedTables.map((table, i) => (
            <div
              key={table.id}
              className="table-row"
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="table-info">
                <span className="name">
                  {table.isPrivate && ' '}
                  {table.name}
                </span>
                <span className="type">{GAME_TYPE_LABELS[table.gameType] || table.gameType}</span>
              </div>
              <div className="stakes">{table.stakes}</div>
              <div className="players">
                <span className={table.players >= table.maxPlayers ? 'full' : ''}>
                  {table.players}/{table.maxPlayers}
                </span>
                {table.waitlist > 0 && <span className="waitlist">+{table.waitlist} waiting</span>}
              </div>
              <div className="avg-pot">
                <span className="value">{table.avgPot.toLocaleString()}</span>
                <span className="label">Avg Pot</span>
              </div>
              <button className="join-btn" onClick={() => onJoinTable?.(table.id)}>
                {table.players >= table.maxPlayers ? 'Waitlist' : 'Join'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default LobbyTableList;
