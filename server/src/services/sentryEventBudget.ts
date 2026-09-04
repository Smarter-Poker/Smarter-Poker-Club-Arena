/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SENTRY EVENT BUDGET - the engine can never burn the org quota again
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Why this exists (2026-09-04). The Sentry org error quota was exhausted on
 * 2026-08-24 by engine error loops - one defect firing thousands of identical
 * events per minute - and stayed exhausted until the renewal on 2026-09-16.
 * Every OTHER project in the org (World Hub, Club Commander) was blind for
 * three weeks: their events were accepted with HTTP 429 `error_usage_exceeded`
 * and dropped. The Commander login outage on 2026-09-03 raised zero alerts
 * because of it.
 *
 * Sentry's own per-key rate limit is NOT available on this plan: the API
 * accepts the PUT and returns `rateLimit: null` (verified 2026-09-04). So the
 * limit has to live here, in the SDK's beforeSend, where it cannot be turned
 * off by a plan change.
 *
 * The budget is two-tier and PURE (no Sentry import) so it is unit-testable:
 *
 *   - per fingerprint: N events per window. A fingerprint is the report's
 *     context (the `[HandController.dealFlop]` prefix reportError() writes) plus
 *     the first 80 chars of the message. A loop is by definition one
 *     fingerprint repeating, so this is what actually stops a loop.
 *   - global: M events per window across everything. A defect that mutates its
 *     message every time (a table id in the text) still cannot exceed M.
 *
 * Dropped events are COUNTED, never lost silently: `drainSummary()` returns the
 * drop counts per fingerprint since the last drain, and errorReporter emits ONE
 * summary event per period carrying them. A quiet Sentry must not be mistaken
 * for a healthy engine (Commander law 3.2), so the summary exists precisely to
 * say "the engine was loud and we throttled it".
 *
 * Defaults: 10 per fingerprint per minute, 60 per minute globally, summary every
 * 10 minutes. Worst case the engine sends ~60/min + 1 summary = 86,400/day when
 * fully on fire, versus the 4-5 million/day a loop produced in August. Tunable
 * through env (SENTRY_BUDGET_PER_KEY, SENTRY_BUDGET_GLOBAL, SENTRY_BUDGET_WINDOW_MS).
 */

export interface BudgetOptions {
  perKeyLimit: number;
  globalLimit: number;
  windowMs: number;
  /** Bound on tracked fingerprints; oldest windows are evicted past this. */
  maxKeys?: number;
  now?: () => number;
}

export interface Verdict {
  allow: boolean;
  reason?: 'per_key' | 'global';
  /** Events of this fingerprint dropped so far in the current window. */
  droppedForKey: number;
}

interface Bucket {
  windowStart: number;
  count: number;
  dropped: number;
}

export const DEFAULT_BUDGET: Omit<BudgetOptions, 'now'> = {
  perKeyLimit: 10,
  globalLimit: 60,
  windowMs: 60_000,
  maxKeys: 500,
};

/** Read env overrides once; malformed values fall back to the defaults. */
export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<BudgetOptions, 'now'> {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    perKeyLimit: num(env.SENTRY_BUDGET_PER_KEY, DEFAULT_BUDGET.perKeyLimit),
    globalLimit: num(env.SENTRY_BUDGET_GLOBAL, DEFAULT_BUDGET.globalLimit),
    windowMs: num(env.SENTRY_BUDGET_WINDOW_MS, DEFAULT_BUDGET.windowMs),
    maxKeys: DEFAULT_BUDGET.maxKeys,
  };
}

/**
 * Derive the fingerprint for an event. reportError() prefixes every message
 * with `[context]`, so a loop inside one call site collapses to one key even
 * when the tail of the message varies. Identifiers that vary per iteration
 * (uuids, hex ids, numbers, timestamps) are normalised away first: a loop over
 * "table 42 stalled at 12:00:01" and "table 43 stalled at 12:00:02" is ONE loop.
 */
