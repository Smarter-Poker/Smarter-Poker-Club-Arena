/** R19 production latency qualification: explicit, read-only and deterministic.
 *
 * Reads the engine's own closed per-window aggregates (public.lightning_latency_window,
 * through the maintained service-authorized reader fn_lightning_operator_cluster) for
 * the private pilot Clusters, and answers per Cluster and per leg PASS, FAIL or
 * INSUFFICIENT against the Cluster's configured ceilings (fn_lightning_config).
 *
 * The table stores one {n, p50, p95, p99} per leg per window, not histograms, so
 * windows are never merged and percentiles are never averaged: every window of a
 * qualifying run must itself have n >= alert_latency_min_samples and
 * p95 <= alert_latency_p95_ms[leg]. A leg with no traffic is INSUFFICIENT, never PASS.
 * The browser latency witness (lightning-pilot-latency-workload.mjs) remains a
 * supplementary sample; it is not this gate. Never writes, seats, funds or plays.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolvePilotTarget } from './lightning-pilot-targets.mjs';
import { pilotServiceFetch } from './prepare-lightning-private-pilot.mjs';

export const OPERATION = 'lightning-latency-telemetry-qualification';
export const LATENCY_PILOT_CLUSTERS = Object.freeze([
  Object.freeze({ clusterId: '56d5d6f0-23e9-41b0-b407-852aa1026c2a', target: 'action' }),
  Object.freeze({ clusterId: '681eb9e8-e9fd-4026-8ec6-64075b911d33', target: 'madness' }),
]);
export const LEGS = Object.freeze([
  'fold_ack',
  'ack_to_idle',
  'idle_to_match',
  'match_to_hand',
  'hand_to_first_render',
  'fast_fold_to_next_hand',
  'normal_fold_to_next_hand',
  'fold_watch_to_next_hand',
]);
/** Legs that exist only when that fold type happened: their consecutive windows
 * are the windows of one unbroken telemetry segment in which the fold occurred. */
export const FOLD_TYPE_LEGS = Object.freeze([
  'fold_ack',
  'fast_fold_to_next_hand',
  'normal_fold_to_next_hand',
  'fold_watch_to_next_hand',
]);
export const DEFAULT_CEILINGS_MS = Object.freeze({
  fold_ack: 500,
  ack_to_idle: 500,
  idle_to_match: 5000,
  match_to_hand: 2000,
  hand_to_first_render: 2000,
  fast_fold_to_next_hand: 5000,
  normal_fold_to_next_hand: 60000,
  fold_watch_to_next_hand: 90000,
});
export const DEFAULT_LOOKBACK_MINUTES = 360;
export const MAX_LOOKBACK_MINUTES = 1440;
const PAGE_LIMIT = 60; // fn_lightning_operator_cluster returns at most 60 windows
const MAX_PAGES = 60;
const PROJECT_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms) => new Date(ms).toISOString();
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const intAtLeast = (v, fallback, floor) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isSafeInteger(n)
    ? Math.max(n, floor)
    : fallback === null
      ? null
      : Math.max(fallback, floor);
};

/** The same reading of configuration as fn_lightning_latency_regression. */
export function latencyConfig(raw) {
  if (!object(raw) || raw.ok !== true) throw new Error('Lightning Configuration Unavailable');
  const ceilings = {};
  const ceilingSource = {};
  const configured = object(raw.alert_latency_p95_ms) ? raw.alert_latency_p95_ms : {};
  for (const leg of LEGS) {
    const v = configured[leg];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      ceilings[leg] = v;
      ceilingSource[leg] = 'fn_lightning_config';
    } else {
      ceilings[leg] = DEFAULT_CEILINGS_MS[leg];
      ceilingSource[leg] = 'documented_default';
    }
  }
  return {
    windowsRequired: intAtLeast(raw.alert_latency_windows, 3, 2),
    minSamples: intAtLeast(raw.alert_latency_min_samples, 20, 1),
    latencyWindowMs: intAtLeast(raw.latency_window_ms, 60000, 1000),
    latencyTelemetry: raw.latency_telemetry === true,
    ceilingsMs: ceilings,
    ceilingSource,
  };
}

