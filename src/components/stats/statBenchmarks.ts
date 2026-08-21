/**
 * Benchmark model for percentile comparison.
 *
 * THE MISTAKE THIS FILE EXISTS TO PREVENT
 * ---------------------------------------
 * The obvious implementation shows "Top 5%" next to every stat. For win rate
 * that is meaningful. For VPIP it is actively harmful: both tails are leaks,
 * and a "Top 5% VPIP" badge would congratulate a player for the loosest game
 * at the table. Aggression factor and WTSD have the same shape.
 *
 * So every metric declares a `direction`:
 *   higher_better  — a percentile is meaningful, high is good
 *   lower_better   — a percentile is meaningful, low is good
 *   band_optimal   — NO percentile is shown. Both tails are leaks, so the only
 *                    honest readout is where the value sits relative to a
 *                    healthy range.
 *
 * COHORT HONESTY: the distribution is computed over every user with 1,000+
 * hands, and 584 of the 585 users with hands are horses. This is a real and
 * useful comparison — those are the opponents actually being faced — but it is
 * not a human population. Every label rendered from this file says "the field".
 */

import type { DistributionRow } from '../../services/StatsFactsService';

export type Direction = 'higher_better' | 'lower_better' | 'band_optimal';

export interface MetricDef {
  metric: string;
  label: string;
  direction: Direction;
  /** Healthy range for band_optimal metrics, in the same unit as the value. */
  band?: [number, number];
  unit: '%' | 'bb/100' | '';
  /** Short, factual consequence shown when the value sits outside the band. */
  lowNote?: string;
  highNote?: string;
}

export const METRIC_DEFS: Record<string, MetricDef> = {
  bb100: {
    metric: 'bb100',
    label: 'Win Rate',
    direction: 'higher_better',
    unit: 'bb/100',
  },
  win_rate: {
    metric: 'win_rate',
    label: 'Hands Won',
    direction: 'higher_better',
    unit: '%',
  },
  vpip: {
    metric: 'vpip',
    label: 'VPIP',
    direction: 'band_optimal',
    band: [18, 28],
    unit: '%',
    lowNote: 'You are folding a lot of playable hands and giving up the blinds cheaply.',
    highNote: 'You are entering too many pots, which is the most common and most expensive leak.',
  },
  pfr: {
    metric: 'pfr',
    label: 'PFR',
    direction: 'band_optimal',
    band: [14, 22],
    unit: '%',
    lowNote: 'You are calling where you could be raising, and taking the pot down less often.',
    highNote: 'You are opening very wide, which is only profitable against players who fold a lot.',
  },
  three_bet: {
    metric: 'three_bet',
    label: '3-Bet',
    direction: 'band_optimal',
    band: [5, 10],
    unit: '%',
    lowNote: 'You rarely re-raise, so opponents can open against you almost risk-free.',
    highNote: 'You re-raise very often, which invites opponents to play back at you lighter.',
  },
};

export interface BenchmarkResult {
  def: MetricDef;
  value: number;
  /** 0..100, only for higher_better / lower_better. Null for band_optimal. */
  percentile: number | null;
  /** 'below' | 'inside' | 'above' — only for band_optimal. */
  bandPosition: 'below' | 'inside' | 'above' | null;
  /** Sentence for the player. Always safe to render. */
  readout: string;
  /** Where to draw the marker on a p10..p90 bar, 0..1. */
  barPosition: number;
  sampleSize: number;
  tone: 'good' | 'bad' | 'neutral';
}

/**
 * Piecewise-linear percentile from the five stored breakpoints.
 *
 * Interpolating between p10/p25/p50/p75/p90 is materially more honest than
 * treating them as buckets: it means a value just above p75 does not get
 * rounded up to "top 10%".
 */
function percentileFrom(value: number, d: DistributionRow): number {
  const pts: Array<[number, number]> = [
    [d.p10, 10],
    [d.p25, 25],
    [d.p50, 50],
    [d.p75, 75],
    [d.p90, 90],
  ].filter(([v]) => typeof v === 'number' && Number.isFinite(v)) as Array<[number, number]>;

  if (pts.length === 0) return 50;
  if (value <= pts[0][0]) return Math.max(1, pts[0][1] * (value / (pts[0][0] || 1)));
  if (value >= pts[pts.length - 1][0]) return Math.min(99, pts[pts.length - 1][1]);

  for (let i = 0; i < pts.length - 1; i++) {
    const [v0, p0] = pts[i];
    const [v1, p1] = pts[i + 1];
    if (value >= v0 && value <= v1) {
      const span = v1 - v0;
      const t = span === 0 ? 0 : (value - v0) / span;
      return p0 + t * (p1 - p0);
    }
  }
  return 50;
}

function ordinal(p: number): string {
  const r = Math.round(p);
  if (r >= 90) return `top ${Math.max(1, 100 - r)}%`;
  if (r <= 10) return `bottom ${Math.max(1, r)}%`;
  return `${r}th percentile`;
}

/**
 * @param value  hero's value, already in the SAME UNIT as the distribution
 *               (percent for rate stats, bb/100 for win rate). The stats page
 *               RPC returns rates as FRACTIONS, so callers must multiply by 100
 *               before calling this.
 */
export function benchmark(
  metric: string,
  value: number,
  rows: DistributionRow[]
): BenchmarkResult | null {
  const def = METRIC_DEFS[metric];
  if (!def) return null;
  const row = rows.find((r) => r.metric === metric);
  if (!row) return null;

  const lo = row.p10;
  const hi = row.p90;
  const span = hi - lo;
  const barPosition = span === 0 ? 0.5 : Math.min(1, Math.max(0, (value - lo) / span));

  if (def.direction === 'band_optimal' && def.band) {
    const [bandLo, bandHi] = def.band;
    let bandPosition: 'below' | 'inside' | 'above';
    let readout: string;
    let tone: 'good' | 'bad' | 'neutral';

    if (value < bandLo) {
      bandPosition = 'below';
      tone = 'bad';
      readout = `${value.toFixed(1)}${def.unit} is below the ${bandLo}-${bandHi}${def.unit} range most winning players sit in. ${def.lowNote ?? ''}`;
    } else if (value > bandHi) {
      bandPosition = 'above';
      tone = 'bad';
      readout = `${value.toFixed(1)}${def.unit} is above the ${bandLo}-${bandHi}${def.unit} range most winning players sit in. ${def.highNote ?? ''}`;
    } else {
      bandPosition = 'inside';
      tone = 'good';
      readout = `${value.toFixed(1)}${def.unit} sits inside the ${bandLo}-${bandHi}${def.unit} range most winning players hold.`;
    }

    return {
      def,
      value,
      percentile: null,
      bandPosition,
      readout: readout.trim(),
      barPosition,
      sampleSize: row.sample_size,
      tone,
    };
  }

  const raw = percentileFrom(value, row);
  const percentile = def.direction === 'lower_better' ? 100 - raw : raw;
  const tone: 'good' | 'bad' | 'neutral' =
    percentile >= 70 ? 'good' : percentile <= 30 ? 'bad' : 'neutral';

  return {
    def,
    value,
    percentile,
    bandPosition: null,
    readout: `${value.toFixed(1)}${def.unit === 'bb/100' ? ' bb/100' : def.unit} — ${ordinal(
      percentile
    )} of the field.`,
    barPosition,
    sampleSize: row.sample_size,
    tone,
  };
}
