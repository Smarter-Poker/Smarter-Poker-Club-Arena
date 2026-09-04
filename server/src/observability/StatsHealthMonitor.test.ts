import { describe, it, expect, vi } from 'vitest';
import {
  StatsHealthMonitor,
  parseStatsHealth,
  type StatsHealthAlert,
  STATS_INDEX_LAG_ALERT,
  STATS_TRIGGER_GAP_ALERT,
  STATS_WITNESS_ALERT,
  STATS_HEALTH_COMPONENT,
  STATS_INDEX_LAG_THRESHOLD_S,
  STATS_HEALTH_PERIOD_MS,
} from './StatsHealthMonitor.js';

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

  it('raises the lag alert past 30 minutes, with the lag in the labels', async () => {
    const { mon, raise } = harness([
      { ...LIVE_SAMPLE, indexLagSeconds: STATS_INDEX_LAG_THRESHOLD_S + 1 },
    ]);
    await mon.tick();
    expect(raise).toHaveBeenCalledTimes(1);
    const a = raise.mock.calls[0]?.[0];
    expect(a?.alertname).toBe(STATS_INDEX_LAG_ALERT);
    expect(a?.component).toBe(STATS_HEALTH_COMPONENT);
    expect(a?.labels?.lag_seconds).toBe(String(STATS_INDEX_LAG_THRESHOLD_S + 1));
  });

  it('does NOT raise the lag alert while a maintenance break is on (CLAUDE.md 13.6)', async () => {
    const { mon, raise } = harness([{ ...LIVE_SAMPLE, indexLagSeconds: 4000 }], {
      paused: true,
    });
    await mon.tick();
    expect(raise).not.toHaveBeenCalled();
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
