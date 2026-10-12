/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STATS CHARTS — split out so recharts is NOT on the Stats critical path
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED 2026-08-25, production build, gzipped:
 *
 *   CartesianChart   96.6 KB      Area / Bar / Pie / Y-axis   23.2 KB
 *   ---------------------------------------------------------------
 *   recharts total  120.0 KB      PlayerStatsPage itself       39.4 KB
 *
 * So three quarters of what a Stats visitor downloaded was a charting library
 * for three charts that live on the ANALYSIS tab - and the default tab is
 * Overview. Someone opening their stats to look at their win rate paid 120 KB
 * for charts they never scrolled to.
 *
 * Lazily loading this component moves all of it behind the tab that uses it.
 * The Suspense fallback matters for one case that is not a network delay: the
 * print dossier renders every tab at once, so `printing` forces this to mount
 * even from Overview - see showTab() on the page.
 *
 * Everything here is presentational. The Analysis tab owns the series and
 * screen-reader summaries; the optional polar renderer has its own lazy edge.
 */

import { lazy, Suspense } from 'react';

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import StatsDataTable from './StatsDataTable';
import { compactChips } from '../../utils/format';

const StatsPositionPiePlot = lazy(() => import('./StatsPositionPiePlot'));

export interface StatsChartsProps {
  dailySeries: Array<{ date: string; profit: number; cumulative: number; hands: number }>;
  positionPie: Array<{ name: string; value: number }>;
  profitChartSummary: string;
  dailyChartSummary: string;
  positionChartSummary: string;
  rangeLabel: string;
  sessionRows: unknown[];
  /**
   * True while the print dossier is being prepared. recharts animates its
   * entrance over 1500ms and printDossier fires at 1200ms, so without this the
   * charts are captured mid-draw. EVLuckChart has taken the same flag since it
   * was written; these three never did.
   */
  still?: boolean;
  onExportSessions: () => void;
  onExportOverview: () => void;
}

export default function StatsCharts({
  dailySeries,
  positionPie,
  profitChartSummary,
  dailyChartSummary,
  positionChartSummary,
  rangeLabel,
  sessionRows,
  still = false,
  onExportSessions,
  onExportOverview,
}: StatsChartsProps) {
  // Axis lines are an inline SVG stroke no print stylesheet can reach; near
  // white vanishes on paper. `still` is only true while the dossier renders.
  const axisStroke = still ? '#374151' : 'rgba(255,255,255,0.4)';
  return (
    <div className="charts-section">
      <div className="stats-section-header">
        <h3 style={{ color: '#00d4ff' }}>Charts</h3>
      </div>

      <div className="stats-action-row">
        {sessionRows.length > 0 && (
          <button className="export-btn" onClick={onExportSessions}>
            Export Sessions CSV
          </button>
        )}
        <button className="export-btn" onClick={onExportOverview}>
          Export Stats CSV
        </button>
      </div>

      {/* Profit Over Time Chart */}
      <div className="chart-card">
        <div className="chart-card-header">
          {/* Derived, not hardcoded. `daily` is windowed by the RPC's
            p_days, so with "7 Days" selected this chart plotted a
            week under a heading that said 90. It is also cash-only
            (the RPC's daily CTE filters is_cash), which the title
            never said either. */}
          <h3>{`Cash Profit Over Time (${rangeLabel})`}</h3>
          {dailySeries.length === 0 && (
            <p className="hand-empty">No Cash Results In This Window.</p>
          )}
          {/* Three recharts SVGs carried no role, no aria-label and
              no adjacent summary, so the entire Charts section was
              empty to a screen reader - a whole workflow (reading
              your own results) closed off. Every number below is
              already in dailySeries. Dan 2026-08-25. */}
          <p className="sr-only">{profitChartSummary}</p>
        </div>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={dailySeries}>
              <defs>
                <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4169E1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#4169E1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke={axisStroke} fontSize={11} />
              <YAxis
                stroke={axisStroke}
                fontSize={11}
                tickFormatter={(value) => compactChips(Number(value))}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(14, 14, 28, 0.95)',
                  border: '1px solid rgba(0, 212, 255, 0.2)',
                  borderRadius: '2px',
                }}
                labelStyle={{ color: '#fff' }}
                formatter={(value, name) => [compactChips(Number(value)), String(name)]}
              />
              <Area
                isAnimationActive={!still}
                type="monotone"
                dataKey="cumulative"
                stroke="#4169E1"
                fill="url(#profitGradient)"
                strokeWidth={2}
                name="Cumulative Profit"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <StatsDataTable
          caption={`Cash Profit Over Time, ${rangeLabel}`}
          rows={dailySeries}
          rowKey={(row) => row.date}
          columns={[
            { key: 'date', label: 'Date', render: (row) => row.date },
            {
              key: 'cumulative',
              label: 'Cumulative Profit',
              render: (row) => compactChips(row.cumulative),
            },
          ]}
        />
      </div>

      {/* Session Results Bar Chart */}
      <div className="chart-card">
        <div className="chart-card-header">
          <h3>{`Daily Cash Results (${rangeLabel})`}</h3>
          <p className="sr-only">{dailyChartSummary}</p>
        </div>
        {dailySeries.length === 0 && <p className="hand-empty">No Cash Results In This Window.</p>}
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailySeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke={axisStroke} fontSize={11} />
              <YAxis
                stroke={axisStroke}
                fontSize={11}
                tickFormatter={(value) => compactChips(Number(value))}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(14, 14, 28, 0.95)',
                  border: '1px solid rgba(0, 212, 255, 0.2)',
                  borderRadius: '2px',
                }}
                labelStyle={{ color: '#fff' }}
                formatter={(value, name) => [compactChips(Number(value)), String(name)]}
              />
              <Bar dataKey="profit" name="Profit" radius={[1, 1, 0, 0]} isAnimationActive={!still}>
                {dailySeries.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.profit >= 0 ? '#22c55e' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <StatsDataTable
          caption={`Daily Cash Results, ${rangeLabel}`}
          rows={dailySeries}
          rowKey={(row) => row.date}
          columns={[
            { key: 'date', label: 'Date', render: (row) => row.date },
            { key: 'profit', label: 'Profit', render: (row) => compactChips(row.profit) },
            { key: 'hands', label: 'Hands', render: (row) => row.hands.toLocaleString() },
          ]}
        />
      </div>

      {/* Position Breakdown Pie Chart */}
      {positionPie.length > 0 && (
        <div className="chart-card">
          <div className="chart-card-header">
            <h3>Hands Won By Position (Count)</h3>
            <p className="sr-only">{positionChartSummary}</p>
          </div>
          <div className="chart-container pie-chart">
            <Suspense
              fallback={<div className="hand-empty hand-loading">Loading Position Chart...</div>}
            >
              <StatsPositionPiePlot data={positionPie} compactChips={compactChips} still={still} />
            </Suspense>
          </div>
          <StatsDataTable
            caption="Hands Won By Position"
            rows={positionPie}
            rowKey={(row) => row.name}
            columns={[
              { key: 'position', label: 'Position', render: (row) => row.name },
              { key: 'hands_won', label: 'Hands Won', render: (row) => row.value.toLocaleString() },
            ]}
          />
        </div>
      )}
    </div>
  );
}
