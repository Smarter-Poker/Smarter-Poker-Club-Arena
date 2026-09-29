/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE GATE SAYS WHY IT IS SHUT (2026-09-18)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The restart gate is one boolean, and on the night of 2026-09-17 it stayed
 * false through five consecutive breaks while the engine went eight hours
 * without a release. Each time the only published number was the unparked
 * COUNT:
 *
 *   23:55  3 tables unparked, flat for the whole five minutes
 *   00:55 16 tables unparked, flat
 *   01:55 22 tables unparked, flat  (cut over by hand)
 *   02:55 22 falling to 17 during last_hand, then flat
 *
 * Every one of those tables had logged "Parked between hands", none had a
 * presence-persist error, and none had a refused park write. Which of the
 * four conditions held the gate had to be reconstructed from the database,
 * the container log and the source, at three in the morning, twice.
 *
 * A gate that can refuse for four different reasons must say which one. These
 * pins are that: the engine answers with the reason, the boolean is DERIVED
 * from the reason so the two can never disagree, the break counts the reasons
 * it refused for, and the scrape carries every reason zero-seeded so a rule
 * can read one before it has ever been the reason.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MaintenanceBreak } from './MaintenanceBreak.js';

type Engine = {
  isRunning: () => boolean;
  isBetweenHands: () => boolean;
  isParkedBetweenHands: () => boolean;
  pauseForMaintenance: (ms: number) => void;
  resumeFromMaintenance: () => void;
  isMaintenanceStateDurable?: () => boolean;
  maintenanceDurabilityReason?: () => string | null;
  hasUnresolvedF06Preparation?: () => boolean;
  hasUnretiredStoppedTimeBankCustody?: () => boolean;
};

/** A table with whatever answers the case needs. */
const table = (over: Partial<Engine> = {}): Engine => ({
  isRunning: () => true,
  isBetweenHands: () => true,
  isParkedBetweenHands: () => true,
  pauseForMaintenance: () => {},
  resumeFromMaintenance: () => {},
  isMaintenanceStateDurable: () => true,
  maintenanceDurabilityReason: () => null,
  ...over,
});

const notDurable = (reason: string | null): Partial<Engine> => ({
  isMaintenanceStateDurable: () => false,
  maintenanceDurabilityReason: () => reason,
});

/** A break already counting down, with this set of engines. */
function countingDown(engines: Array<[string, Engine]>): MaintenanceBreak {
  const mb = new MaintenanceBreak({
    engines: () => new Map(engines) as never,
    isRunning: () => true,
  } as never);
  // The phase and the durable flag are what snapshot() reads; the pins below
  // are about the reason breakdown, not about how a break is announced.
  Object.assign(mb as never, { phase: 'counting_down', durableConfirmed: true });
  return mb;
}

const reasons = (mb: MaintenanceBreak): Record<string, number> =>
  (mb.snapshot().unparkedReasons ?? {}) as Record<string, number>;

