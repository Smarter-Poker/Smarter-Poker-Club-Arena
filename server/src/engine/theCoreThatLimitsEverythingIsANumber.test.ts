/**
 * THE CORE THAT LIMITS EVERYTHING IS A NUMBER (2026-09-06).
 *
 * The engine is one Node core and CLAUDE.md calls that the ceiling. Two
 * defects kept it unmeasurable:
 *
 *   1. `EquityLoadGovernor` sampled the loop only inside `current()`, which
 *      is called from `simulateEquity` - so the delay was read when a horse
 *      happened to be thinking, and at no other time. A loop saturated by
 *      settlement, broadcasts, logging or a boot adopting 195 tables was
 *      never sampled, which is precisely when it should shed load. The
 *      module's own docblock claimed "once a second" and the code did not.
 *   2. The reading never left the process. It lived in
 *      `equityGovernor.snapshot()` inside the /health JSON - no series, no
 *      chart, no alert. `HorseDataLedger` says so: "the ONLY visibility the
 *      governor has outside the GameServer status payload".
 *
 * Both are why a 27-second cluster pass read as a database problem for six
 * measurements before the engine was even a suspect.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { equityGovernor, scaleForLoopDelay } from './EquityLoadGovernor.js';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');
const GOV = read('EquityLoadGovernor.ts');
const SERVER = read('../GameServer.ts');
const INSTRUMENTS = read('../observability/engineInstruments.ts');

/* The singleton is the only instance the process has; the class is module
   private on purpose. Every test here stops the sampler it started, and the
   timer is unref'd, so nothing is left running. */
afterEach(() => equityGovernor.stopSampling());

describe('the sample is on a clock, not on a horse turn', () => {
  it('exposes a sampler that can be started and stopped', () => {
    expect(typeof equityGovernor.startSampling).toBe('function');
    expect(typeof equityGovernor.stopSampling).toBe('function');
    // Idempotent, and stopping one that never started is not an error.
    equityGovernor.startSampling();
    equityGovernor.startSampling();
    equityGovernor.stopSampling();
    equityGovernor.stopSampling();
  });

  it("the timer is unref'd, so it can never hold the process open", () => {
    expect(GOV).toContain('this.timer.unref?.();');
  });

  it('a reading it could not take does not stop the next one (10.86)', () => {
    const body = GOV.slice(
      GOV.indexOf('startSampling(): void {'),
      GOV.indexOf('stopSampling(): void {')
    );
    expect(body).toContain('try {');
    expect(body).toContain('catch');
  });

  it('current() still samples on demand when no timer runs, so nothing changes for a test', () => {
    expect(GOV).toContain('return this.sample(now);');
  });

  it('the scale table is untouched - this changes WHEN it is read, not what it decides', () => {
    expect(scaleForLoopDelay(0)).toBe(1);
    expect(scaleForLoopDelay(39)).toBe(1);
    expect(scaleForLoopDelay(40)).toBe(0.6);
    expect(scaleForLoopDelay(119)).toBe(0.6);
    expect(scaleForLoopDelay(120)).toBe(0.35);
    expect(scaleForLoopDelay(300)).toBe(0.2);
    expect(scaleForLoopDelay(Number.NaN)).toBe(1);
  });

  it('a snapshot is finite and in range even before anything has been sampled', () => {
    const s = equityGovernor.snapshot();
    expect(Number.isFinite(s.p50Ms)).toBe(true);
    expect(Number.isFinite(s.p99Ms)).toBe(true);
    expect(s.scale).toBeGreaterThan(0);
    expect(s.scale).toBeLessThanOrEqual(1);
  });
});

