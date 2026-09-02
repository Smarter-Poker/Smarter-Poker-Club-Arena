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

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { vipService, FEATURE_PRICING } from '../../services/VIPService';
import { useToast } from '../common/Toast';
import './RabbitHunt.css';
import { reportError } from '../../utils/errorReporter';
/* Dan: "use the actual rabbit hunt dynamic image". Updated to the custom
   rabbit/crosshair icon provided by the user. Imported through Vite so it
   emits to dist/assets/ and reaches production via the automated build. */
import { useButtonImage } from '../../hooks/useButtonImage';

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
  /** Uses left on a purchased pack after this one. Null unless a pack paid. */
  usesRemaining?: number | null;
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
  /**
   * Live diamond price from the server's `feature_pricing` row, delivered with
   * the offer. The button used to render a hardcoded 5 from the client's
   * FEATURE_PRICING while the charge came from that table, so repricing in the
   * dashboard — which the migration explicitly supports — made the label lie.
   * Falls back to the constant only if the offer arrived without one.
   */
  rabbitDiamondCost?: number | null;
  /** Authenticated player supplied by TablePage, the owner of the session. */
  userId: string | null | undefined;
  onReveal: () => Promise<RabbitHuntRevealResult>;
}

/* The card-image helpers that lived here (`normalizeRank`, `toCardImage`) are
   gone, with the `CardImage` import that fed them. POKERBROS PARITY 2026-08-26
   moved the reveal onto the CommunityCards board; this component has drawn no
   card since, so the pair had no call site and the import pulled the CardImage
   module into the Rabbit Hunt chunk for nothing. */

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RabbitHunt({
  isAvailable,
  cardsAvailable,
  rabbitDiamondCost,
  userId,
  onReveal,
}: RabbitHuntProps) {
  const rabbitHuntIcon = useButtonImage('icon-rabbit');
  const toast = useToast();

  const [isRevealing, setIsRevealing] = useState(false);
  /* Write-only on purpose: the reveal RENDERS on the CommunityCards board
     (TablePage passes it `rabbitCards`), so nothing here reads the array back.
     The setter stays because clearing it on a new hand is what stops the
     previous hand's cards being offered again. */
  const [, setRevealedCards] = useState<Card[]>([]);
  const [hasRevealed, setHasRevealed] = useState(false);
  const [isVIP, setIsVIP] = useState(false);
  const [vipRemaining, setVipRemaining] = useState<number | null>(null);
  /* Uses left on a PURCHASED pack. A different pool from the VIP monthly one,
     and only knowable after a reveal has consumed one, so it can never be read
     before the first press. Once it IS known it belongs on the tile with every
     other count, not in a popup. See the corner numeral below. */
  const [packRemaining, setPackRemaining] = useState<number | null>(null);
  const revealInFlightRef = useRef(false);

  // Server price when we have it, the constant only as a fallback.
  const cost =
    typeof rabbitDiamondCost === 'number' && rabbitDiamondCost > 0
      ? rabbitDiamondCost
      : FEATURE_PRICING.rabbit_hunt.cost;

  // Label only. The server decides the actual price, so this lookup must never
  // be able to block the button: it used to drive a `disabled={isCheckingVIP}`
  // that started true and was only cleared inside this async function, so a
  // hung (as opposed to rejected) VIP query disabled Rabbit Hunt forever with
  // nothing on screen to say why. The button is enabled from the first frame
  // and the label fills in when the answer arrives.
  //
  // It also reads the monthly USAGE, not just the VIP flag. The earlier attempt
  // at "stop saying FREE once the pool runs out" set `vipRemaining` from the
  // reveal response — which arrives strictly after the button has been pressed,
  // and the button is unmounted the moment it has been. So the state was never
  // non-null while the label was on screen, and the 101st hunt still read FREE.
  // checkVIPStatus already returns monthlyLimits; the number just has to be
  // fetched BEFORE the press rather than reported after it.
  useEffect(() => {
    let cancelled = false;
    const checkVIP = async () => {
      if (!userId) {
        if (!cancelled) setIsVIP(false);
        return;
      }
      try {
        const status = await vipService.checkVIPStatus(userId);
        if (cancelled) return;
        setIsVIP(!!status?.isVIP);
        const pool = status?.monthlyLimits?.rabbitHunts;
        if (pool && typeof pool.limit === 'number' && typeof pool.used === 'number') {
          setVipRemaining(Math.max(0, pool.limit - pool.used));
        }
      } catch (err) {
        /* 2026-08-28: was `setIsVIP(false)`. checkVIPStatus now THROWS when the
           read fails rather than answering "not VIP" (a failed read is not a
           downgrade — see VIPService), so overwriting here would re-create the
           bug one level up: a blip mid-session took a paying member's free
           hunt away and offered them the paid path instead. Keep what we last
           knew; `isVIP` starts false, so a failure on the very first check
           still grants nothing. */
        reportError(err, 'RabbitHunt.Error');
      }
    };
    checkVIP();
    return () => {
      cancelled = true;
    };
  }, [userId, isAvailable]);

  // A new hand's offer must not show the previous hand's cards.
  useEffect(() => {
    setRevealedCards([]);
    setHasRevealed(false);
  }, [isAvailable, cardsAvailable]);

  const handleReveal = useCallback(async () => {
    if (revealInFlightRef.current || isRevealing || hasRevealed || !isAvailable) return;
    if (!userId) {
      toast.error('Please Log In To Use Rabbit Hunt');
      return;
    }

    // State does not update until React renders. This synchronous mutex makes
    // the paid endpoint single-flight even when two taps land in one frame.
    revealInFlightRef.current = true;
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

      // Every paying path says what it took. The player must never spend
      // something and be told nothing.
      if (result.diamondsSpent && result.diamondsSpent > 0) {
        toast.info(`${result.diamondsSpent} Diamonds Charged`);
      } else if (typeof result.vipRemaining === 'number') {
        /* Dan 2026-08-30: "YOU DO NOT NEED A POP UP IN THE BOTTOM RIGHT CORNER
           'ALERTING YOU' HOW MANY RABBIT HUNTS YOU HAVE LEFT."

           The count is not dropped, it is MOVED. It already renders as the
           corner numeral on the tile (rabbit-hunt__remaining), where it is
           readable BEFORE the press rather than announced after the money has
           gone — which is the moment it is actually useful. A toast that
           repeats it is one more thing covering the felt at the end of a hand.
           Nothing spent is left unsaid: the diamonds branch above still speaks,
           because that one is a charge, not a stock level. */
        setVipRemaining(result.vipRemaining);
      } else if (typeof result.usesRemaining === 'number') {
        // A purchased pack. Same rule: the number lands on the tile, not in a
        // popup. This spends neither diamonds nor a VIP use, so without one of
        // the two it would be the only path with no acknowledgement at all.
        setPackRemaining(result.usesRemaining);
      } else if (result.source === 'already_revealed') {
        toast.info('Showing Your Rabbit Hunt Again, No Charge');
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
      revealInFlightRef.current = false;
      setIsRevealing(false);
    }
  }, [isRevealing, hasRevealed, isAvailable, onReveal, userId, toast]);

  if (!isAvailable && !hasRevealed) {
    return null;
  }

  // (pendingCount removed 2026-08-26 — it fed the old in-panel reveal, which
  // now renders on the CommunityCards board.)

  return (
    <div className="rabbit-hunt">
      {/* POKERBROS PARITY 2026-08-26 (frame-by-frame of RABBIT HUNT.MOV): the
          reference button is a COMPACT ICON, anchored bottom-LEFT above the
          table toolbar, that fades in once the pot has shipped and vanishes on
          the tap. No text label — the artwork carries the name. The cost badge
          stays as a corner pill: the reference app does not bill per hunt, we
          do, and a paid tap with no visible price is not an option here. */}
      {!hasRevealed && (
        <button
          className={`rabbit-hunt__button ${isRevealing ? 'rabbit-hunt__button--loading' : ''} ${isVIP ? 'rabbit-hunt__button--vip' : ''}`}
          onClick={handleReveal}
          disabled={isRevealing}
          aria-label={
            isRevealing
              ? 'Revealing Rabbit Hunt'
              : isVIP && typeof vipRemaining === 'number' && vipRemaining > 0
                ? `Rabbit Hunt, ${vipRemaining} Free This Month`
                : `Rabbit Hunt, ${cost} Diamonds`
          }
          title="Rabbit Hunt"
        >
          <img
            className="rabbit-hunt__icon-img"
            src={rabbitHuntIcon}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          {/* Dan 2026-08-26: "there is enough space below to add the current
              total rabbit hunts the user has left." The count overlays INSIDE
              the tile rather than growing the button. VIP-only by necessity:
              the monthly pool is the one per-user stock the client can know
              BEFORE the press (checkVIPStatus above) — the offer event is a
              table broadcast and cannot carry a per-user number, and a pack's
              uses_remaining only comes back after a reveal consumes one.
              Non-VIPs have no stock, only a price, and the price pill already
              shows it.

              The bare numeral, not "N Left": this is a 36px HUD tile now (see
              RabbitHunt.css) and it carries the count exactly the way the time
              bank tile in the same slot carries its own — a numeral in the
              bottom-right corner. The word does not fit and does not need to;
              the aria-label above still says "N Free This Month" in full, so
              nothing is lost to a screen reader. */}
          {!isRevealing && typeof (vipRemaining ?? packRemaining) === 'number' && (
            <span className="rabbit-hunt__remaining">{vipRemaining ?? packRemaining}</span>
          )}
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

      {/* Cards are now rendered natively on the CommunityCards board */}
    </div>
  );
}

export default RabbitHunt;