describe('the restart gate says why it is shut', () => {
  it('counts a table with cards in the air as cards_in_air', () => {
    const mb = countingDown([
      ['a', table({ isBetweenHands: () => false })],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ cards_in_air: 1 });
  });

  it('counts each durability reason under its own name', () => {
    const mb = countingDown([
      ['a', table(notDurable('accounting_pending'))],
      ['b', table(notDurable('accounting_pending'))],
      ['c', table(notDurable('bank_park_write_incomplete'))],
      ['d', table(notDurable('accounting_unconfirmed'))],
      ['e', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(4);
    expect(reasons(mb)).toMatchObject({
      accounting_pending: 2,
      bank_park_write_incomplete: 1,
      accounting_unconfirmed: 1,
    });
  });

  it('never guesses: an engine that publishes only the boolean is unknown', () => {
    const mb = countingDown([
      [
        'a',
        table({ isMaintenanceStateDurable: () => false, maintenanceDurabilityReason: undefined }),
      ],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ unknown: 1 });
  });

  it('a table with cards in the air is counted once, not twice', () => {
    // Both conditions true. The gate refuses once and the reason is the one
    // that matters first: nothing durable can be concluded mid-hand.
    const mb = countingDown([
      ['a', table({ isBetweenHands: () => false, ...notDurable('accounting_pending') })],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ cards_in_air: 1 });
    expect(reasons(mb).accounting_pending).toBeUndefined();
  });

  it('reports nothing when every table is parked and durable', () => {
    const mb = countingDown([
      ['a', table()],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(Object.values(reasons(mb)).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a stopped engine is not the gate’s business', () => {
    const mb = countingDown([
      ['a', table({ isRunning: () => false, isBetweenHands: () => false })],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(0);
  });

  it('an engine that throws on inspection does not become a reason', () => {
    const mb = countingDown([
      [
        'a',
        table({
          isBetweenHands: () => {
            throw new Error('unreadable');
          },
        }),
      ],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(Object.values(reasons(mb)).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: ONE STUCK PERMIT CANNOT HOLD THE WHOLE PLATFORM (2026-09-19)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The F06 test is the first thing the gate asks and it is right to be: an
 * unresolved hand-number preparation means a number may be allocated and its
 * fate unproven. It even counts a STOPPED engine, deliberately.
 *
 * It had no bound. So one table held `readyForRestart` shut for every other
 * table on the platform, for as long as the process lived - and because the
 * engine only restarts inside a certified break, that meant the engine could
 * never be replaced either, including by the build that would fix it.
 *
 * MEASURED, from `engine_maintenance_break_log`. The engine instance that
 * started at 21:56 on 2026-09-18 held every break it ever saw:
 *
 *   22:55, 23:55, 00:05, 00:14, 00:55, 01:55
 *   unparked 1 at countdown, ready_for_restart_at NULL, every one
 *
 * against 13:55 to 21:55 the same day, which certified in 4.5 to 86 seconds
 * with zero unparked. `/health` named it throughout:
 * `unparkedReasons: { f06_preparation_unresolved: 1 }`. Six consecutive engine
 * releases failed on that gate and production sat four and a half hours behind
 * main with no route forward, while `status` read `ok` - because every table
 * was dealing. It was the RESTART that was impossible.
 *
 * What is pinned here: the gate still refuses for a live preparation, it stops
 * refusing for one that has outlived any legitimate window, and it never stops
 * SAYING so.
 */
describe('one stuck F06 permit cannot hold the whole platform', () => {
  const GATE = MaintenanceBreak.F06_UNRESOLVED_GATE_MS;

  /** A counting-down break whose clock the test moves by hand. */
  function atClock(engines: Array<[string, Engine]>) {
    let clock = 1_000_000;
    const mb = new MaintenanceBreak({
      engines: () => new Map(engines) as never,
      isRunning: () => true,
      now: () => clock,
    } as never);
    Object.assign(mb as never, { phase: 'counting_down', durableConfirmed: true });
    return { mb, advance: (ms: number) => (clock += ms) };
  }

  const unresolved = (): Partial<Engine> => ({ hasUnresolvedF06Preparation: () => true });

  it('still shuts the gate while the preparation could plausibly resolve', () => {
    // Unchanged behaviour, and the reason this guard exists. A permit seconds
    // old is in flight, not stuck, and restarting on top of it is exactly what
    // the check was written to prevent.
    const { mb, advance } = atClock([
      ['a', table(unresolved())],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ f06_preparation_unresolved: 1 });

    advance(GATE - 1000);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ f06_preparation_unresolved: 1 });
  });

  it('stops holding every other table hostage once it outlives the gate', () => {
    // THE REGRESSION, BY NAME. One table, 195 others, and an indefinitely
    // unresolved permit. Past the bound the gate opens for the rest.
    //
    // The clock starts when the condition is first OBSERVED, not when the
    // permit was created - the break can only measure what it has seen. So
    // the sequence here is the production one: observe, wait, observe again.
    const { mb, advance } = atClock([
      ['a', table(unresolved())],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables, 'shut while the preparation is young').toBe(1);
    advance(GATE + 1000);
    expect(mb.snapshot().unparkedTables, 'the gate must no longer be shut by it').toBe(0);
  });

  it('and never stops saying so', () => {
    // Not silence. A bound that hides the fault would be the same bug wearing
    // a different hat - the table is still wedged and still needs its engine
    // replaced, and the permit is process-local so nothing else clears it.
    const { mb, advance } = atClock([
      ['a', table(unresolved())],
      ['b', table()],
    ]);
    mb.snapshot();
    advance(GATE + 1000);
    expect(reasons(mb)).toMatchObject({ f06_preparation_stuck: 1 });
    expect(reasons(mb).f06_preparation_unresolved ?? 0).toBe(0);
    expect(mb.snapshot().f06StuckTables).toBe(1);
  });

  it('a table that resolves its preparation does not inherit the old clock', () => {
    // The bound is per table and starts when the condition does. A table that
    // resolves and later prepares again is a new preparation, and gets the
    // full gate - it must not be past the bound the instant it appears.
    let stuck = true;
    const engine = table({ hasUnresolvedF06Preparation: () => stuck });
    const { mb, advance } = atClock([
      ['a', engine],
      ['b', table()],
    ]);
    mb.snapshot();
    advance(GATE + 1000);
    expect(mb.snapshot().unparkedTables).toBe(0);

    stuck = false;
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(reasons(mb).f06_preparation_stuck ?? 0).toBe(0);

    stuck = true;
    expect(mb.snapshot().unparkedTables, 'a fresh preparation gets the full gate').toBe(1);
    expect(reasons(mb)).toMatchObject({ f06_preparation_unresolved: 1 });
  });

  it('the bound is far past any real window', () => {
    // A permit is prepared between hands and resolves in seconds. Ten minutes
    // is the same figure the reaper already uses for "no legitimate pause is
    // this long", and it costs at most two breaks rather than every break.
    expect(GATE).toBe(10 * 60_000);
  });
});

/**
 * THE SAME BOUND, APPLIED TO THE THIRD BLOCKER CLASS (2026-09-25)
 * -----------------------------------------------------------------
 * Engine 778075b4 had 20 tournament managers quarantined after lease loss.
 * Their STOPPED tournament engines answered
 * `hasUnretiredStoppedTimeBankCustody()` true for ever (the root cause is fixed
 * engine-side in #5254, which that process was not running), and the branch
 * above the F06 test counted them with no bound at all. `/health` showed, at
 * EVERY break:
 *
 *   readyForRestart false, unparkedTables 154,
 *   unparkedReasons { f06_preparation_stuck: 13, stopped_bank_custody_unconfirmed: 154 }
 *
 * Every `auto-deploy-hetzner` run since 15:59 UTC waited for a certificate that
 * could not open, including the run carrying the fix. The reason is raised only
 * by a TERMINAL engine, which deals no hands; what a restart discards is the
 * in-memory mirror of banks whose seats already stopped, and the chips are in
 * the database. Same bound, same clearing rule, same `_stuck` shape, and the
 * table never stops being named.
 */
describe('a stopped bank that can never be released is named, and still refuses', () => {
  /* CORRECTED 2026-09-26 (#5267). These cases were written for #5266, where a
     custody table past the bound stopped holding the certificate. That was
     reversed before an engine carrying it ever served: on a build with #5255
     what outlives the bound is a bank still not on disk, and an ordinary
     cutover reads no reasons. Every case is kept; the verdict past the bound
     is now "named stopped_bank_custody_stuck, still refusing". */
  const GATE = MaintenanceBreak.STOPPED_CUSTODY_GATE_MS;

  function atClock(engines: Array<[string, Engine]>) {
    let clock = 1_000_000;
    const mb = new MaintenanceBreak({
      engines: () => new Map(engines) as never,
      isRunning: () => true,
      now: () => clock,
    } as never);
    Object.assign(mb as never, { phase: 'counting_down', durableConfirmed: true });
    return { mb, advance: (ms: number) => (clock += ms) };
  }

  const stoppedBank = (): Partial<Engine> => ({
    hasUnretiredStoppedTimeBankCustody: () => true,
    maintenanceDurabilityReason: () => 'stopped_bank_custody_unwritten',
  });

  it('shuts the gate under the engine reason while the custody is young', () => {
    const { mb, advance } = atClock([
      ['a', table(stoppedBank())],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unwritten: 1 });
    advance(GATE - 1000);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unwritten: 1 });
    expect(reasons(mb).stopped_bank_custody_stuck ?? 0).toBe(0);
  });

  it('past the bound it is named stuck and STILL holds the certificate', () => {
    const { mb, advance } = atClock([
      ['a', table(stoppedBank())],
      ['b', table(stoppedBank())],
      ['c', table()],
    ]);
    expect(mb.snapshot().unparkedTables, 'shut while the custody is young').toBe(2);
    advance(GATE + 1000);
    expect(mb.snapshot().unparkedTables, 'an unwritten bank still refuses').toBe(2);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_stuck: 2 });
    expect(reasons(mb).stopped_bank_custody_unwritten ?? 0).toBe(0);
    expect(mb.snapshot().stoppedCustodyStuckTables).toBe(2);
  });

  it('keeps its own stuck counter beside the F06 one, and only F06 stops holding', () => {
    const { mb, advance } = atClock([
      ['a', table(stoppedBank())],
      ['b', table({ hasUnresolvedF06Preparation: () => true })],
    ]);
    mb.snapshot();
    advance(GATE + 1000);
    expect(mb.snapshot().unparkedTables, 'only the custody table still holds').toBe(1);
    expect(reasons(mb)).toMatchObject({
      stopped_bank_custody_stuck: 1,
      f06_preparation_stuck: 1,
    });
    expect(mb.snapshot().f06StuckTables).toBe(1);
    expect(mb.snapshot().stoppedCustodyStuckTables).toBe(1);
  });

  it('a table whose custody clears does not inherit the old clock', () => {
    let held = true;
    const engine = table({
      hasUnretiredStoppedTimeBankCustody: () => held,
      maintenanceDurabilityReason: () => (held ? 'stopped_bank_custody_unwritten' : null),
    });
    const { mb, advance } = atClock([
      ['a', engine],
      ['b', table()],
    ]);
    mb.snapshot();
    advance(GATE + 1000);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_stuck: 1 });

    held = false;
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(reasons(mb).stopped_bank_custody_stuck ?? 0).toBe(0);
    expect(mb.snapshot().stoppedCustodyStuckTables).toBe(0);

    held = true;
    expect(mb.snapshot().unparkedTables, 'a fresh custody gets the full bound').toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unwritten: 1 });
  });

  it('the two classes keep separate clocks on the same table', () => {
    let prepared = false;
    const engine = table({
      hasUnretiredStoppedTimeBankCustody: () => !prepared,
      maintenanceDurabilityReason: () => (prepared ? null : 'stopped_bank_custody_unwritten'),
      hasUnresolvedF06Preparation: () => prepared,
    });
    const { mb, advance } = atClock([['a', engine]]);
    mb.snapshot();
    advance(GATE + 1000);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_stuck: 1 });
    prepared = true;
    expect(mb.snapshot().unparkedTables, 'the preparation is young').toBe(1);
    expect(reasons(mb)).toMatchObject({ f06_preparation_unresolved: 1 });
  });

  it('is one helper, reading declared bounds, and the same clearing rule', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), './MaintenanceBreak.ts'),
      'utf8'
    );
    expect(src).toContain(
      'private stoppedCustodyHoldsGate(tableId: string, reason: string): boolean {'
    );
    expect(src.match(/this\.holdsGateWithinBound\(/g)?.length).toBe(2);
    expect(src).toContain('const bound = MaintenanceBreak.UNPARKED_REASON_BOUNDS[reason];');
    const loop = src.slice(src.indexOf('if (engine.hasUnretiredStoppedTimeBankCustody?.()) {'));
    const branch = loop.slice(0, loop.indexOf('if (engine.hasUnresolvedF06Preparation?.()) {'));
    expect(branch).toContain('if (this.stoppedCustodyHoldsGate(tableId, custodyReason)) {');
    expect(branch).toContain("count('stopped_bank_custody_stuck');");
    expect(branch).not.toContain("'stopped_bank_custody_unconfirmed'");
    expect(branch.indexOf('out.push(tableId);')).toBeLessThan(
      branch.indexOf('this.stoppedCustodyHoldsGate(')
    );
    expect(src).toContain('for (const tableId of [...this.stoppedCustodySince.keys()]) {');
    const gameServer = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../GameServer.ts'),
      'utf8'
    );
    expect(gameServer).toContain("'stopped_bank_custody_stuck',");
  });
});
