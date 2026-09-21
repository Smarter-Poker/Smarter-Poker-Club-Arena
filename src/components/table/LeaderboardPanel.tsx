/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD PANEL — Club/Table Rankings Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium leaderboard panel showing:
 * - Top players by winnings
 * - Session rankings
 * - All-time table stats
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import './LeaderboardPanel.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
import { useFocusTrap } from '../../hooks/useFocusTrap';

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

function formatAmount(amount: number): string {
  return compactChips(amount);
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

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface PlayerRowProps {
  player: LeaderboardPlayer;
  index?: number;
}

function PlayerRow({ player, index = 0 }: PlayerRowProps) {
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
    <div
      className={`leaderboard-row ${player.isCurrentUser ? 'leaderboard-row--current' : ''}`}
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

      <div className="leaderboard-row__player">
        <div className="leaderboard-row__avatar">
          {player.avatar ? (
            <img
              loading="lazy"
              decoding="async"
              src={player.avatar}
              alt=""
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
          ) : (
            <span>{player.playerName[0]?.toUpperCase()}</span>
          )}
        </div>
        <div className="leaderboard-row__info">
          <span className="leaderboard-row__name">
            {player.playerName}
            {player.isCurrentUser && <span className="leaderboard-row__you">(You)</span>}
          </span>
          {player.handsPlayed !== undefined && (
            <span className="leaderboard-row__hands">{compactChips(player.handsPlayed)} Hands</span>
          )}
        </div>
      </div>

      <div className="leaderboard-row__stats">
        <span
          className={`leaderboard-row__amount ${player.isPositive ? 'leaderboard-row__amount--positive' : 'leaderboard-row__amount--negative'}`}
        >
          {player.isPositive ? '+' : ''}
          {formatAmount(player.amount)}
        </span>
        {player.winRate !== undefined && (
          <span className="leaderboard-row__winrate">
            {player.winRate > 0 ? '+' : ''}
            {player.winRate.toFixed(1)} BB/100
          </span>
        )}
      </div>
    </div>
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
  metric = 'winnings',
  isLoading = false,
}: LeaderboardPanelProps) {
  const dialogRef = useFocusTrap(isOpen);
  useEffect(() => {
    if (!isOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', close);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', close);
    };
  }, [isOpen, onClose]);
  if (!isOpen) return null;

  return (
    <div className="leaderboard-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="leaderboard-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-leaderboard-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          crest="flat"
          eyebrow="Table Rankings"
          title={title}
          titleId="table-leaderboard-title"
          subtitle={
            metric === 'hands' ? 'Hands Played' : metric === 'profit' ? 'Net Profit' : 'Winnings'
          }
          pill={PERIOD_LABELS[period]}
        >
          <button
            className="leaderboard-panel__dismiss"
            onClick={onClose}
            aria-label="Close Leaderboard"
          >
            Close
          </button>

          {/* Period Tabs */}
          <div className="leaderboard-panel__tabs">
            {(Object.keys(PERIOD_LABELS) as LeaderboardPeriod[]).map((p) => (
              <button
                key={p}
                className={`leaderboard-panel__tab ${period === p ? 'leaderboard-panel__tab--active' : ''}`}
                aria-pressed={period === p}
                onClick={() => {
                  haptic.light();
                  onPeriodChange(p);
                }}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="leaderboard-panel__body">
            {isLoading ? (
              <div className="leaderboard-panel__loading" role="status">
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
              <div className="leaderboard-panel__list">
                <div className="leaderboard-panel__rows">
                  {players.map((player, idx) => (
                    // LP-1 BUG FIX: pass index so stagger animation actually staggers
                    // (previously index defaulted to 0 → all rows animated simultaneously)
                    <PlayerRow key={player.playerId} player={player} index={idx} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default LeaderboardPanel;
