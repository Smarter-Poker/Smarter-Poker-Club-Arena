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
import { cardWords } from '../../utils/cardWords';
import { haptic } from '../../services/SoundService';
import { serverNow } from '../../utils/serverClock';
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
  /**
   * Epoch ms when the engine FOLDS you for missing the round. Absolute and
   * server-authored - see the discard-clock block in TablePage. Read against
   * serverNow() so a skewed device clock cannot make this panel disagree with
   * the deadline actually being enforced.
   */
  deadline?: number | null;
  deckStyle?: DeckStyle;
  /**
   * How long the round runs, ms, as the ENGINE reports it. Drives when the
   * countdown turns urgent. Without it the threshold was a hard-coded 5s,
   * which is most of a 6-second round and a blink of a 30-second one - and
   * action_time_seconds is a per-table setting, so both exist.
   */
  durationMs?: number;
  /** Time bank uses the player has left. 0 hides the button entirely. */
  timeBanksRemaining?: number;
  /**
   * Spend one. The engine extends THIS seat's deadline and nobody else's.
   * Resolves `{ armed: true }` when the ordinary clock was not yet exhausted:
   * nothing has been spent, the bank redeems itself at expiry, and the panel
   * says so in place rather than through a toast (Dan 2026-08-24).
   */
  onTimeBank?: () => void | Promise<{ armed?: boolean } | void>;
}

export function PineappleDiscard({
  isOpen,
  cards,
  onDiscard,
  deadline,
  deckStyle,
  durationMs = 0,
  timeBanksRemaining = 0,
  onTimeBank,
}: PineappleDiscardProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  /* Armed = pressed with clock still to run. Nothing spent, nothing to count
     down yet, so the button becomes the notice instead of firing a popup. */
  const [bankArmed, setBankArmed] = useState(false);

  // Reset whenever a new discard phase opens.
  useEffect(() => {
    if (isOpen) {
      setSelected(null);
      setBusy(false);
      setError(null);
      setBankArmed(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !deadline) {
      setSecondsLeft(null);
      return;
    }
    /* serverNow(), not Date.now(). The engine stamps its own clock on every
       snapshot and the shared helper tracks the offset, so a device running a
       few seconds fast cannot drain this ring early - which, on a round where
       running out FOLDS you, is the difference between a decision and a
       confiscation. */
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - serverNow()) / 1000)));
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
      setError('The server did not accept that discard - try again.');
      setBusy(false);
      return;
    }
    setBusy(false);
  }, [selected, busy, onDiscard]);

  if (!isOpen || cards.length !== 3) return null;

  /* The last third of whatever the table actually allows, clamped so a very
     long round does not spend ten seconds shouting and a very short one still
     warns at all. */
  const urgentAt = durationMs > 0 ? Math.min(8, Math.max(3, Math.round(durationMs / 3000))) : 5;
  const urgent = secondsLeft !== null && secondsLeft <= urgentAt;

  return (
    <div className="pineapple-discard" role="dialog" aria-labelledby="pd-title">
      <div className="pineapple-discard__panel">
        <div className="pineapple-discard__header">
          <h2 id="pd-title" className="pineapple-discard__title">
            Discard A Card
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
          Pick The Card To Throw Away. Miss The Timer And Your Hand Is Folded.
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
                /* "Discard Ace Of Spades", not "Discard As".
                   DEEP DIVE 2026-09-06: Phase 7 gave every card FACE its words
                   and missed this one, which is the place they matter most.
                   A button's aria-label REPLACES its content as the accessible
                   name, so the corrected alt on the CardImage inside is never
                   read here - the player choosing which card to throw away,
                   against a timer that folds the hand if it runs out, heard
                   the sprite's own field values. */
                aria-label={`Discard ${cardWords(card)}`}
                disabled={busy}
                onClick={() => {
                  haptic.light();
                  setSelected(i);
                  setError(null);
                }}
              >
                <CardImage card={card} size="md" deckStyle={deckStyle} />
                <span className="pineapple-discard__card-tag">
                  {isSelected ? 'DISCARD' : 'KEEP'}
                </span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="pineapple-discard__error" role="alert">
            {error}
          </div>
        )}

        {onTimeBank && timeBanksRemaining > 0 && (
          <button
            type="button"
            className="pineapple-discard__timebank"
            disabled={busy || bankArmed}
            onClick={() => {
              haptic.light();
              void Promise.resolve(onTimeBank()).then((r) => {
                if (r && r.armed) setBankArmed(true);
              });
            }}
          >
            {bankArmed
              ? 'Time Bank Armed. It Starts When Your Clock Runs Out'
              : `Use Time Bank (${timeBanksRemaining})`}
          </button>
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
              ? 'Select A Card'
              : `Discard ${cards[selected].rank}${cards[selected].suit}`}
        </button>
      </div>
    </div>
  );
}

export default PineappleDiscard;
