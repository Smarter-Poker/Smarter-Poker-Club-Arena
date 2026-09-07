/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE SERIES PER METRIC NAME, OR EVERY FLEET ALARM IS READING ONE TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GameServer.getPrometheusMetrics()` called `getPrometheusMetrics()` on EVERY
 * table engine and concatenated the results, stripping only the `#` comment
 * lines. Each engine's exposition carries fourteen GLOBAL gauges with no
 * distinguishing label, so a fleet of 272 engines emitted 272 samples of the
 * same timeseries in a single scrape.
 *
 * Prometheus keeps the last of those and drops the other 271. MEASURED on
 * production 2026-09-07, with 272 tables dealing and the fleet at roughly
 * 27,000 hands an hour, `/api/v1/query` answered:
 *
 *     poker_active_tables      1      the truth was 272
 *     poker_active_players     6      one table's seats
 *     poker_hands_dealt_total  100    one table's ring buffer, saturated
 *
 * So every fleet-level rule in infra/monitoring was reading one arbitrary
 * table and calling it the platform:
 *
 *   - `EngineHandsStopped` / `EngineNoHandsDealt` are
 *     `sum(increase(poker_hands_dealt_total[5m])) == 0`, and that counter was
 *     `tableTimings.length` — a RING BUFFER capped at 100. Every dealing table
 *     reaches 100 within a couple of minutes and never moves again, so the
 *     increase is 0 forever on a perfectly healthy engine. It had been firing
 *     continuously for over three hours when this was found. An alarm that is
 *     always on is an alarm that gets muted (CLAUDE.md 10.84).
 *   - `EngineFleetShrank` is
 *     `poker_active_tables < 0.5 * avg_over_time(poker_active_tables[1h] offset 1h)`,
 *     which compares 1 with 1 and can never fire. It is the alarm that should
 *     have caught 2026-09-07 04:05 UTC, when the fleet lost about 80% of its
 *     throughput for two hours and paged nobody.
 *
 * THREE PINS: globals appear exactly once, per-table lines always carry a
 * `table_id`, and the hands counter is monotonic rather than a buffer length.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EngineTelemetry } from './EngineTelemetry.js';

// The fleet counters are process-wide and monotonic by design, so each case
// starts from a clean slate rather than inheriting the previous one's total.
beforeEach(() => EngineTelemetry.__resetFleetCountersForTest());

/** A telemetry instance that has dealt `hands` hands on one table. */
function engineWith(tableId: string, hands: number, seats = 6): EngineTelemetry {
  const t = new EngineTelemetry();
  t.recordPlayerCount(tableId, seats);
  for (let i = 0; i < hands; i++) t.recordHandTiming(tableId, 5, 2, 7_000);
  return t;
}

/** Every non-comment, non-blank sample line. */
const samples = (text: string): string[] => text.split('\n').filter((l) => l && !l.startsWith('#'));

