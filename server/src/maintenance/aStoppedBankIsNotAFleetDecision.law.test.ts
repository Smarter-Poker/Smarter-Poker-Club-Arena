/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A STOPPED BANK IS NOT A FLEET DECISION (2026-09-26)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `unparkedTables()` bounds every F06 blocker class through
 * `f06PreparationHoldsGate` - #4909 added that after one unresolved permit held
 * engine 8825af51 shut for 70 consecutive breaks, and 2026-09-21 extended the
 * same bound to the manager-retained class beside it. THE STOPPED-CUSTODY TEST
 * NEXT TO THEM NEVER GOT ONE.
 *
 * Measured on production 2026-09-25/26: `stopped_bank_custody_unconfirmed` went
 * 137 -> 154 -> 187 over ten hours, monotonic, while `/health` read
 * `readyForRestart: false` and the break's census cost - which is charged
 * against the release's 15000ms admission window (see
 * theCertificateOpensBeforeTheFleetIsSwept) - scaled with it. The release
 * window narrowed every hour, and the engine could not be replaced by the very
 * release that carried the fix.
 *
 * WHY IT COULD NEVER CLEAR. `hasUnretiredStoppedTimeBankCustody()` requires
 * `this.terminal`. Failing a replacement engine's adoption, a confirmed session
 * close or a durable F06 receipt, it compares `acknowledgedTimeBankPark`
 * against the custody hand number - and `acknowledgedTimeBankPark` is set ONLY
 * when `when === 'parked'`, whose every call site is inside the dealing loop,
 * which a terminal engine does not have. The `'announced'` path it does take
 * passes `timeBanks: undefined` and writes `time_bank_snapshot: null`.
 * Corroborated from rows: 267,741 tournament park rows carry a null
 * `time_bank_snapshot` against 8,016 with banks. So the census answered "not
 * yet" to a question whose answer was "never" - CLAUDE.md 10.86 rule 1.
 *
 * THE ORDERING, AND WHY THE CHECK STAYS WHERE IT IS. The custody test sits
 * ABOVE `if (!engine.isRunning()) continue`, and that position is correct: a
 * terminal engine is exactly what it exists to catch, so moving it below the
 * skip would DELETE the check and pass over a player's time bank in silence.
 * What it never did was INHERIT the skip's reasoning - that a stopped engine
 * has no hand to protect, and therefore has no business making a fleet-wide
 * decision for ever. The bound is how it inherits it.
 *
 * NOTHING IS PASSED OVER PAST THE BOUND. The money protection is not this
 * census and never was: `legacy-engine-checkpoint-guard.mjs` checks every
 * captured engine's own `maintenanceDurabilityReason()` per table and from
 * rows, admitting only `bank_park_write_incomplete` on a row-proved stopped
 * table, so an engine whose bank is genuinely unwritten or unreadable still
 * refuses the cutover on its own. And `stopped_bank_custody_stuck` is
 * deliberately outside that guard's allow-list, which admits the two F06 names
 * and nothing else.
 *
 * AND THE HALF #5255 STILL OWED. #5255 split the engine's answer into
 * `stopped_bank_custody_unwritten` and `_unreadable` and seeded both as
 * /metrics labels, but this census kept publishing the retired conflated name
 * `stopped_bank_custody_unconfirmed`, which is in no seed list - so the count
 * only ever reached /metrics through the dynamic extension and no rule could
 * read it before it had already wedged the fleet.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MaintenanceBreak } from './MaintenanceBreak.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

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

/** A terminal engine still holding a frozen stopped time bank. */
const custody = (reason: string | null = 'stopped_bank_custody_unwritten'): Partial<Engine> => ({
  // Terminal engines are not running. The census must see this one anyway.
  isRunning: () => false,
  hasUnretiredStoppedTimeBankCustody: () => true,
  isMaintenanceStateDurable: () => false,
  maintenanceDurabilityReason: () => reason,
});

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

const reasons = (mb: MaintenanceBreak): Record<string, number> =>
  (mb.snapshot().unparkedReasons ?? {}) as Record<string, number>;

