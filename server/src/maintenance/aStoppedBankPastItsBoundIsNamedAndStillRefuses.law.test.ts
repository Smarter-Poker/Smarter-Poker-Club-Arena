/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A STOPPED BANK PAST ITS BOUND IS NAMED, AND STILL REFUSES (2026-09-26)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `unparkedTables()` bounds every F06 blocker class (#4909, extended
 * 2026-09-21). The stopped-custody test beside them had no bound, so on
 * 778075b4 `stopped_bank_custody_unconfirmed` answered "not yet" for ever:
 * 137 -> 154 -> 187 tables over ten hours on 2026-09-25/26, monotonic. On that
 * build it could never clear - `acknowledgedTimeBankPark` was set only on the
 * 'parked' path, inside a dealing loop a terminal engine does not have.
 *
 * THE ROOT CAUSE IS FIXED ELSEWHERE, NOT HERE. #5255 (on main) makes a
 * terminal engine persist the custody it holds on the 'announced' path, which
 * every break's :53 fan-out reaches (`parkEveryEngine` -> `pauseForMaintenance`
 * for every engine, running or not), and acknowledges it only on a real write.
 * The class drains on its own evidence. What remains is a write that keeps
 * failing, and #5255 is explicit about it: "a bank we could not persist is
 * still a bank at stake".
 *
 * SO THE BOUND CHANGES THE NAME, NEVER THE VERDICT. Two drafts of this fix
 * (#5266, and the first commit of #5267) retired the table from the census
 * past the bound, as F06 is retired. That is safe for F06, which holds no
 * money. For a time bank it would have been an allow-list by another name:
 * the per-table release guard that draft relied on
 * (legacy-engine-checkpoint-guard.mjs) runs only when the serving release is
 * one of four pinned predecessors, and every other cutover is admitted on
 * `readyForRestart && unparkedTables == 0` without reading a reason. Past the
 * bound the table is therefore reported as `stopped_bank_custody_stuck` - the
 * distinct "this process will not resolve it" outcome CLAUDE.md 10.86 rule 1
 * asks for - it is still counted in unparkedTables, and it still refuses.
 * The decision is one declared fact: UNPARKED_REASON_BOUNDS.neverHoldsGate.
 *
 * AND THE HALF #5255 STILL OWED. The census publishes the engine's own
 * `unwritten` / `unreadable` answer instead of the retired conflated
 * `unconfirmed` name, which was in no /metrics seed list.
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

describe('a stopped bank past its bound is named, and still refuses', () => {
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
  it('past the bound it changes its name and still holds the gate', () => {
    const { mb, advance } = atClock([
      ['a', table(custody())],
      ['b', table()],
      ['c', table()],
    ]);
    expect(mb.snapshot().unparkedTables, 'shut while the custody is young').toBe(1);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_unwritten: 1 });
    advance(GATE + 1000);
    // NEGATIVE PROOF of the rejected drafts: a player's unwritten time bank is
    // never retired from the census. Only the name says it will not resolve.
    expect(mb.snapshot().unparkedTables, 'an unwritten bank still refuses').toBe(1);
    expect(mb.snapshot().readyForRestart).toBe(false);
    expect(reasons(mb)).toMatchObject({ stopped_bank_custody_stuck: 1 });
    expect(reasons(mb)).not.toHaveProperty('stopped_bank_custody_unwritten');
    // The verdict is declared data, not an accident of which branch was edited.
    const bound = MaintenanceBreak.UNPARKED_REASON_BOUNDS.stopped_bank_custody_unwritten;
    expect(bound).toMatchObject({
      scope: 'lifetime',
      never: 'stopped_bank_custody_stuck',
      neverHoldsGate: true,
    });
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
    // (The same hard limit holds for engine-release-transaction.sh's
    // PREPARATION_ONLY; theCertificateOpensBeforeTheFleetIsSwept pins it.)
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
    expect(body).toContain('this.stoppedCustodyHoldsGate(tableId, custodyReason)');
    // The push comes BEFORE the bound, so no answer the bound gives can drop it.
    const branch = body.slice(custodyAt, body.indexOf('if (engine.hasUnresolvedF06Preparation'));
    expect(branch.indexOf('out.push(tableId);')).toBeGreaterThan(-1);
    expect(branch.indexOf('out.push(tableId);')).toBeLessThan(
      branch.indexOf('this.stoppedCustodyHoldsGate(')
    );
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
