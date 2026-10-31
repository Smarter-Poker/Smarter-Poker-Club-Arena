/**
 * HOLD'EM LIVE MEASURE - heap growth, 3-bet shares, river one-pair call
 * outcomes by size class, and V61/V62 receipt counts, read from production.
 *
 *     # take one /health sample (append to a samples file; run it on a cadence
 *     # you control - every few minutes for an hour or two is plenty)
 *     npx tsx scripts/holdem-live-measure.ts sample-health --samples /tmp/health.jsonl
 *
 *     # the report (needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 *     # environment, as the engine itself has them; nothing is printed from them)
 *     npx tsx scripts/holdem-live-measure.ts report --samples /tmp/health.jsonl \
 *         --since-hours 24 --out /tmp/holdem-live-measure
 *
 * `report` writes <out>.json and <out>.md and prints the markdown. The
 * arithmetic lives in src/benchmark/HoldemLiveMeasure.ts (pure, unit-tested);
 * this file only fetches. Every query is a bounded SELECT over an indexed
 * window: horse_daily_play by day, horse_hand_reviews by played_at with a row
 * cap, horse_brain_telemetry by day and feature. No table scan, no RPC that
 * writes, no retry loop (CLAUDE.md: avoid heavy production analytics).
 *
 * The four numbers are only meaningful for a revision that contains #8692,
 * #8694, #8733 and #8705: the report names the serving release so a reader
 * never attributes EED's figures to the fix.
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  heapSlopes,
  receiptCounts,
  renderMarkdown,
  riverOnePairCalls,
  threeBetShares,
  RECEIPT_FEATURES,
  type HealthSample,
  type LiveMeasureReport,
  type PlayRow,
  type ReviewRow,
  type TelemetryRow,
} from '../src/benchmark/HoldemLiveMeasure.js';

const HEALTH_URL = process.env.ENGINE_HEALTH_URL ?? 'https://engine.smarter.poker/health';
// Hold'em review rows only (12,207 of ~62,000 in a day, measured 2026-10-30),
// read in keyset pages of PAGE newest-first up to REVIEW_ROW_CAP, so a day
// fits without one oversized read.
const REVIEW_PAGE = 2000;
const REVIEW_ROW_CAP = 20000;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const value = process.argv[i + 1];
  if (value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

async function fetchHealth(): Promise<HealthSample | null> {
  const res = await fetch(`${HEALTH_URL}?nocache=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok && res.status !== 503) return null;
  const d = (await res.json()) as { instanceId?: unknown; releaseSha?: unknown; memory?: { heapUsedMb?: unknown; rssMb?: unknown } };
  if (typeof d.instanceId !== 'string' || typeof d.releaseSha !== 'string') return null;
  const heap = Number(d.memory?.heapUsedMb);
  const rss = Number(d.memory?.rssMb);
  if (!Number.isFinite(heap) || !Number.isFinite(rss)) return null;
  return { at: Date.now(), instanceId: d.instanceId, releaseSha: d.releaseSha, heapUsedMb: heap, rssMb: rss };
}

function readSamples(path: string | undefined): HealthSample[] {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as HealthSample;
      } catch {
        return null;
      }
    })
    .filter((s): s is HealthSample => s !== null);
}

function database(): { url: string; key: string } {
  const url = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the report');
  if (!/^https:\/\//.test(url)) throw new Error('SUPABASE_URL must be https');
  return { url, key };
}

async function select<T>(table: string, query: string): Promise<T[]> {
  const { url, key } = database();
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${table} answered HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error(`${table} did not return rows`);
  return body as T[];
}

async function report(): Promise<void> {
  const sinceHours = Number(arg('--since-hours', '24'));
  // ~1,760 unfloored+floored play rows a day (measured 2026-10-31): a week
  // stays inside the single 20,000-row play read.
  if (!Number.isFinite(sinceHours) || sinceHours <= 0 || sinceHours > 24 * 7) throw new Error('--since-hours must be 1..168');
  const out = arg('--out', '/tmp/holdem-live-measure')!;
  const since = new Date(Date.now() - sinceHours * 3600000);
  const sinceDay = since.toISOString().slice(0, 10);

  const live = await fetchHealth().catch(() => null);
  const samples = readSamples(arg('--samples'));
  if (live) samples.push(live);

  // Unfloored tables only, as the tuner and fn_horse_frequency_leaks read
  // them: a VPIP-floored table forces 40-70% VPIP and its 3-bet shares are not
  // comparable. horse_daily_play carries no variant, so this is every variant.
  const play = await select<PlayRow>(
    'horse_daily_play',
    `select=horse_user_id,day,format,hands,three_bets,three_bet_opps,faced_3bets,fold_to_3bets&day=gte.${sinceDay}&floored=eq.false&limit=20000`
  );
  const reviews: ReviewRow[] = [];
  let before: string | null = null;
  while (reviews.length < REVIEW_ROW_CAP) {
    const cursor: string = before ? `&played_at=lt.${encodeURIComponent(before)}` : '';
    const page: Array<ReviewRow & { played_at: string }> = await select<ReviewRow & { played_at: string }>(
      'horse_hand_reviews',
      `select=played_at,horse_user_id,game_variant,net_bb,hole_cards,board,actions&game_variant=eq.nlh&played_at=gte.${encodeURIComponent(since.toISOString())}${cursor}&order=played_at.desc&limit=${REVIEW_PAGE}`
    );
    reviews.push(...page);
    if (page.length < REVIEW_PAGE) break;
    before = page[page.length - 1].played_at;
  }
  const telemetry = await select<TelemetryRow>(
    'horse_brain_telemetry',
    `select=day,feature,fires&day=gte.${sinceDay}&feature=in.(${RECEIPT_FEATURES.join(',')})&order=day.asc`
  );

  const result: LiveMeasureReport = {
    generatedAt: new Date().toISOString(),
    servingReleaseSha: live?.releaseSha ?? null,
    heap: heapSlopes(samples),
    threeBet: threeBetShares(play),
    riverOnePair: riverOnePairCalls(reviews),
    receipts: receiptCounts(telemetry),
  };
  if (reviews.length >= REVIEW_ROW_CAP) {
    result.riverOnePair.caveat += `; the review window hit its ${REVIEW_ROW_CAP}-row cap, so only the newest rows are counted`;
  }
  result.threeBetCaveat = 'horse_daily_play carries no variant: every variant, unfloored tables only, as the tuner reads them';
  const md = renderMarkdown(result);
  writeFileSync(`${out}.json`, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(`${out}.md`, md);
  process.stdout.write(md);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'sample-health') {
    const path = arg('--samples');
    if (!path) throw new Error('--samples FILE is required');
    const sample = await fetchHealth();
    if (!sample) throw new Error('health did not carry instanceId, releaseSha and memory');
    appendFileSync(path, JSON.stringify(sample) + '\n');
    process.stdout.write(`${sample.instanceId} ${sample.releaseSha.slice(0, 9)} heap ${sample.heapUsedMb} MB rss ${sample.rssMb} MB\n`);
    return;
  }
  if (mode === 'report') {
    await report();
    return;
  }
  throw new Error('usage: holdem-live-measure.ts sample-health --samples FILE | report [--samples FILE] [--since-hours N] [--out PATH]');
}

main().catch((err: unknown) => {
  process.stderr.write(`[holdem-live-measure] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