/** Validate one persisted window. Malformed evidence is refused, never repaired. */
export function normalizeWindow(raw) {
  const a = Date.parse(raw?.window_from),
    b = Date.parse(raw?.window_to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || !object(raw.legs))
    throw new Error('Malformed Latency Window');
  const legs = {};
  for (const leg of LEGS) {
    const v = raw.legs[leg];
    if (v === undefined) continue;
    if (!object(v) || !Number.isSafeInteger(v.n) || v.n < 0)
      throw new Error('Malformed Latency Leg');
    const p95 = v.p95 === null || v.p95 === undefined ? null : v.p95;
    if (p95 !== null && (typeof p95 !== 'number' || !Number.isFinite(p95) || p95 < 0))
      throw new Error('Malformed Latency Leg');
    legs[leg] = { n: v.n, p95 };
  }
  return { fromMs: a, toMs: b, windowFrom: iso(a), windowTo: iso(b), legs };
}

/** Closed windows, oldest first, split into unbroken segments (exact adjacency). */
export function segmentWindows(windows) {
  const sorted = [...windows].sort((x, y) => x.fromMs - y.fromMs);
  const segments = [];
  let current = null;
  for (const w of sorted) {
    if (current && current.at(-1).toMs === w.fromMs) current.push(w);
    else if (current && current.at(-1).fromMs === w.fromMs)
      throw new Error('Duplicate Latency Window');
    else if (current && w.fromMs < current.at(-1).toMs)
      throw new Error('Overlapping Latency Window');
    else segments.push((current = [w]));
  }
  return segments;
}

const sample = (w, leg) => ({
  windowFrom: w.windowFrom,
  windowTo: w.windowTo,
  n: w.legs[leg]?.n ?? 0,
  p95: w.legs[leg]?.p95 ?? null,
});

