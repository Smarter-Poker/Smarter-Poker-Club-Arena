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
  STATS_TRIGGER_GAP_MIN_SHARE,
  STATS_TRIGGER_GAP_MIN_HANDS,
  STATS_TRIGGER_GAP_RAISE_TICKS,
  STATS_TRIGGER_GAP_CLEAR_TICKS,
  STATS_LIVE_WRITER_BACKLOG_GRACE_S,
  STATS_LIVE_WRITER_SAMPLE_MAX_AGE_S,
  type StatsWriterBacklog,
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

function harness(
  reads: unknown[],
  opts: { paused?: boolean; backlog?: StatsWriterBacklog | null | 'absent' } = {}
) {
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
    // 'absent' = the dep is not wired at all; null = it is wired and answers
    // null; undefined = the default, a projector that is keeping up. `??` is
    // wrong here: it collapses the null case into the default and hides the
    // very outcome these cases exist to test.
    ...(opts.backlog === 'absent'
      ? {}
      : {
          liveWriterBacklog: (): StatsWriterBacklog | null =>
            opts.backlog === undefined || opts.backlog === 'absent'
              ? DRAINED_OUTBOX(clock)
              : opts.backlog,
        }),
  });
  return { mon, raise, resolve, read, advance: (ms: number) => (clock += ms) };
}

/** A projector that is keeping up: nothing pending, sampled just now. */
const DRAINED_OUTBOX = (now: number): StatsWriterBacklog => ({
  depth: 0,
  oldestAgeSeconds: 0,
  sampledAt: now,
});

/** The window is two minutes of dealing; at the measured quiet hour ~55 hands. */
const BUSY_WINDOW = 1109;

