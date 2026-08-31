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
import { useButtonImage } from '../../hooks/useButtonImage';

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
  /** Whether the hero is seated */
  isSeated: boolean;
  /** Tap handler — session stats on cash, the tournament lobby on a tournament */
  onTap?: () => void;
  /** Whether the table is a tournament */
  isTournament?: boolean;
}

/* `handsPlayed`, `vpipCount` and `handsWon` were removed from this interface on
   2026-08-28 along with the four-figure tournament bar that was their only
   reader. Dan: "STATS SHOULD LIVE INSIDE THE HERO AVATAR." They are still
   tracked in TablePage and still shown — in the session-stats surfaces the hero
   hub launches — they are simply no longer passed to a corner button that does
   not print them. Left in place they would have been three dead props that
   every future reader had to check. */

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function MiniStatsCard({
  currentStack,
  totalBuyIn,
  isSeated,
  onTap,
  isTournament = false,
}: MiniStatsCardProps) {
  const statsIcon = useButtonImage('icon-stats');
  // Don't show if not seated (unless in a tournament, where stats/lobby button is always visible)
  if (!isSeated && !isTournament) return null;

  const pnl = currentStack - totalBuyIn;
  const pnlColor = pnl >= 0 ? 'var(--success, #3fb950)' : 'var(--danger, #F02849)';
  const pnlSign = pnl >= 0 ? '+' : '';
  /* `vpipPct` deleted 2026-08-28 with the tournament bar that was its only
     reader; `winRate` went the same way on 2026-08-25. */

  const handleClick = () => {
    onTap?.();
  };

  /**
   * ═══ ON A TOURNAMENT THIS CONTROL IS THE LOBBY DOOR (Dan 2026-08-28) ═══
   *
   * Dan, ruling on this exact corner: "ALL TOURNAMENTS NEED THE STATS ICON IN
   * THE UPPER RIGHT HAND CORNER. IT SHOULDN'T SHOW THE STATS, BUT OPEN TO THE
   * TOURNAMENT LOBBY PAGE AS AN IN GAME 3/4 POP UP", and then, asked whether
   * the inline figures should stay: "STATS SHOULD LIVE INSIDE THE HERO AVATAR,
   * WHEN YOU CLICK IT YOU SHOULD SEE STATS INSIDE THERE. STATS ICON IS NOT THE
   * TOURNAMENT LOBBY BUTTON. USE THE EXACT BUTTON AS IT IS."
   *
   * So the corner is ONE button, the existing artwork unchanged, and it opens
   * the tournament lobby. It does not print figures at it. A player's own
   * numbers are reached by tapping their own seat, which is where somebody
   * looking for their stats actually looks.
   *
   * THIS REPLACES the four-figure bar added on 2026-08-25 in response to
   * "tournaments are still missing the stats bar in the right corner." That
   * complaint was about the corner being EMPTY-looking on a tournament, and it
   * was answered by cramming Stack / Hands / VPIP / Won into a 375px-wide
   * corner. Dan has now said where those belong instead. Seated and observing
   * collapse to the same branch, which also retires the separate spectator case
   * that existed only to avoid printing four zeroes at somebody who was
   * watching rather than playing.
   */
  if (isTournament) {
    return (
      <button
        type="button"
        className="mini-stats-card mini-stats-card--icon"
        onClick={handleClick}
        aria-label="Tournament Lobby. Standings, Payouts And The Clock."
        title="Tournament Lobby"
      >
        <img
          src={statsIcon}
          className="mini-stats-card__icon-img"
          alt=""
          aria-hidden="true"
          draggable={false}
        />
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
      aria-label={`Session Stats, P&L ${pnlSign}${pnl.toLocaleString()}`}
      title="Session Stats"
      data-pnl-direction={pnlDirection}
    >
      <img
        src={statsIcon}
        className="mini-stats-card__icon-img"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
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
