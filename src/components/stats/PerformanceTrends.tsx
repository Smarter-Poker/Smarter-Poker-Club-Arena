/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PERFORMANCE TRENDS — 7d/30d/90d Profit Line Chart
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays cumulative profit/loss over time using session_history data.
 * Pure SVG rendering — no chart library dependency.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './PerformanceTrends.css';

interface PerformanceTrendsProps {
  userId: string;
}

type TimeRange = '7d' | '30d' | '90d';

interface SessionRecord {
  ended_at: string;
  profit_loss: number;
  hands_played: number;
  big_blind: number;
}

export default function PerformanceTrends({ userId }: PerformanceTrendsProps) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [range, setRange] = useState<TimeRange>('30d');
  const [loading, setLoading] = useState(true);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    loadSessions();
  }, [userId, range]);

  // Bus listeners for live updates
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('HAND_COMPLETED', () => loadSessions(), 2000),
      masterBus.subscribeDebounced('SESSION_ENDED', () => loadSessions(), 1000),
      masterBus.subscribeDebounced('DATA_MUTATED', () => loadSessions(), 3000),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const loadSessions = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    try {
      const { data, error } = await supabase
        .from('session_history')
        .select('ended_at, profit_loss, hands_played, big_blind')
        .eq('user_id', userId)
        .gte('ended_at', since)
        .order('ended_at', { ascending: true })
        .limit(500);

      if (error) {
        console.warn('[PerformanceTrends] Fetch error:', error.message);
        if (isMounted.current) setSessions([]);
      } else {
        if (isMounted.current) setSessions(data || []);
      }
    } catch (err) {
      console.error('[PerformanceTrends] Error:', err);
      if (isMounted.current) setSessions([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [userId, range]);

  // Build cumulative P&L data
  const chartData = useMemo(() => {
    if (sessions.length === 0)
      return { points: [], min: 0, max: 0, total: 0, sessionCount: 0, handsTotal: 0 };

    let cumulative = 0;
    const points = sessions.map((s) => {
      cumulative += s.profit_loss;
      return { date: new Date(s.ended_at), value: cumulative, hands: s.hands_played };
    });

    const values = points.map((p) => p.value);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const handsTotal = sessions.reduce((s, r) => s + r.hands_played, 0);

    return { points, min, max, total: cumulative, sessionCount: sessions.length, handsTotal };
  }, [sessions]);

  const renderChart = useCallback(() => {
    if (chartData.points.length < 2) {
      return <div className="pt-no-data">Not enough sessions to chart</div>;
    }

    const W = 400;
    const H = 160;
    const PAD = 24;
    const usableW = W - PAD * 2;
    const usableH = H - PAD * 2;
    const range = chartData.max - chartData.min || 1;

    const svgPoints = chartData.points.map((p, i) => {
      const x = PAD + (i / (chartData.points.length - 1)) * usableW;
      const y = PAD + usableH - ((p.value - chartData.min) / range) * usableH;
      return { x, y, ...p };
    });

    // Zero line
    const zeroY = PAD + usableH - ((0 - chartData.min) / range) * usableH;
    const isPositive = chartData.total >= 0;
    const mainColor = isPositive ? '#22c55e' : '#ef4444';

    // Build polyline
    const linePoints = svgPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    // Gradient fill
    const areaPoints = `${PAD},${zeroY} ${linePoints} ${PAD + usableW},${zeroY}`;

    return (
      <svg className="pt-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="pt-fill-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={mainColor} stopOpacity="0.3" />
            <stop offset="100%" stopColor={mainColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        <line
          x1={PAD}
          y1={zeroY}
          x2={W - PAD}
          y2={zeroY}
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="0.5"
          strokeDasharray="3,3"
        />

        {/* Area fill */}
        <polygon points={areaPoints} fill="url(#pt-fill-grad)" />

        {/* Main line */}
        <polyline
          points={linePoints}
          fill="none"
          stroke={mainColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Session dots */}
        {svgPoints.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="2.5" fill={mainColor} opacity="0.6" />
        ))}

        {/* End dot with glow */}
        {svgPoints.length > 0 && (
          <circle
            cx={svgPoints[svgPoints.length - 1].x}
            cy={svgPoints[svgPoints.length - 1].y}
            r="4"
            fill={mainColor}
            className="pt-end-dot"
          />
        )}

        {/* Y-axis labels */}
        <text x={PAD - 4} y={PAD + 4} textAnchor="end" className="pt-axis-label">
          {chartData.max >= 0 ? '+' : ''}
          {chartData.max.toLocaleString()}
        </text>
        <text x={PAD - 4} y={PAD + usableH + 4} textAnchor="end" className="pt-axis-label">
          {chartData.min >= 0 ? '+' : ''}
          {chartData.min.toLocaleString()}
        </text>
        <text
          x={PAD - 4}
          y={zeroY + 3}
          textAnchor="end"
          className="pt-axis-label"
          fill="rgba(255,255,255,0.3)"
        >
          0
        </text>
      </svg>
    );
  }, [chartData]);

  const plClass = chartData.total >= 0 ? 'pt-positive' : 'pt-negative';

  return (
    <div className="performance-trends">
      {/* Header */}
      <div className="pt-header">
        <h3 className="pt-title">Performance Trends</h3>
        <div className="pt-range-tabs">
          {(['7d', '30d', '90d'] as TimeRange[]).map((r) => (
            <button
              key={r}
              className={`pt-range-tab ${range === r ? 'pt-range-active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Summary stats */}
      <div className="pt-summary">
        <div className="pt-stat">
          <span className={`pt-stat-value ${plClass}`}>
            {chartData.total >= 0 ? '+' : ''}
            {chartData.total.toLocaleString()}
          </span>
          <span className="pt-stat-label">Total P/L</span>
        </div>
        <div className="pt-stat">
          <span className="pt-stat-value">{chartData.sessionCount}</span>
          <span className="pt-stat-label">Sessions</span>
        </div>
        <div className="pt-stat">
          <span className="pt-stat-value">{chartData.handsTotal.toLocaleString()}</span>
          <span className="pt-stat-label">Hands</span>
        </div>
        <div className="pt-stat">
          <span className={`pt-stat-value ${plClass}`}>
            {chartData.handsTotal > 0
              ? `${chartData.total >= 0 ? '+' : ''}${(chartData.total / chartData.sessionCount).toFixed(0)}`
              : '0'}
          </span>
          <span className="pt-stat-label">Avg/Session</span>
        </div>
      </div>

      {/* Chart */}
      <div className="pt-chart-container">
        {loading ? (
          <div className="pt-loading">
            <div className="pt-skeleton-bar" />
          </div>
        ) : (
          renderChart()
        )}
      </div>
    </div>
  );
}
