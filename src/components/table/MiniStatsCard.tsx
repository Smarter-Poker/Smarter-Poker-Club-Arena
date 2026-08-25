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

import React, { useState } from 'react';
import './MiniStatsCard.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MiniStatsObserver {
  id: string;
  name: string;
  avatar?: string;
}

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
  /** Observers watching the table */
  observers?: MiniStatsObserver[];
  /** Whether we are displaying real-time results (true overrides expanded logic) */
  showRealTimeResults?: boolean;
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
  observers = [],
  // Dan 2026-04-17: stats panel was covering 40% of the table by default.
  // Collapse by default — single-line P&L pill. Tap expands to full panel.
  showRealTimeResults = false,
  isTournament = false,
}: MiniStatsCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Don't show if not seated (unless in a tournament, where stats/lobby button is always visible)
  if (!isSeated && !isTournament) return null;

  const pnl = currentStack - totalBuyIn;
  const pnlColor = pnl >= 0 ? 'var(--success, #31A24C)' : 'var(--danger, #F02849)';
  const pnlSign = pnl >= 0 ? '+' : '';
  const vpipPct = handsPlayed > 0 ? Math.round((vpipCount / handsPlayed) * 100) : 0;
  /* `winRate` deleted 2026-08-25: computed on every render and read by
     nothing. `handsWon` is shown directly on the tournament bar instead. */

  // Resolve effective expand state. `onTap` (if provided) opens the full
  // SessionStats modal or tournament lobby; internal isExpanded toggle only matters when onTap
  // is not wired. showRealTimeResults forces expanded display.
  const expanded = showRealTimeResults || isExpanded;

  const handleClick = () => {
    if (onTap) {
      onTap();
    } else {
      setIsExpanded((prev) => !prev);
    }
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
        aria-label={`Tournament stats. Stack ${currentStack.toLocaleString()}, ${handsPlayed} hands played. Opens tournament lobby.`}
        title="Tournament Stats & Lobby"
      >
        <span className="mini-stats-card__tstat">
          <span className="mini-stats-card__tstat-label">Stack</span>
          <span className="mini-stats-card__tstat-value">{currentStack.toLocaleString()}</span>
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
  if (!expanded) {
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
        <span
          className="mini-stats-card__dot"
          style={{ background: pnlColor }}
          aria-hidden="true"
        />
      </button>
    );
  }

  return (
    <div
      className="mini-stats-card mini-stats-card--expanded"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label="Session stats"
    >
      {/* Real-Time Results View */}
      <div className="mini-stats-card__details">
        <div className="mini-stats-card__row">
          <span className="mini-stats-card__label">Buy-In</span>
          <span className="mini-stats-card__value">{totalBuyIn.toLocaleString()}</span>
        </div>
        <div className="mini-stats-card__row">
          <span className="mini-stats-card__label">P&L</span>
          <span className="mini-stats-card__value" style={{ color: pnlColor, fontWeight: 700 }}>
            {pnlSign}
            {pnl.toLocaleString()}
          </span>
        </div>
        <div className="mini-stats-card__row">
          <span className="mini-stats-card__label">Stack</span>
          <span className="mini-stats-card__value">{currentStack.toLocaleString()}</span>
        </div>
        <div className="mini-stats-card__row">
          <span className="mini-stats-card__label">VPIP</span>
          <span className="mini-stats-card__value">{vpipPct}%</span>
        </div>

        {/* Observers / Who's watching */}
        <div
          className="mini-stats-card__observers"
          style={{
            marginTop: '6px',
            paddingTop: '6px',
            borderTop: '1px dashed rgba(255,255,255,0.1)',
          }}
        >
          <span
            className="mini-stats-card__label"
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <span className="mini-stats-card__observer-icon" style={{ color: '#22c55e' }}>
              ◉
            </span>
            Who's Watching: {observers.length}
          </span>
        </div>
        {observers.length > 0 ? (
          <div className="mini-stats-card__observer-list">
            {observers.slice(0, 5).map((obs) => (
              <span key={obs.id} className="mini-stats-card__observer-name">
                {obs.name}
              </span>
            ))}
            {observers.length > 5 && (
              <span className="mini-stats-card__observer-more">+{observers.length - 5} More</span>
            )}
          </div>
        ) : (
          <div className="mini-stats-card__observer-list" style={{ opacity: 0.5 }}>
            <span
              className="mini-stats-card__observer-name"
              style={{ fontStyle: 'italic', background: 'transparent', padding: 0 }}
            >
              Nobody Yet
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default MiniStatsCard;