describe('the number leaves the process', () => {
  it('three always-on gauges: the delay, its tail, and the scale it produced', () => {
    expect(INSTRUMENTS).toContain("alwaysOnRegistry.gauge(\n  'poker_event_loop_delay_p50_ms'");
    expect(INSTRUMENTS).toContain("'poker_event_loop_delay_p99_ms'");
    expect(INSTRUMENTS).toContain("'poker_equity_governor_scale'");
  });

  it('they are on the ALWAYS-ON registry, not the ENGINE_METRICS-gated one', () => {
    const block = INSTRUMENTS.slice(INSTRUMENTS.indexOf('export const alwaysOnRegistry'));
    for (const name of [
      'poker_event_loop_delay_p50_ms',
      'poker_event_loop_delay_p99_ms',
      'poker_equity_governor_scale',
    ]) {
      expect(block).toContain(name);
    }
  });

  it('the scrape reads the governor, so /metrics can never be older than the last sample', () => {
    expect(SERVER).toContain('eventLoopDelayP50.set(');
    expect(SERVER).toContain('eventLoopDelayP99.set(');
    expect(SERVER).toContain('equityGovernorScale.set(');
    // Non-finite readings render as a number, never as NaN.
    expect(SERVER).toContain('Number.isFinite(g.p50Ms) ? g.p50Ms : 0');
  });

  it('the sampler starts at boot and stops with the server', () => {
    expect(SERVER).toContain('equityGovernor.startSampling();');
    expect(SERVER).toContain('equityGovernor.stopSampling();');
    const start = SERVER.indexOf('equityGovernor.startSampling();');
    const stopFn = SERVER.indexOf('stop(): Promise<void> {');
    expect(start).toBeGreaterThan(0);
    expect(stopFn).toBeGreaterThan(0);
  });
});

/**
 * 2026-09-07, found while verifying the metric above was live. It was not.
 * `/health` and `/metrics` had been publishing
 *
 *     equityGovernor: { p50Ms: 0.000511, p99Ms: 0.000511, scale: 1 }
 *
 * frozen to the digit across reads seconds apart, on an engine with 137 hands
 * in flight. 0.000511 ms is 511 nanoseconds, and 511 is what Node answers to
 * `percentile()` on a histogram holding ZERO samples - proven locally:
 * `never-enabled p50 511 p99 511 count 0`.
 *
 * Both callers ran on the same one-second cadence: the boot timer calling
 * `sample()` directly, and the horse equity path calling `current()` thousands
 * of times a second. `current()` held the elapsed-time check; `sample()` held
 * none. Once the two drifted into phase, whichever ran second read a histogram
 * the first had emptied a millisecond earlier and published the emptiness.
 *
 * `scaleForLoopDelay(0.000511)` is 1, so the governor stopped shedding load on
 * the one core, and both engine-core alerts became unfireable. A metric
 * reaching zero meant the opposite of success.
 */
