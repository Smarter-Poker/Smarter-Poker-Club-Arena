/**
 * AlertStoreLiveness - which senders are still writing to the private alert
 * store, read once a minute and published on /metrics (`poker_alert_store_*`).
 *
 * WHY THIS EXISTS (Production Alerts, 2026-09-21)
 * ------------------------------------------------
 * Every operational alert on the platform ends up as a row in
 * public.operational_alert_events, written by a dozen independent senders:
 * Alertmanager's webhook, the drift-incident and financial-alert updaters,
 * the owner notification path, World Hub's deploy monitor, Open Claw, the
 * worker watchdogs, the engine-alert backfill. A sender that dies produces
 * nothing, and nothing is exactly what a healthy, quiet sender produces too.
 * On 2026-09-19/20 the engine-alert producer was silent for 17.8 hours and
 * the store simply stopped filling; nobody could tell an empty queue from a
 * dead pipeline. So the engine, the one process that is already scraped,
 * asks the store when each source last wrote and lets Prometheus watch the
 * silence grow.
 *
 * Five series:
 *
 *   poker_alert_store_source_last_received_timestamp_seconds{source}
 *       the newest last_received_at per source inside a 30-day window
 *   poker_alert_store_source_silence_seconds{source}
 *       now minus that, computed AT SCRAPE from the cached timestamp, so it
 *       keeps growing between reads and while the read itself is failing
 *   poker_alert_store_source_expected_interval_seconds{source}
 *       for the EXPECTED senders only, how long each may be silent; the
 *       rule compares silence against this per source, so a sender that is
 *       expected to be quiet for a day is not paged after six hours and a
 *       sender nobody listed is rendered but never paged
 *   poker_alert_store_collector_last_success_timestamp_seconds
 *       when the collector last read the store successfully; 0 until it has
 *   poker_alert_store_collector_errors_total
 *       reads that failed; the last good per-source values stay published
 *
 * THE READ (current schema, no new SQL)
 * -------------------------------------
 * What we want is `select source, max(last_received_at) ... group by source`.
 * PostgREST aggregates are not enabled on the project, so
 * readAlertStoreSourceMaxima() does it in two bounded steps against the
 * table as it stands: one window of the ALERT_STORE_DISCOVERY_LIMIT newest
 * rows (the first row seen per source in a descending window IS that
 * source's maximum), then one `limit 1` read per EXPECTED source the window
 * did not reach. A quiet expected sender buried under a noisy one is never
 * lost; an unexpected sender is reported only while it is inside the window.
 * That is at most 1 + (one per ALERT_STORE_EXPECTED_SOURCES entry) round trips a
 * minute, each under the shared client's deadline.
 *
 * TWO THINGS IT MUST NEVER DO
 *   - Run on the scrape path. The timer is unref'd and the scrape only
 *     renders what the last tick cached.
 *   - Erase what it knew. A failed read counts an error and leaves the last
 *     good timestamps in place; silence keeps growing from them.
 */

export interface AlertStoreSourceRow {
  source: string;
  /** ISO-8601 as PostgREST returns timestamptz. */
  lastReceivedAt: string;
}

export interface AlertStoreLivenessDeps {
  /** One pass over the store: the newest last_received_at per source. */
  read: () => Promise<readonly AlertStoreSourceRow[]>;
  /** source -> expected max silence seconds; ALERT_STORE_EXPECTED_SOURCES by default. */
  expectedSources?: Readonly<Record<string, number>>;
  now?: () => number;
  log?: (msg: string) => void;
}

export const ALERT_STORE_LIVENESS_PERIOD_MS = 60 * 1000;
/** Sources older than this are not senders any more, only history. */
export const ALERT_STORE_WINDOW_DAYS = 30;
/**
 * Newest rows read per tick before falling back to per-source reads.
 * Measured 2026-09-21: 84,511 rows in the 30-day window across 32 sources,
 * 51,291 of them from one backfill, so a window alone cannot reach a quiet
 * sender; it only saves the per-source reads for the sources it does reach.
 */
export const ALERT_STORE_DISCOVERY_LIMIT = 1000;
/** More distinct sources than this are truncated (sorted by name) so one
 * misbehaving writer cannot grow the scrape without bound. */
export const ALERT_STORE_MAX_SOURCES = 64;
/**
 * Senders that are expected to keep writing, and how long each may be
 * silent before that silence means it has stopped (seconds). Each gets its
 * own bounded read when the discovery window did not reach it, so its
 * silence is measured exactly however noisy the others are, and each is
 * rendered as poker_alert_store_source_expected_interval_seconds so the
 * rule can compare per source instead of with one number for all. A source
 * not listed here renders its silence but never an interval, and so never
 * alerts. Everything else is reported only while it is inside the window.
 *
 * Measured 2026-09-20/21: the continuous senders write many times an hour;
 * financial-alerts-backfill is a live mirror trigger despite its name
 * (51k rows in 30 days, hourly); worldhub.deploy-monitor went 8 h quiet,
 * openclaw 10.6 h, engine-alerts-backfill 17.8 h (the engine producer's own
 * poker_engine_alerts_* series now cover its liveness) and
 * workers.deploy-error-poll 90 h, all legitimately.
 */
