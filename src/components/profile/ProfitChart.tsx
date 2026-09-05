/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROFIT CHART — Lazy-loaded Recharts component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Loaded through lazyWithRetry from ProfilePage so the Recharts bundle is only
 * fetched when the Activity panel opens. Sole caller: ProfilePage.
 *
 * 2026-09-04: this used to draw a "P/L" line from `wallet_transactions` -
 * every buy-in, add-on, cash-out, diamond purchase and VIP charge netted by
 * day. That is wallet flow, not poker results: a 400-chip buy-in followed by a
 * 3.96 cash-out read as a 396-chip "loss" the moment you sat down, and a
 * diamond purchase read as a losing session. The real daily P/L series was
 * already in the stats payload the page fetches (`daily[]` from
 * ca_player_stats_overview_v2, settled from hand results), so the chart now
 * draws that and nothing else.
 */

import { useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { formatSignedChips } from '../../utils/format';

export interface DailyProfitPoint {
  /** ISO date, YYYY-MM-DD, in the payload's window timezone. */
  date: string;
  hands: number;
  profit: number;
}

interface ProfitChartProps {
  series: DailyProfitPoint[];
}

const CYAN = '#00d4ff';
const RED = '#ff5d6c';

export default function ProfitChart({ series }: ProfitChartProps) {
  const data = useMemo(() => {
    let cumulative = 0;
    return [...(series || [])]
      .filter((p) => p && typeof p.date === 'string')
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((p) => {
        const profit = Number.isFinite(Number(p.profit)) ? Number(p.profit) : 0;
        cumulative += profit;
        const d = new Date(`${p.date}T12:00:00Z`);
        return {
          date: p.date,
          day: Number.isNaN(d.getTime())
            ? p.date
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
          hands: Number(p.hands) || 0,
          profit,
          cumulative: Math.trunc(cumulative * 100) / 100,
        };
      });
  }, [series]);

  if (data.length === 0) {
    return (
      <div className="profit-chart-empty" role="status">
        <span aria-hidden="true">▦</span>
        <strong>No Settled Sessions In This Window</strong>
        <small>The Cumulative P/L Curve Draws Itself From Hand Results, Not Wallet Flow.</small>
      </div>
    );
  }

  const last = data[data.length - 1];
  const stroke = last.cumulative < 0 ? RED : CYAN;
  const gradientId = `profitGrad-${last.cumulative < 0 ? 'neg' : 'pos'}`;

  return (
    <div className="profit-chart" aria-label="Cumulative Profit And Loss By Day">
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={stroke} stopOpacity={0.32} />
              <stop offset="95%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <ReferenceLine y={0} stroke="rgba(184, 195, 205, 0.28)" strokeDasharray="4 4" />
          <XAxis
            dataKey="day"
            tick={{ fill: '#7f8f9d', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: '#7f8f9d', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={54}
            tickFormatter={(v: number) => formatSignedChips(v, 0)}
          />
          <Tooltip
            contentStyle={{
              background: '#0d1218',
              border: '1px solid #27313c',
              borderRadius: 3,
              color: '#f2f6f9',
              fontSize: 12,
            }}
            labelStyle={{ color: '#b8c3cd', fontWeight: 700 }}
            formatter={(value: unknown, name: unknown, item: unknown) => {
              const day = (item as { payload?: { profit?: number; hands?: number } })?.payload;
              return [
                `${formatSignedChips(Number(value))} Cumulative | ${formatSignedChips(day?.profit)} Day | ${day?.hands ?? 0} Hands`,
                'P/L',
              ];
            }}
          />
          <Area
            type="monotone"
            dataKey="cumulative"
            stroke={stroke}
            fill={`url(#${gradientId})`}
            strokeWidth={2}
            isAnimationActive
            animationDuration={700}
            dot={false}
            activeDot={{ r: 4, fill: stroke, stroke: '#05070a', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