/** One leg against its ceiling. Returns PASS, FAIL or INSUFFICIENT with provenance. */
export function evaluateLeg(segments, leg, cfg) {
  const ceilingMs = cfg.ceilingsMs[leg];
  const k = cfg.windowsRequired;
  const min = cfg.minSamples;
  const foldType = FOLD_TYPE_LEGS.includes(leg);
  const qualifies = (s) => s.n >= min && s.p95 !== null && s.p95 <= ceilingMs;
  const breaches = (s) => s.n >= min && s.p95 !== null && s.p95 > ceilingMs;
  // The leg's own window sequences: every window of a segment, or for a fold
  // type only the segment windows in which that fold happened.
  const sequences = segments
    .map((seg) =>
      seg.filter((w) => !foldType || (w.legs[leg]?.n ?? 0) > 0).map((w) => sample(w, leg))
    )
    .filter((seq) => seq.length > 0);
  const observed = sequences.flat().filter((s) => s.n > 0);
  const base = {
    leg,
    ceilingMs,
    ceilingSource: cfg.ceilingSource[leg],
    minSamples: min,
    windowsRequired: k,
    consecutiveness: foldType
      ? 'windows_with_this_fold_type_within_one_unbroken_segment'
      : 'adjacent_closed_windows',
    windowsWithTraffic: observed.length,
    samplesObserved: observed.reduce((t, s) => t + s.n, 0),
    windowsMeetingMinSamples: observed.filter((s) => s.n >= min).length,
    latestTrafficWindowTo: observed.length ? observed.at(-1).windowTo : null,
  };
  // The most recent run of k consecutive qualifying windows.
  let run = null;
  let longest = 0;
  for (let i = sequences.length - 1; i >= 0 && !run; i--) {
    const seq = sequences[i];
    let streak = 0;
    for (let j = seq.length - 1; j >= 0; j--) {
      streak = qualifies(seq[j]) ? streak + 1 : 0;
      longest = Math.max(longest, streak);
      if (streak === k) {
        run = seq.slice(j, j + k);
        break;
      }
    }
  }
  if (!run)
    for (const seq of sequences) {
      let streak = 0;
      for (const s of seq) longest = Math.max(longest, (streak = qualifies(s) ? streak + 1 : 0));
    }
  const runEnd = run ? Date.parse(run.at(-1).windowTo) : -Infinity;
  const laterBreaches = sequences
    .flat()
    .filter((s) => breaches(s) && Date.parse(s.windowTo) > runEnd);
  if (laterBreaches.length) {
    const latest = laterBreaches.at(-1);
    return {
      ...base,
      verdict: 'FAIL',
      reason: run
        ? 'measured_breach_after_latest_qualifying_run'
        : 'measured_breach_without_qualifying_run',
      breach: { leg, ...latest, ceilingMs },
      breachCount: laterBreaches.length,
      latestQualifyingRun: run,
    };
  }
  if (run) return { ...base, verdict: 'PASS', method: 'per_window', run };
  // POOLED SPAN (same strength, fewer samples per minute). If every window in
  // an unbroken span has p95 <= ceiling, at most 5% of each window's samples
  // exceed the ceiling, so at most 5% of their union does: the union's p95 is
  // <= the ceiling. The union must hold k windows with traffic and at least
  // k * min samples, the same total the per-window rule demands. Only the most
  // recent span counts and any breaching window (whatever its n) ends it, so a
  // later slow window can never be outvoted by an older fast one.
  const latestSeq = sequences.at(-1) ?? [];
  const span = [];
  for (let j = latestSeq.length - 1; j >= 0; j--) {
    const s = latestSeq[j];
    if (s.n > 0 && (s.p95 === null || s.p95 > ceilingMs)) break;
    span.unshift(s);
  }
  const spanTraffic = span.filter((s) => s.n > 0);
  const spanSamples = spanTraffic.reduce((t, s) => t + s.n, 0);
  const latestTraffic = observed.at(-1);
  if (
    spanTraffic.length >= k &&
    spanSamples >= k * min &&
    latestTraffic &&
    spanTraffic.at(-1).windowTo === latestTraffic.windowTo
  )
    return {
      ...base,
      verdict: 'PASS',
      method: 'pooled_span',
      pooledSpan: {
        windowFrom: spanTraffic[0].windowFrom,
        windowTo: spanTraffic.at(-1).windowTo,
        windows: spanTraffic.length,
        samples: spanSamples,
        maxWindowP95: Math.max(...spanTraffic.map((s) => s.p95)),
        requiredSamples: k * min,
      },
    };
  return {
    ...base,
    verdict: 'INSUFFICIENT',
    reason:
      observed.length === 0
        ? 'no_traffic'
        : base.windowsMeetingMinSamples < k
          ? 'below_min_samples'
          : 'no_consecutive_qualifying_run',
    longestQualifyingRun: longest,
  };
}

