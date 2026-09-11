/**
 * LIVENESS THE ENGINE CANNOT FAKE — and, more importantly, cannot MISFIRE.
 *
 * This verifier can declare the whole process dead, and Docker will restart it,
 * voiding every in-flight hand on every table. So the tests that matter most
 * are the ones proving it stays QUIET: a thrown query, a small fleet, a paused
 * fleet and a single dealt hand must each keep it silent.
 *
 * The failure it exists to catch is the 2026-08-22 outage, where the engine's
 * own `msSinceProgress()` said healthy while 1,603 kills said otherwise and
 * every layer above /health inherited the same wrong belief.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const builder = {
  select: vi.fn(),
  in: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
};
const from = vi.fn((_table: string) => builder);
vi.mock('./supabase.js', () => ({ supabase: { from: (table: string) => from(table) } }));

/** Every alert the verifier raises or resolves, in order. */
const raised: Array<{ alertname: string; severity: string; page?: boolean }> = [];
const resolved: string[] = [];
vi.mock('./engineAlerts.js', () => ({
  raiseEngineAlert: async (input: { alertname: string; severity: string; page?: boolean }) => {
    raised.push(input);
    return true;
  },
  resolveEngineAlert: async (alertname: string) => {
    resolved.push(alertname);
    return true;
  },
}));

const { DealRateVerifier } = await import('./DealRateVerifier.js');

/** Make the query chain resolve to `result`. */
function answers(result: { count?: number | null; error?: unknown } | Error) {
  builder.select.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  if (result instanceof Error) {
    builder.gt.mockRejectedValue(result);
  } else {
    builder.gt.mockResolvedValue(result);
  }
}

const tables = (n: number) => Array.from({ length: n }, (_, i) => `table-${i}`);

beforeEach(() => {
  raised.length = 0;
  resolved.length = 0;
  from.mockClear();
  builder.select.mockReset();
  builder.in.mockReset();
  builder.eq.mockReset();
  builder.gt.mockReset();
});

describe('DealRateVerifier - when it must stay quiet', () => {
  it('a database it cannot reach is NOT evidence of silence', async () => {
    const v = new DealRateVerifier(() => tables(40));
    answers({ count: 0, error: { message: 'fetch failed' } });
    for (let i = 0; i < 10; i++) await v.check();
    const s = v.snapshot();
    expect(s.silentChecks).toBe(0);
    expect(s.dbConfirmedDead).toBe(false);
    // "We could not ask" must never read as "nothing is happening" -- the same
    // inversion heartbeatTables avoids. A real Supabase outage happened during
    // this work; this is the branch that stops it becoming a fleet restart on
    // top of an outage.
    expect(s.handsInWindow).toBeNull();
  });

  it('a thrown query is treated the same way', async () => {
    const v = new DealRateVerifier(() => tables(40));
    answers(new Error('ETIMEDOUT'));
    for (let i = 0; i < 10; i++) await v.check();
    expect(v.snapshot().dbConfirmedDead).toBe(false);
    expect(v.snapshot().silentChecks).toBe(0);
  });

  it('refuses to judge a fleet too small to mean anything', async () => {
    const v = new DealRateVerifier(() => tables(2));
    answers({ count: 0, error: null });
    for (let i = 0; i < 10; i++) await v.check();
    expect(v.snapshot().dbConfirmedDead).toBe(false);
    // It never judged the DEAL RATE: two tables between hands is not evidence.
    // `.in('table_id', ...)` is unique to that query — the floor check added on
    // 2026-08-30 asks a different, unfiltered question (has the platform dealt
    // ANYTHING), so "did it ask at all" is no longer the right assertion.
    expect(builder.in).not.toHaveBeenCalled();
  });

  it('stands down entirely when no table should be dealing', async () => {
    const v = new DealRateVerifier(() => []);
    answers({ count: 0, error: null });
    await v.check();
    expect(v.snapshot().silentChecks).toBe(0);
    // Again: no DEAL-RATE query. See the note above on the floor check.
    expect(builder.in).not.toHaveBeenCalled();
  });

  it('one hand anywhere clears the alarm', async () => {
    const v = new DealRateVerifier(() => tables(40));
    answers({ count: 0, error: null });
    await v.check();
    await v.check();
    expect(v.snapshot().silentChecks).toBe(2);
    answers({ count: 1, error: null });
    await v.check();
    expect(v.snapshot().silentChecks).toBe(0);
    expect(v.snapshot().dbConfirmedDead).toBe(false);
  });

  it('does not declare dead on a single quiet minute', async () => {
    const v = new DealRateVerifier(() => tables(40));
    answers({ count: 0, error: null });
    await v.check();
    expect(v.snapshot().dbConfirmedDead).toBe(false);
  });
});

