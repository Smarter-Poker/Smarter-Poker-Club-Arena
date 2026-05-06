/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION GRAPH — Profit/Loss Chart
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useMemo, useState, useEffect } from 'react';
import './SessionGraph.css';

interface SessionGraphProps {
  data: { time: Date; balance: number }[];
  height?: number;
  showLabels?: boolean;
}

export function SessionGraph({ data, height = 120, showLabels = true }: SessionGraphProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  const { path, minVal, maxVal, startBalance, endBalance, profit } = useMemo(() => {
    if (data.length === 0) {
      return { path: '', minVal: 0, maxVal: 0, startBalance: 0, endBalance: 0, profit: 0 };
    }

    const values = data.map((d) => d.balance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const padding = range * 0.1;

    const points = data.map((d, i) => {
      const x = (i / (data.length - 1)) * 100;
      const y = height - ((d.balance - min + padding) / (range + padding * 2)) * height;
      return `${x},${y}`;
    });

    return {
      path: `M ${points.join(' L ')}`,
      minVal: min,
      maxVal: max,
      startBalance: values[0],
      endBalance: values[values.length - 1],
      profit: values[values.length - 1] - values[0],
    };
  }, [data, height]);

  const isPositive = profit >= 0;

  return (
    <div
      className="session-graph"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      {showLabels && (
        <div className="session-graph__header">
          <span className="label">Session P/L</span>
          <span className={`value ${isPositive ? 'positive' : 'negative'}`}>
            {isPositive ? '+' : ''}
            {profit.toLocaleString()}
          </span>
        </div>
      )}

      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="graph-svg">
        <defs>
          <linearGradient id="graphGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={isPositive ? '#4ade80' : '#f87171'} stopOpacity="0.3" />
            <stop offset="100%" stopColor={isPositive ? '#4ade80' : '#f87171'} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Zero line */}
        {minVal < startBalance && maxVal > startBalance && (
          <line
            x1="0"
            x2="100"
            y1={height - ((startBalance - minVal) / (maxVal - minVal)) * height}
            y2={height - ((startBalance - minVal) / (maxVal - minVal)) * height}
            stroke="rgba(255,255,255,0.1)"
            strokeDasharray="2,2"
          />
        )}

        {/* Fill area */}
        <path d={`${path} L 100,${height} L 0,${height} Z`} fill="url(#graphGradient)" />

        {/* Line */}
        <path
          d={path}
          fill="none"
          stroke={isPositive ? '#4ade80' : '#f87171'}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {showLabels && (
        <div className="session-graph__footer">
          <span>Start: {startBalance.toLocaleString()}</span>
          <span>End: {endBalance.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

export default SessionGraph;
