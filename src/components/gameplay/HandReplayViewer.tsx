/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎬 HAND REPLAY VIEWER — Animated Hand Playback
 * Step-by-step replay of past hands with player actions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { CardImage } from '../table/CardImage';
import type { Card } from '../table/CardImage';
import styles from './HandReplayViewer.module.css';
import { reportError } from '../../utils/errorReporter';

interface HandAction {
  playerId: string;
  playerName: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in';
  amount?: number;
  street: 'preflop' | 'flop' | 'turn' | 'river';
  timestamp: number;
}

interface HandPlayer {
  id: string;
  name: string;
  position: number;
  holeCards?: string[];
  startStack: number;
  finalStack: number;
  isWinner: boolean;
}

interface HandData {
  id: string;
  tableName: string;
  gameType: string;
  blinds: string;
  pot: number;
  communityCards: string[];
  players: HandPlayer[];
  actions: HandAction[];
  winners: { playerId: string; amount: number }[];
  playedAt: string;
}

interface HandReplayViewerProps {
  handId?: string;
  handData?: HandData;
  autoPlay?: boolean;
  onClose?: () => void;
}

export default function HandReplayViewer({
  handId,
  handData: propHandData,
  autoPlay = false,
  onClose,
}: HandReplayViewerProps) {
  const [hand, setHand] = useState<HandData | null>(propHandData || null);
  const [loading, setLoading] = useState(!propHandData);
  const [currentStep, setCurrentStep] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [visibleCards, setVisibleCards] = useState<string[]>([]);
  const [currentPot, setCurrentPot] = useState(0);
  const [visibleActions, setVisibleActions] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!hand) return;
    hand.actions.forEach((_, i) => {
      if (i <= currentStep) {
        setTimeout(() => setVisibleActions((prev) => new Set(prev).add(i)), i * 40);
      }
    });
  }, [hand?.actions.length, currentStep]);

  useEffect(() => {
    if (handId && !propHandData) {
      loadHand();
    }
  }, [handId]);

  useEffect(() => {
    if (!isPlaying || !hand) return;
    const interval = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev >= hand.actions.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 1500 / playSpeed);
    return () => clearInterval(interval);
  }, [isPlaying, hand, playSpeed]);

  useEffect(() => {
    if (!hand) return;
    updateBoard();
  }, [currentStep, hand]);

  const loadHand = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('hands')
        .select(
          `
                    id,
                    table_name,
                    game_type,
                    blinds,
                    pot,
                    community_cards,
                    players,
                    actions,
                    winners,
                    played_at
                `
        )
        .eq('id', handId)
        .maybeSingle();

      if (!error && data) {
        setHand({
          id: data.id,
          tableName: data.table_name,
          gameType: data.game_type,
          blinds: data.blinds,
          pot: data.pot,
          communityCards: data.community_cards || [],
          players: data.players || [],
          actions: data.actions || [],
          winners: data.winners || [],
          playedAt: data.played_at,
        });
      }
    } catch (error) {
      reportError(error, 'HandReplayViewer.Failed_to_load_hand');
    }
    setLoading(false);
  };

  const updateBoard = useCallback(() => {
    if (!hand) return;

    const actionsUpToStep = hand.actions.slice(0, currentStep + 1);
    const lastAction = actionsUpToStep[actionsUpToStep.length - 1];

    // Calculate pot up to this point
    const potTotal = actionsUpToStep.reduce((sum, a) => sum + (a.amount || 0), 0);
    setCurrentPot(potTotal);

    // Determine visible community cards
    if (!lastAction) {
      setVisibleCards([]);
    } else if (lastAction.street === 'preflop') {
      setVisibleCards([]);
    } else if (lastAction.street === 'flop') {
      setVisibleCards(hand.communityCards.slice(0, 3));
    } else if (lastAction.street === 'turn') {
      setVisibleCards(hand.communityCards.slice(0, 4));
    } else if (lastAction.street === 'river') {
      setVisibleCards(hand.communityCards);
    }
  }, [hand, currentStep]);

  const stepForward = () => {
    if (!hand || currentStep >= hand.actions.length - 1) return;
    setCurrentStep((prev) => prev + 1);
  };

  const stepBackward = () => {
    if (currentStep < 0) return;
    setCurrentStep((prev) => prev - 1);
  };

  const togglePlay = () => setIsPlaying(!isPlaying);

  const reset = () => {
    setCurrentStep(-1);
    setIsPlaying(false);
  };

  const skipToEnd = () => {
    if (!hand) return;
    setCurrentStep(hand.actions.length - 1);
    setIsPlaying(false);
  };

  const getActionDisplay = (action: HandAction): { text: string; color: string } => {
    switch (action.action) {
      case 'fold':
        return { text: 'Folds', color: '#6b7280' };
      case 'check':
        return { text: 'Checks', color: '#3b82f6' };
      case 'call':
        return { text: `Calls ${action.amount}`, color: '#10b981' };
      case 'bet':
        return { text: `Bets ${action.amount}`, color: '#f59e0b' };
      case 'raise':
        return { text: `Raises to ${action.amount}`, color: '#ef4444' };
      case 'all-in':
        return { text: `All-In ${action.amount}`, color: '#a855f7' };
      default:
        return { text: action.action, color: '#ffffff' };
    }
  };

  const parseCard = (cardStr: string): Card => {
    const suit = cardStr.slice(-1) as Card['suit'];
    let rank = cardStr.slice(0, -1);
    if (rank === '10') rank = 'T';
    return { rank: rank as Card['rank'], suit };
  };

  if (loading) {
    return (
      <div className={styles.viewer}>
        <div className={styles.loading}>Loading hand...</div>
      </div>
    );
  }

  if (!hand) {
    return (
      <div className={styles.viewer}>
        <div className={styles.error}>Hand not found</div>
      </div>
    );
  }

  const currentAction = currentStep >= 0 ? hand.actions[currentStep] : null;

  return (
    <div className={styles.viewer}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.handInfo}>
          <h3>🎬 Hand Replay</h3>
          <span className={styles.subtitle}>
            {hand.tableName} • {hand.blinds} {hand.gameType}
          </span>
        </div>
        {onClose && (
          <button className={styles.closeBtn} onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      {/* Board */}
      <div className={styles.board}>
        <div className={styles.communityCards}>
          {visibleCards.length > 0 ? (
            visibleCards.map((card, i) => (
              <div key={i} className={styles.cardWrapper}>
                <CardImage card={parseCard(card)} deckStyle="4color" size="sm" />
              </div>
            ))
          ) : (
            <span className={styles.noCards}>Preflop</span>
          )}
        </div>
        <div className={styles.potDisplay}>Pot: {currentPot.toLocaleString()}</div>
      </div>

      {/* Current Action */}
      {currentAction && (
        <div className={styles.actionDisplay}>
          <span className={styles.actionPlayer}>{currentAction.playerName}</span>
          <span
            className={styles.actionText}
            style={{ color: getActionDisplay(currentAction).color }}
          >
            {getActionDisplay(currentAction).text}
          </span>
        </div>
      )}

      {/* Action History */}
      <div className={styles.history}>
        {hand.actions.slice(0, currentStep + 1).map((action, i) => (
          <div
            key={i}
            className={`${styles.historyItem} ${i === currentStep ? styles.current : ''}`}
            style={{
              opacity: visibleActions.has(i) ? 1 : 0,
              transform: visibleActions.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <span className={styles.historyPlayer}>{action.playerName}</span>
            <span style={{ color: getActionDisplay(action).color }}>
              {getActionDisplay(action).text}
            </span>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        <button onClick={reset} title="Reset">
          ⏮️
        </button>
        <button onClick={stepBackward} title="Step Back">
          ⏪
        </button>
        <button onClick={togglePlay} className={styles.playBtn}>
          {isPlaying ? '⏸️' : '▶️'}
        </button>
        <button onClick={stepForward} title="Step Forward">
          ⏩
        </button>
        <button onClick={skipToEnd} title="Skip to End">
          ⏭️
        </button>

        <div className={styles.speedControl}>
          <span>Speed:</span>
          <select value={playSpeed} onChange={(e) => setPlaySpeed(Number(e.target.value))}>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={3}>3x</option>
          </select>
        </div>
      </div>

      {/* Progress Bar */}
      <div className={styles.progress}>
        <div
          className={styles.progressFill}
          style={{
            width: `${hand.actions.length > 0 ? ((currentStep + 1) / hand.actions.length) * 100 : 0}%`,
          }}
        />
      </div>

      {/* Winners (at end) */}
      {currentStep >= hand.actions.length - 1 && hand.winners.length > 0 && (
        <div className={styles.winners}>
          {hand.winners
            .map((w, i) => {
              const player = hand.players.find((p) => p.id === w.playerId);
              return (
                <span key={i}>
                  {player?.name || 'Unknown'} wins{' '}
                  {w.amount.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              );
            })
            .reduce((prev, curr) => (
              <>
                {prev}, {curr}
              </>
            ))}
        </div>
      )}
    </div>
  );
}