describe('a stopped bank is not a fleet decision', () => {
  const GATE = MaintenanceBreak.STOPPED_CUSTODY_GATE_MS as unknown as number;

  // ── 1. THE PROTECTION IS UNCHANGED WHILE THE CUSTODY IS YOUNG ────────────
  it('still shuts the gate while the custody could plausibly be handed over', () => {
    // NEGATIVE PROOF of the obvious wrong fix: "bound it" must not mean "stop
    // caring". A custody seconds old may still be adopted by a replacement
    // engine, retired on a confirmed session close, or made durable by its own
    // park write, and restarting on top of it would cost a player their bank.
    const { mb, advance } = atClock([
      ['a', table(custody())],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unwritten: 1 });

    advance(GATE - 1000);
    expect(mb.snapshot().unparkedTables, 'still inside the bound').toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unwritten: 1 });
  });

  // ── 2. PAST THE BOUND IT STOPS DECIDING FOR EVERY OTHER TABLE ────────────
  it('stops holding every other table hostage once it outlives the bound', () => {
    const { mb, advance } = atClock([
      ['a', table(custody())],
      ['b', table()],
      ['c', table()],
    ]);
    expect(mb.snapshot().unparkedTables, 'shut while the custody is young').toBe(1);
    advance(GATE + 1000);
    expect(mb.snapshot().unparkedTables, 'the fleet gate must no longer be shut by it').toBe(0);
  });

  // ── 3. AND IT NEVER STOPS SAYING SO ─────────────────────────────────────
  it('keeps naming, counting and publishing the table past the bound', () => {
    // A bound that hid the fault would be the same bug in a different hat.
    const { mb, advance } = atClock([
      ['a', table(custody())],
      ['b', table()],
    ]);
    mb.snapshot();
    advance(GATE + 1000);
    const snap = mb.snapshot();
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_stuck: 1 });
    expect(snap.stoppedCustodyStuckTables).toBe(1);
    // NEGATIVE PROOF: silence is not an option.
    expect(reasons(mb).stopped_bank_custody_stuck).toBeGreaterThan(0);
  });

  // ── 4. THE ENGINE'S OWN NAME, NOT THE RETIRED CONFLATED ONE ─────────────
  it('publishes the engine reason and never the retired unconfirmed name', () => {
    const { mb } = atClock([
      ['a', table(custody('stopped_bank_custody_unwritten'))],
      ['b', table(custody('stopped_bank_custody_unreadable'))],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(2);
    expect(reasons(mb)).toMatchObject({
      stopped_bank_custody_unwritten: 1,
      stopped_bank_custody_unreadable: 1,
    });
    // NEGATIVE PROOF: the name #5255 retired must be gone from the census, in
    // its output AND in its source. It is in no /metrics seed list, so a rule
    // could never read it before it had already wedged the fleet.
    expect(reasons(mb)).not.toHaveProperty('stopped_bank_custody_unconfirmed');
    expect(read('./MaintenanceBreak.ts')).not.toContain("'stopped_bank_custody_unconfirmed'");
  });

  // ── 5. AN UNREADABLE ANSWER REFUSES; IT IS NEVER COERCED ────────────────
  it('falls back to a refusing custody name when the engine answers nothing', () => {
    // CLAUDE.md 10.86 rule 2. A missing method, a null, or a name outside the
    // class is "I could not tell", and it must still refuse under a name a
    // /metrics rule can read.
    for (const answer of [null, undefined, 'unknown', 'cards_in_air'] as const) {
      const { mb } = atClock([
        [
          'a',
          table({
            isRunning: () => false,
            hasUnretiredStoppedTimeBankCustody: () => true,
            isMaintenanceStateDurable: () => false,
            maintenanceDurabilityReason: answer === undefined ? undefined : () => answer,
          }),
        ],
      ]);
      expect(mb.snapshot().unparkedTables, `${String(answer)} must still refuse`).toBe(1);
      expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unreadable: 1 });
      // NEGATIVE PROOF: never counted as anything outside the class.
      expect(reasons(mb)).not.toHaveProperty('unknown');
      expect(reasons(mb)).not.toHaveProperty('cards_in_air');
    }
  });

  // ── 6. NO BANK OR CUSTODY REASON MAY ENTER THE RELEASE ALLOW-LIST ───────
  it('leaves every custody reason outside the guard allow-list', () => {
    const guard = read('../../scripts/legacy-engine-checkpoint-guard.mjs');
    const start = guard.indexOf('const restartHeldOnlyByProvenUnresolvableCustody = () => {');
    expect(start, 'the guard fallback must still exist').toBeGreaterThan(-1);
    const body = guard.slice(start, guard.indexOf('\n    };', start));
    // It is an ALLOW-list: anything not these two names keeps the gate shut.
    expect(body).toContain("name !== 'f06_preparation_unresolved'");
    expect(body).toContain("name !== 'f06_preparation_stuck'");
    // NEGATIVE PROOF, the pinned hard limit: not the bounded custody name, not
    // any custody or bank name, may ever be admitted there.
    expect(body).not.toContain('stopped_bank_custody');
    expect(body).not.toContain('bank_park_write_incomplete');
  });

  // ── 7. THE CHECK STAYS ABOVE THE isRunning() SKIP ───────────────────────
  it('asks about stopped custody before the running-engine skip', () => {
    // NEGATIVE PROOF of the other wrong fix. Moving the custody test below
    // `if (!engine.isRunning()) continue` would make it unreachable for the
    // terminal engines it exists to catch - the count would read zero and a
    // player's bank would be passed over in silence. The bound is what makes
    // it stop deciding for the fleet; the position is what makes it see them.
    const src = read('./MaintenanceBreak.ts');
    const census = src.slice(src.indexOf('private unparkedTables(): string[] {'));
    const body = census.slice(0, census.indexOf('\n    return out;'));
    const custodyAt = body.indexOf('hasUnretiredStoppedTimeBankCustody');
    const skipAt = body.indexOf('if (!engine.isRunning()) continue;');
    expect(custodyAt, 'the custody test must be in the census').toBeGreaterThan(-1);
    expect(skipAt, 'the running skip must be in the census').toBeGreaterThan(-1);
    expect(custodyAt, 'custody is asked BEFORE the skip').toBeLessThan(skipAt);
    // And it is bounded, by the same named constant this law owns.
    expect(body).toContain('this.stoppedCustodyHoldsGate(tableId)');
  });

  // ── 8. A HAND IN THE AIR IS NEVER BOUNDED OUT ───────────────────────────
  it('never bounds cards_in_air, however long it has been counted', () => {
    // NEGATIVE PROOF: the bound is scoped to a class that has no hand. A
    // terminal engine has no dealing loop, so bounding it cannot certify over
    // a hand; `cards_in_air` is a live engine mid-hand and stays unbounded.
    const { mb, advance } = atClock([['a', table({ isBetweenHands: () => false })]]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    advance(GATE * 10);
    expect(mb.snapshot().unparkedTables, 'a hand in the air still refuses').toBe(1);
    expect(reasons(mb)).toMatchObject({ cards_in_air: 1 });
  });

  // ── 9. A REPLACEMENT ENGINE DOES NOT INHERIT THE OLD CLOCK ──────────────
  it('forgets the clock of a table whose custody cleared or which left', () => {
    // Without this a replacement engine would appear already past the bound.
    const engines: Array<[string, Engine]> = [
      ['a', table(custody())],
      ['b', table()],
    ];
    const { mb, advance } = atClock(engines);
    mb.snapshot();
    advance(GATE + 1000);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_stuck: 1 });

    // The custody clears - adopted, retired, or made durable.
    engines[0] = ['a', table()];
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(reasons(mb)).not.toHaveProperty('stopped_bank_custody_stuck');

    // It comes back on a fresh engine: it must hold the gate again, not be
    // instantly past a bound it never served.
    engines[0] = ['a', table(custody())];
    expect(mb.snapshot().unparkedTables, 'a fresh custody starts inside the bound').toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unwritten: 1 });
  });

  // ── 10. THE BOUND IS A NAMED CONSTANT, AND /metrics CAN READ THE NAME ───
  it('seeds the bounded reason on /metrics so a rule can fire the first time', () => {
    expect(Number.isSafeInteger(GATE)).toBe(true);
    expect(GATE).toBeGreaterThan(0);
    const gs = read('../GameServer.ts');
    const seed = gs.slice(gs.indexOf('const reasons = ['), gs.indexOf("'unknown',\n        ];"));
    expect(seed).toContain("'stopped_bank_custody_stuck'");
    expect(seed).toContain("'stopped_bank_custody_unwritten'");
    expect(seed).toContain("'stopped_bank_custody_unreadable'");
    // NEGATIVE PROOF: the retired name is not resurrected as a label either.
    expect(seed).not.toContain("'stopped_bank_custody_unconfirmed'");
  });
});
