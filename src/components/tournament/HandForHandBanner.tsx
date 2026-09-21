/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND-FOR-HAND BANNER — Bubble mode indicator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * #ClubArenaConsole (2026-09-14): A BANNER IS NOT A CARD. This was a rounded
 * amber slab - `border-radius: 12px`, two linear-gradients, a 1px rim and the
 * yellow #eab308 - which is a frame invented in CSS in a colour the
 * smarter.poker schema does not own ("NO BROWNS OR PINKS"). It is INKED now:
 * no fill, no rim, no radius, no gradient. The copy is printed straight onto
 * the black glass between two engraved rules, in the master's own inks - gold
 * on the bubble because the bubble is about money, green when it bursts -
 * with a lit bullet carrying the state. Every animation it had still plays.
 * The inks are SpadeConsole.css's; this component loads that sheet itself.
 */

import React from 'react';
import '../console/SpadeConsole.css';
import './HandForHandBanner.css';

interface HandForHandBannerProps {
  playersRemaining: number;
  paidPositions: number;
  active: boolean;
  bubbleBurst?: boolean;
}

export const HandForHandBanner: React.FC<HandForHandBannerProps> = ({
  playersRemaining,
  paidPositions,
  active,
  bubbleBurst = false,
}) => {
  if (!active && !bubbleBurst) return null;

  if (bubbleBurst) {
    return (
      <div className="hfh-banner hfh-burst" role="status">
        {/* The bullet keeps the bounce the old triangle carried: an animation
            that is owed still plays, on the mark that replaced the glyph. */}
        <span className="hfh-burst-icon sc-ink--green" aria-hidden="true">
          &bull;
        </span>
        <div className="hfh-burst-content">
          <span className="hfh-burst-text sc-ink--green">Bubble Burst</span>
          <span className="hfh-burst-sub">{playersRemaining} Players Are Now In The Money</span>
        </div>
      </div>
    );
  }

  return (
    <div className="hfh-banner" role="status">
      <span className="hfh-dot sc-ink--gold" aria-hidden="true">
        &bull;
      </span>
      <div className="hfh-content">
        <span className="hfh-text sc-ink--gold">Hand For Hand</span>
        <div className="hfh-info">
          <span className="hfh-players">{playersRemaining} Players Remaining</span>
          <span className="hfh-separator sc-ink--muted">&bull;</span>
          <span className="hfh-money">{paidPositions} Paid Positions</span>
        </div>
        <div className="hfh-bubble-text sc-ink--muted">The Money Bubble</div>
      </div>
    </div>
  );
};

export default HandForHandBanner;
