import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_STORE_EXPECTED_SOURCES,
  ALERT_STORE_LIVENESS_PERIOD_MS,
  ALERT_STORE_MAX_SOURCES,
  ALERT_STORE_STOP_WAIT_MS,
  AlertStoreLiveness,
  readAlertStoreSourceMaxima,
  reduceLatestBySource,
  type AlertStoreQueryChain,
  type AlertStoreQueryClient,
  type AlertStoreSourceRow,
} from './AlertStoreLiveness.js';

// A fixed clock: 2026-09-21T18:00:00Z, so every silence below is arithmetic.
const T0 = Date.parse('2026-09-21T18:00:00.000Z');

const rows: AlertStoreSourceRow[] = [
  { source: 'alertmanager', lastReceivedAt: '2026-09-21T17:59:30.000Z' },
  { source: 'workers.deploy-error-poll', lastReceivedAt: '2026-09-16T22:36:30.534Z' },
];

function series(lines: string[], name: string): string[] {
  return lines.filter((l) => l.startsWith(name + '{') || l.startsWith(name + ' '));
}

describe('AlertStoreLiveness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one timestamp and one silence per source, from the cached read', async () => {
    let now = T0;
    const read = vi.fn(async () => rows);
    const liveness = new AlertStoreLiveness({ read, now: () => now, log: () => {} });

    // Nothing read yet: the collector series exist at zero, no per-source lines.
    const empty = liveness.prometheusLines();
    expect(series(empty, 'poker_alert_store_source_last_received_timestamp_seconds')).toEqual([]);
    expect(series(empty, 'poker_alert_store_source_silence_seconds')).toEqual([]);
    expect(empty).toContain('poker_alert_store_collector_last_success_timestamp_seconds 0');
    expect(empty).toContain('poker_alert_store_collector_errors_total 0');

    await liveness.tick();
    const lines = liveness.prometheusLines();
    expect(lines).toContain(
      '# TYPE poker_alert_store_source_last_received_timestamp_seconds gauge'
    );
    expect(lines).toContain('# TYPE poker_alert_store_source_silence_seconds gauge');
    expect(lines).toContain('# TYPE poker_alert_store_collector_errors_total counter');
    expect(series(lines, 'poker_alert_store_source_last_received_timestamp_seconds')).toEqual([
      `poker_alert_store_source_last_received_timestamp_seconds{source="alertmanager"} ${Math.floor(
        Date.parse('2026-09-21T17:59:30.000Z') / 1000
      )}`,
      `poker_alert_store_source_last_received_timestamp_seconds{source="workers.deploy-error-poll"} ${Math.floor(
        Date.parse('2026-09-16T22:36:30.534Z') / 1000
      )}`,
    ]);
    expect(series(lines, 'poker_alert_store_source_silence_seconds')).toEqual([
      'poker_alert_store_source_silence_seconds{source="alertmanager"} 30',
      `poker_alert_store_source_silence_seconds{source="workers.deploy-error-poll"} ${Math.floor(
        (T0 - Date.parse('2026-09-16T22:36:30.534Z')) / 1000
      )}`,
    ]);
    expect(lines).toContain(
      `poker_alert_store_collector_last_success_timestamp_seconds ${Math.floor(T0 / 1000)}`
    );
    expect(lines).toContain('poker_alert_store_collector_errors_total 0');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('computes silence at scrape time from the cached timestamp, without reading again', async () => {
    let now = T0;
    const read = vi.fn(async () => rows);
    const liveness = new AlertStoreLiveness({ read, now: () => now, log: () => {} });
    await liveness.tick();
    expect(series(liveness.prometheusLines(), 'poker_alert_store_source_silence_seconds')[0]).toBe(
      'poker_alert_store_source_silence_seconds{source="alertmanager"} 30'
    );

    now = T0 + 6 * 3600 * 1000; // six hours later, no tick in between
    const lines = liveness.prometheusLines();
    expect(series(lines, 'poker_alert_store_source_silence_seconds')[0]).toBe(
      `poker_alert_store_source_silence_seconds{source="alertmanager"} ${6 * 3600 + 30}`
    );
    // The timestamp itself did not move: it is the cache, not the clock.
    expect(series(lines, 'poker_alert_store_source_last_received_timestamp_seconds')[0]).toBe(
      `poker_alert_store_source_last_received_timestamp_seconds{source="alertmanager"} ${Math.floor(
        Date.parse('2026-09-21T17:59:30.000Z') / 1000
      )}`
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('counts a failed read and keeps the last good values and last success time', async () => {
    let now = T0;
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error('supabase_timeout');
      return rows;
    });
    const log = vi.fn();
    const liveness = new AlertStoreLiveness({ read, now: () => now, log });
    await liveness.tick();

    fail = true;
    now = T0 + 60_000;
    await liveness.tick();
    now = T0 + 120_000;
    await liveness.tick();

    const lines = liveness.prometheusLines();
    expect(lines).toContain('poker_alert_store_collector_errors_total 2');
    expect(lines).toContain(
      `poker_alert_store_collector_last_success_timestamp_seconds ${Math.floor(T0 / 1000)}`
    );
    expect(series(lines, 'poker_alert_store_source_last_received_timestamp_seconds')).toHaveLength(
      2
    );
    expect(series(lines, 'poker_alert_store_source_silence_seconds')[0]).toBe(
      'poker_alert_store_source_silence_seconds{source="alertmanager"} 150'
    );
    expect(liveness.snapshot().lastError).toBe('supabase_timeout');
    expect(log).toHaveBeenCalledWith('[AlertStoreLiveness] read failed: supabase_timeout');

    // A later good read clears the error text; the counter never goes down.
    fail = false;
    now = T0 + 180_000;
    await liveness.tick();
    expect(liveness.snapshot().lastError).toBeNull();
    expect(liveness.prometheusLines()).toContain('poker_alert_store_collector_errors_total 2');
    expect(liveness.prometheusLines()).toContain(
      `poker_alert_store_collector_last_success_timestamp_seconds ${Math.floor(
        (T0 + 180_000) / 1000
      )}`
    );
  });

  it('renders the expected interval only for expected sources, at the configured value', async () => {
    const liveness = new AlertStoreLiveness({
      read: async () => [
        ...rows,
        { source: 'cash-pot-conservation-measurement', lastReceivedAt: '2026-09-20T18:34:10Z' },
      ],
      now: () => T0,
      log: () => {},
    });
    await liveness.tick();
    const lines = liveness.prometheusLines();
    expect(lines).toContain('# TYPE poker_alert_store_source_expected_interval_seconds gauge');
    const interval = series(lines, 'poker_alert_store_source_expected_interval_seconds');
    // Exactly the configured map, sorted by source, whether or not the
    // source has written yet.
    expect(interval).toEqual(
      Object.keys(ALERT_STORE_EXPECTED_SOURCES)
        .sort((a, b) => a.localeCompare(b))
        .map(
          (source) =>
            `poker_alert_store_source_expected_interval_seconds{source="${source}"} ${ALERT_STORE_EXPECTED_SOURCES[source]}`
        )
    );
    expect(interval).toContain(
      'poker_alert_store_source_expected_interval_seconds{source="alertmanager"} 10800'
    );
    expect(interval).toContain(
      'poker_alert_store_source_expected_interval_seconds{source="workers.deploy-error-poll"} 604800'
    );
    // The unexpected source has a silence and a timestamp but no interval,
    // so the vector-matched rule can never fire on it.
    expect(series(lines, 'poker_alert_store_source_silence_seconds')).toContain(
      `poker_alert_store_source_silence_seconds{source="cash-pot-conservation-measurement"} ${Math.floor(
        (T0 - Date.parse('2026-09-20T18:34:10Z')) / 1000
      )}`
    );
    expect(interval.some((l) => l.includes('cash-pot-conservation-measurement'))).toBe(false);
  });

  it('pins the per-source expectations that the rule compares against', () => {
    expect(ALERT_STORE_EXPECTED_SOURCES).toEqual({
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
    });
  });

  it('honours an injected expectation map, rendering intervals before any read', () => {
    const liveness = new AlertStoreLiveness({
      read: async () => rows,
      expectedSources: { only: 42 },
      now: () => T0,
    });
    expect(
      series(liveness.prometheusLines(), 'poker_alert_store_source_expected_interval_seconds')
    ).toEqual(['poker_alert_store_source_expected_interval_seconds{source="only"} 42']);
  });

  it('stop() resolves within the bound while a read still hangs, and the late result is discarded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let resolveRead: ((v: AlertStoreSourceRow[]) => void) | null = null;
    let reads = 0;
    const read = vi.fn(
      () =>
        new Promise<AlertStoreSourceRow[]>((resolve) => {
          reads += 1;
          resolveRead = reads === 1 ? () => resolve(rows) : resolve;
        })
    );
    const liveness = new AlertStoreLiveness({ read, log: () => {} });
    liveness.start();
    resolveRead!(rows);
    await Promise.resolve();
    await Promise.resolve();
    expect(liveness.snapshot().sources).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(ALERT_STORE_LIVENESS_PERIOD_MS);
    expect(read).toHaveBeenCalledTimes(2);

    // The second read never answers. stop() must not wait for it.
    let stopped = false;
    const stopping = liveness.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(ALERT_STORE_STOP_WAIT_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);

    // When the hung read finally answers, nothing changes and no error is counted.
    resolveRead!([{ source: 'late', lastReceivedAt: '2026-09-21T17:59:59Z' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(liveness.snapshot().sources.map((s) => s.source)).toEqual([
      'alertmanager',
      'workers.deploy-error-poll',
    ]);
    expect(liveness.snapshot().errorsTotal).toBe(0);
    await vi.advanceTimersByTimeAsync(ALERT_STORE_LIVENESS_PERIOD_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('escapes label values and drops rows it cannot read', async () => {
    const liveness = new AlertStoreLiveness({
      read: async () =>
        [
          { source: 'odd "quoted" \\ name', lastReceivedAt: '2026-09-21T17:00:00Z' },
          { source: '', lastReceivedAt: '2026-09-21T17:00:00Z' },
          { source: 'no-time', lastReceivedAt: 'yesterday' },
          { source: 42, lastReceivedAt: '2026-09-21T17:00:00Z' },
          null,
        ] as unknown as AlertStoreSourceRow[],
      now: () => T0,
      log: () => {},
    });
    await liveness.tick();
    expect(series(liveness.prometheusLines(), 'poker_alert_store_source_silence_seconds')).toEqual([
      'poker_alert_store_source_silence_seconds{source="odd \\"quoted\\" \\\\ name"} 3600',
    ]);
  });

  it('caps the number of sources it will render', async () => {
    const many = Array.from({ length: ALERT_STORE_MAX_SOURCES + 10 }, (_, i) => ({
      source: `s${String(i).padStart(3, '0')}`,
      lastReceivedAt: '2026-09-21T17:00:00Z',
    }));
    const liveness = new AlertStoreLiveness({ read: async () => many, now: () => T0 });
    await liveness.tick();
    expect(
      series(liveness.prometheusLines(), 'poker_alert_store_source_silence_seconds')
    ).toHaveLength(ALERT_STORE_MAX_SOURCES);
  });

  it('reads on an unref timer every period and stops cleanly; a read finishing after stop is dropped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      const t = realSetInterval(fn, ms);
      (t as { unref?: () => void }).unref = unref;
      return t;
    }) as typeof setInterval);

    let resolveRead: ((v: AlertStoreSourceRow[]) => void) | null = null;
    const read = vi.fn(
      () =>
        new Promise<AlertStoreSourceRow[]>((resolve) => {
          resolveRead = resolve;
        })
    );
    const liveness = new AlertStoreLiveness({ read, log: () => {} });
    liveness.start();
    expect(read).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(ALERT_STORE_LIVENESS_PERIOD_MS);
    resolveRead!(rows);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(ALERT_STORE_LIVENESS_PERIOD_MS);
    expect(read).toHaveBeenCalledTimes(2);

    // The second read is still in flight when we stop: it resolves, its
    // result is discarded, and no further reads happen.
    const stopped = liveness.stop();
    resolveRead!([{ source: 'late', lastReceivedAt: '2026-09-21T17:59:59Z' }]);
    await stopped;
    await vi.advanceTimersByTimeAsync(ALERT_STORE_LIVENESS_PERIOD_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
    expect(liveness.snapshot().sources.map((s) => s.source)).toEqual([
      'alertmanager',
      'workers.deploy-error-poll',
    ]);
    intervalSpy.mockRestore();
  });
});

describe('reduceLatestBySource', () => {
  it('keeps the newest timestamp per source whatever the row order or key style', () => {
    const latest = reduceLatestBySource([
      { source: 'a', last_received_at: '2026-09-21T10:00:00Z' },
      { source: 'a', lastReceivedAt: '2026-09-21T12:00:00Z' },
      { source: 'a', last_received_at: '2026-09-21T11:00:00Z' },
      { source: 'b', last_received_at: '2026-09-01T00:00:00Z' },
    ]);
    expect([...latest.entries()]).toEqual([
      ['a', Date.parse('2026-09-21T12:00:00Z')],
      ['b', Date.parse('2026-09-01T00:00:00Z')],
    ]);
  });
});

describe('readAlertStoreSourceMaxima', () => {
  interface Call {
    filters: Array<[string, string, string]>;
    order: [string, boolean] | null;
    limit: number | null;
  }

  function fakeClient(
    answer: (call: Call) => { data: unknown[] | null; error: { message: string } | null }
  ): { client: AlertStoreQueryClient; calls: Call[] } {
    const calls: Call[] = [];
    const client: AlertStoreQueryClient = {
      from(table: string) {
        expect(table).toBe('operational_alert_events');
        return {
          select(columns: string) {
            expect(columns).toBe('source, last_received_at');
            const call: Call = { filters: [], order: null, limit: null };
            calls.push(call);
            const chain: AlertStoreQueryChain = {
              gt: (c, v) => (call.filters.push(['gt', c, v]), chain),
              eq: (c, v) => (call.filters.push(['eq', c, v]), chain),
              order: (c, o) => ((call.order = [c, o.ascending]), chain),
              limit: (n) => ((call.limit = n), chain),
              then: (onFulfilled, onRejected) =>
                Promise.resolve(answer(call)).then(onFulfilled, onRejected),
            };
            return chain;
          },
        };
      },
    };
    return { client, calls };
  }

  it('takes maxima from one descending window and reads each unseen expected source once', async () => {
    const { client, calls } = fakeClient((call) => {
      const eq = call.filters.find((f) => f[0] === 'eq');
      if (!eq) {
        return {
          data: [
            { source: 'alertmanager', last_received_at: '2026-09-21T17:59:30+00:00' },
            { source: 'noisy', last_received_at: '2026-09-21T17:59:00+00:00' },
            { source: 'alertmanager', last_received_at: '2026-09-21T17:58:00+00:00' },
          ],
          error: null,
        };
      }
      return eq[2] === 'quiet'
        ? {
            data: [{ source: 'quiet', last_received_at: '2026-09-16T22:36:30+00:00' }],
            error: null,
          }
        : { data: [], error: null };
    });
    const result = await readAlertStoreSourceMaxima(client, {
      now: () => T0,
      expectedSources: ['alertmanager', 'quiet', 'never'],
      discoveryLimit: 3,
    });
    expect(result).toEqual([
      { source: 'alertmanager', lastReceivedAt: '2026-09-21T17:59:30.000Z' },
      { source: 'noisy', lastReceivedAt: '2026-09-21T17:59:00.000Z' },
      { source: 'quiet', lastReceivedAt: '2026-09-16T22:36:30.000Z' },
    ]);
    // One window + one per expected source the window did not reach.
    expect(calls).toHaveLength(3);
    const cutoff = new Date(T0 - 30 * 24 * 3600 * 1000).toISOString();
    expect(calls[0]).toEqual({
      filters: [['gt', 'last_received_at', cutoff]],
      order: ['last_received_at', false],
      limit: 3,
    });
    expect(calls[1]).toEqual({
      filters: [
        ['eq', 'source', 'quiet'],
        ['gt', 'last_received_at', cutoff],
      ],
      order: ['last_received_at', false],
      limit: 1,
    });
    expect(calls[2]!.filters[0]).toEqual(['eq', 'source', 'never']);
  });

  it('turns a PostgREST error into a rejection', async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: 'PGRST002' } }));
    await expect(readAlertStoreSourceMaxima(client, { now: () => T0 })).rejects.toThrow('PGRST002');
  });
});
