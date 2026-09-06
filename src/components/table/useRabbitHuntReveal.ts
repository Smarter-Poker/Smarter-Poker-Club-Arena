/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE REVEAL PATH, TWO SURFACES (P5, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Rabbit Hunt can now be bought from two places: the felt tile at the end
 * of a hand, and the hand replayer afterwards (ClubWPT Gold does the same, and
 * it is the one thing in the 2026-09-05 competitive research that we did not
 * have). Both spend money, so both must be the SAME code.
 *
 * This repo has been bitten repeatedly by a second implementation of a paid
 * action drifting from the first - the deleted standalone rabbit button, the
 * duplicate keyboard listener, the parallel handFold/handCall pair that
 * skipped VPIP counting. So the reveal lives here once: the synchronous
 * single-flight mutex, the one call that charges and answers, the toasts that
 * say what was taken, and the counters the tile shows. A surface supplies the
 * request and renders the cards; it decides nothing about money.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide whether a hand is purchasable.
 * That is the engine's (`revealRabbitHunt`), which checks the offer, the 90s
 * TTL, the table's toggle, the board length, whether the caller was dealt in,
 * and whether they already bought it. A client copy of those rules would be a
 * second authority to drift from.
 */
import { useCallback, useRef, useState } from 'react';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import type { Card, RabbitHuntRevealResult } from './RabbitHunt';

export interface UseRabbitHuntRevealOptions {
  /** Charges and answers in ONE call. `handNumber` names an older hand. */
  onReveal: (handNumber?: number) => Promise<RabbitHuntRevealResult>;
  /** The signed-in player. Without one there is nobody to bill. */
  userId: string | null | undefined;
  /** Blocks the request before it is made (the tile's offer being down). */
  disabled?: boolean;
}

export interface RabbitHuntRevealState {
  reveal: (handNumber?: number) => Promise<void>;
  isRevealing: boolean;
  hasRevealed: boolean;
  cards: Card[];
  /** VIP monthly hunts left after the last reveal; null until one is bought. */
  vipRemaining: number | null;
  /** Uses left on a purchased pack; null unless a pack paid for one. */
  packRemaining: number | null;
  /** Forget the last reveal (a new hand, or the panel closing). */
  reset: () => void;
  /**
   * Seed the count from the VIP status lookup, so the tile can show it BEFORE
   * the press rather than only after the money has gone. One piece of state,
   * written from two moments, instead of two pieces that can disagree.
   */
  setVipRemaining: (n: number | null) => void;
}

export function useRabbitHuntReveal({
  onReveal,
  userId,
  disabled = false,
}: UseRabbitHuntRevealOptions): RabbitHuntRevealState {
  const toast = useToast();
  const [isRevealing, setIsRevealing] = useState(false);
  const [hasRevealed, setHasRevealed] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [vipRemaining, setVipRemaining] = useState<number | null>(null);
  const [packRemaining, setPackRemaining] = useState<number | null>(null);
  /* State does not update until React renders. This synchronous mutex makes
     the paid endpoint single-flight even when two taps land in one frame. */
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setCards([]);
    setHasRevealed(false);
  }, []);

  const reveal = useCallback(
    async (handNumber?: number) => {
      if (inFlightRef.current || isRevealing || hasRevealed || disabled) return;
      if (!userId) {
        toast.error('Please Log In To Use Rabbit Hunt');
        return;
      }
      inFlightRef.current = true;
      setIsRevealing(true);
      try {
        /* One call: it charges and returns the cards, or it charges nothing
           and returns why. There is no window in which a player has paid and
           has no cards - the failure the old fetch-then-charge dance could
           not close from the client. */
        const result = await onReveal(handNumber);

        if (!result.success || !result.cards || result.cards.length === 0) {
          toast.error(result.error || 'Rabbit Hunt Is Not Available For This Hand');
          setIsRevealing(false);
          return;
        }

        /* Every paying path says what it took. The player must never spend
           something and be told nothing. */
        if (result.diamondsSpent && result.diamondsSpent > 0) {
          toast.info(`${result.diamondsSpent} Diamonds Charged`);
        } else if (typeof result.vipRemaining === 'number') {
          /* Dan 2026-08-30: "YOU DO NOT NEED A POP UP IN THE BOTTOM RIGHT
             CORNER 'ALERTING YOU' HOW MANY RABBIT HUNTS YOU HAVE LEFT." The
             count is not dropped, it is MOVED - it renders on the tile, where
             it is readable BEFORE the press rather than announced after the
             money has gone. */
          setVipRemaining(result.vipRemaining);
        } else if (typeof result.usesRemaining === 'number') {
          setPackRemaining(result.usesRemaining);
        } else if (result.source === 'already_revealed') {
          toast.info('Showing Your Rabbit Hunt Again, No Charge');
        }

        setCards(result.cards);
        setHasRevealed(true);
      } catch (error) {
        reportError(error, 'RabbitHunt.Rabbit_hunt_failed');
        toast.error('Rabbit Hunt Failed');
      } finally {
        inFlightRef.current = false;
        setIsRevealing(false);
      }
    },
    [disabled, hasRevealed, isRevealing, onReveal, toast, userId]
  );

  return {
    reveal,
    isRevealing,
    hasRevealed,
    cards,
    vipRemaining,
    packRemaining,
    reset,
    setVipRemaining,
  };
}
