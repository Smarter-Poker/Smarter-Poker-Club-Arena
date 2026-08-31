/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SITTING OUT BADGE — the tag over a seat, and on cash, the clock in it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: a cash player may sit out for five minutes before the seat is
 * reclaimed; a tournament, spin or heads-up player may sit out as long as they
 * like and is blinded off instead.
 *
 * The badge said `SITTING OUT` and nothing else, so the only player who could
 * see the deadline was the hero, on the footer bar — and only from 2026-08-29.
 * A table cannot read the room without it: whether the seat you are waiting on
 * is thirty seconds from opening, or is a tournament player who is not going
 * anywhere, is the difference between waiting and finding another table.
 *
 * WHY THIS IS ITS OWN COMPONENT, and not two more props threaded into SeatSlot:
 *
 * The countdown has to tick, and `SeatSlot` is memoised behind a hand-written
 * comparator because it is rendered up to ten times per table and up to six
 * tables at once. Passing a number that changes every second would defeat that
 * comparator sixty times a minute per sat-out seat, re-rendering avatars, cards,
 * chips and badges to move two digits.
 *
 * So the parent passes the STAMP, which is stable for the whole sit-out, and
 * this component owns the interval. Only the text node re-renders, only for
 * seats that are actually counting, and a tournament seat starts no timer at
 * all. It is the memoised child the SitOutModal note asked for, applied where
 * the cost is ten times higher.
 */

import { useEffect, useState, memo } from 'react';
import { sitOutMsRemaining, sitOutBadgeLabel, isSitOutUrgent } from '../../lib/sitOutDeadline';

export interface SitOutBadgeProps {
  /**
   * `table_seats.sit_out_at` in epoch ms — or null/undefined when this seat has
   * NO deadline, which covers both "not stamped yet" and "tournament, spin or
   * heads-up, where a player may sit out as long as they like".
   *
   * THE PARENT DECIDES, deliberately. `SeatSlot` carries a standing rule that
   * nothing inside it may branch a visual on tournament-ness — the incident
   * behind it gave a Spin an inert empty seat and a stack that would not warn
   * at 8bb. Withholding the stamp keeps that rule intact and leaves this
   * component with one input and one meaning: a stamp is a deadline.
   *
   * The SERVER's stamp, never a local `Date.now()`. A client-side stamp
   * restarts on every reload, which on a five-minute deadline means showing a
   * player a full five minutes thirty seconds before their seat is taken.
   */
  sitOutAt?: number | null;
}

function SitOutBadgeInner({ sitOutAt }: SitOutBadgeProps) {
  const [msRemaining, setMsRemaining] = useState<number | null>(() =>
    sitOutMsRemaining({ sitOutSince: sitOutAt ?? null, isTournament: false })
  );

  useEffect(() => {
    const read = () => sitOutMsRemaining({ sitOutSince: sitOutAt ?? null, isTournament: false });
    setMsRemaining(read());
    // No stamp means no deadline means no timer at all.
    if (read() === null) return;
    const id = setInterval(() => {
      const next = read();
      setMsRemaining(next);
      /* STOP AT ZERO. The seat is now the engine's to reclaim and the number
         cannot get any more urgent, so a timer that keeps firing is a
         once-a-second re-render buying nothing — for as long as the eviction
         sweep takes to land, on every sat-out seat at the table. */
      if (next !== null && next <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [sitOutAt]);

  const urgent = isSitOutUrgent(msRemaining);
  const label = sitOutBadgeLabel(msRemaining);

  return (
    <div
      className={`seat__sitout-badge${urgent ? ' seat__sitout-badge--urgent' : ''}`}
      /* The title carries the rule, not just the state: the countdown is the
         TIME half of "2 orbits or 5 minutes, whichever comes first", and the
         orbit half is engine state no client can see. Nobody may be shown a
         number that promises them longer than they have. */
      title={
        msRemaining === null
          ? 'This Player Is Sitting Out'
          : 'This Player Is Sitting Out. Their Seat Is Held For Up To This Long, Or Two Orbits, Whichever Comes First'
      }
      data-testid="seat-sitout-badge"
    >
      {label}
    </div>
  );
}

/** Stable stamp in, so the parent's own memoisation is not defeated. */
export const SitOutBadge = memo(SitOutBadgeInner);

export default SitOutBadge;
