/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE COUNTDOWN OWNS ITS OWN SECOND (2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The container held `now` in state and advanced it every second, so every tick
 * re-ran the lane memo, re-rendered TickerRail, and rebuilt every field of
 * every announcement - about sixty times a minute, on the same thread as a live
 * poker table, to change four characters.
 *
 * The clock is the only thing on the strip that changes at 1Hz, so the clock is
 * the only thing that should re-render at 1Hz. It keeps its own interval and
 * its own state; React updates one text node and nothing above it moves.
 *
 * The container still ticks - announcements expire and the spoken line is
 * rounded to the minute - but at a fifth of the rate, which is plenty for both.
 *
 * `deadlineMs` is an INSTANT, not a duration, which is what makes this safe to
 * own locally: a tab that sleeps for ten minutes wakes up showing the right
 * number rather than one that drifted by however long it was away.
 */

import { useEffect, useState } from 'react';
import { countdown } from './tickerMessages';

export interface TickerClockProps {
  /** Absolute epoch ms this is counting down to. */
  deadlineMs: number;
  /** Under a minute, the digits carry the urgency. Nothing else moves. */
  urgent: boolean;
}

export function TickerClock({ deadlineMs, urgent }: TickerClockProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    /* Nothing to count once it has arrived: a strip that has reached 0:00 is
       about to be replaced, and an interval that outlives its reason is how a
       phone loses a percent an hour to a bar nobody is reading. */
    if (deadlineMs - Date.now() <= 0) return undefined;
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (deadlineMs - current <= 0) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [deadlineMs]);

  return (
    <span className={`mtt-ticker__clock${urgent ? ' mtt-ticker__clock--urgent' : ''}`}>
      {countdown(deadlineMs - now)}
    </span>
  );
}

export default TickerClock;