export const ALERT_STORE_EXPECTED_SOURCES: Readonly<Record<string, number>> = {
  alertmanager: 3 * 3600,
  'drift-incidents-updates': 3 * 3600,
  'financial-alerts-backfill': 6 * 3600,
  'financial-alerts-updates': 12 * 3600,
  'owner-operational-notifications': 12 * 3600,
  'workers.scraper-watchdog': 6 * 3600,
  openclaw: 24 * 3600,
  'engine-alerts-backfill': 72 * 3600,
  'worldhub.deploy-monitor': 96 * 3600,
  'workers.deploy-error-poll': 7 * 24 * 3600,
};
/**
 * How long stop() waits for a read in flight. A tick is at most
 * 1 + expected-source reads, each under the shared client's 15 s deadline,
 * which is longer than the engine's whole shutdown budget
 * (index.ts SHUTDOWN_DEADLINE_MS, 40 s). After this the late result is
 * discarded by the generation check, so nothing is lost by not waiting.
 */
export const ALERT_STORE_STOP_WAIT_MS = 5 * 1000;

const SOURCE_MAX_LENGTH = 120;

/** Prometheus label escaping, as observability/Metrics.ts renders it. */
function labelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function parseRow(raw: unknown): AlertStoreSourceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = (raw as { source?: unknown }).source;
  const at =
    (raw as { lastReceivedAt?: unknown }).lastReceivedAt ??
    (raw as { last_received_at?: unknown }).last_received_at;
  if (typeof source !== 'string' || source.length === 0 || source.length > SOURCE_MAX_LENGTH)
    return null;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  return { source, lastReceivedAt: at };
}

/**
 * Newest last_received_at per source from any mix of rows, in any order.
 * Unparseable rows are dropped rather than allowed to fail the tick.
 */
export function reduceLatestBySource(rows: readonly unknown[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const raw of rows) {
    const row = parseRow(raw);
    if (!row) continue;
    const ms = Date.parse(row.lastReceivedAt);
    const seen = latest.get(row.source);
    if (seen === undefined || ms > seen) latest.set(row.source, ms);
  }
  return latest;
}

/**
 * The shape of the query builder this reader needs - just enough of
 * supabase-js to be replaced by a fake in tests. `from(...).select(...)`
 * returns a thenable filter chain; every method used here returns the
 * chain again.
 */
export interface AlertStoreQueryChain extends PromiseLike<{
  data: unknown[] | null;
  error: { message: string } | null;
}> {
  gt(column: string, value: string): AlertStoreQueryChain;
  eq(column: string, value: string): AlertStoreQueryChain;
  order(column: string, options: { ascending: boolean }): AlertStoreQueryChain;
  limit(count: number): AlertStoreQueryChain;
}

/**
 * Typed loosely on purpose: supabase-js's `select` carries a template-literal
 * parser that makes a structural comparison against the real client
 * "excessively deep" (TS2589). The one cast lives here, beside the query.
 */
export interface AlertStoreQueryClient {
  from(table: string): unknown;
}

function selectSourceRows(client: AlertStoreQueryClient): AlertStoreQueryChain {
  const builder = client.from('operational_alert_events') as {
    select(columns: string): AlertStoreQueryChain;
  };
  return builder.select('source, last_received_at');
}

/**
 * `select source, max(last_received_at) ... group by source` on the current
 * schema, bounded: one window of the newest ALERT_STORE_DISCOVERY_LIMIT rows,
 * then one `limit 1` read per expected source the window did not reach.
 */