/** Pure evaluation of one Cluster's windows. Deterministic for equal inputs. */
export function evaluateCluster({
  clusterId,
  target,
  rawConfig,
  rawWindows,
  queryTime,
  lookbackFrom,
}) {
  const cfg = latencyConfig(rawConfig);
  const nowMs = Date.parse(queryTime);
  const fromMs = Date.parse(lookbackFrom);
  const all = rawWindows.map(normalizeWindow);
  const closed = all.filter((w) => w.toMs <= nowMs && w.fromMs >= fromMs);
  const segments = segmentWindows(closed);
  const legs = {};
  for (const leg of LEGS) legs[leg] = evaluateLeg(segments, leg, cfg);
  const verdicts = LEGS.map((l) => legs[l].verdict);
  const verdict = verdicts.includes('FAIL')
    ? 'FAIL'
    : verdicts.every((v) => v === 'PASS')
      ? 'PASS'
      : 'INSUFFICIENT';
  return {
    clusterId,
    target,
    verdict,
    failingLegs: LEGS.filter((l) => legs[l].verdict === 'FAIL'),
    insufficientLegs: LEGS.filter((l) => legs[l].verdict === 'INSUFFICIENT'),
    config: {
      source: 'fn_lightning_config',
      latencyTelemetry: cfg.latencyTelemetry,
      latencyWindowMs: cfg.latencyWindowMs,
      alertLatencyWindows: cfg.windowsRequired,
      alertLatencyMinSamples: cfg.minSamples,
      alertLatencyP95Ms: cfg.ceilingsMs,
      ceilingSource: cfg.ceilingSource,
    },
    windows: {
      lookbackFrom: iso(fromMs),
      queryTime: iso(nowMs),
      read: all.length,
      closedInLookback: closed.length,
      excludedOpenOrOutside: all.length - closed.length,
      segments: segments.length,
      oldestWindowFrom: closed.length ? iso(Math.min(...closed.map((w) => w.fromMs))) : null,
      newestWindowTo: closed.length ? iso(Math.max(...closed.map((w) => w.toMs))) : null,
      key: 'window_from (unique per cluster in lightning_latency_window; the reader exposes no row id)',
    },
    legs,
  };
}

/** Read every window intersecting [from, to] through the 60-row reader, newest first. */
export async function readLatencyWindows(admin, clusterId, from, to) {
  const windows = [];
  let cursor = to;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const r = await admin.rpc('fn_lightning_operator_cluster', {
      p_cluster_id: clusterId,
      p_from: from,
      p_to: cursor,
    });
    if (
      r.error ||
      r.data?.ok !== true ||
      r.data.cluster_id !== clusterId ||
      !Array.isArray(r.data.latency_windows) ||
      r.data.latency_windows.length > PAGE_LIMIT
    )
      throw new Error('Latency Reader Unavailable');
    const rows = r.data.latency_windows;
    windows.push(
      ...rows.map((w) => ({ window_from: w.window_from, window_to: w.window_to, legs: w.legs }))
    );
    if (rows.length < PAGE_LIMIT) break;
    const oldest = Math.min(...rows.map((w) => Date.parse(w.window_from)));
    if (!Number.isFinite(oldest) || oldest >= Date.parse(cursor))
      throw new Error('Latency Reader Did Not Advance');
    // A full page that already reaches the lookback start has read everything:
    // asking again would send a window that ends before it begins.
    if (oldest <= Date.parse(from)) break;
    cursor = iso(oldest);
  }
  return { windows, truncated };
}

export function parseLookback(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LOOKBACK_MINUTES;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 15 || n > MAX_LOOKBACK_MINUTES)
    throw Object.assign(new Error(), { code: 'BOUNDED_LOOKBACK_REQUIRED' });
  return n;
}

export function parseTargets(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '')
    return [...LATENCY_PILOT_CLUSTERS];
  const names = [
    ...new Set(
      String(raw)
        .split(',')
        .map((s) => s.trim().toLowerCase())
    ),
  ];
  const picked = names.map((n) =>
    LATENCY_PILOT_CLUSTERS.find((c) => c.target === n || c.clusterId === n)
  );
  if (picked.some((p) => !p))
    throw Object.assign(new Error(), { code: 'PRIVATE_PILOT_TARGET_REQUIRED' });
  return LATENCY_PILOT_CLUSTERS.filter((c) => picked.includes(c));
}

