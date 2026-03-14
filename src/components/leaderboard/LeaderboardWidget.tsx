/**
 * ♠ CLUB ARENA — Leaderboard Widget
 * Compact leaderboard for dashboard display
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LeaderboardService } from '../../services/LeaderboardService';
import type { LeaderboardMetric, LeaderboardPeriod } from '../../services/LeaderboardService';
import { masterBus } from '../../core/MasterBus';
import './LeaderboardWidget.css';

interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatar?: string;
  value: number;
  change: number; // positive = up, negative = down
}

type LeaderboardType = 'profit' | 'hands' | 'tournaments' | 'streak';

interface LeaderboardWidgetProps {
  clubId?: string;
  type?: LeaderboardType;
  limit?: number;
  showFilters?: boolean;
  onPlayerClick?: (userId: string) => void;
}

export const LeaderboardWidget: React.FC<LeaderboardWidgetProps> = ({
  clubId,
  type = 'profit',
  limit = 5,
  showFilters = true,
  onPlayerClick,
}) => {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [selectedType, setSelectedType] = useState<LeaderboardType>(type);
  const [timeframe, setTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'alltime'>('weekly');
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useRef(true);
  const animTimers = useRef<number[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Map widget timeframe to service period type
  const periodMap: Record<string, LeaderboardPeriod> = {
    daily: 'daily',
    weekly: 'weekly',
    monthly: 'monthly',
    alltime: 'all_time',
  };

  // Map widget type to service metric
  const metricMap: Record<string, LeaderboardMetric> = {
    profit: 'profit',
    hands: 'hands_played',
    tournaments: 'tournaments_won',
    streak: 'profit',
  };

  const loadLeaderboard = useCallback(async () => {
    if (!clubId || !isMounted.current) {
      if (isMounted.current) setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const servicePeriod = periodMap[timeframe] || 'weekly';
      const serviceMetric = metricMap[selectedType] || 'profit';
      const data = await LeaderboardService.getClubLeaderboard(
        clubId,
        serviceMetric,
        servicePeriod,
        limit
      );
      if (!isMounted.current) return;
      const mapped: LeaderboardEntry[] = data.map((entry) => ({
        rank: entry.rank,
        userId: entry.userId,
        username: entry.username,
        avatar: entry.avatar,
        value: entry.value,
        change: entry.change,
      }));
      setEntries(mapped);
      // Staggered reveal — track timers for cleanup
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
      setVisibleItems(new Set());
      mapped.forEach((_, i) => {
        const t = window.setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        animTimers.current.push(t);
      });
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId, selectedType, timeframe, limit]);

  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (isMounted.current) loadLeaderboard();
    }, 2000);
  }, [loadLeaderboard]);

  useEffect(() => {
    isMounted.current = true;
    loadLeaderboard();

    const unsubHand = masterBus.subscribe('HAND_COMPLETED', debouncedRefresh);
    const unsubBalance = masterBus.subscribe('BALANCE_UPDATED', debouncedRefresh);

    return () => {
      isMounted.current = false;
      unsubHand();
      unsubBalance();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, [loadLeaderboard, debouncedRefresh]);

  const formatValue = (value: number) => {
    if (selectedType === 'profit') {
      return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const getTypeLabel = (t: LeaderboardType) => {
    switch (t) {
      case 'profit':
        return 'Profit';
      case 'hands':
        return 'Hands';
      case 'tournaments':
        return 'Wins';
      case 'streak':
        return 'Streak';
    }
  };

  const getRankBadge = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  };

  return (
    <div className="leaderboard-widget">
      {/* Header */}
      <div className="widget-header">
        <h3>🏆 Leaderboard</h3>
        <a href="/leaderboard" className="view-all">
          View All →
        </a>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="filters-row">
          <div className="type-filters">
            {(['profit', 'hands', 'tournaments', 'streak'] as LeaderboardType[]).map((t) => (
              <button
                key={t}
                className={`filter-btn ${selectedType === t ? 'active' : ''}`}
                onClick={() => setSelectedType(t)}
              >
                {getTypeLabel(t)}
              </button>
            ))}
          </div>
          <select
            className="timeframe-select"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as any)}
          >
            <option value="daily">Today</option>
            <option value="weekly">This Week</option>
            <option value="monthly">This Month</option>
            <option value="alltime">All Time</option>
          </select>
        </div>
      )}

      {/* Entries */}
      <div className="entries-list">
        {loading ? (
          <div className="loading-skeleton">
            {Array.from({ length: limit }).map((_, i) => (
              <div key={i} className="skeleton-row" />
            ))}
          </div>
        ) : (
          entries.map((entry, index) => (
            <div
              key={entry.userId}
              className={`entry-row rank-${entry.rank}`}
              onClick={() => onPlayerClick?.(entry.userId)}
              style={{
                opacity: visibleItems.has(index) ? 1 : 0,
                transform: visibleItems.has(index) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="rank-badge">{getRankBadge(entry.rank)}</span>
              <div className="player-info">
                <div className="player-avatar">
                  {entry.avatar ? (
                    <img src={entry.avatar} alt={entry.username} />
                  ) : (
                    <span>{entry.username[0]}</span>
                  )}
                </div>
                <span className="player-name">{entry.username}</span>
              </div>
              <div className="value-section">
                <span className="entry-value">{formatValue(entry.value)}</span>
                {entry.change !== 0 && (
                  <span className={`change-indicator ${entry.change > 0 ? 'up' : 'down'}`}>
                    {entry.change > 0 ? '↑' : '↓'}
                    {Math.abs(entry.change)}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default LeaderboardWidget;
