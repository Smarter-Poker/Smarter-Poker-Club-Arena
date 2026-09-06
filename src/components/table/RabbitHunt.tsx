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
import { useRabbitHuntReveal } from './useRabbitHuntReveal';

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
  /**
   * P4 2026-09-05: the hotkey's way in. While the tile is mounted with an
   * offer up it hands its reveal handler to the page, so useTableKeyboard
   * (the ONLY keyboard system on the table - see that file's header) can run
   * the SAME function a tap runs: single-flight, charged once, toasts
   * included. Called with null the moment the offer is gone, the reveal has
   * happened, or the tile unmounts, so B on a table with nothing to hunt is a
   * no-op rather than a second code path. A callback rather than a ref on
   * purpose: the page keeps the ref and makes the assignment itself, where
   * tests/unit/bustHoldIsWired.test.ts can see that every callable ref on
   * the page is assigned by the page.
   */
  registerHotkey?: (handler: (() => void) | null) => void;
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
  registerHotkey,
}: RabbitHuntProps) {
  const rabbitHuntIcon = useButtonImage('icon-rabbit');
  const toast = useToast();

  /* THE REVEAL ITSELF LIVES IN useRabbitHuntReveal (P5, 2026-09-05), because
     the hand replayer buys the same thing and two implementations of a paid
     action drift. This component is the felt TILE: the artwork, the price
     badge, the counts and the offer's own visibility. It decides nothing
     about money. */
  const [isVIP, setIsVIP] = useState(false);
  const {
    reveal,
    isRevealing,
    hasRevealed,
    vipRemaining,
    packRemaining,
    reset: resetReveal,
    setVipRemaining,
  } = useRabbitHuntReveal({ onReveal, userId, disabled: !isAvailable });
  const handleReveal = useCallback(() => void reveal(), [reveal]);

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
    resetReveal();
  }, [isAvailable, cardsAvailable, resetReveal]);

  // The hotkey sees exactly what the button sees: a handler while an offer
  // is up and not yet revealed, nothing otherwise.
  const hotkeyLive = isAvailable && !hasRevealed;
  useEffect(() => {
    if (!registerHotkey) return;
    registerHotkey(hotkeyLive ? () => void handleReveal() : null);
    return () => registerHotkey(null);
  }, [registerHotkey, hotkeyLive, handleReveal]);

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
          title="Rabbit Hunt (B)"
          aria-keyshortcuts="b"
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
