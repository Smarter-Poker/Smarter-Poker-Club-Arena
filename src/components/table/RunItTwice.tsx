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

import React, { useState, useEffect } from 'react';
import { CardImage } from './CardImage';
import type { Card as CardImageCard } from './CardImage';
import { formatPopupText } from '../../utils/popupStyle';
import './RunItTwice.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's';
}

/**
 * POKERBROS PARITY 2026-08-26: one row per all-in participant in the consent
 * panel — hole cards, equity when the table computed it, and a live check
 * that flips green the moment that player agrees (rit_response_update).
 */
export interface RitPanelPlayer {
  id: string;
  name: string;
  cards: Card[];
  /** 0-100, absent when equity was not broadcast for this hand. */
  equityPct?: number;
  accepted: boolean;
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
  /** FIX 96: number of runs chosen (2 or 3).
   *  UNDEFINED MEANS "NOT ANSWERED YET" and is what puts the chooser in front
   *  of the Run Once / Twice / 3 Times buttons. TablePage held this in a
   *  `useState<2 | 3>(2)` until 2026-08-28, so it was never undefined and the
   *  chooser's own question was unreachable. Do not give it a default. */
  chosenRuns?: 2 | 3;
  /** FIX 96: max runs allowed (2 or 3) */
  maxRuns?: 2 | 3;
  /** FIX 96: number of players in the all-in (affects RIT eligibility) */
  playerCount?: number;
  opponentName: string;
  /** Community cards already dealt when the all-in locked (0, 3 or 4). */
  boardCards?: Card[];
  /** The full pot at stake. */
  potAmount?: number;
  /** All-in participants for the consent rows. */
  players?: RitPanelPlayer[];
  /** Countdown denominator — the shared offer window (engine 25s). */
  totalSeconds?: number;
  /** True once the hero has already accepted (buttons become a waiting line). */
  heroAccepted?: boolean;
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
  boardCards = [],
  potAmount,
  players = [],
  totalSeconds = 25,
  heroAccepted = false,
  currency = '$',
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
  //
  // POKERBROS PARITY 2026-08-26: the panel is now the reference consent
  // sheet — board preview with face-down slots for undealt streets, the pot,
  // one shared live countdown, and a consent row per all-in player whose
  // check flips the moment they agree. Responders can Accept or Decline from
  // the moment the panel opens (the engine's consent-race fix records an
  // accept that lands before the chooser picks).
  const isChooserPhase = isChooser && !chosenRuns;
  const runsLabel = chosenRuns === 3 ? '3 Times' : 'Twice';
  const undealt = Math.max(0, 5 - boardCards.length);

