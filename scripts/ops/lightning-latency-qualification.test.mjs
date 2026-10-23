import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_CEILINGS_MS,
  FOLD_TYPE_LEGS,
  LATENCY_PILOT_CLUSTERS,
  LEGS,
  collectLatencyQualification,
  evaluateCluster,
  latencyConfig,
  parseLookback,
  parseTargets,
  qualifyClusterLatency,
  readLatencyWindows,
  runLatencyQualification,
} from './lightning-latency-qualification.mjs';

const CLUSTER = LATENCY_PILOT_CLUSTERS[0].clusterId;
const QUERY = '2026-10-22T04:00:30.000Z';
const FROM = '2026-10-22T03:00:00.000Z';
const config = (patch = {}) => ({
  ok: true,
  latency_telemetry: true,
  latency_window_ms: 60000,
  alert_latency_windows: 3,
  alert_latency_min_samples: 20,
  alert_latency_p95_ms: { ...DEFAULT_CEILINGS_MS },
  ...patch,
});
const good = () =>
  Object.fromEntries(
    LEGS.map((leg) => [
      leg,
      { n: 25, p50: 1, p95: DEFAULT_CEILINGS_MS[leg] / 2, p99: DEFAULT_CEILINGS_MS[leg] },
    ])
  );
const minute = (i) => new Date(Date.parse('2026-10-22T03:50:00.000Z') + i * 60000).toISOString();
/** Window i covers [03:50 + i min, 03:51 + i min). */
const win = (i, legs = good()) => ({ window_from: minute(i), window_to: minute(i + 1), legs });
const evaluate = (rawWindows, rawConfig = config()) =>
  evaluateCluster({
    clusterId: CLUSTER,
    target: 'action',
    rawConfig,
    rawWindows,
    queryTime: QUERY,
    lookbackFrom: FROM,
  });

test('three consecutive qualifying closed windows pass every leg with provenance', () => {
  const r = evaluate([win(0), win(1), win(2)]);
  assert.equal(r.verdict, 'PASS');
  for (const leg of LEGS) {
    assert.equal(r.legs[leg].verdict, 'PASS', leg);
    assert.deepEqual(
      r.legs[leg].run.map((s) => s.windowFrom),
      [minute(0), minute(1), minute(2)]
    );
    assert.equal(r.legs[leg].ceilingMs, DEFAULT_CEILINGS_MS[leg]);
  }
  assert.equal(r.config.alertLatencyWindows, 3);
  assert.equal(r.windows.queryTime, QUERY);
  assert.equal(r.windows.closedInLookback, 3);
  // Deterministic: same inputs, byte-identical verdict, regardless of row order.
  assert.equal(JSON.stringify(evaluate([win(2), win(0), win(1)])), JSON.stringify(r));
});

test('a single leg over its ceiling fails with leg, window, p95 and ceiling', () => {
  const bad = good();
  bad.match_to_hand = { n: 30, p50: 100, p95: 2500, p99: 2600 };
  const r = evaluate([win(0), win(1), win(2, bad)]);
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(r.failingLegs, ['match_to_hand']);
  const f = r.legs.match_to_hand;
  assert.equal(f.verdict, 'FAIL');
  assert.deepEqual(f.breach, {
    leg: 'match_to_hand',
    windowFrom: minute(2),
    windowTo: minute(3),
    n: 30,
    p95: 2500,
    ceilingMs: 2000,
  });
  for (const leg of LEGS.filter((l) => l !== 'match_to_hand'))
    assert.equal(r.legs[leg].verdict, 'PASS');
});

test('a breach older than a later qualifying run does not fail the leg', () => {
  const bad = good();
  bad.idle_to_match = { n: 30, p50: 100, p95: 9000, p99: 9100 };
  const r = evaluate([win(0, bad), win(1), win(2), win(3)]);
  assert.equal(r.legs.idle_to_match.verdict, 'PASS');
  assert.equal(r.verdict, 'PASS');
});

test('windows below the minimum sample count are insufficient, never pass, never fail', () => {
  const thin = good();
  thin.match_to_hand = { n: 8, p50: 1, p95: 99999, p99: 99999 };
  const r = evaluate([win(0, thin), win(1, thin), win(2, thin)]);
  assert.equal(r.legs.match_to_hand.verdict, 'INSUFFICIENT');
  assert.equal(r.legs.match_to_hand.reason, 'below_min_samples');
  assert.equal(r.legs.match_to_hand.samplesObserved, 24);
  assert.equal(r.verdict, 'INSUFFICIENT');
  assert.deepEqual(r.insufficientLegs, ['match_to_hand']);
});

