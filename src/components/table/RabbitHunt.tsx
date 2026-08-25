/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RABBIT HUNT — See What Cards Would Have Come
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "The rabbit hunt should pop up when the action is completed,
 * no matter if it's pre flop, on the flop, on the turn, or on the river. It
 * should ghost run or show the cards that would have appeared if the hand
 * played out. These should ONLY APPEAR TO THE PLAYER WHO CLICKED. VIP members
 * get 100 rabbit hunts a month for free, and they cost 5 diamonds each after
 * that."
 *
 * WHAT CHANGED, AND WHY THIS COMPONENT GOT SMALLER
 *
 * This component used to hold the paywall, and the paywall did not work. The
 * engine broadcast the five remaining cards to every socket at the table the
 * moment a hand ended, so the cards were already on every opponent's machine
 * before anyone clicked; this file then called vipService.useFeature to bill,
 * which routed to fn_purchase_feature relying on a cost that defaults to zero.
 * Free cards, free of charge, shown to everyone.
 *
 * The cards now come back in the response to POST /rabbit-hunt, which charges
 * on the server before it answers and answers only the caller. So there is
 * nothing to bill here and nothing to guard: this file asks, and renders what
 * it is given. The VIP lookup that remains is for the LABEL only — whether the
 * button reads FREE or 5 — and being wrong about it costs nothing, because the
 * price is decided server-side either way.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { vipService, FEATURE_PRICING } from '../../services/VIPService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { CardImage } from '../table/CardImage';
import type { Card as CardImageCard } from '../table/CardImage';
import './RabbitHunt.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
  rank: string;
  suit: 'h' | 'd' | 'c' | 's';
}

export interface RabbitHuntRevealResult {
  success: boolean;
  cards?: Card[];
  error?: string;
  source?: string;
  diamondsSpent?: number;
  /** VIP monthly hunts left AFTER this one. Server-counted; null for non-VIP. */
  vipRemaining?: number | null;
}

