/**
 * ===============================================================================
 *  SENTRY EVENT BUDGET - the engine's share of a free plan, as code
 * ===============================================================================
 *
 * Why this exists. The Sentry org error quota was exhausted on 2026-08-24 by
 * engine error loops - one defect firing thousands of identical events per
 * minute - and stayed exhausted until the renewal. Every OTHER project in the
 * org (World Hub, Club Commander) was blind for three weeks: their events were
 * accepted with HTTP 429 `error_usage_exceeded` and dropped. The Commander
 * login outage on 2026-09-03 raised zero alerts because of it.
 *
 * Then, on 2026-09-04, Dan cancelled the Team plan. The Developer plan gives
 * the WHOLE organisation 5,000 errors a month (~166 a day), shared by the
 * World Hub, the Arena client and this engine. docs/SENTRY-FREE-TIER-POLICY.md
 * section 3 gives the engine 60 a day. Sentry's own per-key rate limit is not
 * available on this plan (the API accepts the PUT and returns
 * `rateLimit: null`, verified 2026-09-04), so the limit lives here, in the
 * SDK's beforeSend, where no plan change can turn it off.
 *
 * The previous version of this file was a per-MINUTE budget (10 per key, 60
 * global): the right shape, built for a plan that no longer exists - fully on
 * fire it could send 86,400 a day, seventeen months of the new allowance. It is
 * REPLACED, not tuned, with a per-UTC-DAY budget:
 *
 *   - global: 60 events per UTC day, across everything. A defect that mutates
 *     its message every time (a table id in the text) still cannot exceed it.
 *   - per fingerprint: 3 per UTC day. A fingerprint is the report's context
 *     (the `[HandController.dealFlop]` prefix reportError() writes) plus the
 *     first 80 chars of the message with identifiers normalised away. Sentry
 *     groups identical errors anyway; the fourth copy buys nothing.
 *
 * Both reset at 00:00 UTC. Dropped events are COUNTED, never lost silently:
 * `dropped` and `sentToday` are read by GameServer.getPrometheusMetrics() and
 * published as `poker_sentry_events_dropped_total` and
 * `poker_sentry_events_sent_today`, so a quiet Sentry is never mistaken for a
 * healthy engine. (The old design sent a "budget summary" EVENT every ten
 * minutes to say what it dropped - 144 a day, more than twice the whole
 * budget. Prometheus does that job for free now.)
 *
 * PURE (no Sentry import) so it is unit-testable. Tunable through env
 * (SENTRY_BUDGET_PER_KEY, SENTRY_BUDGET_GLOBAL) for an incident, never above
 * the policy's figure without a line in the policy naming the cost.
 */

export interface BudgetOptions {
  /** Events allowed per fingerprint per UTC day. */
  perKeyLimit: number;
  /** Events allowed across all fingerprints per UTC day. */
  globalLimit: number;
  /** Bound on tracked fingerprints per day; oldest are evicted past this. */
  maxKeys?: number;
  now?: () => number;
}

export interface Verdict {
  allow: boolean;
  reason?: 'per_key' | 'global';
  /** Events of this fingerprint dropped so far today. */
  droppedForKey: number;
  /** Events sent so far today, including this one when allowed. */
  sentToday: number;
}

export const DEFAULT_BUDGET: Omit<BudgetOptions, 'now'> = {
  perKeyLimit: 3,
  globalLimit: 60,
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
    maxKeys: DEFAULT_BUDGET.maxKeys,
  };
}

/** UTC calendar day, e.g. `2026-09-04`. The reset boundary. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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

interface KeyRecord {
  sent: number;
  dropped: number;
  /** Insertion tick, for eviction order. */
  seq: number;
}

export class SentryEventBudget {
  private readonly opts: Required<BudgetOptions>;
  private day = '';
  private sentTodayCount = 0;
  private droppedTodayCount = 0;
  /** Lifetime drops for this process; what Prometheus scrapes as a counter. */
  private droppedTotalCount = 0;
  private seq = 0;
  private readonly perKey = new Map<string, KeyRecord>();

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
    this.rollDay();
    const { perKeyLimit, globalLimit } = this.opts;

    let rec = this.perKey.get(key);
    if (!rec) {
      rec = { sent: 0, dropped: 0, seq: ++this.seq };
      this.perKey.set(key, rec);
      this.evictIfNeeded();
    }

    if (rec.sent >= perKeyLimit) {
      rec.dropped += 1;
      this.countDrop();
      return {
        allow: false,
        reason: 'per_key',
        droppedForKey: rec.dropped,
        sentToday: this.sentTodayCount,
      };
    }
    if (this.sentTodayCount >= globalLimit) {
      rec.dropped += 1;
      this.countDrop();
      return {
        allow: false,
        reason: 'global',
        droppedForKey: rec.dropped,
        sentToday: this.sentTodayCount,
      };
    }

    rec.sent += 1;
    this.sentTodayCount += 1;
    return { allow: true, droppedForKey: rec.dropped, sentToday: this.sentTodayCount };
  }

  /** Events sent so far in the current UTC day. */
  get sentToday(): number {
    this.rollDay();
    return this.sentTodayCount;
  }

  /** Events dropped so far in the current UTC day. */
  get droppedToday(): number {
    this.rollDay();
    return this.droppedTodayCount;
  }

  /** Events dropped since this process started. Monotonic: a counter. */
  get dropped(): number {
    return this.droppedTotalCount;
  }

  /** The UTC day the counters belong to. */
  get currentDay(): string {
    this.rollDay();
    return this.day;
  }

  /** Number of fingerprints currently tracked (for tests / health). */
  get trackedKeys(): number {
    return this.perKey.size;
  }

  /** The day's worst offenders, most-dropped first (for logs / tests). */
  topDropped(limit = 10): Array<{ key: string; sent: number; dropped: number }> {
    return [...this.perKey.entries()]
      .filter(([, r]) => r.dropped > 0)
      .map(([key, r]) => ({ key, sent: r.sent, dropped: r.dropped }))
      .sort((a, b) => b.dropped - a.dropped)
      .slice(0, limit);
  }

  private countDrop(): void {
    this.droppedTodayCount += 1;
    this.droppedTotalCount += 1;
  }

  private rollDay(): void {
    const today = utcDayOf(this.opts.now());
    if (today === this.day) return;
    this.day = today;
    this.sentTodayCount = 0;
    this.droppedTodayCount = 0;
    this.perKey.clear();
  }

  private evictIfNeeded(): void {
    const max = this.opts.maxKeys;
    if (this.perKey.size <= max) return;
    // Map iteration is insertion order: the first entries are the oldest.
    const excess = this.perKey.size - max;
    let n = 0;
    for (const k of this.perKey.keys()) {
      if (n++ >= excess) break;
      this.perKey.delete(k);
    }
  }
}
