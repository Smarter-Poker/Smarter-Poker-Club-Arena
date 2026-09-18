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
import { useButtonImage } from '../../hooks/useButtonImage';

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
  /** Lifetime VIP has no finite balance and no purchase action. */
  unlimited?: boolean;
  /**
   * Seconds one time bank adds to the clock. Engine default is 20.
   * The count is shown as a white number overlay on the icon image.
   */
  bankSeconds?: number;
}

export const TimebankCounter: React.FC<TimebankCounterProps> = ({
  count,
  onClick,
  low,
  unlimited = false,
  bankSeconds = 20,
}) => {
  const timebankIcon = useButtonImage('icon-timebank');
  const contents = (
    <div className="tbc-img-wrap" aria-hidden="true">
      <img src={timebankIcon} className="tbc-icon-img" alt="" draggable={false} />
      <span className={`tbc-count-overlay${!unlimited && low ? ' tbc-count-overlay--low' : ''}`}>
        {unlimited ? 'VIP' : count === null ? '-' : count}
      </span>
    </div>
  );

  if (unlimited) {
    return (
      <div
        className="tbc-widget"
        role="status"
        aria-label="Unlimited Lifetime VIP Time Banks"
        title="Unlimited Lifetime VIP Time Banks"
      >
        {contents}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`tbc-widget${low ? ' tbc-widget--low' : ''}`}
      onClick={onClick}
      aria-label={
        count === null
          ? 'Time Banks Remaining: Loading'
          : `Time Banks Remaining: ${count}, ${bankSeconds} Seconds Each`
      }
      title={
        count === null
          ? 'Loading Your Time Banks'
          : `${count} Time Bank${count === 1 ? '' : 's'} Remaining (${bankSeconds}s Each)`
      }
    >
      {/* Resolved 2026-08-26: main replaced the outline glyph with the
          stopwatch image + overlay, and that newer design is kept. The only
          thing carried across from this branch is the null case: `count` is
          null until the TRUE balance loads, and must render as a dash rather
          than a fabricated number (it used to be seeded with a hard 4 and
          shown to a player holding 481). */}
      {/* Custom stopwatch icon with time-bank count overlaid in white bold text */}
      {contents}
    </button>
  );
};

export default TimebankCounter;
