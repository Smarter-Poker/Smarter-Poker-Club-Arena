/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL CHART — Revenue visualization with Recharts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

interface FinancialChartProps {
  data: {
    name: string;
    rake: number;
    rakeback?: number;
    commissions?: number;
    net?: number;
  }[];
  height?: number;
  /**
   * The rake series. Defaults to true because every caller that has rake wants
   * it, but it is a CHOICE now: the agent's Commission Trends chart feeds
   * rake: 0 for every day (it has commission data, not rake data), and this
   * component drew that as a flat green "Rake" line at zero next to the real
   * commission line. A series with no source behind it reads as "no rake this
   * week", which was never true - the downline rakes constantly.
   */
  showRake?: boolean;
  showRakeback?: boolean;
  showCommissions?: boolean;
}

export const FinancialChart: React.FC<FinancialChartProps> = ({
  data,
  height = 200,
  showRake = true,
  showRakeback = true,
  showCommissions = false,
}) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  if (data.length === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
          fontSize: '14px',
        }}
      >
        No Data To Display
      </div>
    );
  }

  return (
    <div
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorRake" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorRakeback" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorNet" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="name" stroke="#666" fontSize={12} tickLine={false} />
          <YAxis stroke="#666" fontSize={12} tickFormatter={(v) => `${v}`} tickLine={false} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: '8px',
              fontSize: '12px',
            }}
            formatter={(value) => [`${((value as number) || 0).toLocaleString()}`, '']}
          />
          <Legend wrapperStyle={{ fontSize: '12px' }} iconType="circle" iconSize={8} />
          {showRake && (
            <Area
              type="monotone"
              dataKey="rake"
              name="Rake"
              stroke="#10b981"
              fill="url(#colorRake)"
              strokeWidth={2}
            />
          )}
          {showRakeback && (
            <Area
              type="monotone"
              dataKey="rakeback"
              name="Rakeback"
              stroke="#f59e0b"
              fill="url(#colorRakeback)"
              strokeWidth={2}
            />
          )}
          {showCommissions && (
            <Area
              type="monotone"
              dataKey="commissions"
              name="Commissions"
              stroke="#ef4444"
              fill="none"
              strokeWidth={2}
              strokeDasharray="5 5"
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export default FinancialChart;
