/**
 * SessionHistory — Timeline of poker sessions with P/L tracking
 * Wired to real Supabase `player_sessions` table with bus listeners
 */

import React, { useState, useEffect, useCallback } from 'react';
import { supabase, getAuthUser } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './SessionHistory.css';

interface SessionRecord {
  id: string;
  date: Date;
  duration: number; // minutes
  handsPlayed: number;
  buyIn: number;
  cashOut: number;
  profitLoss: number;
  hourlyRate: number;
}

const SessionHistory: React.FC = () => {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [visibleSessions, setVisibleSessions] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const { data: userResp } = await getAuthUser();
      if (!userResp.user) return;

      const { data, error } = await supabase
        .from('player_sessions')
        .select('id, date, duration_minutes, hands_played, buy_in, cash_out, profit_loss')
        .eq('user_id', userResp.user.id)
        .order('date', { ascending: false })
        .limit(20);

      if (error) {
        console.error('[SessionHistory] Query error:', error.message);
        setLoaded(true);
        return;
      }

      if (data && data.length > 0) {
        const mapped: SessionRecord[] = data.map((s) => {
          const dur = s.duration_minutes || 0;
          const pl = s.profit_loss || 0;
          return {
            id: s.id,
            date: new Date(s.date),
            duration: dur,
            handsPlayed: s.hands_played || 0,
            buyIn: s.buy_in || 0,
            cashOut: s.cash_out || 0,
            profitLoss: pl,
            hourlyRate: dur > 0 ? (pl / dur) * 60 : 0,
          };
        });
        setSessions(mapped);

        // Stagger animation
        mapped.forEach((_, i) => {
          setTimeout(() => {
            setVisibleSessions((prev) => new Set([...prev, i]));
          }, i * 60);
        });
      } else {
        setSessions([]);
      }

      setLoaded(true);
    } catch (err) {
      console.error('[SessionHistory] Failed to load:', err);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Bus listeners: refresh when sessions might change
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced('HAND_COMPLETED', () => loadSessions(), 3000);
    const unsubCashout = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => loadSessions(),
      2000
    );
    return () => {
      unsubHand();
      unsubCashout();
    };
  }, [loadSessions]);

  const getTotalProfit = () => sessions.reduce((sum, s) => sum + s.profitLoss, 0);
  const getWinningSessions = () => sessions.filter((s) => s.profitLoss > 0).length;
  const getWinRate = () =>
    sessions.length > 0 ? ((getWinningSessions() / sessions.length) * 100).toFixed(1) : '0';
  const getAverageHourlyRate = () =>
    sessions.length > 0
      ? (sessions.reduce((sum, s) => sum + s.hourlyRate, 0) / sessions.length).toFixed(2)
      : '0';

  const formatDuration = (minutes: number): string => {
    if (minutes < 60) return `${minutes}m`;
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  };

  if (!loaded) {
    return (
      <div className="session-history">
        <div className="session-header">
          <h3>Session History</h3>
          <p className="session-subtitle">Loading sessions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="session-history">
      <div className="session-header">
        <h3>Session History</h3>
        <p className="session-subtitle">
          {sessions.length > 0 ? `Last ${sessions.length} sessions tracked` : 'No sessions yet'}
        </p>
      </div>

      {/* Summary Stats */}
      {sessions.length > 0 && (
        <div className="session-summary-stats">
          <div className="summary-stat">
            <span className="stat-label">Total P/L</span>
            <span
              className="stat-value"
              style={{ color: getTotalProfit() >= 0 ? '#10b981' : '#ef4444' }}
            >
              {getTotalProfit() > 0 ? '+' : ''}
              {getTotalProfit().toLocaleString()}
            </span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Win Rate</span>
            <span className="stat-value">{getWinRate()}%</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Avg Hourly</span>
            <span
              className="stat-value"
              style={{ color: parseFloat(getAverageHourlyRate()) >= 0 ? '#10b981' : '#ef4444' }}
            >
              {parseFloat(getAverageHourlyRate()) > 0 ? '+' : ''}
              {getAverageHourlyRate()}/hr
            </span>
          </div>
        </div>
      )}

      {/* Sessions Timeline */}
      <div className="sessions-timeline">
        {sessions.map((session, i) => {
          const isVisible = visibleSessions.has(i);
          const isExpanded = expandedSession === session.id;

          return (
            <div
              key={session.id}
              className={`session-card ${session.profitLoss >= 0 ? 'winning' : 'losing'}`}
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateX(0)' : 'translateX(-16px)',
                transition: `all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 30}ms`,
              }}
              onClick={() => setExpandedSession(isExpanded ? null : session.id)}
            >
              <div className="session-main">
                {/* Date */}
                <div className="session-date">
                  <span className="date-day">{session.date.getDate()}</span>
                  <span className="date-month">
                    {session.date.toLocaleDateString('en-US', { month: 'short' })}
                  </span>
                </div>

                {/* Core stats */}
                <div className="session-core">
                  <div className="core-stat">
                    <span className="core-label">Duration</span>
                    <span className="core-value">{formatDuration(session.duration)}</span>
                  </div>
                  <div className="core-stat">
                    <span className="core-label">Hands</span>
                    <span className="core-value">{session.handsPlayed}</span>
                  </div>
                </div>

                {/* P/L indicator */}
                <div className="session-result">
                  <div className="result-pl">
                    <span className="pl-sign">{session.profitLoss > 0 ? '+' : ''}</span>
                    <span className="pl-value">{session.profitLoss.toLocaleString()}</span>
                  </div>
                  <div className="result-hourly">
                    <span className="hourly-label">$/hr</span>
                    <span
                      className="hourly-value"
                      style={{ color: session.hourlyRate >= 0 ? '#10b981' : '#ef4444' }}
                    >
                      {session.hourlyRate > 0 ? '+' : ''}
                      {session.hourlyRate.toFixed(1)}
                    </span>
                  </div>
                </div>

                {/* Expand indicator */}
                <div className="session-expand">
                  <span
                    style={{
                      transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s',
                    }}
                  >
                    ▼
                  </span>
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div
                  className="session-details"
                  style={{
                    animation: 'slideDown 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <div className="details-grid">
                    <div className="detail-item">
                      <span className="detail-label">Buy-In</span>
                      <span className="detail-value">{session.buyIn.toLocaleString()}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Cash-Out</span>
                      <span className="detail-value">{session.cashOut.toLocaleString()}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">P/L per Hand</span>
                      <span className="detail-value">
                        {session.handsPlayed > 0
                          ? (session.profitLoss / session.handsPlayed).toFixed(2)
                          : '0'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {sessions.length === 0 && (
        <div className="session-empty">
          <span className="empty-icon">📊</span>
          <p>No sessions recorded yet. Play some hands to start tracking!</p>
        </div>
      )}
    </div>
  );
};

export default SessionHistory;
