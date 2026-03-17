/**
 * SessionHistory — Timeline of poker sessions with P/L tracking
 * Shows each session's duration, hands played, and profit/loss
 */

import React, { useState, useEffect } from 'react';
import { formatDurationMinutes as formatTime } from '@/lib/date';
import './SessionHistory.css';

interface SessionRecord {
  id: string;
  date: Date;
  duration: number; // minutes
  handsPlayed: number;
  buyIn: number;
  cashOut: number;
  profitLoss: number;
  gameType: string;
  stakes: string;
  hourlyRate?: number;
}

const SAMPLE_SESSIONS: SessionRecord[] = [
  {
    id: 's1',
    date: new Date(2026, 2, 11),
    duration: 285,
    handsPlayed: 187,
    buyIn: 500,
    cashOut: 642,
    profitLoss: 142,
    gameType: '6-max NLH',
    stakes: '1/2',
    hourlyRate: 30,
  },
  {
    id: 's2',
    date: new Date(2026, 2, 10),
    duration: 165,
    handsPlayed: 98,
    buyIn: 300,
    cashOut: 245,
    profitLoss: -55,
    gameType: '9-max NLH',
    stakes: '0.5/1',
    hourlyRate: -20,
  },
  {
    id: 's3',
    date: new Date(2026, 2, 9),
    duration: 240,
    handsPlayed: 156,
    buyIn: 400,
    cashOut: 580,
    profitLoss: 180,
    gameType: '6-max NLH',
    stakes: '1/2',
    hourlyRate: 45,
  },
  {
    id: 's4',
    date: new Date(2026, 2, 8),
    duration: 320,
    handsPlayed: 215,
    buyIn: 600,
    cashOut: 672,
    profitLoss: 72,
    gameType: '9-max NLH',
    stakes: '1/2',
    hourlyRate: 13.5,
  },
  {
    id: 's5',
    date: new Date(2026, 2, 7),
    duration: 195,
    handsPlayed: 124,
    buyIn: 350,
    cashOut: 520,
    profitLoss: 170,
    gameType: '6-max NLH',
    stakes: '0.5/1',
    hourlyRate: 52.3,
  },
  {
    id: 's6',
    date: new Date(2026, 2, 6),
    duration: 140,
    handsPlayed: 82,
    buyIn: 250,
    cashOut: 195,
    profitLoss: -55,
    gameType: '9-max NLH',
    stakes: '0.5/1',
    hourlyRate: -23.6,
  },
];

type FilterGameType = 'all' | '6-max' | '9-max';

const SessionHistory: React.FC = () => {
  const [sessions, setSessions] = useState<SessionRecord[]>(SAMPLE_SESSIONS);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [filterGame, setFilterGame] = useState<FilterGameType>('all');
  const [visibleSessions, setVisibleSessions] = useState<Set<number>>(new Set());

  useEffect(() => {
    const sorted = [...SAMPLE_SESSIONS].sort((a, b) => b.date.getTime() - a.date.getTime());
    const filtered =
      filterGame === 'all'
        ? sorted
        : sorted.filter((s) => s.gameType.includes(filterGame === '6-max' ? '6-max' : '9-max'));
    setSessions(filtered);

    // Stagger animation
    filtered.forEach((_, i) => {
      setTimeout(() => {
        setVisibleSessions((prev) => new Set([...prev, i]));
      }, i * 60);
    });
  }, [filterGame]);

  const getTotalProfit = () => sessions.reduce((sum, s) => sum + s.profitLoss, 0);
  const getWinningSessions = () => sessions.filter((s) => s.profitLoss > 0).length;
  const getWinRate = () =>
    sessions.length > 0 ? ((getWinningSessions() / sessions.length) * 100).toFixed(1) : '0';
  const getAverageHourlyRate = () =>
    sessions.length > 0
      ? (sessions.reduce((sum, s) => sum + (s.hourlyRate || 0), 0) / sessions.length).toFixed(2)
      : '0';

  return (
    <div className="session-history">
      <div className="session-header">
        <h3>Session History</h3>
        <p className="session-subtitle">Last {sessions.length} sessions tracked</p>
      </div>

      {/* Summary Stats */}
      <div className="session-summary-stats">
        <div className="summary-stat">
          <span className="stat-label">Total P/L</span>
          <span
            className="stat-value"
            style={{ color: getTotalProfit() >= 0 ? '#10b981' : '#ef4444' }}
          >
            {getTotalProfit() > 0 ? '+' : ''}
            {getTotalProfit()}
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
            {parseFloat(getAverageHourlyRate()) > 0 ? '+' : ''}${getAverageHourlyRate()}/hr
          </span>
        </div>
      </div>

      {/* Filter */}
      <div className="session-filter">
        <button
          className={filterGame === 'all' ? 'active' : ''}
          onClick={() => setFilterGame('all')}
        >
          All Games
        </button>
        <button
          className={filterGame === '6-max' ? 'active' : ''}
          onClick={() => setFilterGame('6-max')}
        >
          6-Max
        </button>
        <button
          className={filterGame === '9-max' ? 'active' : ''}
          onClick={() => setFilterGame('9-max')}
        >
          9-Max
        </button>
      </div>

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
                    <span className="core-value">{formatTime(session.duration)}</span>
                  </div>
                  <div className="core-stat">
                    <span className="core-label">Hands</span>
                    <span className="core-value">{session.handsPlayed}</span>
                  </div>
                  <div className="core-stat">
                    <span className="core-label">Stakes</span>
                    <span className="core-value">{session.stakes}</span>
                  </div>
                </div>

                {/* P/L indicator */}
                <div className="session-result">
                  <div className="result-pl">
                    <span className="pl-sign">{session.profitLoss > 0 ? '+' : ''}</span>
                    <span className="pl-value">{session.profitLoss}</span>
                  </div>
                  <div className="result-hourly">
                    <span className="hourly-label">$/hr</span>
                    <span
                      className="hourly-value"
                      style={{ color: (session.hourlyRate || 0) >= 0 ? '#10b981' : '#ef4444' }}
                    >
                      {(session.hourlyRate || 0) > 0 ? '+' : ''}
                      {(session.hourlyRate || 0).toFixed(1)}
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
                      <span className="detail-label">Game Type</span>
                      <span className="detail-value">{session.gameType}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Buy-In</span>
                      <span className="detail-value">${session.buyIn}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Cash-Out</span>
                      <span className="detail-value">${session.cashOut}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Win Rate</span>
                      <span className="detail-value">
                        {(session.handsPlayed > 0
                          ? ((session.profitLoss / session.handsPlayed) * 100).toFixed(2)
                          : 0
                        ).toString()}
                        %
                      </span>
                    </div>
                  </div>

                  {/* Key hands placeholder */}
                  <div className="detail-section">
                    <span className="section-title">Notable Moments</span>
                    <p className="placeholder">Hand history details coming soon...</p>
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
          <p>No sessions found for selected filters</p>
        </div>
      )}
    </div>
  );
};

export default SessionHistory;
