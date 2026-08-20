/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PINEAPPLE DISCARD — pick which of your three hole cards to throw away
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Crazy Pineapple deals three hole cards and, after the flop, every player still
 * in the hand discards one. That choice IS the game — it is the only decision
 * the variant adds over Hold'em, and it is made with the flop visible.
 *
 * Until 2026-08-20 there was no way for a human to make it. The engine had the
 * whole path (`performDiscard`, `PINEAPPLE_DISCARD_REQUIRED`, a discard timer,
 * `GameServerAPI.submitDiscard`) and the client had NOTHING: `submitDiscard` had
 * zero call sites anywhere in `src/`, and no component listened for the stage.
 *
 * So on all 103 pineapple tables the discard timer simply expired every hand and
 * the engine's fallback threw away the LAST card for every human, regardless of
 * the board. Worse, it was not symmetric — horses call
 * `HorseLogic.decideDiscard` and pick the equity-maximising card. The bots were
 * playing Crazy Pineapple correctly and the people were not playing it at all.
 */

import { useState, useEffect, useCallback } from 'react';
// Use CardImage's own Card shape ('h'|'d'|'c'|'s' suits) — it is what the felt
// renders and what mapEngineSnapshot normalises hero's hole cards into.
import CardImage, { type Card, type DeckStyle } from './CardImage';
import { haptic } from '../../services/SoundService';
import './PineappleDiscard.css';

export interface PineappleDiscardProps {
  isOpen: boolean;
  /** Hero's three hole cards, in the order the engine holds them. */
  cards: Card[];
  /**
   * Submit the discard. Resolve TRUE only when the engine accepted it — on false
   * the panel stays open so the player can try again before the timer expires.
   * The index is into `cards`, which must be the engine's own ordering.
   */
  onDiscard: (cardIndex: number) => Promise<boolean>;
  /** Epoch ms when the engine auto-discards for you. Drives the countdown. */
  deadline?: number | null;
  deckStyle?: DeckStyle;
}

export function PineappleDiscard({
  isOpen,
  cards,
  onDiscard,
  deadline,
  deckStyle,
}: PineappleDiscardProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Reset whenever a new discard phase opens.
  useEffect(() => {
    if (isOpen) {
      setSelected(null);
      setBusy(false);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !deadline) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [isOpen, deadline]);

  const submit = useCallback(async () => {
    if (selected === null || busy) return;
    setBusy(true);
    setError(null);
    haptic.medium();
    const ok = await onDiscard(selected);
    if (!ok) {
      // Do not close. The engine will auto-discard when the timer runs out, and
      // silently closing here would take the choice away exactly like the old
      // no-UI behaviour did.
      setError('The server did not accept that discard — try again.');
      setBusy(false);
      return;
    }
    setBusy(false);
  }, [selected, busy, onDiscard]);

  if (!isOpen || cards.length !== 3) return null;

  const urgent = secondsLeft !== null && secondsLeft <= 5;

  return (
    <div className="pineapple-discard" role="dialog" aria-modal="true" aria-labelledby="pd-title">
      <div className="pineapple-discard__panel">
        <div className="pineapple-discard__header">
          <h2 id="pd-title" className="pineapple-discard__title">
            Discard a card
          </h2>
          {secondsLeft !== null && (
            <span
              className={`pineapple-discard__timer${urgent ? ' pineapple-discard__timer--urgent' : ''}`}
              aria-live="off"
            >
              {secondsLeft}s
            </span>
          )}
        </div>

        <p className="pineapple-discard__hint">
          Pick the card to throw away. If the timer runs out the table discards your last card for
          you.
        </p>

        <div className="pineapple-discard__cards">
          {cards.map((card, i) => {
            const isSelected = selected === i;
            return (
              <button
                key={`${card.rank}${card.suit}-${i}`}
                type="button"
                className={`pineapple-discard__card${isSelected ? ' pineapple-discard__card--selected' : ''}`}
                aria-pressed={isSelected}
                aria-label={`Discard ${card.rank}${card.suit}`}
                disabled={busy}
                onClick={() => {
                  haptic.light();
                  setSelected(i);
                  setError(null);
                }}
              >
                <CardImage card={card} size="lg" deckStyle={deckStyle} />
                <span className="pineapple-discard__card-tag">{isSelected ? 'DISCARD' : 'KEEP'}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="pineapple-discard__error" role="alert">
            {error}
          </div>
        )}

        <button
          type="button"
          className="pineapple-discard__confirm"
          disabled={selected === null || busy}
          onClick={() => void submit()}
        >
          {busy
            ? 'Discarding…'
            : selected === null
              ? 'Select a card'
              : `Discard ${cards[selected].rank}${cards[selected].suit}`}
        </button>
      </div>
    </div>
  );
}

export default PineappleDiscard;
