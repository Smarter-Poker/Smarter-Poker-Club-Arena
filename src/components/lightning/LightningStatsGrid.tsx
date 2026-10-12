/**
 * LIGHTNING PHASE 8: one grid for the running Session panel and the summary,
 * so the two can never print the same number two ways. A number the database
 * did not give is a dash; VPIP and PFR appear only when it gives them.
 */
import {
  lightningChipsText,
  lightningDurationText,
  lightningRateText,
  lightningWaitText,
  type LightningSessionStats,
} from '../../lightning/lightningSessionApi';
import './LightningSession.css';

export interface LightningStatRow {
  key: string;
  label: string;
  value: string;
  tone?: 'up' | 'down';
}

export function lightningStatRows(
  s: LightningSessionStats,
  mode: 'session' | 'summary'
): LightningStatRow[] {
  const rows: LightningStatRow[] = [
    { key: 'hands', label: 'Hands', value: s.hands.toLocaleString() },
    { key: 'duration', label: 'Duration', value: lightningDurationText(s.durationS) },
    { key: 'hands_per_hour', label: 'Hands / Hour', value: lightningRateText(s.handsPerHour, 0) },
    { key: 'starting_stack', label: 'Starting Stack', value: lightningChipsText(s.startingStack) },
    {
      key: 'current_stack',
      label: mode === 'summary' ? 'Ending Stack' : 'Current Stack',
      value: lightningChipsText(s.currentStack),
    },
    {
      key: 'net',
      label: 'Net',
      value: lightningChipsText(s.net, true),
      tone: s.net === null || s.net === 0 ? undefined : s.net > 0 ? 'up' : 'down',
    },
    { key: 'bb_per_100', label: 'BB / 100', value: lightningRateText(s.bbPer100, 1) },
  ];
  if (s.vpip !== null)
    rows.push({ key: 'vpip', label: 'VPIP', value: lightningRateText(s.vpip, 0, '%') });
  if (s.pfr !== null)
    rows.push({ key: 'pfr', label: 'PFR', value: lightningRateText(s.pfr, 0, '%') });
  rows.push(
    {
      key: 'showdowns',
      label: 'Showdowns',
      value: s.showdowns === null ? '-' : s.showdowns.toLocaleString(),
    },
    {
      key: 'fast_folds',
      label: 'LIGHTNING FOLD',
      value: s.fastFolds === null ? '-' : s.fastFolds.toLocaleString(),
    }
  );
  if (mode === 'session') {
    rows.push(
      { key: 'avg_wait', label: 'Average Wait', value: lightningWaitText(s.avgWaitMs) },
      { key: 'p95_wait', label: 'P95 Wait', value: lightningWaitText(s.p95WaitMs) }
    );
  }
  return rows;
}

export default function LightningStatsGrid({
  stats,
  mode,
}: {
  stats: LightningSessionStats;
  mode: 'session' | 'summary';
}) {
  return (
    <dl className="lightning-stats" data-testid={`lightning-stats-${mode}`}>
      {lightningStatRows(stats, mode).map((r) => (
        <div key={r.key} className="lightning-stats__row" data-stat={r.key}>
          <dt className="lightning-stats__label">{r.label}</dt>
          <dd
            className={`lightning-stats__value${r.tone ? ` lightning-stats__value--${r.tone}` : ''}`}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
