/**
 * BankrollTracker — Cumulative cash P/L across the sessions in the page's
 * analysis window, with a moving average and drawdown.
 *
 * PURE PRESENTATION (2026-09-03). The page RPC derives sessions from the SAME
 * range-scoped hand rows every other panel uses, and the page passes them in.
 * This component used to carry:
 *   - a second `player_sessions` fetch that could never run (the parent always
 *     supplies an array), ordered ASCENDING with `.limit(90)` - the 90 OLDEST
 *     sessions, not the most recent;
 *   - its own 7D/30D/90D/All selector, defaulting to 30D, layered on top of
 *     the page's range - so "7 Days" on the page printed "Last 30 Days" here;
 *   - "Cumulative P/L" accumulated from BEFORE the selected sub-window, then
 *     labelled with the sub-window;
 *   - "Winning Days" / "Losing Days" that counted SESSIONS.
 * One range, the page's; every figure below is computed inside it; the
 * labels say what is counted.
 */

import React, { useMemo } from 'react';
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
import './BankrollTracker.css';

interface BankrollDataPoint {
  date: string;
  ts: number;
  bankroll: number;
  sessionProfit: number;
}

interface SessionRowLike {
  date?: string;
  profit_loss?: number;
}

interface BankrollTrackerProps {
  userId?: string;
  /** Range-scoped rows from the page RPC. */
  initialSessions?: SessionRowLike[] | null;
  /** The page's analysis window label, e.g. "7 Days" or "All". */
  rangeLabel?: string;
  /** Print mode: recharts entrance animation off. */
  still?: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function buildPoints(data: SessionRowLike[]): BankrollDataPoint[] {
  const dated = data
    .map((s) => {
      const d = s?.date ? new Date(s.date) : null;
      const ts = d && Number.isFinite(d.getTime()) ? d.getTime() : null;
      return { ts, pl: num(s?.profit_loss) };
    })
    .filter((s): s is { ts: number; pl: number } => s.ts !== null)
    .sort((a, b) => a.ts - b.ts);
  let cumulative = 0;
  return dated.map((s) => {
    cumulative += s.pl;
    return {
      date: new Date(s.ts).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
      ts: s.ts,
      bankroll: Math.round(cumulative * 100) / 100,
      sessionProfit: s.pl,
    };
  });
}

const BankrollTracker: React.FC<BankrollTrackerProps> = ({
  initialSessions,
  rangeLabel,
  still = false,
}) => {
  const chartData = useMemo(
    () => buildPoints(Array.isArray(initialSessions) ? initialSessions : []),
    [initialSessions]
  );

  const dataWithAverage = useMemo(() => {
    const windowSize = Math.min(7, chartData.length);
    return chartData.map((point, i) => {
      const start = Math.max(0, i - windowSize + 1);
      const slice = chartData.slice(start, i + 1);
      const avg = slice.reduce((sum, d) => sum + d.bankroll, 0) / slice.length;
      return { ...point, movingAvg: Math.round(avg * 100) / 100 };
    });
  }, [chartData]);

  const totalProfit = chartData.length > 0 ? chartData[chartData.length - 1].bankroll : 0;
  const peak = chartData.length > 0 ? Math.max(0, ...chartData.map((d) => d.bankroll)) : 0;
  const trough = chartData.length > 0 ? Math.min(0, ...chartData.map((d) => d.bankroll)) : 0;

  // Biggest drop from a running high, starting from zero (the window's start).
  const maxDrawdown = useMemo(() => {
    let peakVal = 0;
    let maxDd = 0;
    for (const point of chartData) {
      if (point.bankroll > peakVal) peakVal = point.bankroll;
      const dd = peakVal - point.bankroll;
      if (dd > maxDd) maxDd = dd;
    }
    return Math.round(maxDd * 100) / 100;
  }, [chartData]);

  const winningSessions = chartData.filter((d) => d.sessionProfit > 0).length;
  const losingSessions = chartData.filter((d) => d.sessionProfit < 0).length;

  const windowLabel = rangeLabel && rangeLabel !== 'All' ? `Last ${rangeLabel}` : 'All Time';
  const trendColor = totalProfit > 0 ? '#10b981' : totalProfit < 0 ? '#ef4444' : '#00d4ff';

  if (chartData.length === 0) {
    return (
      <div className="bankroll-tracker">
        <div className="bankroll-header">
          <h3>Bankroll Tracker</h3>
          <p className="bankroll-subtitle">No Cash Sessions To Chart ({windowLabel})</p>
        </div>
        <div className="bankroll-empty">
          <span className="bankroll-empty-label">Awaiting Session Ledger</span>
          <p>Play Some Cash Sessions And Your Bankroll Progression Will Appear Here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bankroll-tracker">
      <div className="bankroll-header">
        <h3>Bankroll Tracker</h3>
        <p className="bankroll-subtitle">
          Cumulative Cash Result Across {chartData.length.toLocaleString()} Sessions, {windowLabel}
        </p>
      </div>

      <div className="bankroll-display">
        <div className="bankroll-amount">
          <span className="amount-label">Cumulative P/L</span>
          <div className="amount-value" style={{ color: trendColor }}>
            <span className="amount-number">
              {totalProfit > 0 ? '+' : ''}
              {totalProfit.toLocaleString()}
            </span>
          </div>
          <span className="amount-period">{windowLabel}</span>
        </div>

        <div className="bankroll-change">
          <span className="change-label">Sessions</span>
          <div className="change-value">
            <span className="change-amount">{chartData.length.toLocaleString()}</span>
          </div>
          <span className="change-pct">
            {winningSessions} Up / {losingSessions} Down
          </span>
        </div>
      </div>

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
            <XAxis
              dataKey="date"
              stroke={still ? '#374151' : 'rgba(255,255,255,0.5)'}
              fontSize={11}
            />
            <YAxis stroke={still ? '#374151' : 'rgba(255,255,255,0.5)'} fontSize={11} />
            <Tooltip
              contentStyle={{
                background: 'rgba(14, 14, 28, 0.95)',
                border: '1px solid rgba(0, 212, 255, 0.2)',
                borderRadius: '2px',
              }}
              labelStyle={{ color: '#fff' }}
              formatter={(value, name) => {
                if (name === 'Bankroll') return [Number(value).toLocaleString(), 'Cumulative P/L'];
                if (name === '7 Session Average')
                  return [Number(value).toLocaleString(), '7 Session Avg'];
                return [String(value), String(name)];
              }}
            />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
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
              isAnimationActive={!still}
            />
            <Line
              type="monotone"
              dataKey="movingAvg"
              stroke="rgba(0, 212, 255, 0.5)"
              strokeWidth={1}
              strokeDasharray="4 4"
              dot={false}
              name="7 Session Average"
              isAnimationActive={!still}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="bankroll-stats">
        <div className="stats-grid">
          <div className="stat-card stat-card--peak">
            <div className="stat-content">
              <span className="stat-label">Window High</span>
              <span className="stat-value">{peak.toLocaleString()}</span>
            </div>
          </div>
          <div className="stat-card stat-card--trough">
            <div className="stat-content">
              <span className="stat-label">Window Low</span>
              <span className="stat-value">{trough.toLocaleString()}</span>
            </div>
          </div>
          <div className="stat-card stat-card--drawdown">
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
          <div className="stat-card stat-card--total">
            <div className="stat-content">
              <span className="stat-label">Window P/L</span>
              <span className="stat-value" style={{ color: trendColor }}>
                {totalProfit > 0 ? '+' : ''}
                {totalProfit.toLocaleString()}
              </span>
            </div>
          </div>
          <div className="stat-card stat-card--winning">
            <div className="stat-content">
              <span className="stat-label">Winning Sessions</span>
              <span className="stat-value" style={{ color: '#10b981' }}>
                {winningSessions}
              </span>
            </div>
          </div>
          <div className="stat-card stat-card--losing">
            <div className="stat-content">
              <span className="stat-label">Losing Sessions</span>
              <span className="stat-value" style={{ color: '#ef4444' }}>
                {losingSessions}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BankrollTracker;
