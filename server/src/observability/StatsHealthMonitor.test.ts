import { describe, it, expect, vi } from 'vitest';
import {
  StatsHealthMonitor,
  parseStatsHealth,
  type StatsHealthAlert,
  STATS_INDEX_LAG_ALERT,
  STATS_TRIGGER_GAP_ALERT,
  STATS_WITNESS_ALERT,
  STATS_EV_COVERAGE_ALERT,
  STATS_EV_COVERAGE_MIN_RATIO,
  STATS_EV_COVERAGE_MIN_SAMPLE,
  STATS_HEALTH_COMPONENT,
  STATS_INDEX_LAG_THRESHOLD_S,
  STATS_HEALTH_PERIOD_MS,
} from './StatsHealthMonitor.js';

// What the phase 3 migrations add to the payload: the 7-day all-in runout
// equity coverage as ca_stats_health() returned it on 2026-09-04 22:48 UTC.
const LIVE_EV = { allInShowdowns: 715, withoutEquity: 1, ratio: 0.9986 };

// The jsonb ca_stats_health() returned in production on 2026-09-04 08:55 UTC,
// verbatim, so the parser is pinned to the real shape and not to a guess.
const LIVE_SAMPLE = {
  repair: {
    done: false,
    cursorAt: '2026-08-30T02:54:13.62798+00:00',
    ceilingAt: '2026-09-03T19:28:15.567327+00:00',
    handsSeen: 584000,
    updatedAt: '2026-09-04T08:55:00.336367+00:00',
    rowsChanged: 263,
  },
  checkedAt: '2026-09-04T08:55:19.890568+00:00',
  indexCeil: '2026-09-04T08:45:19.412255+00:00',
  seatBackfill: { done: false, cursorAt: '2026-08-28T21:29:00+00:00', rowsAdded: 2 },
  indexRows: 23356167,
  lastAudit: null,
  recentHands: 897,
  indexLagSeconds: 600.5,
  indexBackfillComplete: true,
  recentHandsWithoutStat: 0,
};

const healthyAudit = {
  ranAt: '2026-09-04T08:54:06.310129+00:00',
  hands: 5963,
  buttonDisagree: 0,
  showdownDisagree: 0,
  handsWithoutStat: 0,
  playerHandsWithoutIdx: 0,
  humanPlayerHands: 0,
  humanWithoutFacts: 0,
  durationMs: 10416,
};

function harness(reads: unknown[], opts: { paused?: boolean } = {}) {
  let i = 0;
  let clock = 1_000_000;
  const raise = vi.fn<(a: StatsHealthAlert) => Promise<boolean>>(async () => true);
  const resolve = vi.fn<(name: string, component: string, note: string) => Promise<boolean>>(
    async () => true
  );
  const read = vi.fn<() => Promise<unknown>>(async () => {
    const v = reads[Math.min(i, reads.length - 1)];
    i += 1;
    if (v instanceof Error) throw v;
    return v;
  });
  const mon = new StatsHealthMonitor({
    read,
    raise,
    resolve,
    paused: () => opts.paused ?? false,
    now: () => clock,
    log: () => {},
  });
  return { mon, raise, resolve, read, advance: (ms: number) => (clock += ms) };
}

describe('parseStatsHealth', () => {
  it('reads the live production shape field for field', () => {
    const s = parseStatsHealth(LIVE_SAMPLE, 'fallback');
    expect(s.checkedAt).toBe(LIVE_SAMPLE.checkedAt);
    expect(s.indexLagSeconds).toBe(600.5);
    expect(s.indexBackfillComplete).toBe(true);
    expect(s.indexRows).toBe(23356167);
    expect(s.recentHands).toBe(897);
    expect(s.recentHandsWithoutStat).toBe(0);
    expect(s.repair?.done).toBe(false);
    expect(s.repair?.handsSeen).toBe(584000);
    expect(s.seatBackfill?.rowsAdded).toBe(2);
    expect(s.lastAudit).toBeNull();
  });

  it('accepts numerics that arrive as strings (numeric(12,1) can) and nulls the rest', () => {
    const s = parseStatsHealth({ indexLagSeconds: '526.9', recentHands: 'x' }, 'fb');
    expect(s.indexLagSeconds).toBe(526.9);
    expect(s.recentHands).toBeNull();
    expect(s.checkedAt).toBe('fb');
    expect(s.repair).toBeNull();
  });

  it('never throws on garbage', () => {
    expect(() => parseStatsHealth(null, 'fb')).not.toThrow();
    expect(() => parseStatsHealth('nope', 'fb')).not.toThrow();
    expect(() => parseStatsHealth([1, 2], 'fb')).not.toThrow();
    expect(parseStatsHealth(undefined, 'fb').indexLagSeconds).toBeNull();
  });
});