test('a gap between windows breaks consecutiveness', () => {
  const r = evaluate([win(0), win(1), win(3), win(4)]);
  assert.equal(r.windows.segments, 2);
  for (const leg of LEGS) {
    assert.equal(r.legs[leg].verdict, 'INSUFFICIENT', leg);
    assert.equal(r.legs[leg].reason, 'no_consecutive_qualifying_run');
    assert.equal(r.legs[leg].longestQualifyingRun, 2);
  }
  assert.equal(evaluate([win(0), win(1), win(3), win(4), win(5)]).verdict, 'PASS');
  // An underfilled middle window breaks the per-window run; the unbroken span
  // still qualifies on its pooled samples (25 + 3 + 25 + 25 = 78 >= 60).
  const thin = good();
  thin.ack_to_idle = { n: 3, p50: 1, p95: 2, p99: 3 };
  const pooled = evaluate([win(0), win(1, thin), win(2), win(3)]).legs.ack_to_idle;
  assert.equal(pooled.verdict, 'PASS');
  assert.equal(pooled.method, 'pooled_span');
  assert.equal(pooled.pooledSpan.samples, 78);
});

test('a fold-type leg with no traffic is insufficient, and counts only windows where that fold happened', () => {
  const noFastFold = () => {
    const legs = good();
    delete legs.fast_fold_to_next_hand;
    delete legs.fold_watch_to_next_hand;
    return legs;
  };
  const r = evaluate([win(0, noFastFold()), win(1, noFastFold()), win(2, noFastFold())]);
  assert.equal(r.legs.fast_fold_to_next_hand.verdict, 'INSUFFICIENT');
  assert.equal(r.legs.fast_fold_to_next_hand.reason, 'no_traffic');
  assert.equal(r.legs.fold_watch_to_next_hand.reason, 'no_traffic');
  assert.equal(r.legs.normal_fold_to_next_hand.verdict, 'PASS');
  assert.equal(r.verdict, 'INSUFFICIENT');
  // Fast-fold windows separated by fast-fold-free windows of the same unbroken
  // segment are that leg's consecutive windows; a telemetry gap is not.
  const r2 = evaluate([win(0), win(1, noFastFold()), win(2), win(3, noFastFold()), win(4)]);
  assert.equal(r2.legs.fast_fold_to_next_hand.verdict, 'PASS');
  assert.deepEqual(
    r2.legs.fast_fold_to_next_hand.run.map((s) => s.windowFrom),
    [minute(0), minute(2), minute(4)]
  );
  assert.equal(r2.legs.idle_to_match.verdict, 'PASS');
  const r3 = evaluate([win(0), win(1), win(5)]);
  assert.equal(r3.legs.fast_fold_to_next_hand.verdict, 'INSUFFICIENT');
  assert.ok(FOLD_TYPE_LEGS.includes('fold_ack'));
  // A non-fold leg missing from a window is a zero-sample window, not skipped.
  const noRender = good();
  delete noRender.hand_to_first_render;
  const zero = evaluate([win(0), win(1, noRender), win(2), win(3)]).legs.hand_to_first_render;
  assert.equal(zero.method, 'pooled_span');
  assert.equal(zero.pooledSpan.windows, 3);
  assert.equal(
    evaluate([win(0, noRender), win(1, noRender), win(2)]).legs.hand_to_first_render.verdict,
    'INSUFFICIENT'
  );
});

test('configuration overrides govern ceilings, sample minimum and window count', () => {
  const windows = [win(0), win(1), win(2)];
  const tight = evaluate(
    windows,
    config({ alert_latency_p95_ms: { ...DEFAULT_CEILINGS_MS, ack_to_idle: 200 } })
  );
  assert.equal(tight.legs.ack_to_idle.verdict, 'FAIL');
  assert.equal(tight.legs.ack_to_idle.breach.ceilingMs, 200);
  assert.equal(tight.legs.ack_to_idle.ceilingSource, 'fn_lightning_config');
  assert.equal(
    evaluate(windows, config({ alert_latency_min_samples: 30 })).verdict,
    'INSUFFICIENT'
  );
  assert.equal(evaluate(windows, config({ alert_latency_windows: 4 })).verdict, 'INSUFFICIENT');
  assert.equal(evaluate(windows.slice(1), config({ alert_latency_windows: 2 })).verdict, 'PASS');
  // The database floor: fewer than two windows is never accepted.
  assert.equal(latencyConfig(config({ alert_latency_windows: 1 })).windowsRequired, 2);
  const missing = latencyConfig(config({ alert_latency_p95_ms: { fold_ack: 300 } }));
  assert.equal(missing.ceilingsMs.fold_ack, 300);
  assert.equal(missing.ceilingsMs.idle_to_match, 5000);
  assert.equal(missing.ceilingSource.idle_to_match, 'documented_default');
  assert.throws(() => latencyConfig({ ok: false }), /Configuration Unavailable/);
});

