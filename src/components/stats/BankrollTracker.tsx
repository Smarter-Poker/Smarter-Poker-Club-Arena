/**
 * BankrollTracker — Visual bankroll progression over time
 * Wired to real Supabase `player_sessions` data with bus listeners
 *
 * Enhancements:
 *  - Optional `initialSessions` prop to skip redundant fetch (dedup from parent)
 *  - localStorage SWR cache for instant render
 *  - Max drawdown metric (biggest drop from peak)
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { supabase, getAuthUser } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './BankrollTracker.css';
import { reportError } from '../../utils/errorReporter';

// ── SWR cache ──
const CACHE_KEY = 'bankroll_v1_';
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

interface BankrollDataPoint {
  date: string;
  /** Epoch ms of the session, so the period filter can use a real time window. */
  ts?: number;
  bankroll: number;
  dayProfit: number;
}

type PeriodFilter = '7d' | '30d' | '90d' | 'all';

interface BankrollTrackerProps {
  userId?: string;
  initialSessions?: any[]; // Pre-fetched session data from parent (dedup)
}

const BankrollTracker: React.FC<BankrollTrackerProps> = ({ userId, initialSessions }) => {
  const [allData, setAllData] = useState<BankrollDataPoint[]>([]);
  const [period, setPeriod] = useState<PeriodFilter>('30d');
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolveUserId = useCallback(async (): Promise<string | null> => {
    if (userId) return userId;
    try {
      const { data: userResp } = await getAuthUser();
      return userResp.user?.id || null;
    } catch (e) {
      reportError(e, 'BankrollTracker.useCallback');
      return null;
    }
  }, [userId]);

  // Build bankroll points from raw session data
  const buildPoints = (data: any[]): BankrollDataPoint[] => {
    // Sort ascending by date for cumulative calculation
    const sorted = [...data].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    let cumulative = 0;
    return sorted.map((s) => {
      const pl = s.profit_loss || 0;
      cumulative += pl;
      return {
        date: new Date(s.date).toLocaleDateString('en-US', {
          month: 'numeric',
          day: 'numeric',
        }),
        // Kept so the period filter can select an actual time window rather
        // than a count of entries.
        ts: new Date(s.date).getTime(),
        bankroll: cumulative,
        dayProfit: pl,
      };
    });
  };

  // If parent passes initialSessions, use them (dedup)
  useEffect(() => {
    if (initialSessions && initialSessions.length > 0) {
      setAllData(buildPoints(initialSessions));
      setLoaded(true);
    } else if (initialSessions && initialSessions.length === 0) {
      setAllData([]);
      setLoaded(true);
    }
  }, [initialSessions]);

  const loadBankrollData = useCallback(async () => {
    if (initialSessions) return; // Parent provided data

    try {
      const uid = await resolveUserId();
      if (!uid || !mountedRef.current) return;

      // SWR: show cached instantly
      const cached = getCached(uid);
      if (cached && !loaded) {
        setAllData(buildPoints(cached));
        setLoaded(true);
      }

      const { data, error } = await supabase
        .from('player_sessions')
        .select('date, profit_loss')
        .eq('user_id', uid)
        .order('date', { ascending: true })
        .limit(90);

      if (!mountedRef.current) return;

      if (error) {
        reportError(error, 'BankrollTracker.Query_error');
        setLoaded(true);
        return;
      }

      if (data && data.length > 0) {
        setCache(uid, data);
        setAllData(buildPoints(data));
      } else {
        setAllData([]);
      }

      setLoaded(true);
    } catch (err) {
      reportError(err, 'BankrollTracker.Failed_to_load');
      if (mountedRef.current) setLoaded(true);
    }
  }, [resolveUserId, initialSessions, loaded]);

  useEffect(() => {
    if (!initialSessions) loadBankrollData();
  }, [loadBankrollData, initialSessions]);

  // Bus listeners
  useEffect(() => {
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => loadBankrollData(),
      3000
    );
    const unsubCashout = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => loadBankrollData(),
      2000
    );
    return () => {
      unsubHand();
      unsubCashout();
    };
  }, [loadBankrollData]);

  // Filter data by period
  const chartData = useMemo(() => {
    if (allData.length === 0) return [];
    if (period === 'all') return allData;
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    // Filter by TIME, not by entry count. Each point is one session, so the old
    // slice(-days) meant "last N sessions" — for a weekend player "Last 7 Days"
    // could span months, and every stat below inherited that wrong window.
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const windowed = allData.filter((d) => typeof d.ts !== 'number' || d.ts >= cutoff);
    return windowed.length > 0 ? windowed : [];
  }, [allData, period]);

  // Calculate moving average
  const dataWithAverage = useMemo(() => {
    const windowSize = Math.min(7, chartData.length);
    return chartData.map((point, i) => {
      const start = Math.max(0, i - windowSize + 1);
      const slice = chartData.slice(start, i + 1);
      const avg = slice.reduce((sum, d) => sum + d.bankroll, 0) / slice.length;
      return { ...point, movingAvg: avg };
    });
  }, [chartData]);

  // Statistics
  const current = chartData.length > 0 ? chartData[chartData.length - 1].bankroll : 0;
  // Baseline is the bankroll BEFORE the first point in the window; using the
  // point itself silently dropped that session's P/L from "Period P/L".
  const previous = chartData.length > 0 ? chartData[0].bankroll - chartData[0].dayProfit : 0;
  const peak = chartData.length > 0 ? Math.max(...chartData.map((d) => d.bankroll)) : 0;
  const trough = chartData.length > 0 ? Math.min(...chartData.map((d) => d.bankroll)) : 0;
  const totalProfit = current - previous;

  // ── Max drawdown calculation ──
  const maxDrawdown = useMemo(() => {
    if (chartData.length < 2) return 0;
    let peakVal = chartData[0].bankroll;
    let maxDd = 0;
    for (const point of chartData) {
      if (point.bankroll > peakVal) peakVal = point.bankroll;
      const dd = peakVal - point.bankroll;
      if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
  }, [chartData]);

  // Winning/losing day count
  const winningDays = useMemo(() => chartData.filter((d) => d.dayProfit > 0).length, [chartData]);
  const losingDays = useMemo(() => chartData.filter((d) => d.dayProfit < 0).length, [chartData]);

  const getPeriodLabel = () => {
    switch (period) {
      case '7d':
        return 'Last 7 Days';
      case '30d':
        return 'Last 30 Days';
      case '90d':
        return 'Last 90 Days';
      case 'all':
        return 'All Time';
      default:
        return 'Last 30 Days';
    }
  };

  const getTrendColor = () => {
    if (totalProfit > 0) return '#10b981';
    if (totalProfit < 0) return '#ef4444';
    return '#00d4ff';
  };

  const getChangePercent = (): string => {
    // No baseline to divide by — render a dash instead of a literal infinity.
    if (previous === 0) return '--';
    return (((current - previous) / Math.abs(previous)) * 100).toFixed(1);
  };

  if (!loaded) {
    return (
      <div className="bankroll-tracker">
        <div className="bankroll-header">
          <h3>Bankroll Tracker</h3>
          <p className="bankroll-subtitle">Loading...</p>
        </div>
      </div>
    );
  }

  if (allData.length === 0) {
    return (
      <div className="bankroll-tracker">
        <div className="bankroll-header">
          <h3>Bankroll Tracker</h3>
          <p className="bankroll-subtitle">No Session Data To Chart Yet</p>
        </div>
        <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'rgba(255,255,255,0.5)' }}>
          <span style={{ fontSize: '2rem' }}>--</span>
          <p style={{ marginTop: '0.5rem' }}>
            Play Some Sessions And Your Bankroll Progression Will Appear Here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bankroll-tracker">
      <div className="bankroll-header">
        <h3>Bankroll Tracker</h3>
        <p className="bankroll-subtitle">Track Your Bankroll Progression Over Time</p>
      </div>

      {/* Period selector */}
      <div className="bankroll-periods">
        {(['7d', '30d', '90d', 'all'] as PeriodFilter[]).map((p) => (
          <button key={p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>
            {p === '7d' ? '7D' : p === '30d' ? '30D' : p === '90d' ? '90D' : 'All'}
          </button>
        ))}
      </div>

      {/* Current bankroll display */}
      <div className="bankroll-display">
        <div className="bankroll-amount">
          <span className="amount-label">Cumulative P/L</span>
          <div className="amount-value" style={{ color: getTrendColor() }}>
            <span className="amount-number">
              {current >= 0 ? '+' : ''}
              {current.toLocaleString()}
            </span>
          </div>
          <span className="amount-period">{getPeriodLabel()}</span>
        </div>

        <div className="bankroll-change">
          <span className="change-label">Period Change</span>
          <div className="change-value" style={{ color: getTrendColor() }}>
            <span className="change-sign">{totalProfit > 0 ? '+' : ''}</span>
            <span className="change-amount">{totalProfit.toLocaleString()}</span>
          </div>
          <span className="change-pct">
            {getChangePercent()}
            {getChangePercent() === '--' ? '' : '%'}
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="bankroll-chart-container">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={dataWithAverage}>
            <defs>
              <linearGradient id="bankrollGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00d4ff" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#00d4ff" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
            <XAxis dataKey="date" stroke="rgba(255,255,255,0.5)" fontSize={11} />
            <YAxis stroke="rgba(255,255,255,0.5)" fontSize={11} />
            <Tooltip
              contentStyle={{
                background: 'rgba(14, 14, 28, 0.95)',
                border: '1px solid rgba(0, 212, 255, 0.2)',
                borderRadius: '8px',
                backdropFilter: 'blur(16px)',
              }}
              labelStyle={{ color: '#fff' }}
              formatter={(value, name) => {
                if (name === 'bankroll') return [Number(value).toLocaleString(), 'Cumulative P/L'];
                if (name === 'movingAvg') return [Number(value).toLocaleString(), '7d Avg'];
                return [value, name];
              }}
            />
            {peak > 0 && (
              <ReferenceLine y={peak} stroke="rgba(16, 185, 129, 0.3)" strokeDasharray="5 5" />
            )}
            {trough < 0 && (
              <ReferenceLine y={trough} stroke="rgba(239, 68, 68, 0.3)" strokeDasharray="5 5" />
            )}
            <Line
              type="monotone"
              dataKey="bankroll"
              stroke="#00d4ff"
              strokeWidth={2}
              dot={false}
              name="Bankroll"
            />
            <Line
              type="monotone"
              dataKey="movingAvg"
              stroke="rgba(0, 212, 255, 0.5)"
              strokeWidth={1}
              strokeDasharray="4 4"
              dot={false}
              name="7d Average"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Stats */}
      <div className="bankroll-stats">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon peak">▲</div>
            <div className="stat-content">
              <span className="stat-label">Period High</span>
              <span className="stat-value">{peak.toLocaleString()}</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon trough">▼</div>
            <div className="stat-content">
              <span className="stat-label">Period Low</span>
              <span className="stat-value">{trough.toLocaleString()}</span>
            </div>
          </div>
          {/* Max Drawdown — Enhancement #5 */}
          <div className="stat-card">
            <div className="stat-icon" style={{ color: '#ef4444' }}>
              --
            </div>
            <div className="stat-content">
              <span className="stat-label">Max Drawdown</span>
              <span
                className="stat-value"
                style={{ color: maxDrawdown > 0 ? '#ef4444' : '#8a9aaa' }}
              >
                {maxDrawdown > 0 ? `-${maxDrawdown.toLocaleString()}` : '0'}
              </span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon total">▪</div>
            <div className="stat-content">
              <span className="stat-label">Period P/L</span>
              <span
                className="stat-value"
                style={{ color: totalProfit >= 0 ? '#10b981' : '#ef4444' }}
              >
                {totalProfit > 0 ? '+' : ''}
                {totalProfit.toLocaleString()}
              </span>
            </div>
          </div>
          {/* Win/Loss day count */}
          <div className="stat-card">
            <div className="stat-icon" style={{ color: '#10b981' }}>
              ✓
            </div>
            <div className="stat-content">
              <span className="stat-label">Winning Days</span>
              <span className="stat-value" style={{ color: '#10b981' }}>
                {winningDays}
              </span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon" style={{ color: '#ef4444' }}>
              ✗
            </div>
            <div className="stat-content">
              <span className="stat-label">Losing Days</span>
              <span className="stat-value" style={{ color: '#ef4444' }}>
                {losingDays}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BankrollTracker;