describe('DealRateVerifier - when it must speak', () => {
  it('declares dead once the database confirms sustained silence', async () => {
    const v = new DealRateVerifier(() => tables(40));
    answers({ count: 0, error: null });
    await v.check();
    await v.check();
    expect(v.snapshot().dbConfirmedDead).toBe(false); // 2/3 -- not yet
    await v.check();
    const s = v.snapshot();
    expect(s.silentChecks).toBe(3);
    expect(s.dbConfirmedDead).toBe(true);
    expect(s.tablesExpectedDealing).toBe(40);
    expect(s.handsInWindow).toBe(0);
  });

  it('reports its evidence before it reaches a verdict', async () => {
    // The point is that a fleet going quiet is VISIBLE on /health well before
    // anything restarts.
    const v = new DealRateVerifier(() => tables(12));
    answers({ count: 0, error: null });
    await v.check();
    const s = v.snapshot();
    expect(s.dbConfirmedDead).toBe(false);
    expect(s.silentChecks).toBe(1);
    expect(s.tablesExpectedDealing).toBe(12);
    expect(s.lastCheckedAt).toBeGreaterThan(0);
  });
});

/**
 * THE HORSE FLEET'S OWN PULSE (Dan 2026-09-11: "I SHOULD GET PUSH
 * NOTIFICATIONS OR TEXT IF ANYTHING INSIDE THE HORSES IS FAILING OR THEY
 * CAN'T PLAY").
 *
 * The seeding loop can stop while the process lives and the already-seated
 * tables keep dealing, so neither of this class's other two questions can
 * see it. Measured 2026-09-11: one such stall of 2,461 s, during which no
 * alarm fired anywhere.
 */
describe('DealRateVerifier - the horse fleet seeding loop', () => {
  const quiet = () => answers({ count: 5, error: null });

  it('says nothing while the fleet is beating normally', async () => {
    const v = new DealRateVerifier(
      () => tables(40),
      () => 45
    );
    quiet();
    for (let i = 0; i < 5; i++) await v.check();
    expect(raised.map((r) => r.alertname)).not.toContain('ClubArenaHorseFleetLoopStopped');
  });

  it('says nothing before the first beat of a fresh process', async () => {
    // -1 is "no cycle has completed yet", which a boot legitimately shows.
    const v = new DealRateVerifier(
      () => tables(40),
      () => -1
    );
    quiet();
    for (let i = 0; i < 5; i++) await v.check();
    expect(raised).toEqual([]);
  });

  it('pages ONCE after two consecutive stale checks, never on one slow cycle', async () => {
    let age = 118; // the worst ordinary cycle this file's history records
    const v = new DealRateVerifier(
      () => tables(40),
      () => age
    );
    quiet();
    await v.check();
    expect(raised).toEqual([]);
    age = 1200;
    await v.check();
    expect(raised).toEqual([]); // one stale check is not a page
    await v.check();
    await v.check();
    await v.check();
    const pages = raised.filter((r) => r.alertname === 'ClubArenaHorseFleetLoopStopped');
    expect(pages).toHaveLength(1);
    expect(pages[0].severity).toBe('critical');
    expect(pages[0].page).toBe(true);
  });

  it('resolves itself when the loop comes back', async () => {
    let age = 1200;
    const v = new DealRateVerifier(
      () => tables(40),
      () => age
    );
    quiet();
    await v.check();
    await v.check();
    expect(raised.some((r) => r.alertname === 'ClubArenaHorseFleetLoopStopped')).toBe(true);
    age = 30;
    await v.check();
    expect(resolved).toContain('ClubArenaHorseFleetLoopStopped');
  });

  it('a reader that throws is not evidence of a stopped fleet', async () => {
    const v = new DealRateVerifier(
      () => tables(40),
      () => {
        throw new Error('no fleet here');
      }
    );
    quiet();
    for (let i = 0; i < 5; i++) await v.check();
    expect(raised).toEqual([]);
  });

  it('a verifier with no fleet reader behaves exactly as before', async () => {
    const v = new DealRateVerifier(() => tables(40));
    quiet();
    for (let i = 0; i < 5; i++) await v.check();
    expect(raised.map((r) => r.alertname)).not.toContain('ClubArenaHorseFleetLoopStopped');
  });
});
