import React from 'react';
import './SeatFillDots.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  COUNT THE SEATS, DO NOT MAKE THE PLAYER COUNT AVATARS (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both waiting footers on a seat-first game were words only, and they did not
 * agree with each other: a spectator read "2 Of 3 Seats Taken" while the
 * player who had just PAID read "Waiting For 1 More Player". The same fact in
 * two shapes, and the one with money in the game got the vaguer of them.
 *
 * Filled and empty seats, in order, plus the count. It is the same fact in a
 * form you take in without reading it.
 *
 * NO ETA. The audit asks for one and the measured fill says not to: a median
 * of 188 seconds against a p95 of 74 MINUTES. An average across that spread
 * is not information, and a number that promises "about three minutes" to
 * somebody who then waits an hour is worse than saying nothing at all.
 */
export interface SeatFillDotsProps {
  /** Seats sold. Clamped, so a stale roster cannot render a negative row. */
  taken: number;
  /** Seats this game needs before it deals. */
  seats: number;
}

export default function SeatFillDots({ taken, seats }: SeatFillDotsProps) {
  const total = Math.max(0, Math.trunc(Number(seats) || 0));
  if (total <= 0) return null;
  const filled = Math.min(total, Math.max(0, Math.trunc(Number(taken) || 0)));

  return (
    <span
      className="seat-fill-dots"
      /* One reading for a screen reader, rather than N unlabelled dots. */
      role="img"
      aria-label={`${filled} Of ${total} Seats Taken`}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`seat-fill-dots__dot${i < filled ? ' seat-fill-dots__dot--filled' : ''}`}
        />
      ))}
      <span className="seat-fill-dots__count" aria-hidden="true">
        {filled}/{total}
      </span>
    </span>
  );
}
