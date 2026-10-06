/**
 * The optional positional polar plot for the Analysis tab.
 *
 * Recharts' polar stack is materially larger than the Cartesian charts. Keep
 * it behind the condition that has positional evidence instead of charging
 * every Stats Analysis visit for a plot that may not render.
 */
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';

const CHART_COLORS = ['#4169E1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981'];

export interface StatsPositionPiePlotProps {
  data: Array<{ name: string; value: number }>;
  compactChips: (value: number | null | undefined) => string;
  still?: boolean;
}

export default function StatsPositionPiePlot({
  data,
  compactChips,
  still = false,
}: StatsPositionPiePlotProps) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <PieChart>
        <Pie
          isAnimationActive={!still}
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={90}
          paddingAngle={2}
          dataKey="value"
          nameKey="name"
          label={({ name, value }) => `${name}: ${compactChips(Number(value))}`}
          labelLine={{ stroke: 'rgba(255,255,255,0.3)' }}
        >
          {data.map((_entry, index) => (
            <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: 'rgba(14, 14, 28, 0.95)',
            border: '1px solid rgba(0, 212, 255, 0.2)',
            borderRadius: '2px',
          }}
          formatter={(value, name) => [compactChips(Number(value)), String(name)]}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