describe('a reading that could not be taken is not published as zero', () => {
  /* The server suite runs with EQUITY_GOVERNOR=off, so the shared singleton
     holds no histogram and cannot answer any of this. These two want a live
     one: stub the env, drop the module from the cache, and import a fresh
     governor that really is watching this process's loop. */
  const liveGovernor = async () => {
    vi.stubEnv('EQUITY_GOVERNOR', 'on');
    vi.resetModules();
    const mod = await import('./EquityLoadGovernor.js');
    return mod.equityGovernor;
  };
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to read a histogram it has just reset, whatever the caller', async () => {
    const gov = await liveGovernor();
    expect(gov.snapshot().enabled).toBe(true);
    // Let the loop record something worth reading.
    await new Promise((r) => setTimeout(r, 150));
    const base = Date.now();
    gov.sample(base);
    const first = gov.snapshot(base).p50Ms;
    expect(first).toBeGreaterThan(0.01);

    // The second sampler, arriving inside the same window - the timer landing
    // just after the equity path, which is the production shape.
    gov.sample(base + 5);
    expect(gov.snapshot(base + 5).p50Ms).toBe(first);

    // And arriving a full window later with nothing recorded in between, which
    // is the same emptiness wearing a legal clock.
    gov.sample(base + 5_000);
    expect(gov.snapshot(base + 5_000).p50Ms).toBe(first);
  });

  it('never publishes the empty-histogram sentinel as a loop delay', async () => {
    const gov = await liveGovernor();
    await new Promise((r) => setTimeout(r, 150));
    const base = Date.now();
    for (const at of [base, base + 1, base + 2_000, base + 2_001, base + 4_000]) {
      gov.sample(at);
      const snap = gov.snapshot(at);
      // 511ns / 1e6. If this ever comes back, the governor is reading an empty
      // histogram again and the engine has silently lost its load shedding.
      expect(snap.p50Ms).not.toBeCloseTo(0.000511, 6);
      expect(snap.p99Ms).not.toBeCloseTo(0.000511, 6);
    }
  });

  it('keeps one authority for when a reading exists', () => {
    const sample = sliceMethod(GOV, 'sample(now: number = Date.now()): number {');
    const current = sliceMethod(GOV, 'current(now: number = Date.now()): number {');
    // The window check lives in sample(), where the reset is.
    expect(sample).toContain('now - this.sampledAt < SAMPLE_EVERY_MS');
    // and current() no longer keeps a second copy of it that a direct caller
    // of sample() can walk straight past.
    expect(current).not.toContain('SAMPLE_EVERY_MS');

    /**
     * THE EMPTINESS DECISION IS MADE BY THE HELPERS, NOT BY AN EARLY RETURN.
     *
     * This used to assert `sample` contained `this.histogram.count === 0` — a
     * guard that returned BEFORE `isEmptyReading` / `effectiveDelayMs`, which
     * are the code written to handle exactly that case. `isEmptyReading`
     * returns false whenever `count > 0`, so with the early return in place
     * `empty` could never be true, the timer-lateness fallback was dead, and
     * `snapshot().stale` was a constant false. The assertion pinned the bug.
     *
     * The intent it was reaching for — one authority for whether a reading
     * exists — is kept, and now points at the authority that actually decides:
     * `effectiveDelayMs` returning null is the single "no reading" verdict.
     */
    expect(
      sample.includes('this.histogram.count === 0') &&
        sample.indexOf('this.histogram.count === 0') < sample.indexOf('effectiveDelayMs'),
      'sample() returns on an empty histogram before consulting effectiveDelayMs, ' +
        'which makes the timer-lateness fallback unreachable - the one case it exists for'
    ).toBe(false);
    expect(sample).toContain('effectiveDelayMs');
    expect(sample).toContain('if (delay === null)');
  });
});

describe('the alert thresholds are the governor own numbers', () => {
  const RULES = readFileSync(join(here, '../../../infra/monitoring/alert-rules.yml'), 'utf8');

  it('40 ms is where the governor starts shedding, and where the warning fires', () => {
    expect(RULES).toContain('poker_event_loop_delay_p50_ms > 40');
    expect(scaleForLoopDelay(40)).toBeLessThan(1);
    expect(scaleForLoopDelay(39)).toBe(1);
  });

  it('300 ms is the governor floor, and where the critical fires', () => {
    expect(RULES).toContain('poker_event_loop_delay_p50_ms > 300');
    expect(scaleForLoopDelay(300)).toBe(0.2);
  });

  it('every one of them is guarded against the scheduled :55 break (CLAUDE.md 13 rule 6)', () => {
    const start = RULES.indexOf('- name: engine-core');
    const nextGroup = RULES.indexOf('\n  - name:', start + 1);
    const group = RULES.slice(start, nextGroup);
    const alerts = group.match(/- alert: /g) ?? [];
    const guards =
      group.match(/unless on\(\) max_over_time\(poker_maintenance_break_active\[6m\]\) == 1/g) ??
      [];
    expect(alerts.length).toBe(3);
    expect(guards.length).toBe(alerts.length);
  });
});
