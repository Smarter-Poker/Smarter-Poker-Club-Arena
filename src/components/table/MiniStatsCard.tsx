/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MINI STATS CARD — Upper-Right HUD Widget
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact card showing the hero's real-time session stats:
 *   - P&L (profit/loss with color coding)
 *   - VPIP percentage
 *   - Buy-in total
 *   - Hands played
 *
 * Taps to expand into full SessionHUD modal.
 * Transparent glass design to not obstruct the table.
 */

import React from 'react';
import './MiniStatsCard.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/* `MiniStatsObserver` deleted 2026-08-26: it typed the `observers` prop, and
   that prop went with the unreachable expanded panel. Exported from the barrel
   and imported by nothing. */

export interface MiniStatsCardProps {
  /** Current hero stack */
  currentStack: number;
  /** Total chips bought in (sum of all buy-ins/rebuys) */
  totalBuyIn: number;
  /** Hands played this session */
  handsPlayed: number;
  /** VPIP count (hands voluntarily put money in) */
  vpipCount: number;
  /** Hands won this session */
  handsWon: number;
  /** Whether the hero is seated */
  isSeated: boolean;
  /** Tap handler — opens full session stats modal */
  onTap?: () => void;
  /** Whether the table is a tournament */
  isTournament?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function MiniStatsCard({
  currentStack,
  totalBuyIn,
  handsPlayed,
  vpipCount,
  handsWon,
  isSeated,
  onTap,
  isTournament = false,
}: MiniStatsCardProps) {
  // Don't show if not seated (unless in a tournament, where stats/lobby button is always visible)
  if (!isSeated && !isTournament) return null;

  const pnl = currentStack - totalBuyIn;
  const pnlColor = pnl >= 0 ? 'var(--success, #31A24C)' : 'var(--danger, #F02849)';
  const pnlSign = pnl >= 0 ? '+' : '';
  const vpipPct = handsPlayed > 0 ? Math.round((vpipCount / handsPlayed) * 100) : 0;
  /* `winRate` deleted 2026-08-25: computed on every render and read by
     nothing. `handsWon` is shown directly on the tournament bar instead. */

  const handleClick = () => {
    onTap?.();
  };

  /**
   * TOURNAMENT STATS BAR — Dan 2026-08-25 (binding): "tournaments are still
   * missing the stats bar in the right corner."
   *
   * They were, and this early return is why. It short-circuited PAST every
   * figure the card exists to show and rendered a bare chart glyph with the
   * word STATS — a button that opens a panel, not a stats bar. A player in a
   * tournament could see nothing about their own game without tapping.
   *
   * It now shows the numbers, in the corner, the way a cash table does. Buy-In
   * and P&L are deliberately absent: in a tournament your buy-in is money and
   * your stack is chips, so subtracting one from the other is meaningless. The
   * four figures below are all genuinely session-tracked for tournament tables too
   * (handsPlayed / vpipCount / handsWon are incremented in TablePage
   * regardless of table kind), so none of this is invented.
   *
   * The tap target is unchanged: it still opens the tournament lobby / info
   * panel, which is where standings, payouts and the clock live in full.
   */
  if (isTournament) {
    return (
      <button
        type="button"
        className="mini-stats-card mini-stats-card--tournament-stats"
        onClick={handleClick}
        aria-label={`Tournament stats. Stack ${currentStack.toLocaleString('en-US')}, ${handsPlayed} hands played. Opens tournament lobby.`}
        title="Tournament Stats & Lobby"
      >
        <span className="mini-stats-card__tstat">
          <span className="mini-stats-card__tstat-label">Stack</span>
          <span className="mini-stats-card__tstat-value">{currentStack.toLocaleString('en-US')}</span>
        </span>
        <span className="mini-stats-card__tstat">
          <span className="mini-stats-card__tstat-label">Hands</span>
          <span className="mini-stats-card__tstat-value">{handsPlayed}</span>
        </span>
        <span className="mini-stats-card__tstat">
          <span className="mini-stats-card__tstat-label">VPIP</span>
          <span className="mini-stats-card__tstat-value">{vpipPct}%</span>
        </span>
        <span className="mini-stats-card__tstat">
          <span className="mini-stats-card__tstat-label">Won</span>
          <span className="mini-stats-card__tstat-value">{handsWon}</span>
        </span>
      </button>
    );
  }

  // ─── Collapsed (default): icon-only stats button (Dan 2026-04-17). The
  // previous "P&L +$N" pill was text — Dan wanted an icon. Renders a compact
  // stats/chart SVG with a tiny status dot whose color signals P&L direction.
  const pnlDirection = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
  return (
    <button
      type="button"
      className="mini-stats-card mini-stats-card--icon"
      onClick={handleClick}
      aria-label={`Session stats, P&L ${pnlSign}${pnl.toLocaleString()}`}
      title="Session Stats"
      data-pnl-direction={pnlDirection}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Bar-chart icon — 4 vertical bars ascending */}
        <path d="M3 21h18" />
        <rect x="5" y="13" width="3" height="6" rx="0.5" />
        <rect x="10.5" y="9" width="3" height="10" rx="0.5" />
        <rect x="16" y="5" width="3" height="14" rx="0.5" />
      </svg>
      <span className="mini-stats-card__dot" style={{ background: pnlColor }} aria-hidden="true" />
    </button>
  );
}

/**
 * THE EXPANDED PANEL IS GONE (2026-08-25, second audit).
 *
 * ~70 lines rendered Buy-In / P&L / Stack / VPIP / Who's Watching inline on
 * the felt, and NOTHING COULD EVER REACH THEM. `expanded` is
 * `showRealTimeResults || isExpanded`; no caller in the app passes
 * `showRealTimeResults`, and TablePage always passes `onTap`, so
 * `setIsExpanded` (the only writer of `isExpanded`) is unreachable. The
 * branch had been dead in production since the card was collapsed to an icon
 * on 2026-04-17, along with the `observers` prop that fed it.
 *
 * Nothing is lost: tapping the icon opens the full SessionStats modal, which
 * shows the same figures with room to read them. If an inline panel is ever
 * wanted again it belongs in that modal's component, not as a second
 * rendering of the same numbers behind a flag nobody sets.
 *
 * Unreachable by construction, which is why the icon branch above simply
 * returns and there is no third branch here.
 */

export default MiniStatsCard;
