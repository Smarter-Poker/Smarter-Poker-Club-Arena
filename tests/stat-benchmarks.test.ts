/**
 * Benchmark direction model.
 *
 * The bug these tests exist to prevent is not a crash — it is a stats page that
 * confidently gives bad advice. If VPIP were treated as "higher is better", a
 * player with a 45% VPIP would be shown a green "Top 5%" badge congratulating
 * them for the single most expensive leak in low-stakes poker.
 *
 * So: metrics whose both tails are leaks must NEVER produce a percentile, and
 * must report band position instead. That is asserted here rather than left to
 * a code review.
 */
import { describe, it, expect } from 'vitest';
import { benchmark, METRIC_DEFS } from '../src/components/stats/statBenchmarks';
import type { DistributionRow } from '../src/services/StatsFactsService';

/** Shaped like the real production distribution (which is horse-heavy). */
const ROWS: DistributionRow[] = [
  {
    cohort: 'field',
    metric: 'vpip',
    p10: 27.3,
    p25: 32,
    p50: 37.9,
    p75: 44,
    p90: 50,
    sample_size: 571,
  },
  {
    cohort: 'field',
    metric: 'pfr',
    p10: 6.4,
    p25: 9,
    p50: 11.9,
    p75: 16,
    p90: 20.8,
    sample_size: 569,
  },
  {
    cohort: 'field',
    metric: 'bb100',
    p10: -52.1,
    p25: -30,
    p50: -15.7,
    p75: 0,
    p90: 15.3,
    sample_size: 571,
  },
  {
    cohort: 'field',
    metric: 'three_bet',
    p10: 1.2,
    p25: 1.7,
    p50: 2.2,
    p75: 3,
    p90: 3.8,
    sample_size: 571,
  },
  {
    cohort: 'field',
    metric: 'win_rate',
    p10: 18.4,
    p25: 20,
    p50: 21.3,
    p75: 23,
    p90: 24.9,
    sample_size: 571,
  },
];

describe('metric definitions', () => {
  it('marks every both-tails-are-leaks metric as band_optimal', () => {
    for (const m of ['vpip', 'pfr', 'three_bet']) {
      expect(METRIC_DEFS[m].direction, `${m} must not be ranked by percentile`).toBe(
        'band_optimal'
      );
      expect(METRIC_DEFS[m].band).toBeDefined();
    }
  });

  it('ranks genuinely directional metrics by percentile', () => {
    expect(METRIC_DEFS.bb100.direction).toBe('higher_better');
    expect(METRIC_DEFS.win_rate.direction).toBe('higher_better');
  });
});

describe('band_optimal metrics never produce a percentile', () => {
  it('does not congratulate a wildly loose player', () => {
    const r = benchmark('vpip', 45, ROWS)!;
    expect(r.percentile).toBeNull();
    expect(r.bandPosition).toBe('above');
    expect(r.tone).toBe('bad');
    expect(r.readout).not.toMatch(/top/i);
    expect(r.readout).toMatch(/above the 18-28% range/);
  });

  it('flags an over-tight player as a leak too, not as a virtue', () => {
    const r = benchmark('vpip', 9, ROWS)!;
    expect(r.percentile).toBeNull();
    expect(r.bandPosition).toBe('below');
    expect(r.tone).toBe('bad');
  });

  it('rewards a value inside the healthy band', () => {
    const r = benchmark('vpip', 23, ROWS)!;
    expect(r.bandPosition).toBe('inside');
    expect(r.tone).toBe('good');
  });

  it('applies the same treatment to PFR and 3-bet', () => {
    expect(benchmark('pfr', 34, ROWS)!.percentile).toBeNull();
    expect(benchmark('three_bet', 19, ROWS)!.percentile).toBeNull();
    expect(benchmark('pfr', 18, ROWS)!.bandPosition).toBe('inside');
  });
});

describe('directional metrics', () => {
  it('places a strong win rate near the top', () => {
    const r = benchmark('bb100', 15.3, ROWS)!;
    expect(r.percentile).not.toBeNull();
    expect(r.percentile!).toBeGreaterThanOrEqual(85);
    expect(r.tone).toBe('good');
  });

  it('places a poor win rate near the bottom', () => {
    const r = benchmark('bb100', -52.1, ROWS)!;
    expect(r.percentile!).toBeLessThanOrEqual(15);
    expect(r.tone).toBe('bad');
  });

  it('puts the median at the median', () => {
    const r = benchmark('bb100', -15.7, ROWS)!;
    expect(r.percentile!).toBeCloseTo(50, 0);
  });

  it('interpolates between breakpoints rather than bucketing', () => {
    // Midway between p50 (-15.7) and p75 (0) should land near the 62nd
    // percentile, not be rounded to either endpoint.
    const r = benchmark('bb100', -7.85, ROWS)!;
    expect(r.percentile!).toBeGreaterThan(55);
    expect(r.percentile!).toBeLessThan(70);
  });

  it('never reports a percentile above 99 or below 1', () => {
    expect(benchmark('bb100', 99999, ROWS)!.percentile!).toBeLessThanOrEqual(99);
    const floor = benchmark('bb100', -99999, ROWS)!.percentile!;
    expect(floor).toBeGreaterThanOrEqual(0);
  });
});

