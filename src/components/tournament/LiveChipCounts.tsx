/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LIVE CHIP COUNTS — Real-time chip leader board with animated counters
 * Shows all remaining players sorted by stack size with visual indicators
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import './LiveChipCounts.css';

interface ChipLeader {
  userId: string;
  username: string;
  avatarUrl: string | null;
  chipCount: number;
  status: 'playing' | 'eliminated' | 'winner';
  rank: number;
}

interface LiveChipCountsProps {
  tournamentId: string;
  currentBigBlind: number;
  limit?: number;
  autoRefresh?: number; // ms
}

export const LiveChipCounts: React.FC<LiveChipCountsProps> = ({
  tournamentId,
  currentBigBlind,
  limit = 20,
  autoRefresh = 10000,
}) => {
  const [leaders, setLeaders] = useState<ChipLeader[]>([]);
  const isMounted = useIsMounted();
  const [totalChips, setTotalChips] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [prevChips, setPrevChips] = useState<Record<string, number>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setTimeout(() => setMounted(true), 50);
  }, []);

  useEffect(() => {
    loadChipCounts();
    intervalRef.current = setInterval(loadChipCounts, autoRefresh);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [tournamentId, autoRefresh]);

  const loadChipCounts = async () => {
    try {
      const { data, error } = await supabase
        .from('tournament_players')
        .select('user_id, chips, status, profile:profiles!user_id(username, avatar_url)')
        .eq('tournament_id', tournamentId)
        .neq('status', 'eliminated')
        .order('chips', { ascending: false })
        .limit(limit);

      if (!error && data) {
        let total = 0;
        const mapped = data.map((p: any, idx: number) => {
          total += p.chips || 0;
          const profile = Array.isArray(p.profile) ? p.profile[0] : p.profile;
          return {
            userId: p.user_id,
            username: profile?.username || 'Unknown',
            avatarUrl: profile?.avatar_url || null,
            chipCount: p.chips || 0,
            status: p.status || 'playing',
            rank: idx + 1,
          };
        });
        setPrevChips(
          leaders.reduce(
            (acc, leader) => ({
              ...acc,
              [leader.userId]: leader.chipCount,
            }),
            {}
          )
        );
        setLeaders(mapped);
        setTotalChips(total);
      }
    } catch (error) {
      console.error('Failed to load chip counts:', error);
    } finally {
      setLoading(false);
    }
  };

  const avgStack = leaders.length > 0 ? totalChips / leaders.length : 0;

  const animateNumber = (from: number, to: number, duration: number = 800): number => {
    // Used in render, but we'll use state-based animation instead
    return to;
  };

  const getChipRatio = (chips: number): number => {
    return avgStack > 0 ? chips / avgStack : 0;
  };

  const formatChips = (amount: number) => {
    if (amount >= 1000000) {
      return (amount / 1000000).toFixed(1) + 'M';
    }
    if (amount >= 1000) {
      return (amount / 1000).toFixed(1) + 'K';
    }
    return amount.toLocaleString();
  };

  const getMRatio = (chips: number) => {
    return currentBigBlind > 0 ? Math.floor(chips / currentBigBlind) : 0;
  };

  const getChipStatus = (chips: number): 'danger' | 'warning' | 'safe' => {
    const ratio = getMRatio(chips);
    if (ratio < 10) return 'danger';
    if (ratio < 25) return 'warning';
    return 'safe';
  };

  if (loading) {
    return (
      <div className="live-chip-counts loading">
        <div className="lcc-spinner" />
        <span>Loading chip counts...</span>
      </div>
    );
  }

  return (
    <div
      className="live-chip-counts"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(12px)',
        transition: 'all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      {/* Header */}
      <div className="lcc-header">
        <div className="lcc-title">
          <h3>Chip Counts</h3>
        </div>
        <div className="lcc-stats">
          <div className="lcc-stat-item">
            <span className="lcc-stat-value">{leaders.length}</span>
            <span className="lcc-stat-label">Players</span>
          </div>
          <div className="lcc-stat-item">
            <span className="lcc-stat-value">{formatChips(avgStack)}</span>
            <span className="lcc-stat-label">Avg Stack</span>
          </div>
          <div className="lcc-stat-item">
            <span className="lcc-stat-value">{formatChips(totalChips)}</span>
            <span className="lcc-stat-label">Total Chips</span>
          </div>
        </div>
      </div>

      {/* Average Stack Indicator Line */}
      <div className="lcc-avg-indicator">
        <div className="lcc-avg-line" />
        <span className="lcc-avg-text">Average Stack</span>
      </div>

      {/* Chip Leaders List */}
      <div className="lcc-list">
        {leaders.map((leader, idx) => {
          const status = getChipStatus(leader.chipCount);
          const mRatio = getMRatio(leader.chipCount);
          const pctOfTotal = totalChips > 0 ? (leader.chipCount / totalChips) * 100 : 0;

          return (
            <div
              key={leader.userId}
              className={`lcc-row rank-${leader.rank} ${status}`}
              style={{
                opacity: mounted ? 1 : 0,
                transform: mounted ? 'translateX(0)' : 'translateX(-12px)',
                transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                transitionDelay: `${0.12 + idx * 0.04}s`,
              }}
            >
              {/* Rank Badge */}
              <div className="lcc-rank-badge">{leader.rank === 1 ? '👑' : `#${leader.rank}`}</div>

              {/* Player Info */}
              <div className="lcc-player-info">
                {leader.avatarUrl && (
                  <img src={leader.avatarUrl} alt={leader.username} className="lcc-avatar" />
                )}
                <div className="lcc-name-plate">
                  <span className="lcc-username">
                    {leader.username}
                    {leader.rank === 1 && <span className="lcc-leader-badge">Chip Leader</span>}
                  </span>
                </div>
              </div>

              {/* Chip Count */}
              <div className="lcc-chips-display">
                <span className="lcc-chip-amount">{formatChips(leader.chipCount)}</span>
              </div>

              {/* M-Ratio (Big Blinds) */}
              <div className="lcc-m-ratio">
                <span className="lcc-m-value">{mRatio}BB</span>
                {mRatio < 10 && <span className="lcc-danger-dot" />}
              </div>

              {/* Percentage of Total Chips */}
              <div className="lcc-percentage">
                <span className="lcc-pct">{pctOfTotal.toFixed(1)}%</span>
              </div>

              {/* Status Badge */}
              {status === 'danger' && (
                <div className="lcc-badge danger" title={`In danger (${mRatio}BB)`}>
                  ⚠️
                </div>
              )}
              {status === 'warning' && (
                <div className="lcc-badge warning" title={`Low stack (${mRatio}BB)`}>
                  ◆
                </div>
              )}

              {/* Visual Stack Bar */}
              <div className="lcc-stack-bar">
                <div
                  className={`lcc-stack-fill ${status}`}
                  style={{
                    width: `${Math.min(100, (getChipRatio(leader.chipCount) * 100) / 2)}%`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty State */}
      {leaders.length === 0 && (
        <div className="lcc-empty">
          <span>No players found</span>
        </div>
      )}
    </div>
  );
};

export default LiveChipCounts;