/** Drive `n` reads of the same payload. */
async function ticks(mon: StatsHealthMonitor, n: number): Promise<void> {
  for (let k = 0; k < n; k += 1) await mon.tick();
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

  /**
   * THE STAT GAP, REWRITTEN 2026-09-12.
   *
   * This block used to be one test: gap of 3 in a window of 897 raises on the
   * first read, gap of 0 resolves on the next. That is the behaviour that
   * flapped 32 times on the night of 2026-09-11 and reported "1 recent hand"
   * for a window holding 1,109. Every case below is one half of that defect.
   */
  describe('the stat gap is a share, it must persist, and it names its writer', () => {
    const gapOf = (missing: number, hands = BUSY_WINDOW) => ({
      ...LIVE_SAMPLE,
      recentHands: hands,
      recentHandsWithoutStat: missing,
    });

    it('a gap under the bar never raises, however many reads it takes', async () => {
      // 3 of 1,109 is 0.27%: the old code raised on this, on read one.
      const { mon, raise } = harness([gapOf(3)]);
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS * 3);
      expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)).toBe(false);
    });

    it('a gap over the bar waits for STATS_TRIGGER_GAP_RAISE_TICKS consecutive reads', async () => {
      const missing = Math.ceil(BUSY_WINDOW * (STATS_TRIGGER_GAP_MIN_SHARE + 0.02));
      const { mon, raise } = harness([gapOf(missing)]);
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS - 1);
      expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)).toBe(false);
      await mon.tick();
      expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)).toBe(true);
    });

    it('one clean read inside the breach resets the count: a 15-minute compensator cannot raise it', async () => {
      const missing = Math.ceil(BUSY_WINDOW * 0.7); // the measured stall: 69-100%
      const reads = [];
      // Four dirty, one clean, four dirty: the shape of the sawtooth.
      for (let k = 0; k < 4; k += 1) reads.push(gapOf(missing));
      reads.push(gapOf(0));
      for (let k = 0; k < 4; k += 1) reads.push(gapOf(missing));
      const { mon, raise } = harness(reads);
      await ticks(mon, 9);
      expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)).toBe(false);
    });

    it('resolves only after STATS_TRIGGER_GAP_CLEAR_TICKS consecutive clean reads', async () => {
      const missing = Math.ceil(BUSY_WINDOW * 0.7);
      const dirty = Array.from({ length: STATS_TRIGGER_GAP_RAISE_TICKS }, () => gapOf(missing));
      const { mon, raise, resolve } = harness([...dirty, gapOf(0)]);
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS);
      expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)).toBe(true);
      await ticks(mon, STATS_TRIGGER_GAP_CLEAR_TICKS - 1);
      expect(resolve.mock.calls.some((c) => c[0] === STATS_TRIGGER_GAP_ALERT)).toBe(false);
      await mon.tick();
      expect(resolve).toHaveBeenCalledWith(
        STATS_TRIGGER_GAP_ALERT,
        STATS_HEALTH_COMPONENT,
        expect.any(String)
      );
    });

    it('reports the share and the denominator, never a bare count', async () => {
      const missing = Math.ceil(BUSY_WINDOW * 0.7);
      const { mon, raise } = harness([gapOf(missing)]);
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS);
      const a = raise.mock.calls.find((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)?.[0];
      expect(a?.summary).toContain(`of ${BUSY_WINDOW}`);
      expect(a?.summary).toMatch(/\d+\.\d% of recent hands/);
      expect(a?.labels?.recent_hands).toBe(String(BUSY_WINDOW));
      expect(a?.labels?.share).toBe((missing / BUSY_WINDOW).toFixed(4));
    });

    it('never names a Postgres log line that cannot exist on the atomic path', async () => {
      const { mon, raise } = harness([gapOf(Math.ceil(BUSY_WINDOW * 0.7))]);
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS);
      const a = raise.mock.calls.find((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)?.[0];
      // The remediation that cost a full investigation on 2026-09-11.
      expect(a?.description).not.toMatch(
        /Read the Postgres log\s+for "trg_ca_stats_live_from_hand:"/
      );
      expect(a?.description).toContain('fn_project_hand_side_effects');
      expect(a?.description).toContain('hand_projection_outbox');
      expect(a?.description).toContain('app.atomic_hand_commit');
    });

    it('a window too small to answer neither raises nor resolves', async () => {
      // During the 2026-09-11 kill storm the window held single digits: that
      // is "the fleet stopped dealing", which is another alarm's job.
      const { mon, raise, resolve } = harness([
        gapOf(STATS_TRIGGER_GAP_MIN_HANDS - 1, STATS_TRIGGER_GAP_MIN_HANDS - 1),
      ]);
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS * 2);
      expect(raise.mock.calls.some((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)).toBe(false);
      expect(resolve.mock.calls.some((c) => c[0] === STATS_TRIGGER_GAP_ALERT)).toBe(false);
      expect(mon.prometheusLines().join('\n')).toContain(
        'poker_stats_recent_hands_without_stat_ratio NaN'
      );
    });

    it('a backed-up outbox is named as the writer that is behind', async () => {
      const { mon, raise } = harness([gapOf(Math.ceil(BUSY_WINDOW * 0.7))], {
        backlog: {
          depth: 100888,
          oldestAgeSeconds: STATS_LIVE_WRITER_BACKLOG_GRACE_S + 1,
          sampledAt: 1_000_000,
        },
      });
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS);
      const a = raise.mock.calls.find((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)?.[0];
      expect(a?.labels?.live_writer).toBe('behind');
      expect(a?.labels?.outbox_depth).toBe('100888');
      expect(a?.description).toContain('BEHIND');
    });

    it('a drained outbox rules the drain OUT, so the gap is a writer defect', async () => {
      const { mon, raise } = harness([gapOf(Math.ceil(BUSY_WINDOW * 0.7))]);
      await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS);
      const a = raise.mock.calls.find((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)?.[0];
      expect(a?.labels?.live_writer).toBe('current');
      expect(a?.description).toContain('not a drain backlog');
    });

    it('an unsampled or stale backlog reads as UNKNOWN, never as current', async () => {
      const missing = Math.ceil(BUSY_WINDOW * 0.7);
      for (const backlog of [
        'absent' as const,
        null,
        { depth: -1, oldestAgeSeconds: 0, sampledAt: 0 },
        { depth: 0, oldestAgeSeconds: 0, sampledAt: 1 }, // sampled at the epoch: ancient
      ]) {
        const { mon, raise } = harness([gapOf(missing)], { backlog });
        await ticks(mon, STATS_TRIGGER_GAP_RAISE_TICKS);
        const a = raise.mock.calls.find((c) => c[0]?.alertname === STATS_TRIGGER_GAP_ALERT)?.[0];
        expect(a?.labels?.live_writer, JSON.stringify(backlog)).toBe('unknown');
        expect(a?.description).toContain('UNKNOWN');
      }
      // and the staleness bar is the one the constant names
      expect(STATS_LIVE_WRITER_SAMPLE_MAX_AGE_S).toBeGreaterThan(0);
    });

    it('publishes the share and the breaching-read count as gauges', async () => {
      const { mon } = harness([gapOf(Math.ceil(BUSY_WINDOW * 0.7))]);
      await ticks(mon, 2);
      const lines = mon.prometheusLines().join('\n');
      expect(lines).toContain('poker_stats_stat_gap_breaching_reads 2');
      expect(lines).toMatch(/poker_stats_recent_hands_without_stat_ratio 0\.7/);
    });
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
