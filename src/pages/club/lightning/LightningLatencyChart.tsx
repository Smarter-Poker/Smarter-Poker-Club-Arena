/**
 * THE LATENCY WINDOWS CHART (Lightning Phase 12).
 *
 * P50, P95 and P99 of one action-latency leg across the Cluster's latest
 * windows, oldest on the left. Recharts, the app's existing chart library,
 * loaded with React.lazy from LightningClusterDetail exactly as
 * ClubActivityChart is from the club dashboard: it never reaches the entry
 * chunk or the overview.
 *
 * Inks are the console's own (silver, lit blue, red); the lines are the one
 * thing on this surface the art does not paint.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LatencyLeg, LightningLatencyWindow } from '../../../lightning/lightningOperatorApi';
import styles from '../ClubLightningOperationsPage.module.css';

const INK = { p50: '#e4e7ec', p95: '#45adff', p99: '#ff5b6e' } as const;

function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function latencySeries(windows: LightningLatencyWindow[], leg: LatencyLeg) {
  return windows
    .filter((w) => w.legs[leg])
    .map((w) => ({
      at: w.windowTo ?? '',
      label: clock(w.windowTo),
      p50: w.legs[leg]?.p50 ?? null,
      p95: w.legs[leg]?.p95 ?? null,
      p99: w.legs[leg]?.p99 ?? null,
    }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export default function LightningLatencyChart({
  windows,
  leg,
}: {
  windows: LightningLatencyWindow[];
  leg: LatencyLeg;
}) {
  const points = latencySeries(windows, leg);
  return (
    <>
      <div className={styles.chart} role="img" aria-label="Latency P50, P95 And P99 By Window">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: '#9aa5b3', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
              minTickGap={16}
            />
            <YAxis
              tick={{ fill: '#9aa5b3', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={40}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: '#050607',
                border: '1px solid rgba(69,173,255,0.35)',
                fontSize: '0.75rem',
              }}
              labelStyle={{ color: '#e4e7ec' }}
              formatter={(value, name) => [
                value === null || value === undefined ? '-' : Math.round(Number(value)),
                String(name ?? ''),
              ]}
            />
            <Line
              type="monotone"
              dataKey="p50"
              name="P50"
              stroke={INK.p50}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="p95"
              name="P95"
              stroke={INK.p95}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="p99"
              name="P99"
              stroke={INK.p99}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className={styles.legend} aria-hidden="true">
        <span className="sc-ink--silver">P50</span>
        <span className="sc-ink--blue">P95</span>
        <span className="sc-ink--red">P99</span>
        <span className="sc-ink--muted">Milliseconds</span>
      </p>
    </>
  );
}