test('open windows, windows outside the lookback and malformed rows are not evidence', () => {
  const open = {
    window_from: '2026-10-22T04:00:00.000Z',
    window_to: '2026-10-22T04:01:00.000Z',
    legs: good(),
  };
  const r = evaluate([win(0), win(1), open]);
  assert.equal(r.windows.excludedOpenOrOutside, 1);
  assert.equal(r.verdict, 'INSUFFICIENT');
  const old = {
    window_from: '2026-10-22T02:00:00.000Z',
    window_to: '2026-10-22T02:01:00.000Z',
    legs: good(),
  };
  assert.equal(evaluate([old]).windows.closedInLookback, 0);
  assert.throws(
    () => evaluate([{ ...win(0), legs: { fold_ack: { n: -1, p95: 1 } } }]),
    /Malformed/
  );
  assert.throws(() => evaluate([win(0), { ...win(0) }]), /Duplicate/);
});

function reader({ windows = [], cfg = config(), error = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'fn_lightning_config') return { data: cfg, error };
      if (name === 'fn_lightning_operator_cluster') {
        if (error) return { data: null, error };
        const to = Date.parse(args.p_to),
          from = Date.parse(args.p_from);
        // As the database does: a window that does not move forward is refused.
        if (!(from < to))
          return {
            data: { ok: false, code: 'INVALID_WINDOW', reason: 'INVALID_WINDOW' },
            error: null,
          };
        const rows = windows
          .filter((w) => Date.parse(w.window_from) < to && Date.parse(w.window_to) > from)
          .sort((a, b) => Date.parse(b.window_from) - Date.parse(a.window_from))
          .slice(0, 60);
        return {
          data: {
            ok: true,
            cluster_id: args.p_cluster_id,
            latency_windows: rows,
            hole_cards: ['As'],
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from: () => {
      throw new Error('No table reads');
    },
  };
}

test('the reader pages past the 60-window limit without loss or duplication', async () => {
  const windows = Array.from({ length: 150 }, (_, i) => ({
    window_from: new Date(Date.parse('2026-10-22T01:00:00Z') + i * 60000).toISOString(),
    window_to: new Date(Date.parse('2026-10-22T01:01:00Z') + i * 60000).toISOString(),
    legs: good(),
  }));
  const admin = reader({ windows });
  const r = await readLatencyWindows(
    admin,
    CLUSTER,
    '2026-10-22T00:00:00Z',
    '2026-10-22T04:00:00Z'
  );
  assert.equal(new Set(r.windows.map((w) => w.window_from)).size, 150);
  assert.equal(r.truncated, false);
});

test('collection is read-only, binds one query time and reports unknown on read failure', async () => {
  const admin = reader({ windows: [win(0), win(1), win(2)] });
  const report = await collectLatencyQualification({
    admin,
    now: () => new Date(QUERY),
    lookbackMinutes: 60,
    resolveTarget: async () => ({}),
  });
  assert.equal(report.readOnly, true);
  assert.equal(report.requirement, 'R19');
  assert.deepEqual(
    report.clusters.map((c) => c.clusterId),
    LATENCY_PILOT_CLUSTERS.map((c) => c.clusterId)
  );
  assert.ok(report.clusters.every((c) => c.windows.queryTime === QUERY && c.verdict === 'PASS'));
  assert.equal(report.verdict, 'PASS');
  assert.ok(
    admin.calls.every((c) =>
      ['fn_lightning_config', 'fn_lightning_operator_cluster'].includes(c.name)
    )
  );
  assert.ok(!JSON.stringify(report).includes('hole_cards'));
  const failed = await qualifyClusterLatency({
    admin: reader({ error: { code: 'X' } }),
    clusterId: CLUSTER,
    target: 'action',
    queryTime: QUERY,
    resolveTarget: async () => ({}),
  });
  assert.equal(failed.verdict, 'UNKNOWN');
  const unbound = await qualifyClusterLatency({
    admin,
    clusterId: CLUSTER,
    target: 'action',
    queryTime: QUERY,
    resolveTarget: async () => {
      throw new Error('Exact Private Pilot Target Required');
    },
  });
  assert.equal(unbound.verdict, 'UNKNOWN');
  const source = readFileSync(
    new URL('./lightning-latency-qualification.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(
    source,
    /\.insert\(|\.update\(|\.delete\(|\.upsert\(|fn_lightning_operator_control|fn_lightning_latency_report/
  );
});

test('inputs are bounded and credentials are verified before any client work', async () => {
  assert.equal(parseLookback(''), 360);
  assert.throws(
    () => parseLookback('5'),
    (e) => e.code === 'BOUNDED_LOOKBACK_REQUIRED'
  );
  assert.throws(
    () => parseLookback('99999'),
    (e) => e.code === 'BOUNDED_LOOKBACK_REQUIRED'
  );
  assert.deepEqual(
    parseTargets('madness').map((t) => t.target),
    ['madness']
  );
  assert.equal(parseTargets('').length, 2);
  assert.throws(
    () => parseTargets('classic'),
    (e) => e.code === 'PRIVATE_PILOT_TARGET_REQUIRED'
  );
  await assert.rejects(runLatencyQualification({}), {
    code: 'VERIFIED_SERVICE_CONFIGURATION_REQUIRED',
  });
  await assert.rejects(
    runLatencyQualification({
      SUPABASE_URL: 'https://other.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    }),
    { code: 'VERIFIED_SERVICE_CONFIGURATION_REQUIRED' }
  );
});

test('pooled span: thin windows under the ceiling pass on their union, never weaker than per-window', () => {
  const thinLeg = (n, p95) => {
    const legs = good();
    legs.match_to_hand = { n, p50: 1, p95, p99: p95 };
    return legs;
  };
  // 13 hands a minute: no window reaches 20, five windows hold 65 >= 60.
  const five = [0, 1, 2, 3, 4].map((i) => win(i, thinLeg(13, 900)));
  const pass = evaluate(five).legs.match_to_hand;
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.method, 'pooled_span');
  assert.deepEqual(
    [
      pass.pooledSpan.windows,
      pass.pooledSpan.samples,
      pass.pooledSpan.requiredSamples,
      pass.pooledSpan.maxWindowP95,
    ],
    [5, 65, 60, 900]
  );
  // Four windows hold 52 < 60: insufficient, never pass.
  assert.equal(evaluate(five.slice(0, 4)).legs.match_to_hand.verdict, 'INSUFFICIENT');
  // One slow thin window anywhere in the span: the span restarts after it.
  const slowMid = [0, 1, 2, 3, 4].map((i) => win(i, thinLeg(13, i === 2 ? 2500 : 900)));
  assert.equal(evaluate(slowMid).legs.match_to_hand.verdict, 'INSUFFICIENT');
  // The most recent window slow: no pass, however good the older span was.
  const slowLast = [...five, win(5, thinLeg(4, 2500))];
  assert.notEqual(evaluate(slowLast).legs.match_to_hand.verdict, 'PASS');
  // A full-size breach after the span still fails the leg.
  const breach = [...five, win(5, thinLeg(25, 2500))];
  assert.equal(evaluate(breach).legs.match_to_hand.verdict, 'FAIL');
  // A gap ends the span: older windows on the far side never count.
  const gapped = [
    win(0, thinLeg(13, 900)),
    win(1, thinLeg(13, 900)),
    win(2, thinLeg(13, 900)),
    win(4, thinLeg(13, 900)),
    win(5, thinLeg(13, 900)),
  ];
  assert.equal(evaluate(gapped).legs.match_to_hand.verdict, 'INSUFFICIENT');
});

test('a lookback filled by exactly four full pages ends at the lookback start, never asks for an inverted window', async () => {
  // Production 2026-10-23: 240 one-minute windows, lookback starting 8 s after a
  // minute boundary. The oldest window begins before the lookback start.
  const start = Date.parse('2026-10-23T09:59:00Z');
  const windows = Array.from({ length: 240 }, (_, i) => ({
    window_from: new Date(start + i * 60000).toISOString(),
    window_to: new Date(start + (i + 1) * 60000).toISOString(),
    legs: good(),
  }));
  const admin = reader({ windows });
  const r = await readLatencyWindows(
    admin,
    CLUSTER,
    '2026-10-23T09:59:51.905Z',
    new Date(start + 240 * 60000).toISOString()
  );
  assert.equal(new Set(r.windows.map((w) => w.window_from)).size, 240);
  assert.equal(r.truncated, false);
  for (const c of admin.calls.filter((c) => c.name === 'fn_lightning_operator_cluster'))
    assert.ok(Date.parse(c.args.p_from) < Date.parse(c.args.p_to));
});
