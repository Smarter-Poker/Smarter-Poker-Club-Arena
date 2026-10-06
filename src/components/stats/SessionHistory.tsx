/**
 * SessionHistory — Timeline of cash sessions with P/L tracking.
 *
 * PURE PRESENTATION (2026-09-03). The page RPC (ca_player_stats_overview_v2)
 * derives sessions from the SAME range-scoped hand rows every other panel
 * uses, and the page passes them in. This component used to carry a second
 * `player_sessions` fetch, a localStorage cache and two bus listeners that
 * could never run (the parent always supplies an array), plus its own
 * 7d/30d/All pills layered ON TOP of the page's range - so "7 Days" on the
 * page and "30 Days" here printed "(Last 30 Days)" over seven days of data.
 * One range, the page's, and the label says which.
 *
 * Amounts are club chips, not dollars - the old "$/Hr" label was wrong.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { compactChips } from '../../utils/format';
import './SessionHistory.css';

interface SessionRecord {
  id: string;
  date: Date | null;
  duration: number; // minutes
  handsPlayed: number;
  buyIn: number;
  cashOut: number;
  profitLoss: number;
  hourlyRate: number;
}

interface SessionRowLike {
  id?: string | number;
  date?: string;
  duration_minutes?: number;
  hands_played?: number;
  buy_in?: number;
  cash_out?: number;
  profit_loss?: number;
}

interface SessionHistoryProps {
  userId?: string;
  /** Range-scoped rows from the page RPC. */
  initialSessions?: SessionRowLike[] | null;
  /** The page's analysis window label, e.g. "7 Days" or "All". */
  rangeLabel?: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function mapSessions(data: SessionRowLike[]): SessionRecord[] {
  const mapped = data.map((s, i) => {
    const d = s?.date ? new Date(s.date) : null;
    const date = d && Number.isFinite(d.getTime()) ? d : null;
    const dur = num(s?.duration_minutes);
    const pl = num(s?.profit_loss);
    return {
      id: String(s?.id ?? `session-${i}`),
      date,
      duration: dur,
      handsPlayed: num(s?.hands_played),
      buyIn: num(s?.buy_in),
      cashOut: num(s?.cash_out),
      profitLoss: pl,
      hourlyRate: dur > 0 ? (pl / dur) * 60 : 0,
    };
  });
  // Newest first. The streak and the timeline both assume descending order;
  // a row with no usable date sorts to the end rather than poisoning the sort.
  return mapped.sort((a, b) => (b.date?.getTime() ?? -1) - (a.date?.getTime() ?? -1));
}

const sign = (n: number) => (n > 0 ? '+' : '');
const tone = (n: number) => (n > 0 ? '#10b981' : n < 0 ? '#ef4444' : 'rgba(255,255,255,0.7)');

