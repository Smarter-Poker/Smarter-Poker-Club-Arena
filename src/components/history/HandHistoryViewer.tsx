/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY VIEWER — Browse Past Hands
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { CardImage } from '../table/CardImage';
import type { Card } from '../table/CardImage';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './HandHistoryViewer.css';

interface HandHistoryViewerProps {
  clubId?: string;
  tableId?: string;
  limit?: number;
  onSelectHand?: (handId: string) => void;
}

interface HandSummary {
  id: string;
  tableId: string;
  tableName: string;
  stakes: string;
  potSize: number;
  myResult: number;
  holeCards: string[];
  communityCards: string[];
  position: string;
  action: string;
  playedAt: Date;
}

export function HandHistoryViewer({
  clubId,
  tableId,
  limit = 25,
  onSelectHand,
}: HandHistoryViewerProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [hands, setHands] = useState<HandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'won' | 'lost'>('all');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (user?.id) {
      loadHands();
    }
  }, [user?.id, clubId, tableId]);

  const loadHands = async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      let query = supabase
        .from('hand_history')
        .select(
          'id, table_id, table_name, stakes, pot_size, result, game_type, hero_hand, community_cards, actions, played_at, user_id, club_id, hole_cards, position, final_action, created_at'
        )
        .eq('user_id', user.id)
        .order('played_at', { ascending: false })
        .limit(limit);

      if (clubId) query = query.eq('club_id', await resolveClubUUID(clubId));
      if (tableId) query = query.eq('table_id', tableId);

      const { data, error } = await query;

      if (!error && data) {
        setHands(
          data.map((h) => ({
            id: h.id,
            tableId: h.table_id,
            tableName: h.table_name || 'Table',
            stakes: h.stakes || '1/2',
            potSize: h.pot_size || 0,
            myResult: h.result || 0,
            holeCards: h.hole_cards || [],
            communityCards: h.community_cards || [],
            position: h.position || 'BTN',
            action: h.final_action || 'fold',
            playedAt: new Date(h.played_at || h.created_at),
          }))
        );
        setVisibleItems(new Set());
        data.forEach((_, i) => {
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        });
      }
    } catch (error) {
      toast.error('Failed to load hand history');
    }
    setLoading(false);
  };

  const filteredHands = hands.filter((h) => {
    if (filter === 'won') return h.myResult > 0;
    if (filter === 'lost') return h.myResult < 0;
    return true;
  });

  const parseCard = (cardStr: string): Card => {
    const suit = cardStr.slice(-1) as Card['suit'];
    let rank = cardStr.slice(0, -1);
    if (rank === '10') rank = 'T';
    return { rank: rank as Card['rank'], suit };
  };

  const renderCards = (cards: string[]) => (
    <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'center' }}>
      {cards.map((c, i) => (
        <CardImage key={i} card={parseCard(c)} deckStyle="4color" size="xs" />
      ))}
    </span>
  );

  if (loading) {
    return <div className="hand-history loading">Loading...</div>;
  }

  return (
    <div className="hand-history">
      <div className="hand-history__header">
        <h3> Hand History</h3>
        <div className="filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={filter === 'won' ? 'active' : ''} onClick={() => setFilter('won')}>
            Won
          </button>
          <button className={filter === 'lost' ? 'active' : ''} onClick={() => setFilter('lost')}>
            Lost
          </button>
        </div>
      </div>

      {filteredHands.length === 0 ? (
        <div className="empty-state">No hands found</div>
      ) : (
        <div className="hand-history__list">
          {filteredHands.map((hand, i) => (
            <div
              key={hand.id}
              className={`hand-row ${hand.myResult > 0 ? 'won' : hand.myResult < 0 ? 'lost' : ''}`}
              onClick={() => onSelectHand?.(hand.id)}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="hand-info">
                <span className="table">{hand.tableName}</span>
                <span className="stakes">{hand.stakes}</span>
                <span className="position">{hand.position}</span>
              </div>
              <div className="cards">
                <span className="hole-cards">{renderCards(hand.holeCards)}</span>
                {hand.communityCards.length > 0 && (
                  <span className="board">{renderCards(hand.communityCards)}</span>
                )}
              </div>
              <div className="result">
                <span className={`amount ${hand.myResult >= 0 ? 'positive' : 'negative'}`}>
                  {hand.myResult >= 0 ? '+' : ''}
                  {hand.myResult.toLocaleString()}
                </span>
                <span className="pot">Pot: {hand.potSize.toLocaleString()}</span>
              </div>
              <span className="time">{hand.playedAt.toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default HandHistoryViewer;
