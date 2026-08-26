/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIMEBANK COUNTER — Spec §5.7 Always-Visible Timebank Balance
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Bottom-left HUD tile showing the player's remaining time-bank charges.
 * Tapping it opens the time-bank store.
 *
 * Dan 2026-08-20 (first redesign): a generic clock glyph plus a pink diamond
 * read as a currency balance, so it became a golden alarm clock with "20s" on
 * its face.
 *
 * Dan 2026-08-25 round 2 (item 6c) — THIS redesign, and it reverses the last
 * one on purpose: "the button just needs to be simple like the attached
 * image ... don't use this exact design, but something similar." The reference
 * is a small, plain, dark rounded square holding one monochrome outline glyph:
 * no gradient, no bells, no gold, no badge, no border. The alarm clock was four
 * paths, two fills, a radial gradient and a drop shadow sitting on a phone
 * screen next to a live poker hand.
 *
 * What it still has to do, and does:
 *   - say how many banks remain  -> the numeral under the glyph, not a badge;
 *   - open the store on tap      -> unchanged `onClick`;
 *   - warn when nearly out       -> `low` tints the NUMERAL only. That is
 *     information, not ornament: the glyph and the tile stay monochrome.
 *
 * The class name stays `.tbc-widget`. TablePage.css hides this element while
 * the raise overlay is open (`body.ca-raising .tbc-widget`), and renaming it
 * would silently put the tile back on top of the slider — the 2026-08-18 bug.
 *
 * Pure presentational: the parent passes `count` and `onClick` (optional).
 */

import React from 'react';
import './TimebankCounter.css';

interface TimebankCounterProps {
  /**
   * How many banks the player holds. `null` = not loaded yet, and renders as
   * a dash. Dan 2026-08-26: the tile used to be seeded with a hard 4 and
   * showed it confidently to a player holding 481 — a placeholder that looks
   * like data is worse than one that looks like a placeholder.
   */
  count: number | null;
  onClick?: () => void;
  /** Optional: when true, widget renders in "low" state (warning tint). */
  low?: boolean;
  /**
   * Seconds one time bank adds to the clock. Engine default is 20.
   * No longer printed on the tile — the flat tile has room for one number and
   * the useful one is how many banks are left. It is still in the label and the
   * tooltip, so the answer is one hover or one screen-reader stop away.
   */
  bankSeconds?: number;
}

export const TimebankCounter: React.FC<TimebankCounterProps> = ({
  count,
  onClick,
  low,
  bankSeconds = 20,
}) => {
  return (
    <button
      type="button"
      className={`tbc-widget${low ? ' tbc-widget--low' : ''}`}
      onClick={onClick}
      aria-label={
        count === null
          ? 'Time banks remaining: loading'
          : `Time banks remaining: ${count}, ${bankSeconds} seconds each`
      }
      title={
        count === null
          ? 'Loading Your Time Banks'
          : `${count} time bank${count === 1 ? '' : 's'} remaining (${bankSeconds}s each)`
      }
    >
      {/* One monochrome outline glyph: a clock face with two small winder stems,
          enough to read as "shot clock" at 16px without any of the alarm
          clock's fills. currentColor throughout, so the tile owns the colour. */}
      <span className="tbc-glyph" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="11.2" r="6.4" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M10 7.8v3.4l2.3 1.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5.5 3.2 3.6 5M14.5 3.2 16.4 5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="tbc-count">{count === null ? '-' : count}</span>
    </button>
  );
};

export default TimebankCounter;
