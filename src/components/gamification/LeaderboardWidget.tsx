/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD WIDGET — Compact Leaderboard Display
 * ═══════════════════════════════════════════════════════════════════════════════
 * Hardened: isMounted, useCallback, bus listeners (HAND_COMPLETED, BALANCE_UPDATED),
 * animation cleanup, loading skeleton.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './LeaderboardWidget.css';

interface LeaderboardWidgetProps {
  clubId?: string;
  period?: 'daily' | 'weekly' | 'monthly' | 'all';
  metric?: 'profit' | 'hands' | 'rake';
  limit?: number;
  showTitle?: boolean;
}

interface LeaderEntry {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string;
  value: number;
}

export function LeaderboardWidget({
  clubId,
  period = 'weekly',
  metric = 'profit',
  limit = 5,
  showTitle = true,
}: LeaderboardWidgetProps) {
  const [entries, setEntries] = useState<LeaderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const animTimers = useRef<number[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLeaderboard = useCallback(async () => {
    if (!isMounted.current) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('fn_get_leaderboard', {
        p_club_id: clubId || null,
        p_period: period,
        p_metric: metric,
        p_limit: limit,
      });

      if (!isMounted.current) return;

      if (!error && data) {
        const mapped = data.map((e: any, idx: number) => ({
          rank: idx + 1,
          userId: e.user_id,
          username: e.username,
          avatarUrl: e.avatar_url || '',
          value: e.value || 0,
        }));
        setEntries(mapped);

        // Staggered reveal animation — track timers for cleanup
        animTimers.current.forEach(clearTimeout);
        animTimers.current = [];
        setVisibleItems(new Set());
        mapped.forEach((_: any, i: number) => {
          const t = window.setTimeout(
            () => setVisibleItems((prev) => new Set(prev).add(i)),
            i * 60
          );
          animTimers.current.push(t);
        });
      }
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
    }
    if (isMounted.current) setLoading(false);
  }, [clubId, period, metric, limit]);

  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (isMounted.current) loadLeaderboard();
    }, 2000); // 2s debounce — leaderboard doesn't need instant refresh
  }, [loadLeaderboard]);

  useEffect(() => {
    loadLeaderboard();

    // Bus listeners — leaderboard refreshes after gameplay events
    const unsubHand = masterBus.subscribe('HAND_COMPLETED', debouncedRefresh);
    const unsubBalance = masterBus.subscribe('BALANCE_UPDATED', debouncedRefresh);

    return () => {
      unsubHand();
      unsubBalance();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, [loadLeaderboard, debouncedRefresh]);

  const formatValue = (value: number) => {
    if (metric === 'profit') {
      return value >= 0 ? `+${value.toLocaleString()}` : value.toLocaleString();
    }
    return value.toLocaleString();
  };

  const getPeriodLabel = () => {
    switch (period) {
      case 'daily':
        return 'Today';
      case 'weekly':
        return 'This Week';
      case 'monthly':
        return 'This Month';
      default:
        return 'All Time';
    }
  };

  const getMetricIcon = () => {
    switch (metric) {
      case 'profit':
        return '';
      case 'hands':
        return '♠';
      case 'rake':
        return '%';
      default:
        return '≡';
    }
  };

  if (loading) {
    return (
      <div className="leaderboard-widget loading">
        {showTitle && (
          <div className="leaderboard-widget__header">
            <span className="icon">{getMetricIcon()}</span>
            <span className="title">Top Players</span>
            <span className="period">{getPeriodLabel()}</span>
          </div>
        )}
        <div className="leaderboard-widget__list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="leader-entry" style={{ opacity: 0.3 }}>
              <span
                className="rank"
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  borderRadius: 4,
                  width: 30,
                  height: 14,
                  display: 'inline-block',
                }}
              >
                &nbsp;
              </span>
              <span
                className="username"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  borderRadius: 4,
                  width: '40%',
                  height: 14,
                  display: 'inline-block',
                }}
              >
                &nbsp;
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="leaderboard-widget">
      {showTitle && (
        <div className="leaderboard-widget__header">
          <span className="icon">{getMetricIcon()}</span>
          <span className="title">Top Players</span>
          <span className="period">{getPeriodLabel()}</span>
        </div>
      )}

      <div className="leaderboard-widget__list">
        {entries.map((entry, i) => (
          <div
            key={entry.userId}
            className={`leader-entry rank-${entry.rank}`}
            style={{
              opacity: visibleItems.has(i) ? 1 : 0,
              transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <span className="rank">
              {entry.rank === 1 && '1st'}
              {entry.rank === 2 && '2nd'}
              {entry.rank === 3 && '3rd'}
              {entry.rank > 3 && `#${entry.rank}`}
            </span>
            <span className="avatar">{entry.avatarUrl}</span>
            <span className="username">{entry.username}</span>
            <span className={`value ${entry.value >= 0 ? 'positive' : 'negative'}`}>
              {formatValue(entry.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default LeaderboardWidget;
