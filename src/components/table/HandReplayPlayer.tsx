/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎬 HAND REPLAY PLAYER — Visual Hand Replay (Premium-Style)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Full visual hand replay with:
 * - Animated card dealing
 * - Action-by-action playback
 * - Play/pause/scrubber controls
 * - Speed control
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './HandReplayPlayer.css';
import { CardImage, type Card } from './CardImage';
import type { ShareableHand, ShareableCard, ShareableAction } from './ShareHand';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ReplayState = 'IDLE' | 'PLAYING' | 'PAUSED' | 'COMPLETE';
export type ReplaySpeed = 0.5 | 1 | 1.5 | 2;

interface ReplayStep {
  type:
    | 'DEAL_HOLE'
    | 'POST_BLIND'
    | 'ACTION'
    | 'DEAL_FLOP'
    | 'DEAL_TURN'
    | 'DEAL_RIVER'
    | 'SHOWDOWN'
    | 'AWARD_POT';
  seat?: number;
  action?: ShareableAction;
  cards?: ShareableCard[];
  card?: ShareableCard;
  amount?: number;
  delay: number; // ms before next step
}

export interface HandReplayPlayerProps {
  hand: ShareableHand;
  autoPlay?: boolean;
  onComplete?: () => void;
  onShare?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert ShareableCard to CardImage Card type.
 * ShareableCard.rank can be '10' or 'T' or 'A' etc — normalize to Card format.
 */
function toCard(sc: ShareableCard): Card {
  let rank = sc.rank;
  if (rank === '10') rank = 'T';
  return { rank: rank as Card['rank'], suit: sc.suit as Card['suit'] };
}

// Position labels for display
const POSITION_NAMES = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'MP+1', 'HJ', 'CO'];

