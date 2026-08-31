/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE HUD — 4-Corner Overlay Layout
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Clean table HUD with fixed-position corner elements:
 *   - Upper-left:  Hamburger menu (internal to table)
 *   - Upper-right: Mini stats card (VPIP, buy-in, winnings)
 *   - Bottom-left: Previous hand card (quick-access hand history)
 *   - Bottom-right: Messages icon (table chat, transparent)
 *
 * Replaces the old header bar with a cleaner overlay approach that
 * keeps the table felt visible and uncluttered.
 */

import React from 'react';
import './TableHUD.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableHUDProps {
  /** Upper-left corner: hamburger menu trigger + dropdown */
  upperLeft?: React.ReactNode;
  /** Upper-right corner: mini stats card */
  upperRight?: React.ReactNode;
  /** Bottom-left corner: previous hand card */
  bottomLeft?: React.ReactNode;
  /** Bottom-right corner: messages icon */
  bottomRight?: React.ReactNode;
  /** Center-top: optional game info bar (table name, blinds) */
  centerTop?: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableHUD({
  upperLeft,
  upperRight,
  bottomLeft,
  bottomRight,
  centerTop,
}: TableHUDProps) {
  return (
    <div className="table-hud" aria-label="Table HUD Overlay">
      {/* Upper row */}
      <div className="table-hud__upper">
        <div className="table-hud__corner table-hud__corner--ul">{upperLeft}</div>
        {centerTop && <div className="table-hud__center-top">{centerTop}</div>}
        <div className="table-hud__corner table-hud__corner--ur">{upperRight}</div>
      </div>

      {/* Lower row */}
      <div className="table-hud__lower">
        <div className="table-hud__corner table-hud__corner--bl">{bottomLeft}</div>
        <div className="table-hud__corner table-hud__corner--br">{bottomRight}</div>
      </div>
    </div>
  );
}

export default TableHUD;
