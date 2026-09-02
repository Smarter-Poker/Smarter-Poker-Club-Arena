/**
 * AN ARMED TIME BANK MUST BE RELEASED WHEN THE PLAYER ACTS (2026-08-26).
 *
 * Pressing the time-bank button while the ordinary clock still has time on it
 * does not spend anything - activateTimeBank's arm-only branch records the
 * INTENT (bank.armed = true) and returns "Time Bank Armed. It Starts When Your
 * Clock Runs Out". Critically it returns BEFORE timeBankActivatedThisTurn is
 * set, because nothing was spent.
 *
 * handlePlayerAction then gated its call to timeBankEngine.playerActed on
 * timeBankActivatedThisTurn alone. playerActed is the only thing that clears
 * bank.armed. So: press early, act in time, and the intent survives into a
 * LATER turn on the same street, where onPrimaryTimerExpired redeems it and
 * burns a use the player never asked to spend.
 *
 * This is a source guard rather than a behavioural test because the defect is
 * in the CALLER's condition, not in TimeBankEngine - whose own contract is
 * already pinned by TimeBankEngine.manualcountdown.test.ts ("player acted in
 * time; the intent dies with it").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('./ServerTableEngineTurns.ts', import.meta.url)),
  'utf8'
);

describe('releasing an armed-but-unspent time bank', () => {
  it('handlePlayerAction reaches playerActed for an ARMED bank, not only an ACTIVATED one', () => {
    const call = 'this.timeBankEngine.playerActed(this.tableId, userId)';
    const i = src.indexOf(call);
    expect(i, 'the playerActed call in handlePlayerAction is gone').toBeGreaterThan(-1);

    // The condition immediately guarding that call.
    const before = src.slice(Math.max(0, i - 600), i);
    const lastIf = before.lastIndexOf('if (');
    expect(lastIf, 'no guarding if( found').toBeGreaterThan(-1);
    const cond = before.slice(lastIf);

    expect(
      cond,
      'the gate is timeBankActivatedThisTurn alone again - an armed-but-unspent ' +
        'bank will leak into a later turn and be spent without consent'
    ).toContain('isArmed');
  });

  it('the arm-only branch still returns without claiming anything was spent', () => {
    // If this ever starts setting timeBankActivatedThisTurn, the guard above
    // becomes redundant rather than wrong - but the reader should know.
    expect(src).toContain('Time Bank Armed. It Starts When Your Clock Runs Out');
  });
});
