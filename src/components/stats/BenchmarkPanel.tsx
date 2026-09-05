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

import { useEffect, useMemo, useState } from 'react';
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
  const medianPct = result.medianPosition === null ? null : Math.round(result.medianPosition * 100);

  return (
    <div className="bench-bar bench-bar-anchored" aria-hidden="true">
      <div className="bench-bar-track">
        {medianPct !== null && (
          // Positioned at the REAL median, not at the track's midpoint - the
          // track is linear over p10..p90 and the two are not the same point.
          <span className="bench-bar-mid" style={{ left: `${medianPct}%` }} />
        )}
        <span className={`bench-bar-marker tone-${result.tone}`} style={{ left: `${pct}%` }} />
      </div>
      {/* The median LABEL used to sit centred by flexbox while the tick moved
          to the real position - up to 12 points apart for PFR, so the word
          named a place it was not. It is now anchored to the tick. */}
      <div className="bench-bar-scale">
        <span>Bottom 10%</span>
        <span>Top 10%</span>
      </div>
      {medianPct !== null && (
        <span className="bench-bar-median-label" style={{ left: `${medianPct}%` }}>
          Median
        </span>
      )}
    </div>
  );
}

export default function BenchmarkPanel({ values, handsPlayed = 0, days = null }: Props) {
  const [rows, setRows] = useState<DistributionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `cancelled` already covers unmount as well as dep change, so the extra
    // mounted-ref this used to carry could not change any outcome.
    let cancelled = false;
    setLoading(true);
    StatsFactsService.getDistribution('field')
      .then((d) => {
        if (cancelled) return;
        setRows(d.rows);
        setReadError(d.error ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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

  // A failed read used to make the whole panel vanish, indistinguishable
  // from "nothing to compare". Say so, and offer the retry.
  if (readError) {
    return (
      <div className="bench-panel">
        <div className="bench-head">
          <h3 className="bench-title">How You Compare</h3>
          <p className="bench-sub" role="alert">
            The Field Distribution Could Not Be Loaded.{' '}
            <button type="button" className="hand-retry" onClick={() => setAttempt((n) => n + 1)}>
              Try Again
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (results.length === 0) {
    return null;
  }

  // Largest cohort across the rendered metrics. Quoting the first metric's
  // sample as if it covered all of them was a small lie that would grow the
  // moment two metrics had genuinely different coverage.
  const sample = results
    .filter((r) => r.barPosition !== null)
    .reduce((m, r) => Math.max(m, r.sampleSize), 0);
  const thinHero = handsPlayed > 0 && handsPlayed < MIN_HERO_HANDS;

  return (
    <div className="bench-panel">
      <div className="bench-head">
        <h3 className="bench-title">How You Compare</h3>
        <p className="bench-sub">
          {sample > 0
            ? `Measured Against ${sample.toLocaleString()} Players In The Field With 1,000 Or More Hands.`
            : 'Measured Against The Range Winning Players Hold.'}
        </p>
      </div>

      {thinHero && (
        <p className="bench-warn">
          You Have {handsPlayed.toLocaleString()} Hands. Rate Stats Do Not Settle Down Until A Few
          Thousand, So Treat Everything Below As A First Impression Rather Than A Verdict.
        </p>
      )}

      <ul className="bench-list">
        {results.map((r) => (
          <li key={r.def.metric} className="bench-item">
            <div className="bench-item-head">
              <span className="bench-label">{r.def.label}</span>
              <span className="bench-value">
                {r.value.toFixed(1)}
                {r.def.unit === 'bb/100' ? ' BB/100' : r.def.unit}
              </span>
              {r.percentile !== null ? (
                <span className={`benchmark-panel__bench-pill tone-${r.tone}`}>
                  {r.percentile >= 90
                    ? `Top ${Math.max(1, Math.round(100 - r.percentile))}%`
                    : r.percentile <= 10
                      ? `Bottom ${Math.max(1, Math.round(r.percentile))}%`
                      : `${Math.round(r.percentile)}th`}
                </span>
              ) : (
                <span className={`benchmark-panel__bench-pill tone-${r.tone}`}>
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
          Your Figures Cover The Last {days} Days; The Field Is Measured Over Its Full History.
          Short Ranges Swing A Long Way, So A Wide Gap Here May Be The Range Rather Than Your Game.
        </p>
      )}
      <p className="bench-note">
        The Comparison Group Is Every Player In The Club Above The Hands Threshold, Which Is The
        Field You Actually Sit Down Against. It Is Not A Sample Of Human Players Only.
      </p>
      {results.some((r) => r.barPosition === null) && (
        <p className="bench-note">
          {results
            .filter((r) => r.barPosition === null)
            .map((r) => r.def.label)
            .join(', ')}{' '}
          {results.filter((r) => r.barPosition === null).length === 1 ? 'Is' : 'Are'} Judged Against
          The Range Winning Players Hold Rather Than Against The Field. For These, Both Extremes Are
          Leaks, So Where The Club Happens To Sit Says Nothing About Where You Should Be.
        </p>
      )}
    </div>
  );
}