export async function readAlertStoreSourceMaxima(
  client: AlertStoreQueryClient,
  options: {
    now?: () => number;
    expectedSources?: readonly string[];
    discoveryLimit?: number;
  } = {}
): Promise<AlertStoreSourceRow[]> {
  const now = options.now ?? (() => Date.now());
  const expected = options.expectedSources ?? Object.keys(ALERT_STORE_EXPECTED_SOURCES);
  const discoveryLimit = options.discoveryLimit ?? ALERT_STORE_DISCOVERY_LIMIT;
  const cutoff = new Date(now() - ALERT_STORE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const window = await selectSourceRows(client)
    .gt('last_received_at', cutoff)
    .order('last_received_at', { ascending: false })
    .limit(discoveryLimit);
  if (window.error) throw new Error(window.error.message);
  const latest = reduceLatestBySource(window.data ?? []);

  for (const source of expected) {
    if (latest.has(source)) continue;
    const one = await selectSourceRows(client)
      .eq('source', source)
      .gt('last_received_at', cutoff)
      .order('last_received_at', { ascending: false })
      .limit(1);
    if (one.error) throw new Error(one.error.message);
    for (const [key, ms] of reduceLatestBySource(one.data ?? [])) latest.set(key, ms);
  }

  return [...latest.entries()].map(([source, ms]) => ({
    source,
    lastReceivedAt: new Date(ms).toISOString(),
  }));
}

export class AlertStoreLiveness {
  /** source -> epoch ms of its newest last_received_at, from the last good read. */
  private latest = new Map<string, number>();
  private lastSuccessAt = 0;
  private errorsTotal = 0;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly expected: Readonly<Record<string, number>>;

  constructor(private readonly deps: AlertStoreLivenessDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((m) => console.warn(m));
    this.expected = deps.expectedSources ?? ALERT_STORE_EXPECTED_SOURCES;
  }

  start(periodMs = ALERT_STORE_LIVENESS_PERIOD_MS): void {
    if (this.timer) return;
    const generation = ++this.generation;
    void this.tick(generation);
    this.timer = setInterval(() => void this.tick(generation), periodMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Clears the timer and waits up to ALERT_STORE_STOP_WAIT_MS for a read in
   * flight. Either way its result is discarded: the generation moved on.
   */
  async stop(): Promise<void> {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.inFlight) return;
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.inFlight.catch(() => {}),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, ALERT_STORE_STOP_WAIT_MS);
        }),
      ]);
    } finally {
      if (bound !== undefined) clearTimeout(bound);
    }
  }

  /** One read. Public so a test can drive it without timers. */
  async tick(generation = this.generation): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = (async () => {
      try {
        const rows = await this.deps.read();
        if (generation !== this.generation) return;
        const latest = reduceLatestBySource(rows);
        const trimmed = [...latest.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, ALERT_STORE_MAX_SOURCES);
        this.latest = new Map(trimmed);
        this.lastSuccessAt = this.now();
        this.lastError = null;
      } catch (err) {
        if (generation !== this.generation) return;
        // A failed read is not a sender failure: keep every last good
        // timestamp, count the error, say why. Silence keeps growing.
        this.errorsTotal += 1;
        this.lastError = (err as Error)?.message ?? String(err);
        this.log(`[AlertStoreLiveness] read failed: ${this.lastError}`);
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  /** What /health could publish; also the test's window into the cache. */
  snapshot(): {
    sources: Array<{ source: string; lastReceivedAt: string }>;
    lastSuccessAt: number;
    errorsTotal: number;
    lastError: string | null;
  } {
    return {
      sources: [...this.latest.entries()].map(([source, ms]) => ({
        source,
        lastReceivedAt: new Date(ms).toISOString(),
      })),
      lastSuccessAt: this.lastSuccessAt,
      errorsTotal: this.errorsTotal,
      lastError: this.lastError,
    };
  }

  /** Prometheus exposition lines for /metrics. Renders the cache only. */
  prometheusLines(): string[] {
    const nowMs = this.now();
    const sources = [...this.latest.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines: string[] = [
      '# HELP poker_alert_store_source_last_received_timestamp_seconds Unix time of the newest operational_alert_events.last_received_at per source inside the 30-day window, from the last successful read',
      '# TYPE poker_alert_store_source_last_received_timestamp_seconds gauge',
    ];
    for (const [source, ms] of sources) {
      lines.push(
        `poker_alert_store_source_last_received_timestamp_seconds{source="${labelValue(source)}"} ${Math.floor(ms / 1000)}`
      );
    }
    lines.push(
      '# HELP poker_alert_store_source_silence_seconds Seconds since that source last wrote to the alert store, computed at scrape from the cached timestamp; grows while a sender is dead and while the collector cannot read',
      '# TYPE poker_alert_store_source_silence_seconds gauge'
    );
    for (const [source, ms] of sources) {
      lines.push(
        `poker_alert_store_source_silence_seconds{source="${labelValue(source)}"} ${Math.max(0, Math.floor((nowMs - ms) / 1000))}`
      );
    }
    lines.push(
      '# HELP poker_alert_store_source_expected_interval_seconds Longest silence this expected sender may show before it is taken to have stopped; rendered only for the sources in ALERT_STORE_EXPECTED_SOURCES, which is what confines AlertStoreSenderSilent to them',
      '# TYPE poker_alert_store_source_expected_interval_seconds gauge'
    );
    for (const source of Object.keys(this.expected).sort((a, b) => a.localeCompare(b))) {
      lines.push(
        `poker_alert_store_source_expected_interval_seconds{source="${labelValue(source)}"} ${this.expected[source]}`
      );
    }
    lines.push(
      '# HELP poker_alert_store_collector_last_success_timestamp_seconds Unix time the alert-store liveness collector last read operational_alert_events successfully; 0 until the first success since this process started',
      '# TYPE poker_alert_store_collector_last_success_timestamp_seconds gauge',
      `poker_alert_store_collector_last_success_timestamp_seconds ${Math.floor(this.lastSuccessAt / 1000)}`,
      '# HELP poker_alert_store_collector_errors_total Alert-store liveness reads that failed since this process started; the last good per-source values stay published',
      '# TYPE poker_alert_store_collector_errors_total counter',
      `poker_alert_store_collector_errors_total ${this.errorsTotal}`
    );
    return lines;
  }
}
