/**
 * BankrollTracker — Visual bankroll progression over time
 * Wired to real Supabase `player_sessions` data with bus listeners
 *
 * Accepts optional `userId` prop — uses it if provided, otherwise falls back to getAuthUser()
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

interface BankrollDataPoint {
  date: string;
  bankroll: number;
  dayProfit: number;
}

type PeriodFilter = '7d' | '30d' | '90d' | 'all';

interface BankrollTrackerProps {
  userId?: string;
}

const BankrollTracker: React.FC<BankrollTrackerProps> = ({ userId }) => {
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
    } catch {
      return null;
    }
  }, [userId]);

  const loadBankrollData = useCallback(async () => {
    try {
      const uid = await resolveUserId();
      if (!uid || !mountedRef.current) return;

      const { data, error } = await supabase
        .from('player_sessions')
        .select('date, profit_loss')
        .eq('user_id', uid)
        .order('date', { ascending: true })
        .limit(90);

      if (!mountedRef.current) return;

      if (error) {
        console.error('[BankrollTracker] Query error:', error.message);
        setLoaded(true);
        return;
      }

      if (data && data.length > 0) {
        // Build cumulative bankroll from session P/L
        let cumulative = 0;
        const points: BankrollDataPoint[] = data.map((s) => {
          const pl = s.profit_loss || 0;
          cumulative += pl;
          return {
            date: new Date(s.date).toLocaleDateString('en-US', {
              month: 'numeric',
              day: 'numeric',
            }),
            bankroll: cumulative,
            dayProfit: pl,
          };
        });
        setAllData(points);
      } else {
        setAllData([]);
      }

      setLoaded(true);
    } catch (err) {
      console.error('[BankrollTracker] Failed to load:', err);
      if (mountedRef.current) setLoaded(true);
    }
  }, [resolveUserId]);

  useEffect(() => {
    loadBankrollData();
  }, [loadBankrollData]);

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
    return allData.slice(-days);
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
  const previous = chartData.length > 0 ? chartData[0].bankroll : 0;
  const peak = chartData.length > 0 ? Math.max(...chartData.map((d) => d.bankroll)) : 0;
  const trough = chartData.length > 0 ? Math.min(...chartData.map((d) => d.bankroll)) : 0;
  const totalProfit = current - previous;

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

  // Safe percentage calculation — guards against division by zero (BUG-4 fix)
  const getChangePercent = (): string => {
    if (previous === 0) return totalProfit === 0 ? '0.0' : totalProfit > 0 ? '+∞' : '-∞';
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
          <p className="bankroll-subtitle">No session data to chart yet</p>
        </div>
        <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'rgba(255,255,255,0.5)' }}>
          <span style={{ fontSize: '2rem' }}>📈</span>
          <p style={{ marginTop: '0.5rem' }}>
            Play some sessions and your bankroll progression will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bankroll-tracker">
      <div className="bankroll-header">
        <h3>Bankroll Tracker</h3>
        <p className="bankroll-subtitle">Track your bankroll progression over time</p>
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
          <span className="change-pct">{getChangePercent()}%</span>
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
          <div className="stat-card">
            <div className="stat-icon swing">◆</div>
            <div className="stat-content">
              <span className="stat-label">Swing Range</span>
              <span className="stat-value">{(peak - trough).toLocaleString()}</span>
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
        </div>
      </div>
    </div>
  );
};

export default BankrollTracker;