  return (
    <div className="rit-overlay">
      <div
        className="rit-panel"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(10px)',
          transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
        role="dialog"
        aria-label="Run It Multiple Times"
      >
        <h3 className="rit-panel__title">Run It Multiple Times</h3>

        <div className="rit-panel__board-row">
          <span className="rit-panel__board-label">Board:</span>
          <div className="rit-panel__board-cards">
            {boardCards.map((card, i) => (
              <span key={`bc-${i}`} className="rit-panel__card">
                <CardImage card={toCardImage(card)} size="xs" />
              </span>
            ))}
            {Array.from({ length: undealt }, (_, i) => (
              <span key={`bk-${i}`} className="rit-panel__card rit-panel__card--back" />
            ))}
          </div>
        </div>

        <div className="rit-panel__meta">
          {potAmount != null && (
            <span className="rit-panel__pot">
              Pot: {currency}
              {potAmount.toLocaleString()}
            </span>
          )}
          <span className="rit-panel__countdown">Countdown: {Math.max(0, timeRemaining)}s</span>
        </div>
        <div className="rit-panel__timer-bar">
          <div
            className="rit-panel__timer-fill"
            style={{
              width: `${Math.min(100, Math.max(0, (timeRemaining / Math.max(1, totalSeconds)) * 100))}%`,
            }}
          />
        </div>

        {players.length > 0 && (
          <div className="rit-panel__players">
            {players.map((p) => (
              <div key={p.id} className="rit-panel__player">
                <div className="rit-panel__player-cards">
                  {p.cards.map((card, i) => (
                    <span key={`pc-${p.id}-${i}`} className="rit-panel__card rit-panel__card--sm">
                      <CardImage card={toCardImage(card)} size="xs" />
                    </span>
                  ))}
                </div>
                <span className="rit-panel__player-name">{p.name}</span>
                {typeof p.equityPct === 'number' && (
                  <span className="rit-panel__player-equity">{p.equityPct.toFixed(2)}%</span>
                )}
                <span
                  className={`rit-panel__check ${p.accepted ? 'rit-panel__check--on' : ''}`}
                  aria-label={p.accepted ? `${p.name} Accepted` : `${p.name} Deciding`}
                >
                  {p.accepted ? '✓' : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* HOUSE RULE (Dan 2026-08-26): First Letter Of Every Word — the
            panel bypasses the Toast layer, so the same central transform
            applies here. Player names keep their interior capitals.

            NEVER ADDRESS THE HERO IN THE THIRD PERSON (Dan 2026-08-28). This
            read `${opponentName} Requests To Run It Twice.` for everyone, and
            `opponentName` is the CHOOSER's name — so a chooser was told, by
            name, that he had requested something. Dan, from a live all-in:
            "this card says 'kingfish offers to run it twice'. I didn't offer
            anything yet." The stale `chosenRuns` initialiser is what made him
            see it before he had answered, and that is fixed in TablePage; this
            line is the other half, because the sentence would still have been
            wrong the moment he DID answer. */}
        <p className="rit-panel__message">
          {formatPopupText(
            isChooserPhase
              ? 'You Have The Best Hand. Choose How Many Times To Run It.'
              : isChooser && chosenRuns
                ? `You Asked To Run It ${runsLabel}.`
                : chosenRuns
                  ? `${opponentName} Requests To Run It ${runsLabel}.`
                  : `${opponentName} Is Choosing How Many Times To Run It.`
          )}
        </p>

        <div className="rit-panel__actions">
          {isChooserPhase ? (
            <>
              {/* FIX 188: Chooser can decline (run once), run twice, or run three times */}
              <button
                className="rit-panel__btn rit-panel__btn--decline"
                onClick={() => onChooserDecide?.(1)}
              >
                Run Once
              </button>
              <button
                className="rit-panel__btn rit-panel__btn--accept"
                onClick={() => onChooserDecide?.(2)}
              >
                Run It Twice
              </button>
              {maxRuns >= 3 && (
                <button
                  className="rit-panel__btn rit-panel__btn--accept rit-panel__btn--triple"
                  onClick={() => onChooserDecide?.(3)}
                >
                  Run It 3 Times
                </button>
              )}
            </>
          ) : heroAccepted || (isChooser && !!chosenRuns) ? (
            <span className="rit-panel__waiting">
              {formatPopupText('Waiting For Other Players…')}
            </span>
          ) : (
            <>
              <button className="rit-panel__btn rit-panel__btn--decline" onClick={onDecline}>
                Decline
              </button>
              <button className="rit-panel__btn rit-panel__btn--accept" onClick={onAccept}>
                Accept
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/*
 * COMPLETENESS PASS 2026-08-26: the RunItTwiceBoard component that lived
 * here was DEAD CODE — zero call sites anywhere in the app — and it was
 * also wrong: a hardcoded 2-player player/opponent/split model that never
 * learned about three runs, side pots, or multiway chops. The live
 * multi-board surface is the felt itself (TablePage ritBoardsView).
 */
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
  /**
   * POKERBROS PARITY 2026-08-26: community cards already dealt when the
   * all-in locked (0 / 3 / 4). Extra runs re-deal only the streets past
   * this — the felt dims the shared prefix on runs 2+.
   */
  baseBoardCount?: number;
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
    <div className="rit-result__overlay" onClick={onClose} role="dialog" aria-label="Run It Result">
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
                    ? `This Run Was Worth ${sharePct}% Of The Pot, Split ${winners.length} Ways`
                    : `This Run Was Worth ${sharePct}% Of The Pot`
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