const SessionHistory: React.FC<SessionHistoryProps> = ({ initialSessions, rangeLabel }) => {
  const sessions = useMemo(
    () => mapSessions(Array.isArray(initialSessions) ? initialSessions : []),
    [initialSessions]
  );
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [visibleSessions, setVisibleSessions] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    setVisibleSessions(new Set());
    setExpandedSession(null);
    for (let i = 0; i < sessions.length; i++) {
      const timer = setTimeout(() => {
        setVisibleSessions((prev) => new Set([...prev, i]));
      }, i * 60);
      staggerTimersRef.current.push(timer);
    }
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, [sessions]);

  // ── Streak calculation ──
  const streak = useMemo(() => {
    // Break-even sessions are neutral: they used to extend a losing streak and
    // break a winning one, because `profitLoss > 0` collapsed 0 into "loss".
    const decided = sessions.filter((s) => s.profitLoss !== 0);
    if (decided.length === 0) return { count: 0, type: 'none' as const };
    const isWin = decided[0].profitLoss > 0;
    let count = 0;
    for (const s of decided) {
      if (s.profitLoss > 0 === isWin) count++;
      else break;
    }
    return { count, type: isWin ? ('winning' as const) : ('losing' as const) };
  }, [sessions]);

  const totalProfit = sessions.reduce((sum, s) => sum + s.profitLoss, 0);
  const winningSessions = sessions.filter((s) => s.profitLoss > 0).length;
  const winRate =
    sessions.length > 0 ? ((winningSessions / sessions.length) * 100).toFixed(1) : '0';
  // Time-weighted, not a mean of per-session rates: a 5-minute +50 heater used
  // to count as much as an 8-hour grind and dominated the average.
  const totalMinutes = sessions.reduce((sum, s) => sum + s.duration, 0);
  const avgHourly = totalMinutes > 0 ? (totalProfit / totalMinutes) * 60 : 0;

  const formatDuration = (minutes: number): string => {
    if (minutes < 60) return `${minutes}m`;
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  };

  const windowText = rangeLabel && rangeLabel !== 'All' ? ` (Last ${rangeLabel})` : '';

  return (
    <div className="session-history">
      <div className="session-header">
        <h3>Hand-Derived Sessions</h3>
        <p className="session-subtitle">
          {sessions.length > 0
            ? `${sessions.length.toLocaleString()} Hand Groups${windowText}`
            : `No Hand Groups${windowText}`}
        </p>
      </div>

      <div className="stats-notice" role="status">
        Coverage: Cash Hands Separated By Forty-Five Minutes Form A Hand Group. These Are Not
        Cashier Sessions And Do Not Supply Actual Buy-Ins, Rebuys, Or Cash-Outs.
      </div>

      {sessions.length > 0 && (
        <div className="session-summary-stats">
          <div className="summary-stat">
            <span className="stat-label">Total P/L</span>
            <span className="stat-value" style={{ color: tone(totalProfit) }}>
              {sign(totalProfit)}
              {compactChips(totalProfit)}
            </span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Winning Sessions</span>
            <span className="stat-value">{winRate}%</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Chips/Hr</span>
            <span className="stat-value" style={{ color: tone(avgHourly) }}>
              {sign(avgHourly)}
              {compactChips(avgHourly)}
            </span>
          </div>
          {streak.count >= 2 && (
            <div className="summary-stat">
              <span className="stat-label">Streak</span>
              <span
                className="stat-value"
                style={{
                  color: streak.type === 'winning' ? '#10b981' : '#ef4444',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {streak.type === 'winning' ? 'W' : 'L'} {streak.count}
              </span>
            </div>
          )}
        </div>
      )}

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
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              onClick={() => setExpandedSession(isExpanded ? null : session.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setExpandedSession(isExpanded ? null : session.id);
                }
              }}
            >
              <div className="session-main">
                <div className="session-date">
                  <span className="date-day">{session.date ? session.date.getDate() : '-'}</span>
                  <span className="date-month">
                    {session.date
                      ? session.date.toLocaleDateString('en-US', { month: 'short' })
                      : ''}
                  </span>
                </div>

                <div className="session-core">
                  <div className="core-stat">
                    <span className="core-label">Duration</span>
                    <span className="core-value">{formatDuration(session.duration)}</span>
                  </div>
                  <div className="core-stat">
                    <span className="core-label">Hands</span>
                    <span className="core-value">{session.handsPlayed.toLocaleString()}</span>
                  </div>
                </div>

                <div className="session-result">
                  <div className="result-pl">
                    <span className="pl-sign">{sign(session.profitLoss)}</span>
                    <span className="pl-value">{compactChips(session.profitLoss)}</span>
                  </div>
                  <div className="result-hourly">
                    <span className="hourly-label">Chips/Hr</span>
                    <span className="hourly-value" style={{ color: tone(session.hourlyRate) }}>
                      {sign(session.hourlyRate)}
                      {compactChips(session.hourlyRate)}
                    </span>
                  </div>
                </div>

                <div className="session-expand">
                  <span>{isExpanded ? 'Hide Details' : 'Show Details'}</span>
                </div>
              </div>

              {isExpanded && (
                <div
                  className="session-details"
                  style={{
                    animation: 'animationsSlideDown 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <div className="details-grid">
                    <div className="detail-item">
                      <span className="detail-label">Chips Invested In Hands</span>
                      <span className="detail-value">{compactChips(session.buyIn)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Returned From Hands</span>
                      <span className="detail-value">{compactChips(session.cashOut)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">P/L Per Hand</span>
                      <span className="detail-value">
                        {session.handsPlayed > 0
                          ? compactChips(session.profitLoss / session.handsPlayed)
                          : '0'}
                      </span>
                    </div>
                  </div>
                  <p className="stats-evidence-unavailable">
                    Hand Evidence Unavailable For This Aggregated Session
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {sessions.length === 0 && (
        <div className="session-empty">
          <span className="session-empty-label">No Hand-Derived Sessions</span>
          <p>
            {rangeLabel && rangeLabel !== 'All'
              ? `No Cash Hand Groups In The Last ${rangeLabel}.`
              : 'No Cash Hand Groups Were Recorded Yet.'}
          </p>
        </div>
      )}
    </div>
  );
};

export default SessionHistory;
