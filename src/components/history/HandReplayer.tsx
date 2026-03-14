/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎬 HAND REPLAYER — Animate Past Hands
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import './HandReplayer.css';

interface HandReplayerProps {
  handId: string;
  isOpen: boolean;
  onClose: () => void;
}

interface HandAction {
  player: string;
  action: string;
  amount?: number;
  street: 'preflop' | 'flop' | 'turn' | 'river';
}

interface HandData {
  id: string;
  players: { seat: number; name: string; stack: number; cards?: string[] }[];
  heroSeat: number;
  actions: HandAction[];
  communityCards: string[];
  potSize: number;
  winners: { player: string; amount: number }[];
}

export function HandReplayer({ handId, isOpen, onClose }: HandReplayerProps) {
  const toast = useToast();

  const [handData, setHandData] = useState<HandData | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentActionIndex, setCurrentActionIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [visibleCards, setVisibleCards] = useState<string[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => setMounted(true), 50);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && handId) {
      loadHandData();
    }
  }, [isOpen, handId]);

  useEffect(() => {
    if (!isPlaying || !handData) return;

    const timer = setTimeout(() => {
      if (currentActionIndex < handData.actions.length - 1) {
        advanceAction();
      } else {
        setIsPlaying(false);
      }
    }, 1500 / playbackSpeed);

    return () => clearTimeout(timer);
  }, [isPlaying, currentActionIndex, playbackSpeed, handData]);

  const loadHandData = async () => {
    setLoading(true);
    setCurrentActionIndex(0);
    setVisibleCards([]);

    try {
      const { data, error } = await supabase
        .from('hand_history')
        .select('*')
        .eq('id', handId)
        .maybeSingle();

      if (!error && data) {
        setHandData({
          id: data.id,
          players: data.players || [],
          heroSeat: data.hero_seat || 0,
          actions: data.actions || [],
          communityCards: data.community_cards || [],
          potSize: data.pot_size || 0,
          winners: data.winners || [],
        });
      }
    } catch (error) {
      toast.error('Failed to load hand');
    }
    setLoading(false);
  };

  const advanceAction = useCallback(() => {
    if (!handData) return;

    const nextIndex = currentActionIndex + 1;
    setCurrentActionIndex(nextIndex);

    // Reveal community cards based on street
    const action = handData.actions[nextIndex];
    if (action) {
      if (action.street === 'flop' && visibleCards.length < 3) {
        setVisibleCards(handData.communityCards.slice(0, 3));
      } else if (action.street === 'turn' && visibleCards.length < 4) {
        setVisibleCards(handData.communityCards.slice(0, 4));
      } else if (action.street === 'river' && visibleCards.length < 5) {
        setVisibleCards(handData.communityCards.slice(0, 5));
      }
    }
  }, [currentActionIndex, handData, visibleCards]);

  const togglePlay = () => {
    if (currentActionIndex >= (handData?.actions.length || 0) - 1) {
      setCurrentActionIndex(0);
      setVisibleCards([]);
    }
    setIsPlaying(!isPlaying);
  };

  const reset = () => {
    setCurrentActionIndex(0);
    setVisibleCards([]);
    setIsPlaying(false);
  };

  const formatCard = (card: string) => {
    const suit = card.slice(-1);
    const suitChar = suit === 'h' ? '♥' : suit === 'd' ? '♦' : suit === 'c' ? '♣' : '♠';
    const suitColor = suit === 'h' || suit === 'd' ? '#ef4444' : '#1a1a2e';
    return { rank: card.slice(0, -1), suit: suitChar, color: suitColor };
  };

  if (!isOpen) return null;

  if (loading || !handData) {
    return (
      <div className="replayer-overlay" onClick={onClose}>
        <div className="replayer" onClick={(e) => e.stopPropagation()}>
          <div className="replayer__loading">Loading...</div>
        </div>
      </div>
    );
  }

  const currentAction = handData.actions[currentActionIndex];

  return (
    <div className="replayer-overlay" onClick={onClose}>
      <div
        className="replayer"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="replayer__header">
          <h3>🎬 Hand Replayer</h3>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="replayer__table">
          <div className="community-cards">
            {visibleCards.map((card, idx) => {
              const { rank, suit, color } = formatCard(card);
              return (
                <div key={idx} className="card" style={{ color }}>
                  <span className="rank">{rank}</span>
                  <span className="suit">{suit}</span>
                </div>
              );
            })}
            {Array(5 - visibleCards.length)
              .fill(0)
              .map((_, idx) => (
                <div key={`empty-${idx}`} className="card empty" />
              ))}
          </div>

          <div className="pot">Pot: {handData.potSize.toLocaleString()}</div>
        </div>

        <div className="replayer__action">
          {currentAction && (
            <div className="current-action">
              <span className="player">{currentAction.player}</span>
              <span className="action">{currentAction.action}</span>
              {currentAction.amount && (
                <span className="amount">{currentAction.amount.toLocaleString()}</span>
              )}
            </div>
          )}
        </div>

        <div className="replayer__timeline">
          <div
            className="progress"
            style={{ width: `${(currentActionIndex / (handData.actions.length - 1)) * 100}%` }}
          />
        </div>

        <div className="replayer__controls">
          <button onClick={reset}>⏮️</button>
          <button onClick={() => setCurrentActionIndex(Math.max(0, currentActionIndex - 1))}>
            ⏪
          </button>
          <button className="play" onClick={togglePlay}>
            {isPlaying ? '⏸️' : '▶️'}
          </button>
          <button onClick={advanceAction}>⏩</button>
          <button onClick={() => setCurrentActionIndex(handData.actions.length - 1)}>⏭️</button>
          <select value={playbackSpeed} onChange={(e) => setPlaybackSpeed(Number(e.target.value))}>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>
        </div>
      </div>
    </div>
  );
}

export default HandReplayer;