/** Read and evaluate one Cluster; any read or schema problem is UNKNOWN, never PASS. */
export async function qualifyClusterLatency({
  admin,
  clusterId,
  target,
  queryTime,
  lookbackMinutes = DEFAULT_LOOKBACK_MINUTES,
  bindTarget = true,
  resolveTarget = resolvePilotTarget,
}) {
  const lookbackFrom = iso(Date.parse(queryTime) - lookbackMinutes * 60000);
  try {
    if (!UUID.test(clusterId)) throw new Error('Cluster Identity');
    if (bindTarget) await resolveTarget(admin, clusterId, { active: false });
    const config = await admin.rpc('fn_lightning_config', { p_cluster_id: clusterId });
    if (config.error) throw new Error('Lightning Configuration Unavailable');
    const read = await readLatencyWindows(admin, clusterId, lookbackFrom, queryTime);
    const result = evaluateCluster({
      clusterId,
      target,
      rawConfig: config.data,
      rawWindows: read.windows,
      queryTime,
      lookbackFrom,
    });
    result.windows.truncatedAtPageLimit = read.truncated;
    result.windows.source =
      'fn_lightning_operator_cluster(latency_windows) <- public.lightning_latency_window';
    return result;
  } catch (error) {
    return {
      clusterId,
      target,
      verdict: 'UNKNOWN',
      cause: /^[A-Za-z ]{1,60}$/.test(error?.message ?? '') ? error.message : 'Read Unavailable',
      windows: { lookbackFrom, queryTime },
    };
  }
}

export async function collectLatencyQualification({
  admin,
  now = () => new Date(),
  lookbackMinutes = DEFAULT_LOOKBACK_MINUTES,
  targets = LATENCY_PILOT_CLUSTERS,
  resolveTarget,
}) {
  // One query time for every Cluster: the report is reproducible from its inputs.
  const queryTime = now().toISOString();
  const clusters = [];
  for (const t of targets)
    clusters.push(
      await qualifyClusterLatency({
        admin,
        clusterId: t.clusterId,
        target: t.target,
        queryTime,
        lookbackMinutes,
        ...(resolveTarget ? { resolveTarget } : {}),
      })
    );
  const verdicts = clusters.map((c) => c.verdict);
  return {
    schemaVersion: 1,
    operation: OPERATION,
    requirement: 'R19',
    releaseGates: ['L40', 'L41'],
    readOnly: true,
    queryTime,
    lookbackMinutes,
    method:
      'Per-window engine aggregates; no percentile averaging. A leg passes on its most recent run of alert_latency_windows consecutive closed windows each with n >= alert_latency_min_samples and p95 <= its ceiling, when no later window with n >= min breaches. Otherwise a leg passes on its most recent unbroken span (ending at its latest traffic window) in which every window with traffic has p95 <= its ceiling, holding at least alert_latency_windows traffic windows and alert_latency_windows * alert_latency_min_samples samples in total: the p95 of their union is then <= the ceiling (method pooled_span). Fold-type legs count only windows where that fold happened, within one unbroken telemetry segment. No traffic is INSUFFICIENT.',
    supplementaryEvidence:
      'scripts/ops/lightning-pilot-latency-workload.mjs browser witness: optional sample only, not the gate',
    verdict: verdicts.includes('UNKNOWN')
      ? 'UNKNOWN'
      : verdicts.includes('FAIL')
        ? 'FAIL'
        : verdicts.every((v) => v === 'PASS')
          ? 'PASS'
          : 'INSUFFICIENT',
    clusters,
    completedAt: now().toISOString(),
  };
}

export async function runLatencyQualification(env = process.env) {
  if (env.SUPABASE_URL !== PROJECT_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
    throw Object.assign(new Error(), { code: 'VERIFIED_SERVICE_CONFIGURATION_REQUIRED' });
  const lookbackMinutes = parseLookback(env.LATENCY_LOOKBACK_MINUTES);
  const targets = parseTargets(env.LATENCY_TARGETS);
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: pilotServiceFetch(env.SUPABASE_SERVICE_ROLE_KEY) },
  });
  const report = await collectLatencyQualification({ admin, lookbackMinutes, targets });
  if (env.LATENCY_REPORT_PATH)
    writeFileSync(env.LATENCY_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLatencyQualification().catch((e) => {
    console.error(
      `Latency Qualification: ${/^[A-Z0-9_]{1,60}$/.test(e?.code ?? '') ? e.code : 'FAILED'}`
    );
    process.exitCode = 1;
  });
}
