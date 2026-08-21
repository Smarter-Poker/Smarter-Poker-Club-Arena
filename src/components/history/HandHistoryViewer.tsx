/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY VIEWER — Browse Past Hands
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
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
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (user?.id) {
      loadHands();
    }
  }, [user?.id, clubId, tableId]);

  const loadHands = async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      // Round 38 audit Pass 1 fix: hand_history's real schema is
      // (id, table_id, tournament_id, hand_number, game_variant, small_blind,
      //  big_blind, pot_size, rake_amount, community_cards, winners, players,
      //  actions, started_at, ended_at, hole_cards, board, created_at, ...).
      // The previous select referenced 11 non-existent columns (table_name,
      // stakes, result, game_type, hero_hand, played_at, user_id, club_id,
      // position, final_action) and filtered .eq('user_id', user.id) on a
      // column that doesn't exist — every player saw an empty list.
      // Fix: select real columns + filter via JSONB contains on the players
      // array. club_id is not on hand_history; if needed it would JOIN via
      // tables(id).club_id (deferred — not required for the viewer).
      let query = supabase
        .from('hand_history')
        .select(
          'id, table_id, tournament_id, hand_number, game_variant, small_blind, big_blind, pot_size, rake_amount, community_cards, winners, players, actions, started_at, ended_at, created_at'
        )
        .contains('players', [{ userId: user.id }])
        .order('created_at', { ascending: false })
        .limit(limit);

      if (clubId) {
        // resolveClubUUID kept warm; downstream club narrowing happens via
        // tables(id) join when that's wired in. No-op for now.
        await resolveClubUUID(clubId);
      }
      if (tableId) query = query.eq('table_id', tableId);

      const { data, error } = await query;

      if (!error && data) {
        setHands(
          data.map((h) => {
            // Round 38 audit Pass 1 fix: derive per-player fields from the
            // JSONB players array since hand_history doesn't store them as
            // top-level columns. The engine writes players as
            // [{ userId, username, seat, stack, cards }] and winners as
            // [{ userId, amount, ... }] (Bible V8 §2.5).
            const playersArr = Array.isArray(h.players) ? (h.players as any[]) : [];
            const winnersArr = Array.isArray(h.winners) ? (h.winners as any[]) : [];
            const myPlayer = playersArr.find((p) => p?.userId === user.id);
            const myWin = winnersArr.find((w) => w?.userId === user.id);
            const myFinalAction = (() => {
              if (!Array.isArray(h.actions)) return 'fold';
              const mySeat = myPlayer?.seat;
              if (mySeat == null) return 'fold';
              const myActions = (h.actions as any[]).filter((a) => a?.seat === mySeat);
              return myActions[myActions.length - 1]?.action || 'fold';
            })();
            return {
              id: h.id,
              tableId: h.table_id,
              tableName: 'Table', // table_name not on hand_history; lookup via tables(id) on demand
              stakes: `${h.small_blind ?? 1}/${h.big_blind ?? 2}`,
              potSize: h.pot_size || 0,
              myResult: myWin?.amount || 0,
              holeCards: myPlayer?.cards || [],
              communityCards: h.community_cards || [],
              position: 'BTN', // position not stored on hand_history; derive from seat vs dealer if added later
              action: myFinalAction,
              playedAt: new Date(h.ended_at || h.created_at),
            };
          })
        );
        setVisibleItems(new Set());
        staggerTimersRef.current.forEach((t) => clearTimeout(t));
        staggerTimersRef.current = data.map((_, i) =>
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
        );
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
        <CardImage key={i} card={parseCard(c)} size="xs" />
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
        <div className="empty-state">No Hands Found</div>
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