/** The metric name of a sample line, labels stripped. */
const nameOf = (line: string): string => line.split(/[{ ]/)[0];

describe('the fleet exposition', () => {
  it('emits each global metric exactly once, however many engines there are', () => {
    const engines = Array.from({ length: 40 }, (_, i) => engineWith(`table-${i}`, 3));
    const out = EngineTelemetry.renderFleetMetrics(engines);

    const unlabelled = samples(out).filter((l) => !l.includes('{'));
    const counts = new Map<string, number>();
    for (const line of unlabelled) {
      const n = nameOf(line);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()].filter(([, c]) => c > 1);
    expect(
      duplicated,
      `these global metrics were emitted more than once, so Prometheus keeps ` +
        `one arbitrary sample and every rule written on them is reading one table: ` +
        JSON.stringify(duplicated)
    ).toEqual([]);

    // And it is not empty-by-accident: the globals really are there.
    expect(counts.get('poker_active_tables')).toBe(1);
    expect(counts.get('poker_hands_dealt_total')).toBe(1);
    expect(counts.get('poker_uptime_seconds')).toBe(1);
  });

  it('aggregates the fleet rather than reporting whichever engine came last', () => {
    const engines = [engineWith('a', 4, 6), engineWith('b', 7, 5), engineWith('c', 2, 3)];
    const out = EngineTelemetry.renderFleetMetrics(engines);
    const value = (name: string) =>
      Number(
        samples(out)
          .find((l) => nameOf(l) === name && !l.includes('{'))
          ?.split(' ')[1]
      );

    expect(value('poker_active_tables')).toBe(3);
    expect(value('poker_active_players')).toBe(6 + 5 + 3);
    expect(value('poker_hands_dealt_total')).toBe(4 + 7 + 2);
  });

  it('gives every per-table sample a table_id, so tables never collide either', () => {
    const engines = [engineWith('a', 3), engineWith('b', 3)];
    const out = EngineTelemetry.renderFleetMetrics(engines);
    const perTable = samples(out).filter((l) => nameOf(l).startsWith('poker_table_'));
    expect(perTable.length).toBeGreaterThan(0);
    for (const line of perTable) {
      expect(line, `${line} carries no table_id`).toMatch(/\{table_id="[^"]+"\}/);
    }
    // Two engines, one table each, three metrics each.
    expect(new Set(perTable.map((l) => l.match(/table_id="([^"]+)"/)![1]))).toEqual(
      new Set(['a', 'b'])
    );
  });
});

describe('poker_hands_dealt_total', () => {
  it('is a counter, not the length of a ring buffer capped at 100', () => {
    // THE BUG, in one assertion. tableTimings keeps the last 100 hands; the
    // counter used to be its length, so it pinned at 100 and
    // `increase(...[5m])` was 0 forever on a fleet dealing 27,000 an hour.
    const t = engineWith('busy', 250);
    expect(t.getSnapshot().global.totalHandsDealt).toBe(250);

    const out = EngineTelemetry.renderFleetMetrics([t]);
    const line = samples(out).find(
      (l) => nameOf(l) === 'poker_hands_dealt_total' && !l.includes('{')
    );
    expect(line).toBe('poker_hands_dealt_total 250');

    const perTable = samples(out).find((l) => nameOf(l) === 'poker_table_hands_dealt');
    expect(perTable).toBe('poker_table_hands_dealt{table_id="busy"} 250');
  });

  it('never goes backwards while the engine is alive', () => {
    const t = engineWith('x', 120);
    const first = t.getSnapshot().global.totalHandsDealt;
    for (let i = 0; i < 30; i++) t.recordHandTiming('x', 5, 2, 7_000);
    expect(t.getSnapshot().global.totalHandsDealt).toBe(first + 30);
  });

  /**
   * ── THE SECOND BUG, FOUND IN PRODUCTION HOURS AFTER THE FIRST FIX ────────
   *
   * Making the exposition fleet-wide was right, but the counters were SUMMED
   * over the live engine set — and engines are destroyed constantly as tables
   * close. Every retirement dropped the sum, Prometheus read each drop as a
   * process restart, and `increase()` added the whole post-drop value back.
   *
   * Measured on production at 15-second resolution over 15 minutes: 61
   * samples, 11 drops (5667->5610, 5689->5624, 5962->5911). Over the same
   * window `increase(poker_hands_dealt_total[5m])` reported 22,663 hands
   * against a true 1,260 in `hand_history` — an 18x over-count that would have
   * made `EngineFleetThroughputCollapsed` unable to ever fire.
   */
  it('does not go backwards when a table closes and its engine is retired', () => {
    const a = engineWith('a', 100);
    const b = engineWith('b', 100);
    const total = (engines: EngineTelemetry[]) =>
      Number(
        samples(EngineTelemetry.renderFleetMetrics(engines))
          .find((l) => nameOf(l) === 'poker_hands_dealt_total' && !l.includes('{'))!
          .split(' ')[1]
      );

    expect(total([a, b])).toBe(200);

    // Table b closes. Its engine leaves the map — exactly what happens seven
    // times over in GameServer. The fleet total must NOT fall to 100.
    const after = total([a]);
    expect(
      after,
      `the counter fell from 200 to ${after} when an engine was retired. ` +
        'Prometheus reads any fall in a counter as a restart and adds the whole ' +
        'value back, which is how increase() came to over-report 18x.'
    ).toBeGreaterThanOrEqual(200);

    // And it keeps counting the survivor's new hands on top.
    for (let i = 0; i < 25; i++) a.recordHandTiming('a', 5, 2, 7_000);
    expect(total([a])).toBe(225);

    // A brand-new table opening later adds to the total, never resets it.
    const c = engineWith('c', 10);
    expect(total([a, c])).toBe(235);
  });

  it('uptime is the PROCESS, so retiring a table cannot look like a restart', () => {
    // `EngineRestartLoop` alerts on `resets(poker_uptime_seconds[30m]) > 3`.
    // Taking the max of per-engine ages made that value fall whenever the
    // OLDEST engine was retired - a table closing, not a restart.
    const uptime = (engines: EngineTelemetry[]) =>
      Number(
        samples(EngineTelemetry.renderFleetMetrics(engines))
          .find((l) => nameOf(l) === 'poker_uptime_seconds' && !l.includes('{'))!
          .split(' ')[1]
      );
    const withEngines = uptime([engineWith('a', 5), engineWith('b', 5)]);
    const withNone = uptime([]);
    expect(withNone).toBeGreaterThanOrEqual(withEngines);
    // And it is the real process clock, not an engine's age.
    expect(Math.abs(withNone - Math.round(process.uptime()))).toBeLessThanOrEqual(2);
  });

  it('the violation counters are banked the same way', () => {
    const a = new EngineTelemetry();
    // One violation: processing over the 50ms threshold.
    a.recordActionProcessingTime('t', 'u', 'bet', 500, null);
    const read = (engines: EngineTelemetry[], type: string) =>
      Number(
        samples(EngineTelemetry.renderFleetMetrics(engines))
          .find((l) => l.startsWith(`poker_threshold_violations_total{type="${type}"}`))!
          .split(' ')[1]
      );
    expect(read([a], 'action_processing')).toBe(1);
    // The engine is retired; the violation it recorded must not un-happen.
    expect(read([], 'action_processing')).toBe(1);
  });

  it('still reports a rate from the sampled window, not from the lifetime count', () => {
    // handsPerHour is a RATE and must keep using the ring buffer, or a
    // long-lived table's rate would be its whole history divided by the last
    // hundred hands' span.
    const t = engineWith('y', 300);
    const table = t.getSnapshot().tables.find((x) => x.tableId === 'y')!;
    expect(table.handsDealt).toBe(300);
    expect(Number.isFinite(table.handsPerHour)).toBe(true);
  });
});
