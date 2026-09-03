/**
 * SessionHistory — Timeline of poker sessions with P/L tracking
 * Wired to real Supabase `player_sessions` table with bus listeners
 *
 * Enhancements:
 *  - Optional `initialSessions` prop to skip redundant fetch (dedup from parent)
 *  - localStorage SWR cache for instant render
 *  - Winning/losing streak indicator
 *  - Date range filter (7d / 30d / All)
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, getAuthUser } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './SessionHistory.css';
import { reportError } from '../../utils/errorReporter';

// ── SWR cache ──
const CACHE_KEY = 'sess_hist_v1_';
const CACHE_TTL = 10 * 60 * 1000;

function getCached(uid: string) {
  try {
    const raw = localStorage.getItem(CACHE_KEY + uid);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p.ts && Date.now() - p.ts > CACHE_TTL) return null;
    return p.data;
  } catch {
    return null;
  }
}
function setCache(uid: string, data: any) {
  try {
    localStorage.setItem(CACHE_KEY + uid, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    /* quota */
  }
}

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

type DateRange = '7d' | '30d' | 'all';

interface SessionHistoryProps {
  userId?: string;
  initialSessions?: any[]; // Pre-fetched from parent (dedup)
}

const SessionHistory: React.FC<SessionHistoryProps> = ({ userId, initialSessions }) => {
  const [allSessions, setAllSessions] = useState<SessionRecord[]>([]);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [visibleSessions, setVisibleSessions] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const mountedRef = useRef(true);
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = [];
    };
  }, []);

  const resolveUserId = useCallback(async (): Promise<string | null> => {
    if (userId) return userId;
    try {
      const { data: userResp } = await getAuthUser();
      return userResp.user?.id || null;
    } catch (e) {
      reportError(e, 'SessionHistory.useCallback');
      return null;
    }
  }, [userId]);

  // Map raw session data to SessionRecord
  const mapSessions = (data: any[]): SessionRecord[] => {
    // Newest first. The streak and the timeline both assume descending order,
    // and the parent-supplied array bypasses this component's own .order().
    const sorted = [...data].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    return sorted.map((s) => {
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
  };

  // If parent passes initialSessions, use them (dedup)
  useEffect(() => {
    if (initialSessions && initialSessions.length > 0) {
      const mapped = mapSessions(initialSessions);
      setAllSessions(mapped);
      setLoaded(true);
      triggerStagger(mapped.length);
    } else if (initialSessions && initialSessions.length === 0) {
      setAllSessions([]);
      setLoaded(true);
    }
  }, [initialSessions]);

  const triggerStagger = (count: number) => {
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    setVisibleSessions(new Set());
    for (let i = 0; i < count; i++) {
      const timer = setTimeout(() => {
        if (mountedRef.current) {
          setVisibleSessions((prev) => new Set([...prev, i]));
        }
      }, i * 60);
      staggerTimersRef.current.push(timer);
    }
  };

  const loadSessions = useCallback(async () => {
    if (initialSessions) return; // Parent provided data, skip fetch

    try {
      const uid = await resolveUserId();
      if (!uid || !mountedRef.current) return;

      // SWR: show cached instantly
      const cached = getCached(uid);
      if (cached && !loaded) {
        const mapped = mapSessions(cached);
        setAllSessions(mapped);
        setLoaded(true);
        triggerStagger(mapped.length);
      }

      const { data, error } = await supabase
        .from('player_sessions')
        .select('id, date, duration_minutes, hands_played, buy_in, cash_out, profit_loss')
        .eq('user_id', uid)
        .order('date', { ascending: false })
        .limit(50);

      if (!mountedRef.current) return;

      if (error) {
        reportError(error, 'SessionHistory.Query_error');
        setLoaded(true);
        return;
      }

      if (data && data.length > 0) {
        setCache(uid, data);
        const mapped = mapSessions(data);
        setAllSessions(mapped);
        triggerStagger(mapped.length);
      } else {
        setAllSessions([]);
      }

      setLoaded(true);
    } catch (err) {
      reportError(err, 'SessionHistory.Failed_to_load');
      if (mountedRef.current) setLoaded(true);
    }
  }, [resolveUserId, initialSessions, loaded]);

  useEffect(() => {
    if (!initialSessions) loadSessions();
  }, [loadSessions, initialSessions]);

  // Bus listeners
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

  // Filter by date range
  const sessions = useMemo(() => {
    if (dateRange === 'all') return allSessions;
    const now = new Date();
    const days = dateRange === '7d' ? 7 : 30;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return allSessions.filter((s) => s.date >= cutoff);
  }, [allSessions, dateRange]);

  // ── Streak calculation ──
  const streak = useMemo(() => {
    // Break-even sessions are neutral: they used to extend a losing streak and
    // break a winning one, because `profitLoss > 0` collapsed 0 into "loss".
    const decided = sessions.filter((s) => s.profitLoss !== 0);
    if (decided.length === 0) return { count: 0, type: 'none' as const };
    const isWin = decided[0].profitLoss > 0;
    let count = 0;
    for (const s of decided) {
      if (s.profitLoss > 0 === isWin) {
        count++;
      } else {
        break;
      }
    }
    return { count, type: isWin ? ('winning' as const) : ('losing' as const) };
  }, [sessions]);

  const getTotalProfit = () => sessions.reduce((sum, s) => sum + s.profitLoss, 0);
  const getWinningSessions = () => sessions.filter((s) => s.profitLoss > 0).length;
  const getWinRate = () =>
    sessions.length > 0 ? ((getWinningSessions() / sessions.length) * 100).toFixed(1) : '0';
  // Time-weighted, not a mean of per-session rates: a 5-minute +50 heater used
  // to count as much as an 8-hour grind and dominated the average.
  const getAverageHourlyRate = () => {
    const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    if (totalMinutes <= 0) return '0';
    return ((getTotalProfit() / totalMinutes) * 60).toFixed(2);
  };

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
          <p className="session-subtitle">Loading Sessions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="session-history">
      <div className="session-header">
        <h3>Session History</h3>
        <p className="session-subtitle">
          {allSessions.length > 0
            ? `${sessions.length} Sessions${dateRange !== 'all' ? ` (${dateRange === '7d' ? 'Last 7 Days' : 'Last 30 Days'})` : ''}`
            : 'No Sessions Yet'}
        </p>
      </div>

      {/* Date range filter */}
      {allSessions.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '6px',
            marginBottom: '12px',
          }}
        >
          {(['7d', '30d', 'all'] as DateRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setDateRange(range)}
              style={{
                padding: '5px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 600,
                border: `1px solid ${dateRange === range ? 'rgba(0, 212, 255, 0.4)' : 'rgba(255,255,255,0.08)'}`,
                background:
                  dateRange === range ? 'rgba(0, 212, 255, 0.12)' : 'rgba(255,255,255,0.03)',
                color: dateRange === range ? '#00d4ff' : 'rgba(255,255,255,0.5)',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {range === '7d' ? '7 Days' : range === '30d' ? '30 Days' : 'All'}
            </button>
          ))}
        </div>
      )}

      {/* Summary Stats + Streak */}
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
            <span className="stat-label">Avg $/Hr</span>
            <span
              className="stat-value"
              style={{ color: parseFloat(getAverageHourlyRate()) >= 0 ? '#10b981' : '#ef4444' }}
            >
              {parseFloat(getAverageHourlyRate()) > 0 ? '+' : ''}
              {getAverageHourlyRate()}
            </span>
          </div>
          {/* Streak badge */}
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
                    <span className="hourly-label">$/Hr</span>
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
                    animation: 'animationsSlideDown 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
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
                      <span className="detail-label">P/L Per Hand</span>
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
          <span className="empty-icon">--</span>
          <p>
            {allSessions.length > 0
              ? 'No Sessions In This Date Range'
              : 'No Sessions Recorded Yet. Play Some Hands To Start Tracking!'}
          </p>
        </div>
      )}
    </div>
  );
};

export default SessionHistory;