describe('StatsHealthMonitor', () => {
  it('publishes null before the first read and the snapshot after it', async () => {
    const { mon } = harness([LIVE_SAMPLE]);
    expect(mon.publish()).toBeNull();
    await mon.tick();
    const p = mon.publish();
    expect(p?.indexLagSeconds).toBe(600.5);
    expect(p?.stale).toBe(false);
    expect(p?.lastError).toBeNull();
  });

  it('a 10-minute lag (one maintenance break) raises nothing and resolves the lag alert', async () => {
    const { mon, raise, resolve } = harness([LIVE_SAMPLE]);
    await mon.tick();
    expect(raise).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(
      STATS_INDEX_LAG_ALERT,
      STATS_HEALTH_COMPONENT,
      expect.any(String)
    );
  });

  it.each([STATS_INDEX_LAG_THRESHOLD_S + 1, 1805, 1849])(
    'raises the lag alert past 30 minutes, retaining lag %s in the labels',
    async (indexLagSeconds) => {
      const { mon, raise } = harness([{ ...LIVE_SAMPLE, indexLagSeconds }]);
      await mon.tick();
      expect(raise).toHaveBeenCalledTimes(1);
      const a = raise.mock.calls[0]?.[0];
      expect(a?.alertname).toBe(STATS_INDEX_LAG_ALERT);
      expect(a?.component).toBe(STATS_HEALTH_COMPONENT);
      expect(a?.labels).toEqual({ lag_seconds: String(indexLagSeconds) });
    }
  );

  it('does NOT raise the lag alert while a maintenance break is on (CLAUDE.md 13.6)', async () => {
    const { mon, raise, resolve } = harness([{ ...LIVE_SAMPLE, indexLagSeconds: 4000 }], {
      paused: true,
    });
    await mon.tick();
    expect(raise).not.toHaveBeenCalled();
    expect(resolve.mock.calls.some(([name]) => name === STATS_INDEX_LAG_ALERT)).toBe(false);
  });

  it('does NOT raise the trigger-gap alert while a maintenance break is on (CLAUDE.md 13.6)', async () => {
    // Regression for the 2026-09-23 fix: this block never checked paused(),
    // unlike its sibling index-lag block immediately above, so a hand written
    // in the last few seconds before the freeze could still read as "missing"
    // on the next tick and page about the scheduled stop this monitor's own
    // class doc says it must never page about.
    const { mon, raise, resolve } = harness([{ ...LIVE_SAMPLE, recentHandsWithoutStat: 5 }], {
      paused: true,
    });
    await mon.tick();
    expect(raise.mock.calls.some(([a]) => a.alertname === STATS_TRIGGER_GAP_ALERT)).toBe(false);
    expect(resolve.mock.calls.some(([name]) => name === STATS_TRIGGER_GAP_ALERT)).toBe(false);
  });

  it('retains index evidence without inferring page staleness from the bulk watermark', async () => {
    // Source-only fixture: precise database-shaped times, not recovered times
    // from the historical originals, which did not retain their checkedAt.
    const checkedAt = '2026-09-11T18:25:09.123456789+00:00';
    const indexCeil = '2026-09-11T17:54:19.823456789+00:00';
    const { mon, raise, resolve } = harness([
      {
        ...LIVE_SAMPLE,
        checkedAt,
        indexCeil,
        indexLagSeconds: '1849.3',
        lastAudit: healthyAudit,
      },
      LIVE_SAMPLE,
    ]);
    await mon.tick();
    const alert = raise.mock.calls.find(([a]) => a.alertname === STATS_INDEX_LAG_ALERT)![0];
    expect(alert).toMatchObject({
      alertname: STATS_INDEX_LAG_ALERT,
      component: STATS_HEALTH_COMPONENT,
      severity: 'warning',
      summary: 'Bulk stats index watermark is 31 minutes old',
    });
    expect(alert.labels).toEqual({ lag_seconds: '1849' });
    expect(alert.description).toContain(`measuredAt=${checkedAt}; indexCeil=${indexCeil};`);
    expect(alert.description).toContain('lagSeconds=1849.3; thresholdSeconds=1800.');
    expect(alert.description).toContain('individual hand index rows may already be present');
    expect(alert.description).not.toContain('two or more ticks');
    expect(alert.description).not.toContain('every stats page is stale');
    expect(alert.description).not.toContain('1970-');

    await mon.tick();
    const recovery = resolve.mock.calls.find(([name]) => name === STATS_INDEX_LAG_ALERT)!;
    expect(recovery.slice(0, 2)).toEqual([STATS_INDEX_LAG_ALERT, STATS_HEALTH_COMPONENT]);
    expect(recovery[2]).toContain('watermark age is within the threshold');
    expect(recovery[2]).toContain(
      `measuredAt=${LIVE_SAMPLE.checkedAt}; indexCeil=${LIVE_SAMPLE.indexCeil};`
    );
    expect(recovery[2]).toContain('lagSeconds=600.5; thresholdSeconds=1800.');
    expect(recovery[2]).toContain('does not certify repair of all previously unindexed hands');
    expect(recovery[2]).not.toContain('caught up');
    expect(recovery[2]).not.toContain(checkedAt);
    expect(alert.description).toContain(`measuredAt=${checkedAt};`);
  });

  it('preserves recovery at the exact index threshold with a nonzero lag', async () => {
    const { mon, raise, resolve } = harness([
      { ...LIVE_SAMPLE, indexLagSeconds: STATS_INDEX_LAG_THRESHOLD_S },
    ]);
    await mon.tick();
    expect(raise).not.toHaveBeenCalled();
    const note = resolve.mock.calls.find(([name]) => name === STATS_INDEX_LAG_ALERT)![2];
    expect(note).toContain('lagSeconds=1800; thresholdSeconds=1800.');
    expect(note).toContain('within the threshold');
  });

  it.each([undefined, null, 'invalid', NaN, Infinity])(
    'does not resolve a raised index lag after unknown lag %j or a failed read',
    async (indexLagSeconds) => {
      const { mon, raise, resolve } = harness([
        { ...LIVE_SAMPLE, indexLagSeconds: 1849 },
        { ...LIVE_SAMPLE, indexLagSeconds },
        new Error('PGRST002'),
      ]);
      await mon.tick();
      await mon.tick();
      await mon.tick();
      expect(raise.mock.calls.filter(([a]) => a.alertname === STATS_INDEX_LAG_ALERT)).toHaveLength(
        1
      );
      expect(resolve.mock.calls.some(([name]) => name === STATS_INDEX_LAG_ALERT)).toBe(false);
      expect(mon.publish()?.lastError).toBe('PGRST002');
    }
  );

  it.each([
    [undefined, null],
    ['not-a-database-time', '2026-02-29T18:00:00Z'],
    [17, { timestamp: LIVE_SAMPLE.indexCeil }],
    ['x'.repeat(1000), 'x'.repeat(1000)],
  ])(
    'keeps unknown index times explicit without changing transitions',
    async (checkedAt, indexCeil) => {
      const { mon, raise, resolve } = harness([
        { ...LIVE_SAMPLE, checkedAt, indexCeil, indexLagSeconds: 1849 },
        { ...LIVE_SAMPLE, checkedAt, indexCeil, indexLagSeconds: 600.5 },
      ]);
      await mon.tick();
      await mon.tick();
      const alert = raise.mock.calls.find(([a]) => a.alertname === STATS_INDEX_LAG_ALERT)![0];
      const note = resolve.mock.calls.find(([name]) => name === STATS_INDEX_LAG_ALERT)![2];
      for (const text of [alert.description!, note]) {
        expect(text).toContain('measuredAt=unknown; indexCeil=unknown;');
        expect(text).not.toContain('1970-');
        expect(text).not.toContain('not-a-database-time');
        expect(text).not.toContain('2026-02-29');
        expect(text).not.toContain('xxx');
      }
      expect(alert.labels).toEqual({ lag_seconds: '1849' });
      expect(mon.publish()?.indexLagSeconds).toBe(600.5);
    }
  );

  it('keeps a parsed index decision when diagnostic ceiling inspection fails', async () => {
    let inspections = 0;
    const raw = {
      ...LIVE_SAMPLE,
      indexLagSeconds: 1849,
      get indexCeil() {
        if (++inspections > 1) throw new Error('DO_NOT_COPY_INDEX_DIAGNOSTIC_ERROR');
        return LIVE_SAMPLE.indexCeil;
      },
    };
    const { mon, raise } = harness([raw]);
    await mon.tick();
    const alert = raise.mock.calls.find(([a]) => a.alertname === STATS_INDEX_LAG_ALERT)![0];
    expect(alert.description).toContain(`measuredAt=${LIVE_SAMPLE.checkedAt}; indexCeil=unknown;`);
    expect(alert.description).toContain('lagSeconds=1849; thresholdSeconds=1800.');
    expect(alert.description).not.toContain('DO_NOT_COPY_INDEX_DIAGNOSTIC_ERROR');
    expect(mon.publish()?.lastError).toBeNull();
  });

  it('raises the trigger-gap alert when a recent hand has no stat row, resolves at zero', async () => {
    const { mon, raise, resolve } = harness([
      { ...LIVE_SAMPLE, recentHandsWithoutStat: 3 },
      { ...LIVE_SAMPLE, recentHandsWithoutStat: 0 },
    ]);
    await mon.tick();
    expect(raise.mock.calls.map((c) => c[0]?.alertname)).toContain(STATS_TRIGGER_GAP_ALERT);
    await mon.tick();
    expect(resolve).toHaveBeenCalledWith(
      STATS_TRIGGER_GAP_ALERT,
      STATS_HEALTH_COMPONENT,
      expect.any(String)
    );
  });

  it('retains the database measurement precision rather than the local clock', async () => {
    const checkedAt = '2026-09-12T07:42:10.123456789+00:00';
    const { mon, raise } = harness([
      { ...LIVE_SAMPLE, checkedAt, recentHands: 136, recentHandsWithoutStat: 136 },
    ]);
    await mon.tick();
    expect(raise).toHaveBeenCalledTimes(1);
    const alert = raise.mock.calls[0]![0];
    expect(alert.description).toContain(`database checkedAt=${checkedAt}`);
    expect(alert.description).toContain('recentHands=136; recentHandsWithoutStat=136');
    expect(alert.description).toContain('current source-contract reconstruction only');
    expect(alert.description).toContain('exact observed bounds unknown');
    expect(alert.description).not.toContain('1970-');
    expect(mon.publish()?.checkedAt).toBe(checkedAt);
    expect(alert.labels).toEqual({ hands_without_stat: '136' });
  });

  it.each([
    [0, '0 (empty sample)'],
    [12, '12'],
    ['12', '12'],
    [undefined, 'unknown'],
    [null, 'unknown'],
    [-1, 'unknown'],
    [1.5, 'unknown'],
    [NaN, 'unknown'],
    [Infinity, 'unknown'],
    [Number.MAX_SAFE_INTEGER + 1, 'unknown'],
    ['9007199254740993', 'unknown'],
    ['1.00000000000000000001', 'unknown'],
    ['1e3', 'unknown'],
    ['0x10', 'unknown'],
    [' 12 ', 'unknown'],
    ['0012', 'unknown'],
    ['not-a-count', 'unknown'],
    [{ count: 12 }, 'unknown'],
  ])(
    'describes zero-gap sample %j without changing its recovery decision',
    async (recentHands, expected) => {
      const raw = { ...LIVE_SAMPLE, recentHands, recentHandsWithoutStat: 0 };
      const { mon, raise, resolve, read } = harness([raw]);
      await mon.tick();
      expect(read).toHaveBeenCalledTimes(1);
      expect(raise).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledTimes(2);
      const call = resolve.mock.calls.find(([name]) => name === STATS_TRIGGER_GAP_ALERT)!;
      expect(call.slice(0, 2)).toEqual([STATS_TRIGGER_GAP_ALERT, STATS_HEALTH_COMPONENT]);
      expect(call[2]).toContain('Current stats gap is zero.');
      expect(call[2]).toContain(`recentHands=${expected};`);
      expect(call[2]).toContain('does not certify repair of previously missing hands');
      expect(call[2]).not.toContain('Every recent hand has a stat row');
      expect(mon.publish()?.recentHands).toBe(parseStatsHealth(raw, 'unused').recentHands);
    }
  );

  it.each([
    '2026-02-29T07:42:10Z',
    '2026-04-31T07:42:10Z',
    '1900-02-29T07:42:10Z',
    '2026-09-12T24:00:00Z',
    '2026-09-12T07:42:10+24:00',
    '2026-09-12T07:42:10',
    'not-a-database-time',
    '',
  ])(
    'does not relabel invalid database time %j as an observed time or fallback',
    async (checkedAt) => {
      const { mon, resolve } = harness([{ ...LIVE_SAMPLE, checkedAt }]);
      await mon.tick();
      const note = resolve.mock.calls.find(([name]) => name === STATS_TRIGGER_GAP_ALERT)![2];
      expect(note).toContain('database checkedAt=unknown (invalid string');
      expect(note).not.toContain('monitor fallback checkedAt=');
      if (checkedAt) expect(note).not.toContain(checkedAt);
      // Classification/public snapshot parsing is deliberately unchanged.
      expect(mon.publish()?.checkedAt).toBe(checkedAt);
    }
  );

  it.each(['2000-02-29T07:42:10.123456Z', '2024-02-29T07:42:10.123456-05:30'])(
    'retains valid leap-day measurement %s verbatim',
    async (checkedAt) => {
      const { mon, resolve } = harness([{ ...LIVE_SAMPLE, checkedAt }]);
      await mon.tick();
      const note = resolve.mock.calls.find(([name]) => name === STATS_TRIGGER_GAP_ALERT)![2];
      expect(note).toContain(`database checkedAt=${checkedAt}`);
      expect(note).not.toContain('monitor fallback');
    }
  );

  it.each([
    [undefined, 'missing'],
    [null, 'missing'],
    [17, 'invalid type'],
    [{ timestamp: LIVE_SAMPLE.checkedAt }, 'invalid type'],
  ])(
    'preserves missing/non-string time %j as explicit fallback provenance',
    async (checkedAt, reason) => {
      const { mon, resolve } = harness([{ ...LIVE_SAMPLE, checkedAt }]);
      await mon.tick();
      const note = resolve.mock.calls.find(([name]) => name === STATS_TRIGGER_GAP_ALERT)![2];
      expect(note).toContain(`database checkedAt=unknown (${reason})`);
      expect(note).toContain('monitor fallback checkedAt=1970-01-01T00:16:40.000Z');
      expect(mon.publish()?.checkedAt).toBe('1970-01-01T00:16:40.000Z');
    }
  );

  it('keeps all four existing transition identities, labels, counts and delivery order', async () => {
    const { mon, raise, resolve, read } = harness([
      {
        ...LIVE_SAMPLE,
        indexLagSeconds: 4000,
        recentHandsWithoutStat: 3,
        lastAudit: { ...healthyAudit, buttonDisagree: 2 },
        evCoverage7d: { allInShowdowns: 100, withoutEquity: 10, ratio: 0.9 },
      },
      { ...LIVE_SAMPLE, lastAudit: healthyAudit, evCoverage7d: LIVE_EV },
    ]);
    await mon.tick();
    await mon.tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(raise).toHaveBeenCalledTimes(4);
    expect(resolve).toHaveBeenCalledTimes(4);
    const order = [
      STATS_INDEX_LAG_ALERT,
      STATS_TRIGGER_GAP_ALERT,
      STATS_WITNESS_ALERT,
      STATS_EV_COVERAGE_ALERT,
    ];
    expect(raise.mock.calls.map(([alert]) => alert.alertname)).toEqual(order);
    expect(resolve.mock.calls.map(([name]) => name)).toEqual(order);
    expect(Math.max(...raise.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...resolve.mock.invocationCallOrder)
    );
    const { description, ...unchanged } = raise.mock.calls[1]![0];
    expect(unchanged).toEqual({
      alertname: STATS_TRIGGER_GAP_ALERT,
      severity: 'warning',
      component: STATS_HEALTH_COMPONENT,
      summary: '3 recent hand(s) have no stat row - stats publication is delayed',
      labels: { hands_without_stat: '3' },
    });
    expect(description).toContain(
      'Accepted atomic hands publish stats through hand_projection_outbox'
    );
    expect(resolve.mock.calls[1]!.slice(0, 2)).toEqual([
      STATS_TRIGGER_GAP_ALERT,
      STATS_HEALTH_COMPONENT,
    ]);
  });

  it('does not invent a transition for an unknown gap or a failed later read', async () => {
    const { mon, raise, resolve, read, advance } = harness([
      { ...LIVE_SAMPLE, recentHandsWithoutStat: 3 },
      { ...LIVE_SAMPLE, recentHandsWithoutStat: null, checkedAt: 'invalid' },
      new Error('PGRST002'),
    ]);
    await mon.tick();
    await mon.tick();
    const prior = mon.publish();
    const raiseCount = raise.mock.calls.length;
    const resolveCount = resolve.mock.calls.length;
    await mon.tick();
    expect(read).toHaveBeenCalledTimes(3);
    expect(raise).toHaveBeenCalledTimes(raiseCount);
    expect(resolve).toHaveBeenCalledTimes(resolveCount);
    expect(resolve.mock.calls.some(([name]) => name === STATS_TRIGGER_GAP_ALERT)).toBe(false);
    expect(mon.publish()?.checkedAt).toBe(prior?.checkedAt);
    expect(mon.publish()?.lastError).toBe('PGRST002');
    advance(STATS_HEALTH_PERIOD_MS + 1);
    expect(mon.publish()?.stale).toBe(true);
  });

  it('does not change classification when a coerced raw count is unsuitable as exact evidence', async () => {
    const { mon, raise } = harness([
      { ...LIVE_SAMPLE, recentHands: '1e3', recentHandsWithoutStat: '1e3' },
    ]);
    await mon.tick();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0].labels).toEqual({ hands_without_stat: '1000' });
    expect(raise.mock.calls[0]![0].description).toContain(
      'recentHands=unknown; recentHandsWithoutStat=unknown'
    );
    expect(mon.publish()?.recentHands).toBe(1000);
    expect(mon.publish()?.recentHandsWithoutStat).toBe(1000);
  });

  it('does not lose the original transition if diagnostic inspection fails', async () => {
    let inspections = 0;
    const raw = {
      ...LIVE_SAMPLE,
      recentHandsWithoutStat: 3,
      get checkedAt() {
        if (++inspections > 1) throw new Error('DO_NOT_COPY_DIAGNOSTIC_ERROR');
        return LIVE_SAMPLE.checkedAt;
      },
    };
    const { mon, raise, resolve, read } = harness([raw]);
    await mon.tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0].labels).toEqual({ hands_without_stat: '3' });
    expect(raise.mock.calls[0]![0].description).toContain(
      'Current measurement details unavailable'
    );
    expect(raise.mock.calls[0]![0].description).not.toContain('DO_NOT_COPY_DIAGNOSTIC_ERROR');
    expect(mon.publish()?.checkedAt).toBe(LIVE_SAMPLE.checkedAt);
    expect(mon.publish()?.lastError).toBeNull();
  });

  it('does not deliver measurement text from a read after its generation stops', async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: unknown) => void;
      const read = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            complete = resolve;
          })
      );
      const raise = vi.fn(async () => true);
      const resolve = vi.fn(async () => true);
      const mon = new StatsHealthMonitor({
        read,
        raise,
        resolve,
        paused: () => false,
        log: () => {},
      });
      mon.start();
      expect(read).toHaveBeenCalledTimes(1);
      const stopping = mon.stop();
      complete({
        ...LIVE_SAMPLE,
        checkedAt: '2026-09-12T07:42:10.123456Z',
        recentHandsWithoutStat: 3,
      });
      await stopping;
      await mon.tick();
      expect(read).toHaveBeenCalledTimes(1);
      expect(raise).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(mon.publish()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds firing and recovery evidence without serializing raw input', async () => {
    const untrusted = 'DO_NOT_COPY_RAW'.repeat(10_000);
    const { mon, raise, resolve } = harness([
      {
        ...LIVE_SAMPLE,
        checkedAt: untrusted,
        recentHands: untrusted,
        recentHandsWithoutStat: Number.MAX_VALUE,
        extra: untrusted,
      },
      {
        ...LIVE_SAMPLE,
        checkedAt: '9999-12-31T23:59:59.123456789-23:59',
        recentHands: Number.MAX_SAFE_INTEGER,
        recentHandsWithoutStat: 0,
      },
    ]);
    await mon.tick();
    await mon.tick();
    const alert = raise.mock.calls[0]![0];
    const note = resolve.mock.calls.find(([name]) => name === STATS_TRIGGER_GAP_ALERT)![2];
    expect(alert.labels).toEqual({ hands_without_stat: String(Number.MAX_VALUE) });
    expect(alert.description).toContain('recentHands=unknown; recentHandsWithoutStat=unknown');
    expect(alert.description).not.toContain('DO_NOT_COPY_RAW');
    expect(
      alert.description!.split('Current measurement:')[1]!.length + 'Current measurement:'.length
    ).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(JSON.stringify(alert), 'utf8')).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(note, 'utf8')).toBeLessThanOrEqual(768);
    expect(note).toContain('does not certify repair of previously missing hands');
    expect(note).not.toContain('DO_NOT_COPY_RAW');
  });

  it('raises the witness alert on any non-zero audit count, and resolves on a clean one', async () => {
    const { mon, raise, resolve } = harness([
      { ...LIVE_SAMPLE, lastAudit: { ...healthyAudit, buttonDisagree: 2 } },
      { ...LIVE_SAMPLE, lastAudit: healthyAudit },
    ]);
    await mon.tick();
    const witness = raise.mock.calls.find((c) => c[0]?.alertname === STATS_WITNESS_ALERT);
    expect(witness).toBeTruthy();
    expect(witness?.[0].labels?.button_disagree).toBe('2');
    await mon.tick();
    expect(resolve).toHaveBeenCalledWith(
      STATS_WITNESS_ALERT,
      STATS_HEALTH_COMPONENT,
      expect.any(String)
    );
  });

  it('a seat with no index row is a witness disagreement too (horses are players)', async () => {
    const { mon, raise } = harness([
      { ...LIVE_SAMPLE, lastAudit: { ...healthyAudit, playerHandsWithoutIdx: 1050 } },
    ]);
    await mon.tick();
    const witness = raise.mock.calls.find((c) => c[0]?.alertname === STATS_WITNESS_ALERT);
    expect(witness?.[0].labels?.player_hands_without_idx).toBe('1050');
    expect(witness?.[0].summary).toContain('1050 no-index');
    expect(mon.prometheusLines().join('\n')).toContain('poker_stats_player_hands_without_idx 1050');
  });

  it('parses the phase 3 EV coverage block and exposes it as gauges', async () => {
    const s = parseStatsHealth({ ...LIVE_SAMPLE, evCoverage7d: LIVE_EV }, 'fb');
    expect(s.evCoverage7d).toEqual(LIVE_EV);
    expect(parseStatsHealth(LIVE_SAMPLE, 'fb').evCoverage7d).toBeNull();
    const { mon } = harness([{ ...LIVE_SAMPLE, evCoverage7d: LIVE_EV }]);
    await mon.tick();
    const lines = mon.prometheusLines().join('\n');
    expect(lines).toContain('poker_stats_ev_coverage_7d 0.9986');
    expect(lines).toContain('poker_stats_allin_showdowns_7d 715');
  });

  it('the measured 99.86% coverage raises nothing and resolves the EV alert', async () => {
    const { mon, raise, resolve } = harness([{ ...LIVE_SAMPLE, evCoverage7d: LIVE_EV }]);
    await mon.tick();
    expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_EV_COVERAGE_ALERT)).toBe(false);
    expect(resolve).toHaveBeenCalledWith(
      STATS_EV_COVERAGE_ALERT,
      STATS_HEALTH_COMPONENT,
      expect.any(String)
    );
  });

  it('raises the EV alert below the bar once the sample is big enough, never on a quiet week', async () => {
    const low = { allInShowdowns: STATS_EV_COVERAGE_MIN_SAMPLE, withoutEquity: 10, ratio: 0.8 };
    expect(low.ratio).toBeLessThan(STATS_EV_COVERAGE_MIN_RATIO);
    const { mon, raise } = harness([
      {
        ...LIVE_SAMPLE,
        evCoverage7d: { ...low, allInShowdowns: STATS_EV_COVERAGE_MIN_SAMPLE - 1 },
      },
      { ...LIVE_SAMPLE, evCoverage7d: low },
    ]);
    await mon.tick();
    expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_EV_COVERAGE_ALERT)).toBe(false);
    await mon.tick();
    const ev = raise.mock.calls.find((c) => c[0]?.alertname === STATS_EV_COVERAGE_ALERT);
    expect(ev).toBeTruthy();
    expect(ev?.[0].labels?.ratio).toBe('0.8000');
    expect(ev?.[0].labels?.without_equity_7d).toBe('10');
    expect(ev?.[0].summary).toContain('80.0%');
    expect(ev?.[0].description).toContain('all_in_equity IS NULL');
  });

  it('the first cut of the measure (98.46%, side pots counted as gaps) WOULD have paged: that is why the audit was refined', async () => {
    const { mon, raise } = harness([
      { ...LIVE_SAMPLE, evCoverage7d: { allInShowdowns: 715, withoutEquity: 11, ratio: 0.9846 } },
    ]);
    await mon.tick();
    expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_EV_COVERAGE_ALERT)).toBe(true);
  });

  it('does not touch the EV alert when the week had no all-in showdowns (ratio null)', async () => {
    const { mon, raise, resolve } = harness([
      { ...LIVE_SAMPLE, evCoverage7d: { allInShowdowns: 0, withoutEquity: 0, ratio: null } },
    ]);
    await mon.tick();
    expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_EV_COVERAGE_ALERT)).toBe(false);
    expect(resolve.mock.calls.some((c) => c[0] === STATS_EV_COVERAGE_ALERT)).toBe(false);
    expect(mon.prometheusLines().join('\n')).toContain('poker_stats_ev_coverage_7d NaN');
  });

  it('does not touch the witness alert at all when no audit has run yet', async () => {
    const { mon, raise, resolve } = harness([LIVE_SAMPLE]);
    await mon.tick();
    expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_WITNESS_ALERT)).toBe(false);
    expect(resolve.mock.calls.some((c) => c[0] === STATS_WITNESS_ALERT)).toBe(false);
  });

  it('a failed read keeps the last snapshot, marks it stale after one period, and never throws', async () => {
    const { mon, advance } = harness([LIVE_SAMPLE, new Error('PGRST002')]);
    await mon.tick();
    await expect(mon.tick()).resolves.toBeUndefined();
    let p = mon.publish();
    expect(p?.indexLagSeconds).toBe(600.5);
    expect(p?.lastError).toBe('PGRST002');
    expect(p?.stale).toBe(false);
    advance(STATS_HEALTH_PERIOD_MS + 1);
    p = mon.publish();
    expect(p?.stale).toBe(true);
  });

  it('emits Prometheus gauges with NaN before any read and real values after', async () => {
    const { mon } = harness([{ ...LIVE_SAMPLE, lastAudit: healthyAudit }]);
    let lines = mon.prometheusLines().join('\n');
    expect(lines).toContain('poker_stats_index_lag_seconds NaN');
    expect(lines).toContain('# TYPE poker_stats_index_lag_seconds gauge');
    await mon.tick();
    lines = mon.prometheusLines().join('\n');
    expect(lines).toContain('poker_stats_index_lag_seconds 600.5');
    expect(lines).toContain('poker_stats_recent_hands_without_stat 0');
    expect(lines).toContain('poker_stats_witness_disagreements 0');
    expect(lines).toContain('poker_stats_human_hands_without_facts 0');
    expect(lines).toContain('poker_stats_money_repair_done 0');
    expect(lines).toMatch(/poker_stats_health_age_seconds \d+/);
  });

  it('start() reads immediately and stop() clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const { mon, read } = harness([LIVE_SAMPLE]);
      mon.start(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(read).toHaveBeenCalledTimes(3);
      mon.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('overlapping ticks do not stack reads', async () => {
    let release: (() => void) | null = null;
    const read = vi.fn<() => Promise<unknown>>(
      () =>
        new Promise<unknown>((res) => {
          release = () => res(LIVE_SAMPLE);
        })
    );
    const mon = new StatsHealthMonitor({
      read,
      raise: async () => true,
      resolve: async () => true,
      paused: () => false,
      log: () => {},
    });
    const first = mon.tick();
    const second = mon.tick();
    expect(read).toHaveBeenCalledTimes(1);
    release!();
    await Promise.all([first, second]);
    expect(mon.publish()?.indexLagSeconds).toBe(600.5);
  });
});
