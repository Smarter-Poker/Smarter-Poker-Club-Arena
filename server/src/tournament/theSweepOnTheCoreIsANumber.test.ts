/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS ACTUALLY ON THE CORE (2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-07 at 04:05 the fleet fell from ~480 hands a minute to 6 for
 * twenty minutes. The engine container sat at 100.8% CPU - one core, pegged -
 * while two of the box's three cores idled and Postgres answered the query the
 * engine was "timing out" on in 133 ms.
 *
 * The cause was the elimination sweep. The ONLY way to see that was to SSH to
 * the box and run
 *
 *     docker logs club-arena-engine | grep -c "elimination sweep still running"
 *
 * which returned **780 for fifteen minutes** - from a warning that fires once
 * per stuck episode, so that is ~780 distinct stuck sweeps. A number you can
 * only get by grepping a container is a number nobody watches, and it is the
 * reason a twenty-minute outage was diagnosed by hand instead of by a chart.
 *
 * `startEliminationChecker` opens a `setInterval` PER TOURNAMENT at
 * ELIMINATION_SWEEP_MS. At the 120-199 RUNNING tournaments measured that night
 * that is 24-40 sweeps a second on one JavaScript thread.
 *
 * These pins keep the three series wired. They measure and change nothing -
 * the fix for the cause is P0/P1 in docs/HANDOFF_CURRENT_STATE.md section 16,
 * and it needs this data to choose between optimising one sweep and
 * re-scheduling thirty.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import {
  eliminationSweepMs,
  eliminationSweepsInflight,
  eliminationSweepOverrunsTotal,
} from '../observability/engineInstruments.js';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const INSTRUMENTS = read('src/observability/engineInstruments.ts');
const SWEEP = read('src/tournament/TournamentManagerEliminations.ts');

describe('the three series exist and are always on', () => {
  it('names the sweep duration, its concurrency, and its overruns', () => {
    expect(INSTRUMENTS).toContain("'poker_tournament_elimination_sweep_ms'");
    expect(INSTRUMENTS).toContain("'poker_tournament_elimination_sweeps_inflight'");
    expect(INSTRUMENTS).toContain("'poker_tournament_elimination_sweep_overruns_total'");
  });

  it('puts them on the ALWAYS-ON registry, not the ENGINE_METRICS-gated one', () => {
    // An outage metric behind a feature flag is a metric that is off during
    // the outage.
    const block = INSTRUMENTS.slice(INSTRUMENTS.indexOf('export const alwaysOnRegistry'));
    for (const name of [
      'poker_tournament_elimination_sweep_ms',
      'poker_tournament_elimination_sweeps_inflight',
      'poker_tournament_elimination_sweep_overruns_total',
    ]) {
      expect(block).toContain(name);
    }
  });

  it('exports them as usable instruments', () => {
    expect(typeof eliminationSweepMs.observe).toBe('function');
    expect(typeof eliminationSweepsInflight.inc).toBe('function');
    expect(typeof eliminationSweepsInflight.dec).toBe('function');
    expect(typeof eliminationSweepOverrunsTotal.inc).toBe('function');
  });
});

describe('the sweep actually reports itself', () => {
  it('counts an inflight sweep when it takes the lock', () => {
    expect(SWEEP).toContain('eliminationSweepsInflight.inc()');
  });

  it('records how long the sweep took, on every path out of it', () => {
    // In the `finally`, not the happy path: a sweep that threw is exactly the
    // one whose duration matters.
    expect(SWEEP).toContain('eliminationSweepMs.observe(Date.now() - sweepStartedAt)');
    const observeAt = SWEEP.indexOf('eliminationSweepMs.observe(');
    const finallyAt = SWEEP.indexOf('} finally {');
    expect(finallyAt).toBeGreaterThan(0);
    expect(observeAt).toBeGreaterThan(finallyAt);
  });

  it('counts a warned overrun and a forced one separately', () => {
    // They are different events: one is late, the other has been abandoned.
    expect(SWEEP).toContain("eliminationSweepOverrunsTotal.inc(1, { outcome: 'warned' })");
    expect(SWEEP).toContain("eliminationSweepOverrunsTotal.inc(1, { outcome: 'forced' })");
  });
});

describe('the gauge cannot drift', () => {
  it('releases the inflight count where a superseded sweep is forced off', () => {
    // A forced sweep never reaches its own `finally` - its generation is
    // superseded - so without this the gauge climbs for ever on exactly the
    // process that is in trouble.
    //
    // Bounded by the BLOCK that forces the lock, never by a byte count. A
    // fixed window drifts off the end of what it guards the moment somebody
    // adds a comment, which cost this estate a 39-minute publish outage on
    // 2026-08-28 - and `noFixedSizeSourceWindows` caught the first draft of
    // this very file doing it.
    // levels = 2: the anchor sits inside the `{ outcome: 'forced' }` object
    // literal, so one climb reaches the call's argument and two reaches the
    // `if (verdict === 'force')` block this is actually about.
    expect(sliceEnclosingBlock(SWEEP, "outcome: 'forced'", 0, 2)).toContain(
      'eliminationSweepsInflight.dec()'
    );
  });

  it('only the current holder decrements in the finally, so it cannot go negative', () => {
    // Decrementing twice for one sweep would walk the gauge below zero, and a
    // metric that lies about the DIRECTION of load is worse than none.
    expect(
      sliceEnclosingBlock(SWEEP, 'sweepGeneration === this.eliminationSweepGeneration')
    ).toContain('eliminationSweepsInflight.dec()');
  });

  it('takes its start time inside the tick, not from the shared lock field', () => {
    // eliminationSweepStartedAt is zeroed by whoever releases the lock, so
    // reading it in the finally would measure 0 for every superseded sweep.
    expect(SWEEP).toContain('const sweepStartedAt = Date.now()');
  });
});

describe('the cadence this is measuring', () => {
  it('is still one interval per tournament - the thing the data has to justify changing', () => {
    expect(SWEEP).toContain('TournamentManagerBase.ELIMINATION_SWEEP_MS');
    expect(SWEEP).toContain('this.eliminationTimer = setInterval(');
  });
});
