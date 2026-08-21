/**
 * BenchmarkPanel — where the player sits against the field.
 *
 * Renders one row per benchmarked metric: the value, a p10..p90 distribution
 * bar with the player's marker on it, and a plain sentence saying what it
 * means. Metrics whose both tails are leaks (VPIP, PFR, 3-Bet) deliberately
 * show NO percentile — see statBenchmarks.ts for why a "Top 5% VPIP" badge
 * would be bad coaching rather than a compliment.
 *
 * COHORT LABEL: 584 of the 585 users with hands are horses. The comparison is
 * genuinely useful — that is the field a player actually faces — but the copy
 * says "the field" and never implies a human population that does not exist.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import StatsFactsService, { type DistributionRow } from '../../services/StatsFactsService';
import { benchmark, type BenchmarkResult } from './statBenchmarks';
import './BenchmarkPanel.css';

type MetricKey = 'bb100' | 'vpip' | 'pfr' | 'three_bet' | 'win_rate';

interface Props {
  /** Hero values as PERCENTAGES (rates) and bb/100 — already converted. */
  values: Partial<Record<MetricKey, number>>;
  /** Hands behind the hero's own numbers, for the small-sample caveat. */
  handsPlayed?: number;
  /**
   * The range the hero's values were computed over, or null for all time. The
   * field distribution is always lifetime, so a short range is comparing a
   * week of the player against a lifetime of the field — which is worth saying
   * out loud rather than quietly presenting as like-for-like.
   */
  days?: number | null;
}

const ORDER: MetricKey[] = ['bb100', 'win_rate', 'vpip', 'pfr', 'three_bet'];

/** Below this, the hero's own rates are too unstable to benchmark honestly. */
const MIN_HERO_HANDS = 500;

function Bar({ result }: { result: BenchmarkResult }) {
  // barPosition is null when the metric has no like-for-like field statistic
  // (see MetricDef.fieldMetric). Drawing a bar there would invent a comparison.
  if (result.barPosition === null) return null;

  const pct = Math.round(result.barPosition * 100);
  const medianPct =
    result.medianPosition === null ? null : Math.round(result.medianPosition * 100);

  return (
    <div className="bench-bar" aria-hidden="true">
      <div className="bench-bar-track">
        {medianPct !== null && (
          // Positioned at the REAL median, not at the track's midpoint - the
          // track is linear over p10..p90 and the two are not the same point.
          <span className="bench-bar-mid" style={{ left: `${medianPct}%` }} />
        )}
        <span className={`bench-bar-marker tone-${result.tone}`} style={{ left: `${pct}%` }} />
      </div>
      <div className="bench-bar-scale">
        <span>Bottom 10%</span>
        <span>Median</span>
        <span>Top 10%</span>
      </div>
    </div>
  );
}

export default function BenchmarkPanel({ values, handsPlayed = 0, days = null }: Props) {
  const [rows, setRows] = useState<DistributionRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // `cancelled` already covers unmount as well as dep change, so the extra
    // mounted-ref this used to carry could not change any outcome.
    let cancelled = false;
    StatsFactsService.getDistribution('field')
      .then((d) => {
        if (!cancelled) setRows(d);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Depend on the individual numbers, not the object: the parent passes a fresh
  // literal on every render, so keying the memo on `values` never hit.
  const { bb100, win_rate: winRate, vpip, pfr, three_bet: threeBet } = values;
  const results = useMemo(() => {
    if (!rows?.length) return [];
    const supplied: Partial<Record<MetricKey, number | undefined>> = {
      bb100,
      win_rate: winRate,
      vpip,
      pfr,
      three_bet: threeBet,
    };
    const out: BenchmarkResult[] = [];
    for (const key of ORDER) {
      const v = supplied[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const r = benchmark(key, v, rows);
      if (r) out.push(r);
    }
    return out;
  }, [rows, bb100, winRate, vpip, pfr, threeBet]);

  if (loading) {
    return (
      <div className="bench-panel">
        <div className="bench-skeleton" />
      </div>
    );
  }

  if (results.length === 0) {
    return null;
  }

  // Largest cohort across the rendered metrics. Quoting the first metric's
  // sample as if it covered all of them was a small lie that would grow the
  // moment two metrics had genuinely different coverage.
  const sample = results.reduce((m, r) => Math.max(m, r.sampleSize), 0);
  const thinHero = handsPlayed > 0 && handsPlayed < MIN_HERO_HANDS;

  return (
    <div className="bench-panel">
      <div className="bench-head">
        <h3 className="bench-title">How You Compare</h3>
        <p className="bench-sub">
          Measured against {sample.toLocaleString()} players in this club with 1,000 or more hands.
        </p>
      </div>

      {thinHero && (
        <p className="bench-warn">
          You have {handsPlayed.toLocaleString()} hands. Rate stats do not settle down until a few
          thousand, so treat everything below as a first impression rather than a verdict.
        </p>
      )}

      <ul className="bench-list">
        {results.map((r) => (
          <li key={r.def.metric} className="bench-item">
            <div className="bench-item-head">
              <span className="bench-label">{r.def.label}</span>
              <span className="bench-value">
                {r.value.toFixed(1)}
                {r.def.unit === 'bb/100' ? ' bb/100' : r.def.unit}
              </span>
              {r.percentile !== null ? (
                <span className={`bench-pill tone-${r.tone}`}>
                  {r.percentile >= 90
                    ? `Top ${Math.max(1, Math.round(100 - r.percentile))}%`
                    : r.percentile <= 10
                      ? `Bottom ${Math.max(1, Math.round(r.percentile))}%`
                      : `${Math.round(r.percentile)}th`}
                </span>
              ) : (
                <span className={`bench-pill tone-${r.tone}`}>
                  {r.bandPosition === 'inside' ? 'In Range' : 'Out Of Range'}
                </span>
              )}
            </div>
            <Bar result={r} />
            <p className="bench-readout">{r.readout}</p>
          </li>
        ))}
      </ul>

      {days !== null && (
        <p className="bench-note">
          Your figures cover the last {days} days; the field is measured over its full history.
          Short ranges swing a long way, so a wide gap here may be the range rather than your game.
        </p>
      )}
      <p className="bench-note">
        The comparison group is every player in the club above the hands threshold, which is the
        field you actually sit down against. It is not a sample of human players only.
      </p>
      {results.some((r) => r.barPosition === null) && (
        <p className="bench-note">
          3-Bet is shown against the range winning players hold rather than against the field: the
          club-wide figure is measured per hand dealt while yours is measured per opportunity, and
          comparing the two would be comparing different statistics.
        </p>
      )}
    </div>
  );
}
