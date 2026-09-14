/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD PANEL — Club/Table Rankings Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium leaderboard panel showing:
 * - Top players by winnings
 * - Session rankings
 * - All-time table stats
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONSOLE (#ClubArenaConsole). This was a rounded navy sheet with a grey
 * header bar, a square close button, a pill tab strip, three drawn "podium"
 * tiles with avatar discs and medal badges, and a rounded card per row - a
 * generic list dressed as a popup, and a grid of drawn tiles on top of it.
 *
 * It is now Dan's approved spade master: the period is the eyebrow, the board's
 * name is engraved in the header well, YOUR OWN PLACE sits in the well's
 * painted pill slot, the five periods print as lit words on the black glass,
 * and every player is a ROW on that glass - place in lit blue, name in silver,
 * the figure on the right. Nothing is drawn: no avatars, no discs, no medals,
 * no podium, no cards.
 *
 * THE TOP THREE ARE NOT LOST WITH THE PODIUM - they gained a row. The old list
 * started at `players.slice(3)` because the first three lived in the podium, so
 * the leader appeared in exactly one place and never in the list. Every player
 * is now in the one list, in order, and 1st/2nd/3rd still say so.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import { SpadeConsole } from '../console/SpadeConsole';
import './LeaderboardPanel.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type LeaderboardPeriod = 'session' | 'day' | 'week' | 'month' | 'allTime';

export interface LeaderboardPlayer {
  rank: number;
  playerId: string;
  playerName: string;
  avatar?: string;
  amount: number; // Could be winnings, hands, or other metric
  isPositive: boolean;
  handsPlayed?: number;
  winRate?: number; // BB/100
  isCurrentUser?: boolean;
}

export interface LeaderboardPanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  players: LeaderboardPlayer[];
  period: LeaderboardPeriod;
  onPeriodChange: (period: LeaderboardPeriod) => void;
  metric?: 'winnings' | 'hands' | 'profit';
  currency?: string;
  isLoading?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// Smart precision — whole dollars for clean amounts, decimals only when fractional
function formatAmount(amount: number, currency: string = ''): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (Math.abs(abs - Math.round(abs)) < 0.005) {
    return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
  }
  return `${sign}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const PERIOD_LABELS: Record<LeaderboardPeriod, string> = {
  session: 'Session',
  day: 'Today',
  week: 'This Week',
  month: 'This Month',
  allTime: 'All Time',
};

/** Your own place, for the header well's painted pill slot. */
function placeLabel(rank: number): string {
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  if (rank === 3) return '3rd';
  return `#${rank}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface PlayerRowProps {
  player: LeaderboardPlayer;
  currency: string;
  index?: number;
}

function PlayerRow({ player, currency, index = 0 }: PlayerRowProps) {
  const [mounted, setMounted] = useState(false);
  // LP-2 BUG FIX: track stagger timer so it cancels on unmount — prevents
  // stale setState when the panel closes mid-animation.
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mountTimerRef.current) clearTimeout(mountTimerRef.current);
    mountTimerRef.current = setTimeout(() => {
      mountTimerRef.current = null;
      setMounted(true);
    }, index * 50);
    return () => {
      if (mountTimerRef.current) clearTimeout(mountTimerRef.current);
    };
  }, [index]);
  const rankBadge = useMemo(() => {
    if (player.rank === 1) return '1st';
    if (player.rank === 2) return '2nd';
    if (player.rank === 3) return '3rd';
    return `#${player.rank}`;
  }, [player.rank]);

  return (
    <li
      className={`leaderboard-row ${player.isCurrentUser ? 'leaderboard-row--current' : ''}`}
      aria-current={player.isCurrentUser ? 'true' : undefined}
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <span
        className={`leaderboard-row__rank ${player.rank <= 3 ? 'leaderboard-row__rank--top' : ''}`}
      >
        {rankBadge}
      </span>

      <span className="leaderboard-row__info">
        <span className="leaderboard-row__name">
          {player.playerName}
          {player.isCurrentUser && <span className="leaderboard-row__you">(You)</span>}
        </span>
        {player.handsPlayed !== undefined && (
          <span className="leaderboard-row__hands">{player.handsPlayed} Hands</span>
        )}
      </span>

      <span className="leaderboard-row__stats">
        <span
          className={`leaderboard-row__amount ${player.isPositive ? 'sc-ink--green' : 'sc-ink--red'}`}
        >
          {player.isPositive ? '+' : ''}
          {formatAmount(player.amount, currency)}
        </span>
        {player.winRate !== undefined && (
          <span className="leaderboard-row__winrate">
            {player.winRate > 0 ? '+' : ''}
            {player.winRate.toFixed(1)} BB/100
          </span>
        )}
      </span>
    </li>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function LeaderboardPanel({
  isOpen,
  onClose,
  title,
  players,
  period,
  onPeriodChange,
  currency = '',
  isLoading = false,
}: LeaderboardPanelProps) {
  if (!isOpen) return null;

  const me = players.find((p) => p.isCurrentUser);

  return (
    <div className="leaderboard-overlay" onClick={onClose}>
      <div
        className="leaderboard-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="leaderboard-panel-title"
      >
        <SpadeConsole
          as="div"
          eyebrow={PERIOD_LABELS[period]}
          title={title}
          titleId="leaderboard-panel-title"
          /* YOUR OWN PLACE, in the well's painted pill slot. A viewer who is
             not on the board is told so rather than shown a fabricated 0. */
          pill={me ? placeLabel(me.rank) : 'Unranked'}
          pillInk={me ? (me.rank <= 3 ? 'gold' : 'blue') : 'muted'}
          foot="foot"
        >
          {/* The five periods: lit words on the glass, never a pill bar. */}
          <div className="leaderboard-panel__tabs" role="tablist" aria-label="Leaderboard Period">
            {(Object.keys(PERIOD_LABELS) as LeaderboardPeriod[]).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                className={`leaderboard-panel__tab ${period === p ? 'leaderboard-panel__tab--active' : ''}`}
                onClick={() => {
                  haptic.light();
                  onPeriodChange(p);
                }}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="leaderboard-panel__loading" role="status" aria-live="polite">
              <span className="leaderboard-panel__spinner" aria-hidden="true" />
              <span>Loading Rankings...</span>
            </div>
          ) : players.length === 0 ? (
            <div className="leaderboard-panel__empty">
              <span className="leaderboard-panel__empty-text">No Rankings Yet</span>
              <span className="leaderboard-panel__empty-hint">
                Play Some Hands To Appear On The Leaderboard
              </span>
            </div>
          ) : (
            <ol className="leaderboard-panel__rows" aria-label="Rankings">
              {players.map((player, idx) => (
                // LP-1 BUG FIX: pass index so stagger animation actually staggers
                // (previously index defaulted to 0 → all rows animated simultaneously)
                <PlayerRow key={player.playerId} player={player} currency={currency} index={idx} />
              ))}
            </ol>
          )}

          {/* One action, so the foot is the flat closing cap and Close is a lit
              word - the master paints BOTH plates, and a single action would
              leave one of them painted and empty. */}
          <button
            type="button"
            className="leaderboard-panel__close"
            onClick={onClose}
            aria-label="Close Leaderboard"
          >
            Close
          </button>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default LeaderboardPanel;
