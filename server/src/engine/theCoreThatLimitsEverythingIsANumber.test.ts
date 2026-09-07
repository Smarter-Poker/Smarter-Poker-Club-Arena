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
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { equityGovernor, scaleForLoopDelay } from './EquityLoadGovernor.js';

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
    const stopFn = SERVER.indexOf('async stop(): Promise<void> {');
    expect(start).toBeGreaterThan(0);
    expect(stopFn).toBeGreaterThan(0);
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
    const group = RULES.slice(
      RULES.indexOf('- name: engine-core'),
      RULES.indexOf('- name: cluster')
    );
    const alerts = group.match(/- alert: /g) ?? [];
    const guards =
      group.match(/unless on\(\) max_over_time\(poker_maintenance_break_active\[6m\]\) == 1/g) ??
      [];
    expect(alerts.length).toBe(3);
    expect(guards.length).toBe(alerts.length);
  });
});