describe('robustness', () => {
  it('returns null for an unknown metric rather than inventing a comparison', () => {
    expect(benchmark('not_a_metric', 5, ROWS)).toBeNull();
  });

  it('returns null when the cohort has no row for the metric', () => {
    expect(benchmark('bb100', 5, [])).toBeNull();
  });

  it('keeps the bar marker inside the track for extreme values', () => {
    expect(benchmark('bb100', 99999, ROWS)!.barPosition).toBeLessThanOrEqual(1);
    expect(benchmark('bb100', -99999, ROWS)!.barPosition).toBeGreaterThanOrEqual(0);
  });

  it('carries the cohort sample size through so the UI can disclose it', () => {
    expect(benchmark('vpip', 23, ROWS)!.sampleSize).toBe(571);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — 2026-08-21 audit
// ═══════════════════════════════════════════════════════════════════════════

describe('percentiles do not invert below a negative breakpoint', () => {
  it('a player far worse than the bottom decile is not ranked ABOVE it', () => {
    // The bug: below p10 the code extrapolated `p10Pct * (value / p10Value)`.
    // With bb100's real p10 of -52.1, a player at -100 scored 19th percentile
    // and a player at -60 scored 11.5th - i.e. the worse you ran, the better
    // you ranked, and both above p10's own value of 10.
    const worse = benchmark('bb100', -100, ROWS)!;
    const bad = benchmark('bb100', -60, ROWS)!;
    const atP10 = benchmark('bb100', -52.1, ROWS)!;

    expect(worse.percentile!).toBeLessThanOrEqual(10);
    expect(bad.percentile!).toBeLessThanOrEqual(10);
    expect(atP10.percentile!).toBeLessThanOrEqual(10);
    // Monotonic: worse can never rank higher than merely bad.
    expect(worse.percentile!).toBeLessThanOrEqual(bad.percentile!);
    expect(worse.tone).toBe('bad');
  });

  it('stays monotonic across the whole range', () => {
    const samples = [-200, -100, -52.1, -30, -15.7, 0, 15.3, 50, 500];
    const pcts = samples.map((v) => benchmark('bb100', v, ROWS)!.percentile!);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
  });
});

describe('metrics with no comparable field statistic draw no bar', () => {
  it('3-bet reports its band but never a percentile or a bar position', () => {
    // The hero's 3-bet is per OPPORTUNITY (5-10%); the field distribution is
    // per HAND DEALT (p90 = 3.8%). Comparing them pinned every normal 3-bettor
    // to the far right as an outlier while the pill read "In Range".
    const r = benchmark('three_bet', 7, ROWS)!;
    expect(r.percentile).toBeNull();
    expect(r.barPosition).toBeNull();
    expect(r.bandPosition).toBe('inside');
  });

  it('DIRECTIONAL metrics still draw a bar', () => {
    // Updated 2026-08-21: `vpip` used to be asserted here. Band metrics now
    // deliberately draw no bar at all — the field is horse-heavy, so its VPIP
    // distribution (p10 27.6) and the healthy-band reading (18-28) contradicted
    // each other inside a single row. Only percentile-ranked metrics get a track.
    expect(benchmark('bb100', 0, ROWS)!.barPosition).not.toBeNull();
    expect(benchmark('win_rate', 21, ROWS)!.barPosition).not.toBeNull();
  });
});

describe('the median tick reflects the real median', () => {
  it('is not the midpoint of the p10..p90 track', () => {
    // bb100: p10 -52.1, p90 15.3 -> midpoint -18.4, but p50 is -15.7.
    const r = benchmark('bb100', 0, ROWS)!;
    expect(r.medianPosition).not.toBeNull();
    const expected = (-15.7 - -52.1) / (15.3 - -52.1);
    expect(r.medianPosition!).toBeCloseTo(expected, 3);
    expect(r.medianPosition!).not.toBeCloseTo(0.5, 2);
  });
});

describe('null and malformed breakpoints', () => {
  const NULLED = [
    {
      cohort: 'field',
      metric: 'bb100',
      p10: null as unknown as number,
      p25: 1,
      p50: 2,
      p75: 3,
      p90: null as unknown as number,
      sample_size: 10,
    },
  ];

  it('does not produce a NaN bar position', () => {
    const r = benchmark('bb100', 5, NULLED);
    if (r) expect(r.barPosition === null || Number.isFinite(r.barPosition)).toBe(true);
  });

  it('rejects a non-finite hero value rather than rendering NaN', () => {
    expect(benchmark('bb100', Number.NaN, ROWS)).toBeNull();
    expect(benchmark('vpip', Number.POSITIVE_INFINITY, ROWS)).toBeNull();
  });
});

describe('win_rate is a complete, working benchmark', () => {
  it('resolves end to end', () => {
    const r = benchmark('win_rate', 24.9, ROWS)!;
    expect(r).not.toBeNull();
    expect(r.percentile).not.toBeNull();
    expect(r.barPosition).not.toBeNull();
    expect(r.def.label).toBe('Hands Won');
  });
});
