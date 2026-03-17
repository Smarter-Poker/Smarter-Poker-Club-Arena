/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RUN IT TWICE — Deal Remaining Cards Twice
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * All-in feature to run board twice:
 * - Prompt before running
 * - Dual board display
 * - Pot split display
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { CardImage } from './CardImage';
import type { Card as CardImageCard } from './CardImage';
import './RunItTwice.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's';
}

export interface RunItTwicePromptProps {
  isOpen: boolean;
  onAccept: () => void;
  onDecline: () => void;
  timeRemaining: number; // seconds
  opponentName: string;
}

export interface RunItTwiceBoardProps {
  currentBoard: Card[];
  run1Cards: Card[]; // Additional cards for run 1
  run2Cards: Card[]; // Additional cards for run 2
  run1Winner: 'player' | 'opponent' | 'split';
  run2Winner: 'player' | 'opponent' | 'split';
  potAmount: number;
  playerName: string;
  opponentName: string;
  currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeRank(rank: string): CardImageCard['rank'] {
  if (rank === '10') return 'T';
  return rank as CardImageCard['rank'];
}

function toCardImage(card: Card): CardImageCard {
  return { rank: normalizeRank(card.rank), suit: card.suit };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RunItTwicePrompt({
  isOpen,
  onAccept,
  onDecline,
  timeRemaining,
  opponentName,
}: RunItTwicePromptProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => setMounted(true), 50);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="rit-overlay">
      <div
        className="rit-prompt"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="rit-prompt__icon"></div>
        <h3 className="rit-prompt__title">Run it Twice?</h3>
        <p className="rit-prompt__text">
          {opponentName} wants to run the remaining cards twice. The pot will be split based on both
          runouts.
        </p>

        <div className="rit-prompt__timer">
          <div className="rit-prompt__timer-bar">
            <div
              className="rit-prompt__timer-fill"
              style={{ width: `${(timeRemaining / 10) * 100}%` }}
            />
          </div>
          <span className="rit-prompt__timer-text">{timeRemaining}s</span>
        </div>

        <div className="rit-prompt__actions">
          <button className="rit-prompt__btn rit-prompt__btn--decline" onClick={onDecline}>
            No Thanks
          </button>
          <button className="rit-prompt__btn rit-prompt__btn--accept" onClick={onAccept}>
            Run it Twice!
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOARD COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RunItTwiceBoard({
  currentBoard,
  run1Cards,
  run2Cards,
  run1Winner,
  run2Winner,
  potAmount,
  playerName,
  opponentName,
  currency = '',
}: RunItTwiceBoardProps) {
  // Calculate pot splits
  const potSplit = useMemo(() => {
    let playerWins = 0;
    let opponentWins = 0;

    if (run1Winner === 'player') playerWins++;
    else if (run1Winner === 'opponent') opponentWins++;
    else {
      playerWins += 0.5;
      opponentWins += 0.5;
    }

    if (run2Winner === 'player') playerWins++;
    else if (run2Winner === 'opponent') opponentWins++;
    else {
      playerWins += 0.5;
      opponentWins += 0.5;
    }

    return {
      player: Math.trunc(potAmount * (playerWins / 2) * 100) / 100,
      opponent: Math.trunc(potAmount * (opponentWins / 2) * 100) / 100,
    };
  }, [run1Winner, run2Winner, potAmount]);

  return (
    <div className="rit-board">
      <div className="rit-board__header">
        <span className="rit-board__badge"> Run it Twice</span>
        <span className="rit-board__pot">
          Pot: {currency}
          {potAmount.toLocaleString()}
        </span>
      </div>

      {/* Run 1 */}
      <div
        className={`rit-board__run ${run1Winner === 'player' ? 'rit-board__run--won' : run1Winner === 'opponent' ? 'rit-board__run--lost' : ''}`}
      >
        <span className="rit-board__run-label">Run 1</span>
        <div className="rit-board__cards">
          {/* Current board (faded) */}
          {currentBoard.map((card, i) => (
            <span key={`base-${i}`} className="rit-board__card rit-board__card--base">
              <CardImage card={toCardImage(card)} deckStyle="4color" size="xs" />
            </span>
          ))}
          {/* Run 1 cards */}
          {run1Cards.map((card, i) => (
            <span key={`run1-${i}`} className="rit-board__card rit-board__card--new">
              <CardImage card={toCardImage(card)} deckStyle="4color" size="xs" />
            </span>
          ))}
        </div>
        <span className="rit-board__run-result">
          {run1Winner === 'player' && ` ${playerName} wins`}
          {run1Winner === 'opponent' && `${opponentName} wins`}
          {run1Winner === 'split' && 'Split pot'}
        </span>
      </div>

      {/* Run 2 */}
      <div
        className={`rit-board__run ${run2Winner === 'player' ? 'rit-board__run--won' : run2Winner === 'opponent' ? 'rit-board__run--lost' : ''}`}
      >
        <span className="rit-board__run-label">Run 2</span>
        <div className="rit-board__cards">
          {/* Current board (faded) */}
          {currentBoard.map((card, i) => (
            <span key={`base-${i}`} className="rit-board__card rit-board__card--base">
              <CardImage card={toCardImage(card)} deckStyle="4color" size="xs" />
            </span>
          ))}
          {/* Run 2 cards */}
          {run2Cards.map((card, i) => (
            <span key={`run2-${i}`} className="rit-board__card rit-board__card--new">
              <CardImage card={toCardImage(card)} deckStyle="4color" size="xs" />
            </span>
          ))}
        </div>
        <span className="rit-board__run-result">
          {run2Winner === 'player' && ` ${playerName} wins`}
          {run2Winner === 'opponent' && `${opponentName} wins`}
          {run2Winner === 'split' && 'Split pot'}
        </span>
      </div>

      {/* Summary */}
      <div className="rit-board__summary">
        <div className="rit-board__summary-row">
          <span className="rit-board__summary-name">{playerName}</span>
          <span className="rit-board__summary-amount rit-board__summary-amount--positive">
            +{currency}
            {potSplit.player.toLocaleString()}
          </span>
        </div>
        <div className="rit-board__summary-row">
          <span className="rit-board__summary-name">{opponentName}</span>
          <span className="rit-board__summary-amount">
            +{currency}
            {potSplit.opponent.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}

export default RunItTwicePrompt;
