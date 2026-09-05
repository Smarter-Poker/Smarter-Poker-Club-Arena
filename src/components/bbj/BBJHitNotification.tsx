/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BAD BEAT JACKPOT — THE HIT NOTIFICATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26, verbatim: "it should stay on screen for 3 seconds, and
 * should EXPLODE with animations in the bottom right corner before auto
 * disappearing."
 *
 * What this replaces: a plain 10-second text toast in the shared toast stack.
 * A jackpot is the rarest event on the platform and it read like a system
 * message about a failed upload.
 *
 * WHY IT IS ITS OWN COMPONENT rather than a fancier toast: the toast stack is
 * a queue - it holds messages until earlier ones expire, stacks them, and is
 * deliberately styled to be uniform. A jackpot must land the moment it
 * happens, in one fixed place, at a size the queue would never allow. Sharing
 * the stack would also mean a routine "seat taken" notice could push the
 * jackpot down the screen, which is precisely backwards.
 *
 * WHEN IT SHOWS is not decided here. `shouldAnnounceBbjHit` (lib/bbjHitOnce)
 * owns that, and it is the fix for the replay bug - see that file. This
 * component is presentation only, so the two can be tested separately: the
 * gate has no DOM and this has no policy.
 *
 * ACCESSIBILITY: `role="status"` + `aria-live="polite"` announces the win
 * without stealing focus mid-hand. It is `pointer-events: none` except for
 * the observe button, so a celebration can never eat a fold click - the
 * bottom-right corner is close to the action bar on a phone.
 */

import React, { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../utils/animationSpeed';
import './BBJHitNotification.css';
import { money } from '../../utils/handFormat';

/** How long the card sits on screen before it leaves. Dan: three seconds. */
export const BBJ_NOTIFICATION_MS = 3000;

/** Must match the outro duration in BBJHitNotification.css. */
const OUTRO_MS = 420;

export interface BBJHitNotificationProps {
  /** The winning player's display name. */
  winnerName: string;
  /** Jackpot amount in dollars. */
  amount: number;
  /** Where it happened, for the sub-line. */
  tableName: string;
  /** Optional: clicking the card observes that table. */
  onObserve?: () => void;
  /** Fired once the card has finished leaving, so the parent can unmount it. */
  onDone: () => void;
}

/**
 * The confetti burst. Twenty shards, each with a precomputed angle, distance,
 * spin and delay handed to CSS as custom properties.
 *
 * Deliberately NOT random per render: the values are derived from the shard's
 * index, so a re-render cannot resample them mid-flight and make the burst
 * visibly stutter. Same reasoning as the per-seat breathing phase in SeatSlot.
 */
const SHARDS = Array.from({ length: 20 }, (_, i) => {
  // Fan the shards over a 210-degree arc pointing up and left, away from the
  // screen corner - a burst that fires into the corner is half wasted.
  const angle = 130 + (i / 19) * 210;
  const distance = 60 + ((i * 37) % 70);
  return {
    angle,
    distance,
    spin: ((i * 53) % 720) - 360,
    delay: (i % 5) * 24,
    hue: [0, 1, 2, 3][i % 4],
  };
});

export function BBJHitNotification({
  winnerName,
  amount,
  tableName,
  onObserve,
  onDone,
}: BBJHitNotificationProps) {
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    /* Two timers, not one: the card holds for its full three seconds, THEN
       plays the outro, and only then does the parent unmount it. Collapsing
       these into a single timeout is how a card gets yanked off screen
       mid-animation. */
    const hold = setTimeout(() => setLeaving(true), BBJ_NOTIFICATION_MS);
    const gone = setTimeout(() => doneRef.current(), BBJ_NOTIFICATION_MS + OUTRO_MS);
    return () => {
      clearTimeout(hold);
      clearTimeout(gone);
    };
  }, []);

  /* Read ONCE at mount rather than per render: the burst is decorative, and a
     player toggling the OS setting mid-celebration should not have shards
     vanish half-flight. */
  const [reduced] = useState(() => prefersReducedMotion());

  /* `amount` is TYPED number but SOURCED from a realtime payload
     (TablePage's bbjHitNotice). A null or undefined there threw a TypeError
     inside render and took the whole table page down - at the single moment a
     crash is least acceptable, the one where a player has just been paid.
     `money` is the NaN-safe formatter every other BBJ surface already uses. */
  const amountText = money(amount);

  return (
    <div
      className={`bbj-hit${leaving ? ' bbj-hit--leaving' : ''}${reduced ? ' bbj-hit--still' : ''}`}
      role="status"
      aria-live="polite"
      /* BBJ audit 2026-09-05: this interpolated `money` - the FORMATTER - so a
         screen reader heard the function's source instead of the amount. */
      aria-label={`Bad Beat Jackpot Hit. ${winnerName} Won ${amountText} Dollars On ${tableName}.`}
    >
      {!reduced && (
        <div className="bbj-hit__burst" aria-hidden="true">
          {SHARDS.map((s, i) => (
            <span
              key={i}
              className={`bbj-hit__shard bbj-hit__shard--${s.hue}`}
              style={
                {
                  '--bbj-angle': `${s.angle}deg`,
                  '--bbj-dist': `${s.distance}px`,
                  '--bbj-spin': `${s.spin}deg`,
                  '--bbj-delay': `${s.delay}ms`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      )}

      <button
        type="button"
        className="bbj-hit__card"
        onClick={onObserve}
        /* Not a button when there is nowhere to go - a dead control that
           looks pressable is worse than a plain card. */
        disabled={!onObserve}
      >
        <span className="bbjhit-notification__bbj-hit__title">Bad Beat Jackpot</span>
        <span className="bbj-hit__amount">${amountText}</span>
        <span className="bbj-hit__who">{winnerName}</span>
        <span className="bbj-hit__where">
          {tableName}
          {onObserve ? ' - Tap To Observe' : ''}
        </span>
      </button>
    </div>
  );
}

export default BBJHitNotification;
