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

interface Props {
  /** Hero values as PERCENTAGES (rates) and bb/100 — already converted. */
  values: Partial<Record<'bb100' | 'vpip' | 'pfr' | 'three_bet' | 'win_rate', number>>;
  /** Hands behind the hero's own numbers, for the small-sample caveat. */
  handsPlayed?: number;
}

const ORDER: Array<keyof Props['values']> = ['bb100', 'vpip', 'pfr', 'three_bet', 'win_rate'];

/** Below this, the hero's own rates are too unstable to benchmark honestly. */
const MIN_HERO_HANDS = 500;

function Bar({ result }: { result: BenchmarkResult }) {
  const pct = Math.round(result.barPosition * 100);
  return (
    <div className="bench-bar" aria-hidden="true">
      <div className="bench-bar-track">
        <span className="bench-bar-mid" />
        <span
          className={`bench-bar-marker tone-${result.tone}`}
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="bench-bar-scale">
        <span>Bottom 10%</span>
        <span>Field median</span>
        <span>Top 10%</span>
      </div>
    </div>
  );
}

export default function BenchmarkPanel({ values, handsPlayed = 0 }: Props) {
  const [rows, setRows] = useState<DistributionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    StatsFactsService.getDistribution('field')
      .then((d) => {
        if (!cancelled && aliveRef.current) setRows(d);
      })
      .finally(() => {
        if (!cancelled && aliveRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => {
    if (!rows?.length) return [];
    const out: BenchmarkResult[] = [];
    for (const key of ORDER) {
      const v = values[key as keyof typeof values];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const r = benchmark(key as string, v, rows);
      if (r) out.push(r);
    }
    return out;
  }, [rows, values]);

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

  const sample = results[0]?.sampleSize ?? 0;
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

      <p className="bench-note">
        The comparison group is every player in the club above the hands threshold, which is the
        field you actually sit down against. It is not a sample of human players only.
      </p>
    </div>
  );
}