export interface RabbitHuntProps {
  isAvailable: boolean;
  /**
   * How many cards a reveal will show, as counted by the SERVER: a fold on the
   * flop leaves two, a fold on the turn leaves one, a fold pre-flop leaves five.
   * This used to be derived from a `currentBoard` prop that was only ever set to
   * [], so every reveal claimed five cards and a turn-fold rendered four empty
   * placeholders next to the one real card.
   */
  cardsAvailable: number;
  onReveal: () => Promise<RabbitHuntRevealResult>;
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
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RabbitHunt({ isAvailable, cardsAvailable, onReveal }: RabbitHuntProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [isRevealing, setIsRevealing] = useState(false);
  const [revealedCards, setRevealedCards] = useState<Card[]>([]);
  const [hasRevealed, setHasRevealed] = useState(false);
  const [isVIP, setIsVIP] = useState(false);
  const [vipRemaining, setVipRemaining] = useState<number | null>(null);

  const cost = FEATURE_PRICING.rabbit_hunt.cost;

  // Label only. The server decides the actual price, so this lookup must never
  // be able to block the button: it used to drive a `disabled={isCheckingVIP}`
  // that started true and was only cleared inside this async function, so a
  // hung (as opposed to rejected) VIP query disabled Rabbit Hunt forever with
  // nothing on screen to say why. The button is enabled from the first frame
  // and the label fills in when the answer arrives.
  useEffect(() => {
    let cancelled = false;
    const checkVIP = async () => {
      if (!user?.id) {
        if (!cancelled) setIsVIP(false);
        return;
      }
      try {
        const status = await vipService.checkVIPStatus(user.id);
        if (!cancelled) setIsVIP(!!status?.isVIP);
      } catch (err) {
        reportError(err, 'RabbitHunt.Error');
        if (!cancelled) setIsVIP(false);
      }
    };
    checkVIP();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // A new hand's offer must not show the previous hand's cards.
  useEffect(() => {
    setRevealedCards([]);
    setHasRevealed(false);
  }, [isAvailable, cardsAvailable]);

  const handleReveal = useCallback(async () => {
    if (isRevealing || hasRevealed || !isAvailable) return;
    if (!user?.id) {
      toast.error('Please Log In To Use Rabbit Hunt');
      return;
    }

    setIsRevealing(true);
    try {
      // One call: it charges and returns the cards, or it charges nothing and
      // returns why. There is no window in which a player has paid and has no
      // cards, which is the failure the old fetch-then-charge dance was written
      // to avoid and could not actually close from the client.
      const result = await onReveal();

      if (!result.success || !result.cards || result.cards.length === 0) {
        toast.error(result.error || 'Rabbit Hunt Is Not Available For This Hand');
        setIsRevealing(false);
        return;
      }

      if (result.diamondsSpent && result.diamondsSpent > 0) {
        toast.info(`${result.diamondsSpent} Diamonds Charged`);
      } else if (typeof result.vipRemaining === 'number') {
        // Tell a VIP what they have left. Without this the 100th free hunt and
        // the 101st paid one look identical until the diamonds toast appears,
        // which is the first the player hears that the free pool ran out.
        setVipRemaining(result.vipRemaining);
        toast.info(
          result.vipRemaining > 0
            ? `Free Rabbit Hunt, ${result.vipRemaining} Left This Month`
            : 'Last Free Rabbit Hunt This Month'
        );
      }

      // Set every card at once and let CSS stagger them. Awaiting 500ms PER
      // CARD before the first one appeared left the player paying for a reveal
      // and then watching it get unmounted: a pre-flop fold took 2.5s to finish
      // drawing, and the next hand starting inside that window tore the panel
      // down mid-animation. The cards carry animationDelay below, so the
      // staggered feel survives without holding the reveal open for seconds.
      setRevealedCards(result.cards);
      setHasRevealed(true);
    } catch (error) {
      reportError(error, 'RabbitHunt.Rabbit_hunt_failed');
      toast.error('Rabbit Hunt Failed');
    } finally {
      setIsRevealing(false);
    }
  }, [isRevealing, hasRevealed, isAvailable, onReveal, user?.id, toast]);

  if (!isAvailable && !hasRevealed) {
    return null;
  }

  const pendingCount = Math.max(0, cardsAvailable - revealedCards.length);

  return (
    <div className="rabbit-hunt">
      {!hasRevealed && (
        <button
          className={`rabbit-hunt__button ${isRevealing ? 'rabbit-hunt__button--loading' : ''} ${isVIP ? 'rabbit-hunt__button--vip' : ''}`}
          onClick={handleReveal}
          disabled={isRevealing}
        >
          <span className="rabbit-hunt__icon">◆</span>
          <span className="rabbit-hunt__label">{isRevealing ? 'Revealing...' : 'Rabbit Hunt'}</span>
          {!isRevealing && (
            <span
              className={`rabbit-hunt__cost ${isVIP && vipRemaining !== 0 ? 'rabbit-hunt__cost--free' : ''}`}
            >
              {/* A VIP whose monthly pool is spent pays like anyone else, so the
                  label has to stop saying FREE the moment it runs out. */}
              {isVIP && vipRemaining === 0 ? `${cost}` : isVIP ? 'FREE' : `${cost}`}
            </span>
          )}
        </button>
      )}

      {revealedCards.length > 0 && (
        <div className="rabbit-hunt__reveal">
          <span className="rabbit-hunt__reveal-label">Rabbit Shows:</span>
          <div className="rabbit-hunt__cards">
            {revealedCards.map((card, idx) => (
              <div
                key={idx}
                className="rabbit-hunt__card"
                style={{
                  animationDelay: `${idx * 0.1}s`,
                }}
              >
                <CardImage card={toCardImage(card)} size="sm" />
              </div>
            ))}
            {Array(pendingCount)
              .fill(null)
              .map((_, idx) => (
                <div
                  key={`pending-${idx}`}
                  className="rabbit-hunt__card rabbit-hunt__card--pending"
                >
                  <span className="rabbit-hunt__pending-icon">?</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default RabbitHunt;
