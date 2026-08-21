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
  /** FIX 96: true = this player chooses how many runs (2 or 3) */
  isChooser?: boolean;
  /** FIX 96: callback when chooser decides number of runs */
  onChooserDecide?: (runs: 1 | 2 | 3) => Promise<void>;
  onAccept: () => void;
  onDecline: () => void;
  timeRemaining: number; // seconds
  /** FIX 96: number of runs chosen (2 or 3) */
  chosenRuns?: 2 | 3;
  /** FIX 96: max runs allowed (2 or 3) */
  maxRuns?: 2 | 3;
  /** FIX 96: number of players in the all-in (affects RIT eligibility) */
  playerCount?: number;
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
  isChooser = false,
  onChooserDecide,
  onAccept,
  onDecline,
  timeRemaining,
  chosenRuns,
  maxRuns = 2,
  playerCount: _playerCount,
  opponentName,
}: RunItTwicePromptProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // FIX 188: Bible V8 §4.20 — Chooser selects number of runs (2 or 3)
  // Phase 1: Chooser (best hand) picks runs. Phase 2: Others accept/decline.
  const isChooserPhase = isChooser && !chosenRuns;
  const isResponderPhase = !isChooser || !!chosenRuns;
  const runsLabel = chosenRuns === 3 ? 'Three Times' : 'Twice';

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
        <h3 className="rit-prompt__title">
          {isChooserPhase ? 'Run It Multiple Times?' : `Run it ${runsLabel}?`}
        </h3>
        <p className="rit-prompt__text">
          {isChooserPhase
            ? 'You have the best hand. Choose how many times to run the remaining cards.'
            : `${opponentName} wants to run the remaining cards ${runsLabel.toLowerCase()}. The pot will be split based on ${chosenRuns === 3 ? 'all three' : 'both'} runouts.`}
        </p>

        <div className="rit-prompt__timer">
          <div className="rit-prompt__timer-bar">
            <div
              className="rit-prompt__timer-fill"
              style={{ width: `${Math.min(100, (timeRemaining / 10) * 100)}%` }}
            />
          </div>
          <span className="rit-prompt__timer-text">{timeRemaining}s</span>
        </div>

        <div className="rit-prompt__actions">
          {isChooserPhase ? (
            <>
              {/* FIX 188: Chooser can decline (run once), run twice, or run three times */}
              <button
                className="rit-prompt__btn rit-prompt__btn--decline"
                onClick={() => onChooserDecide?.(1)}
              >
                Run Once
              </button>
              <button
                className="rit-prompt__btn rit-prompt__btn--accept"
                onClick={() => onChooserDecide?.(2)}
              >
                Run It Twice
              </button>
              {maxRuns >= 3 && (
                <button
                  className="rit-prompt__btn rit-prompt__btn--accept rit-prompt__btn--triple"
                  onClick={() => onChooserDecide?.(3)}
                >
                  Run It 3×
                </button>
              )}
            </>
          ) : (
            <>
              <button className="rit-prompt__btn rit-prompt__btn--decline" onClick={onDecline}>
                No Thanks
              </button>
              <button className="rit-prompt__btn rit-prompt__btn--accept" onClick={onAccept}>
                Run It {runsLabel}!
              </button>
            </>
          )}
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
        <span className="rit-board__badge"> Run It Twice</span>
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
              <CardImage card={toCardImage(card)} size="xs" />
            </span>
          ))}
          {/* Run 1 cards */}
          {run1Cards.map((card, i) => (
            <span key={`run1-${i}`} className="rit-board__card rit-board__card--new">
              <CardImage card={toCardImage(card)} size="xs" />
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
              <CardImage card={toCardImage(card)} size="xs" />
            </span>
          ))}
          {/* Run 2 cards */}
          {run2Cards.map((card, i) => (
            <span key={`run2-${i}`} className="rit-board__card rit-board__card--new">
              <CardImage card={toCardImage(card)} size="xs" />
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

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT OVERLAY (2026-08-18)
//
// The engine's rit_result event carried the boards and the per-player payout
// for every run-it-twice hand, and the client THREW IT AWAY (the handler was
// a stub) - players watched the pot ship with no runout cards shown at all,
// because RIT boards never enter the engine's community-card state either.
// This overlay is the only place a human sees the extra boards.
// ═══════════════════════════════════════════════════════════════════════════════

/** Engine card strings look like 'Ahearts' / '10diamonds'. */
export function parseRitCard(raw: string): Card | null {
  const m = /^(10|[2-9]|[TJQKA])(hearts|diamonds|clubs|spades)$/.exec(raw);
  if (!m) return null;
  return { rank: m[1] === '10' ? 'T' : m[1], suit: m[2][0] as Card['suit'] };
}

export interface RitResultData {
  runs: number;
  /** One array of card strings per board, engine format. */
  boards: string[][];
  /** userId → net amount won (post rake/BBJ). */
  distribution: Record<string, number>;
  /** Exact winner userIds per board (splits/side pots included). */
  perBoardWinners?: string[][];
  potTotal: number;
}

export interface RunItTwiceResultProps {
  isOpen: boolean;
  data: RitResultData | null;
  /** Resolve a userId to a display name (falls back to 'Player'). */
  resolveName: (userId: string) => string;
  onClose: () => void;
  currency?: string;
}

export function RunItTwiceResult({
  isOpen,
  data,
  resolveName,
  onClose,
  currency = '',
}: RunItTwiceResultProps) {
  if (!isOpen || !data) return null;
  const payouts = Object.entries(data.distribution)
    .filter(([, amt]) => amt > 0)
    .sort((x, y) => y[1] - x[1]);

  return (
    <div className="rit-result__overlay" onClick={onClose} role="dialog" aria-label="Run it result">
      <div className="rit-result" onClick={(e) => e.stopPropagation()}>
        <div className="rit-board__header">
          <span className="rit-board__badge">
            Ran It {data.runs === 3 ? 'Three Times' : 'Twice'}
          </span>
          <span className="rit-board__pot">
            Pot: {currency}
            {data.potTotal.toLocaleString()}
          </span>
        </div>

        {data.boards.map((board, bi) => {
          /* ANIMATION AUDIT 2026-08-20 — per-board equity.
             The overlay showed the boards and it showed the payouts, but
             nothing connected the two: a player saw five cards, then a number,
             and had to work out for themselves which run earned what. That is
             the one question run-it-twice creates and the only place it can be
             answered.
             Every run is worth an equal slice of the pot by definition, so the
             share is derived, not guessed — and when a board is split it is
             divided again among that board's winners. Rounded down per winner
             so the displayed parts can never sum to more than the pot. */
          const runs = data.runs || data.boards.length || 1;
          const boardValue = Math.floor(data.potTotal / runs);
          const winners = data.perBoardWinners?.[bi] ?? [];
          const perWinner =
            winners.length > 1 ? Math.floor(boardValue / winners.length) : boardValue;
          const sharePct = data.potTotal > 0 ? Math.round((boardValue / data.potTotal) * 100) : 0;

          return (
            <div key={`b-${bi}`} className="rit-board__run">
              <span className="rit-board__run-label">Run {bi + 1}</span>
              {winners.length > 0 && (
                <span className="rit-result__board-winner">
                  {winners.map(resolveName).join(' & ')}
                </span>
              )}
              <span
                className="rit-result__board-equity"
                title={
                  winners.length > 1
                    ? `This run was worth ${sharePct}% of the pot, split ${winners.length} ways`
                    : `This run was worth ${sharePct}% of the pot`
                }
              >
                {currency}
                {perWinner.toLocaleString()}
                {winners.length > 1 ? ` each` : ''}
                <span className="rit-result__board-pct">{sharePct}%</span>
              </span>
              <div className="rit-board__cards">
                {board.map((raw, ci) => {
                  const card = parseRitCard(raw);
                  /* ANIMATION AUDIT 2026-08-19: all 10-15 cards used to appear
                     in one frame. Each card now flips in with a stagger — board
                     1 first, board 2 after it, so the runs read as separate
                     deals (see .rit-board__card animation in RunItTwice.css). */
                  return card ? (
                    <span
                      key={`c-${bi}-${ci}`}
                      className="rit-board__card"
                      style={{ animationDelay: `${bi * 900 + ci * 140}ms` } as React.CSSProperties}
                    >
                      <CardImage card={toCardImage(card)} size="xs" />
                    </span>
                  ) : null;
                })}
              </div>
            </div>
          );
        })}

        <div className="rit-result__payouts">
          {payouts.map(([uid, amt]) => (
            <div key={uid} className="rit-result__payout">
              <span className="rit-result__name">{resolveName(uid)}</span>
              <span className="rit-result__amount">
                +{currency}
                {amt.toLocaleString()}
              </span>
            </div>
          ))}
        </div>

        <button className="rit-result__close" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

export default RunItTwicePrompt;
