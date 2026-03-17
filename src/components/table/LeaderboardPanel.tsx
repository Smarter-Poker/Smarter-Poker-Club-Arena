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

import React, { useState, useEffect, useMemo } from 'react';
import { haptic } from '../../services/SoundService';
import './LeaderboardPanel.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

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

// EXACT precision — no abbreviations, no rounding
function formatAmount(amount: number, currency: string = ''): string {
  return `${amount < 0 ? '-' : ''}${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  currency: string;
  index?: number;
}

function PlayerRow({ player, currency, index = 0 }: PlayerRowProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTimeout(() => setMounted(true), index * 50);
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
            <span className="leaderboard-row__hands">{player.handsPlayed} hands</span>
          )}
        </div>
      </div>

      <div className="leaderboard-row__stats">
        <span
          className={`leaderboard-row__amount ${player.isPositive ? 'leaderboard-row__amount--positive' : 'leaderboard-row__amount--negative'}`}
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
  currency = '',
  isLoading = false,
}: LeaderboardPanelProps) {
  if (!isOpen) return null;

  return (
    <div className="leaderboard-overlay" onClick={onClose}>
      <div className="leaderboard-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="leaderboard-panel__header">
          <h2 className="leaderboard-panel__title">{title}</h2>
          <button className="leaderboard-panel__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Period Tabs */}
        <div className="leaderboard-panel__tabs">
          {(Object.keys(PERIOD_LABELS) as LeaderboardPeriod[]).map((p) => (
            <button
              key={p}
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

        {/* Content */}
        <div className="leaderboard-panel__body">
          {isLoading ? (
            <div className="leaderboard-panel__loading">
              <div className="leaderboard-panel__spinner" />
              <span>Loading rankings...</span>
            </div>
          ) : players.length === 0 ? (
            <div className="leaderboard-panel__empty">
              <span className="leaderboard-panel__empty-icon">≡</span>
              <span className="leaderboard-panel__empty-text">No rankings yet</span>
              <span className="leaderboard-panel__empty-hint">
                Play some hands to appear on the leaderboard
              </span>
            </div>
          ) : (
            <div className="leaderboard-panel__list">
              {/* Top 3 Highlight */}
              {players.length > 0 && (
                <div className="leaderboard-panel__podium">
                  {players.slice(0, 3).map((player) => (
                    <div
                      key={player.playerId}
                      className={`leaderboard-podium leaderboard-podium--rank${player.rank}`}
                    >
                      <div className="leaderboard-podium__avatar">
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
                        <span className="leaderboard-podium__medal">
                          {player.rank === 1 ? '1st' : player.rank === 2 ? '2nd' : '3rd'}
                        </span>
                      </div>
                      <span className="leaderboard-podium__name">{player.playerName}</span>
                      <span
                        className={`leaderboard-podium__amount ${player.isPositive ? 'leaderboard-podium__amount--positive' : 'leaderboard-podium__amount--negative'}`}
                      >
                        {player.isPositive ? '+' : ''}
                        {formatAmount(player.amount, currency)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Rest of the list */}
              <div className="leaderboard-panel__rows">
                {players.slice(3).map((player) => (
                  <PlayerRow key={player.playerId} player={player} currency={currency} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default LeaderboardPanel;
