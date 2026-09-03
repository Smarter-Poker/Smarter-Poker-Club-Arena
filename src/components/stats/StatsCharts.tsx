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
 * Everything here is presentational. The memos it renders (dailySeries,
 * positionPie and the three screen-reader summaries) stay on the page, because
 * the CSV exports and the empty-state logic read them too.
 */

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

const CHART_COLORS = ['#4169E1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981'];

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
              <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(14, 14, 28, 0.95)',
                  border: '1px solid rgba(0, 212, 255, 0.2)',
                  borderRadius: '10px',
                  backdropFilter: 'blur(16px)',
                }}
                labelStyle={{ color: '#fff' }}
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
      </div>

      {/* Session Results Bar Chart */}
      <div className="chart-card">
        <div className="chart-card-header">
          <h3>Daily Results</h3>
          <p className="sr-only">{dailyChartSummary}</p>
        </div>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailySeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(14, 14, 28, 0.95)',
                  border: '1px solid rgba(0, 212, 255, 0.2)',
                  borderRadius: '10px',
                  backdropFilter: 'blur(16px)',
                }}
                labelStyle={{ color: '#fff' }}
              />
              <Bar dataKey="profit" name="Profit" radius={[4, 4, 0, 0]} isAnimationActive={!still}>
                {dailySeries.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.profit >= 0 ? '#22c55e' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Position Breakdown Pie Chart */}
      {positionPie.length > 0 && (
        <div className="chart-card">
          <div className="chart-card-header">
            <h3>Hands Won By Position</h3>
            <p className="sr-only">{positionChartSummary}</p>
          </div>
          <div className="chart-container pie-chart">
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  isAnimationActive={!still}
                  data={positionPie}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="name"
                  label={({ name, value }) => `${name}: ${value}`}
                  labelLine={{ stroke: 'rgba(255,255,255,0.3)' }}
                >
                  {positionPie.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'rgba(14, 14, 28, 0.95)',
                    border: '1px solid rgba(0, 212, 255, 0.2)',
                    borderRadius: '10px',
                    backdropFilter: 'blur(16px)',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