export function fingerprintOf(message: string, source?: string): string {
  const msg = String(message ?? '');
  const m = msg.match(/^\[([^\]]{1,120})\]/);
  const ctx = (source && String(source)) || (m ? m[1] : '');
  const tail = normalizeTail(m ? msg.slice(m[0].length) : msg).slice(0, 80);
  return ctx ? `${ctx}|${tail}` : tail || '(empty)';
}

function normalizeTail(text: string): string {
  return text
    .trim()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ');
}

const OTHER_KEY = '(other)';

export class SentryEventBudget {
  private readonly perKey = new Map<string, Bucket>();
  private globalBucket: Bucket = { windowStart: 0, count: 0, dropped: 0 };
  /** Drops accumulated since the last drainSummary(), by fingerprint. */
  private readonly droppedSinceDrain = new Map<string, number>();
  private readonly opts: Required<BudgetOptions>;

  constructor(options: Partial<BudgetOptions> = {}) {
    this.opts = {
      ...DEFAULT_BUDGET,
      maxKeys: DEFAULT_BUDGET.maxKeys ?? 500,
      now: () => Date.now(),
      ...options,
    } as Required<BudgetOptions>;
  }

  /** Decide whether an event with this fingerprint may be sent right now. */
  admit(key: string): Verdict {
    const now = this.opts.now();
    const { windowMs, perKeyLimit, globalLimit } = this.opts;

    if (now - this.globalBucket.windowStart >= windowMs) {
      this.globalBucket = { windowStart: now, count: 0, dropped: 0 };
    }

    let bucket = this.perKey.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { windowStart: now, count: 0, dropped: 0 };
      this.perKey.set(key, bucket);
      this.evictIfNeeded(now);
    }

    if (bucket.count >= perKeyLimit) {
      bucket.dropped += 1;
      this.recordDrop(key);
      return { allow: false, reason: 'per_key', droppedForKey: bucket.dropped };
    }
    if (this.globalBucket.count >= globalLimit) {
      bucket.dropped += 1;
      this.globalBucket.dropped += 1;
      this.recordDrop(key);
      return { allow: false, reason: 'global', droppedForKey: bucket.dropped };
    }

    bucket.count += 1;
    this.globalBucket.count += 1;
    return { allow: true, droppedForKey: bucket.dropped };
  }

  /**
   * Return and reset the drop counts accumulated since the previous drain.
   * Returns null when nothing was dropped, so the caller can skip the summary.
   */
  drainSummary(): { total: number; byKey: Array<{ key: string; dropped: number }> } | null {
    if (this.droppedSinceDrain.size === 0) return null;
    const byKey = [...this.droppedSinceDrain.entries()]
      .map(([key, dropped]) => ({ key, dropped }))
      .sort((a, b) => b.dropped - a.dropped);
    const total = byKey.reduce((s, r) => s + r.dropped, 0);
    this.droppedSinceDrain.clear();
    return { total, byKey };
  }

  /** Number of fingerprints currently tracked (for tests / health). */
  get trackedKeys(): number {
    return this.perKey.size;
  }

  private recordDrop(key: string): void {
    const m = this.droppedSinceDrain;
    m.set(key, (m.get(key) ?? 0) + 1);
    // Bound the summary map too: a message-mutating loop must not grow it
    // forever. Overflow is folded into one "(other)" row so no drop is lost.
    while (m.size > this.opts.maxKeys) {
      let victim: string | undefined;
      for (const k of m.keys()) {
        if (k !== OTHER_KEY) { victim = k; break; }
      }
      if (victim === undefined) break;
      const n = m.get(victim) ?? 0;
      m.delete(victim);
      m.set(OTHER_KEY, (m.get(OTHER_KEY) ?? 0) + n);
    }
  }

  private evictIfNeeded(now: number): void {
    if (this.perKey.size <= this.opts.maxKeys) return;
    for (const [k, b] of this.perKey) {
      if (now - b.windowStart >= this.opts.windowMs) this.perKey.delete(k);
    }
    // Still over: drop the oldest windows first.
    if (this.perKey.size > this.opts.maxKeys) {
      const sorted = [...this.perKey.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      for (const [k] of sorted.slice(0, this.perKey.size - this.opts.maxKeys)) this.perKey.delete(k);
    }
  }
}