// Generate replay steps from hand data
function generateReplaySteps(hand: ShareableHand): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const baseDelay = 800;

  // Deal hole cards
  for (const player of hand.players) {
    if (player.cards) {
      steps.push({
        type: 'DEAL_HOLE',
        seat: player.seat,
        cards: player.cards,
        delay: 200,
      });
    }
  }
  steps.push({ type: 'DEAL_HOLE', delay: 500 }); // Pause after dealing

  // Preflop actions
  for (const action of hand.preflop) {
    steps.push({
      type: 'ACTION',
      seat: action.seat,
      action,
      delay: baseDelay,
    });
  }

  // Flop
  if (hand.flop) {
    steps.push({
      type: 'DEAL_FLOP',
      cards: hand.flop.cards,
      delay: 600,
    });
    for (const action of hand.flop.actions) {
      steps.push({
        type: 'ACTION',
        seat: action.seat,
        action,
        delay: baseDelay,
      });
    }
  }

  // Turn
  if (hand.turn) {
    steps.push({
      type: 'DEAL_TURN',
      card: hand.turn.card,
      delay: 600,
    });
    for (const action of hand.turn.actions) {
      steps.push({
        type: 'ACTION',
        seat: action.seat,
        action,
        delay: baseDelay,
      });
    }
  }

  // River
  if (hand.river) {
    steps.push({
      type: 'DEAL_RIVER',
      card: hand.river.card,
      delay: 600,
    });
    for (const action of hand.river.actions) {
      steps.push({
        type: 'ACTION',
        seat: action.seat,
        action,
        delay: baseDelay,
      });
    }
  }

  // Showdown
  const shownPlayers = hand.players.filter((p) => p.cards && p.isWinner);
  if (shownPlayers.length > 0) {
    steps.push({
      type: 'SHOWDOWN',
      delay: 1000,
    });
  }

  // Award pot
  for (const winner of hand.winners) {
    steps.push({
      type: 'AWARD_POT',
      seat: winner.seat,
      amount: winner.amount,
      delay: 800,
    });
  }

  return steps;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function HandReplayPlayer({
  hand,
  autoPlay = true,
  onComplete,
  onShare,
}: HandReplayPlayerProps) {
  const [state, setState] = useState<ReplayState>('IDLE');
  const [currentStep, setCurrentStep] = useState(0);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [showControls, setShowControls] = useState(true);

  // Current display state
  const [visibleCards, setVisibleCards] = useState<Record<number, ShareableCard[]>>({});
  const [board, setBoard] = useState<ShareableCard[]>([]);
  const [pot, setPot] = useState(0);
  const [activeAction, setActiveAction] = useState<{ seat: number; text: string } | null>(null);
  const [winningSeats, setWinningSeats] = useState<number[]>([]);
  const [visibleSeats, setVisibleSeats] = useState<Set<number>>(new Set());

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // HRP-1 BUG FIX: store onComplete in a ref so executeStep's dep array is
  // [steps] only. If onComplete is an inline arrow in the parent, its identity
  // changes on every parent render, which forced executeStep to recreate →
  // play-loop useEffect rescheduled the timer → double step execution.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Generate steps
  const steps = useMemo(() => generateReplaySteps(hand), [hand]);
  const progress = steps.length > 0 ? (currentStep / steps.length) * 100 : 0;

  // X6.2d: compute step indices for the start of each street
  const streetBoundaries = useMemo(() => {
    const boundaries: { label: string; stepIndex: number }[] = [];
    // Preflop always starts at 0
    boundaries.push({ label: 'Preflop', stepIndex: 0 });
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].type === 'DEAL_FLOP') boundaries.push({ label: 'Flop', stepIndex: i });
      if (steps[i].type === 'DEAL_TURN') boundaries.push({ label: 'Turn', stepIndex: i });
      if (steps[i].type === 'DEAL_RIVER') boundaries.push({ label: 'River', stepIndex: i });
      if (steps[i].type === 'SHOWDOWN') boundaries.push({ label: 'Showdown', stepIndex: i });
    }
    return boundaries;
  }, [steps]);

  // Execute a step
  const executeStep = useCallback(
    (stepIndex: number) => {
      if (stepIndex >= steps.length) {
        setState('COMPLETE');
        onCompleteRef.current?.();
        return;
      }

      const step = steps[stepIndex];

      switch (step.type) {
        case 'DEAL_HOLE':
          if (step.seat !== undefined && step.cards) {
            setVisibleCards((prev) => ({
              ...prev,
              [step.seat!]: step.cards!,
            }));
          }
          break;

        case 'ACTION':
          if (step.action) {
            const actionText = step.action.amount
              ? `${step.action.action} ${step.action.amount}`
              : step.action.action;
            setActiveAction({ seat: step.seat!, text: actionText });
            if (step.action.amount) {
              setPot((prev) => prev + step.action!.amount!);
            }
          }
          break;

        case 'DEAL_FLOP':
          if (step.cards) {
            setBoard(step.cards);
            setActiveAction(null);
          }
          break;

        case 'DEAL_TURN':
          if (step.card) {
            setBoard((prev) => [...prev, step.card!]);
            setActiveAction(null);
          }
          break;

        case 'DEAL_RIVER':
          if (step.card) {
            setBoard((prev) => [...prev, step.card!]);
            setActiveAction(null);
          }
          break;

        case 'SHOWDOWN':
          setActiveAction(null);
          break;

        case 'AWARD_POT':
          if (step.seat !== undefined) {
            setWinningSeats((prev) => [...prev, step.seat!]);
          }
          break;
      }

      setCurrentStep(stepIndex + 1);
    },
    [steps] // onComplete via ref — removing it from deps prevents timer reschedule storms
  );

  // Play loop
  useEffect(() => {
    if (state !== 'PLAYING') return;
    if (currentStep >= steps.length) {
      setState('COMPLETE');
      return;
    }

    const step = steps[currentStep];
    const delay = step.delay / speed;

    timerRef.current = setTimeout(() => {
      executeStep(currentStep);
    }, delay);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [state, currentStep, speed, steps, executeStep]);

  // Auto-play on mount
  useEffect(() => {
    if (autoPlay && state === 'IDLE') {
      setState('PLAYING');
    }
  }, [autoPlay, state]);

  useEffect(() => {
    // BUG FIX: collect timeout IDs and clear them all on cleanup.
    // Without this, if `hand` changes before all timeouts fire (e.g. rapid
    // navigation), old timeouts fire setVisibleSeats on a stale hand.
    const ids: ReturnType<typeof setTimeout>[] = [];
    hand.players.forEach((player, i) => {
      const id = setTimeout(() => {
        setVisibleSeats((prev) => new Set([...prev, player.seat]));
      }, i * 60);
      ids.push(id);
    });
    return () => ids.forEach(clearTimeout);
  }, [hand]);

  // Controls
  const handlePlayPause = useCallback(() => {
    if (state === 'PLAYING') {
      setState('PAUSED');
    } else if (state === 'PAUSED' || state === 'COMPLETE') {
      if (state === 'COMPLETE') {
        // Reset
        setCurrentStep(0);
        setVisibleCards({});
        setBoard([]);
        setPot(0);
        setActiveAction(null);
        setWinningSeats([]);
      }
      setState('PLAYING');
    } else {
      setState('PLAYING');
    }
  }, [state]);

  // X6.2d: re-simulate all steps up to a target index to rebuild display state
  const jumpToStep = useCallback(
    (targetStep: number) => {
      // BUG FIX: cancel the active play-loop timer before taking over state.
      // Without this, if the user clicks a street button while PLAYING, the
      // play-loop timer fires executeStep() concurrently with jumpToStep,
      // causing double-execution and corrupted display state.
      if (timerRef.current) clearTimeout(timerRef.current);
      // Reset state
      setVisibleCards({});
      setBoard([]);
      setPot(0);
      setActiveAction(null);
      setWinningSeats([]);
      // Re-execute every step up to (but not including) targetStep
      const nextCards: Record<number, ShareableCard[]> = {};
      let nextBoard: ShareableCard[] = [];
      let nextPot = 0;
      let nextAction: { seat: number; text: string } | null = null;
      const nextWinners: number[] = [];
      for (let i = 0; i < targetStep && i < steps.length; i++) {
        const s = steps[i];
        if (s.type === 'DEAL_HOLE' && s.seat !== undefined && s.cards) {
          nextCards[s.seat] = s.cards;
        } else if (s.type === 'ACTION' && s.action) {
          const txt = s.action.amount ? `${s.action.action} ${s.action.amount}` : s.action.action;
          nextAction = { seat: s.seat!, text: txt };
          if (s.action.amount) nextPot += s.action.amount;
        } else if (s.type === 'DEAL_FLOP' && s.cards) {
          nextBoard = [...s.cards];
          nextAction = null;
        } else if ((s.type === 'DEAL_TURN' || s.type === 'DEAL_RIVER') && s.card) {
          nextBoard = [...nextBoard, s.card];
          nextAction = null;
        } else if (s.type === 'SHOWDOWN') {
          nextAction = null;
        } else if (s.type === 'AWARD_POT' && s.seat !== undefined) {
          nextWinners.push(s.seat);
        }
      }
      setVisibleCards(nextCards);
      setBoard(nextBoard);
      setPot(nextPot);
      setActiveAction(nextAction);
      setWinningSeats(nextWinners);
      setCurrentStep(targetStep);
      setState('PAUSED');
    },
    [steps]
  );

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const targetStep = Math.floor((parseInt(e.target.value) / 100) * steps.length);
      jumpToStep(targetStep);
    },
    [steps.length, jumpToStep]
  );

  // Hide controls after delay
  // BUG FIX: remove currentStep from deps. Including it caused a new 3s timer
  // to be scheduled on every step advance, creating a timer storm during fast
  // playback where the controls flickered off/on unpredictably. The intent is
  // to auto-hide after playback starts, not after every individual step.
  useEffect(() => {
    if (state === 'PLAYING') {
      const timer = setTimeout(() => setShowControls(false), 3000);
      return () => clearTimeout(timer);
    } else {
      setShowControls(true);
    }
  }, [state]);

  return (
    <div
      className="replay-player"
      onMouseMove={() => setShowControls(true)}
      onClick={handlePlayPause}
    >
      {/* Table Background */}
      <div className="replay-player__table">
        {/* Players */}
        <div className="replay-player__seats">
          {hand.players.map((player, idx) => {
            const angle = (idx / hand.players.length) * 360 - 90;
            const isActive = activeAction?.seat === player.seat;
            const isWinner = winningSeats.includes(player.seat);
            const cards = visibleCards[player.seat];

            return (
              <div
                key={player.seat}
                className={`replay-player__seat ${isActive ? 'replay-player__seat--active' : ''} ${isWinner ? 'replay-player__seat--winner' : ''}`}
                style={
                  {
                    '--angle': `${angle}deg`,
                    opacity: visibleSeats.has(player.seat) ? 1 : 0,
                    transform: visibleSeats.has(player.seat) ? 'scale(1)' : 'scale(0.8)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  } as React.CSSProperties
                }
              >
                <div className="replay-player__player-info">
                  <span className="replay-player__name">{player.name}</span>
                  <span className="replay-player__stack">{player.stack.toLocaleString()}</span>
                </div>

                {/* Hole Cards — Custom PNG Deck */}
                {cards && (
                  <div className="replay-player__hole-cards">
                    {cards.map((card, ci) => (
                      <div key={ci} className="replay-player__card-img">
                        <CardImage
                          card={toCard(card)}
                          deckStyle="4color"
                          size="sm"
                          isHighlighted={isWinner}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Action Chip */}
                {isActive && activeAction && (
                  <div className="replay-player__action-chip">{activeAction.text}</div>
                )}

                {/* Winner Badge */}
                {isWinner && <div className="replay-player__winner-badge"></div>}
              </div>
            );
          })}
        </div>

        {/* Board — Custom PNG Deck */}
        <div className="replay-player__board">
          {board.map((card, idx) => (
            <div key={idx} className="replay-player__board-card-img">
              <CardImage card={toCard(card)} deckStyle="4color" size="md" />
            </div>
          ))}
        </div>

        {/* Pot */}
        {pot > 0 && <div className="replay-player__pot">Pot: {pot.toLocaleString()}</div>}
      </div>

      {/* Controls Overlay */}
      <div
        className={`replay-player__controls ${showControls ? 'replay-player__controls--visible' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="replay-player__header">
          <span className="replay-player__game-info">
            {hand.variant} {hand.stakes}
          </span>
          {onShare && (
            <button className="replay-player__share-btn" onClick={onShare}>
              Share
            </button>
          )}
        </div>

        {/* X6.2d: Street Navigation Buttons */}
        <div className="replay-player__streets">
          {streetBoundaries.map((street, idx) => {
            // HRP-2 BUG FIX: use map idx directly instead of O(n) indexOf call
            // (indexOf was called twice per element → O(n²) per render).
            const isCurrentStreet =
              currentStep >= street.stepIndex &&
              (idx === streetBoundaries.length - 1 ||
                currentStep < streetBoundaries[idx + 1].stepIndex);
            return (
              <button
                key={street.label}
                className={`replay-player__street-btn ${isCurrentStreet ? 'replay-player__street-btn--active' : ''}`}
                onClick={() => jumpToStep(street.stepIndex)}
              >
                {street.label}
              </button>
            );
          })}
        </div>

        {/* Bottom Controls */}
        <div className="replay-player__bottom">
          <button className="replay-player__play-btn" onClick={handlePlayPause}>
            {state === 'PLAYING' ? '⏸' : state === 'COMPLETE' ? '⟳' : '▶'}
          </button>

          <input
            type="range"
            className="replay-player__scrubber"
            min={0}
            max={100}
            value={progress}
            onChange={handleSeek}
          />

          <div className="replay-player__speed">
            {[0.5, 1, 1.5, 2].map((s) => (
              <button
                key={s}
                className={`replay-player__speed-btn ${speed === s ? 'replay-player__speed-btn--active' : ''}`}
                onClick={() => setSpeed(s as ReplaySpeed)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default HandReplayPlayer;
