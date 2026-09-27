/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LEASE IS HELD BY A DEALER, NOT BY AN ADMISSION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-26 09:08 UTC an engine release was sealed mid-hour. The outgoing
 * process drained its managers into 122 mixed manager-custody transfers
 * between 09:33:05 and 09:34:23 and left. Thirty-six hours later 120 of those
 * events were still RUNNING - 32, 20, 16, 12 and 7 players in the biggest -
 * and none had dealt a hand since 09:32.
 *
 * Seventy-two of them held a lease taken by the LIVE engine and heartbeated
 * two seconds ago. `continueAdmission` had thrown once, been caught into
 * `GameServer.mixed_original_recovery_retained`, and returned - before
 * `manager.resume()`. So the manager was registered, proved its lease every
 * fifteen seconds, owned no dealer, and was classified `owned`. /health
 * reported tournamentManagersQuarantined: 0 for the whole thirty-six hours.
 *
 * Three laws, each failing on the code as it stood that night:
 *   1. owning the lease is not dealing - the classifier must say so;
 *   2. a retention with nothing local at stake is bounded, and then the lease
 *      goes back;
 *   3. the catch that retains must RECORD the retention, or nothing above can
 *      ever see it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTournamentOwner } from './quarantinedTournamentManagers.js';
import {
  RETAINED_MIXED_ADMISSION,
  RETAINED_MIXED_ADMISSION_LEASE_WINDOW_MS,
  retainedMixedAdmissionVerdict,
} from './retainedMixedAdmission.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

describe('owning the lease is not dealing', () => {
  it('a registered manager that holds its lease and deals nothing is NOT owned', () => {
    // The exact shape of the seventy-two: registered, lease proven, no dealer.
    expect(
      classifyTournamentOwner({
        managerRegistered: true,
        managerOwnsLease: true,
        managerIsDealing: false,
        admissionInFlight: false,
      })
    ).toBe('quarantined');
  });

  it('still calls a dealing manager owned, and an empty slot unowned', () => {
    expect(
      classifyTournamentOwner({
        managerRegistered: true,
        managerOwnsLease: true,
        managerIsDealing: true,
        admissionInFlight: false,
      })
    ).toBe('owned');
    expect(
      classifyTournamentOwner({
        managerRegistered: false,
        managerOwnsLease: false,
        managerIsDealing: false,
        admissionInFlight: false,
      })
    ).toBe('unowned');
  });
});

describe('a retained admission is bounded', () => {
  const observation = (over: Partial<Parameters<typeof retainedMixedAdmissionVerdict>[0]> = {}) => ({
    managerIsDealing: false,
    hasInProcessOriginals: false,
    retainedForMs: 0,
    ...over,
  });

  it('retries inside its window and hands the lease back after it', () => {
    expect(retainedMixedAdmissionVerdict(observation())).toBe('retry');
    expect(
      retainedMixedAdmissionVerdict(
        observation({ retainedForMs: RETAINED_MIXED_ADMISSION_LEASE_WINDOW_MS - 1 })
      )
    ).toBe('retry');
    expect(
      retainedMixedAdmissionVerdict(
        observation({ retainedForMs: RETAINED_MIXED_ADMISSION_LEASE_WINDOW_MS })
      )
    ).toBe('give_up_the_lease');
    // Thirty-six hours is the number this law exists for.
    expect(retainedMixedAdmissionVerdict(observation({ retainedForMs: 36 * 3_600_000 }))).toBe(
      'give_up_the_lease'
    );
  });

  it('never abandons originals that live in this process, however long it waits', () => {
    // Their reserved permits can only be attested by those exact objects.
    expect(
      retainedMixedAdmissionVerdict(
        observation({ hasInProcessOriginals: true, retainedForMs: 36 * 3_600_000 })
      )
    ).toBe('retry');
  });

  it('a manager that became a dealer is done, whatever its age', () => {
    expect(
      retainedMixedAdmissionVerdict(
        observation({ managerIsDealing: true, retainedForMs: 36 * 3_600_000 })
      )
    ).toBe('dealing');
  });

  it('a nonsense age reads as brand new, never as an expired window', () => {
    expect(retainedMixedAdmissionVerdict(observation({ retainedForMs: Number.NaN }))).toBe('retry');
    expect(retainedMixedAdmissionVerdict(observation({ retainedForMs: -1 }))).toBe('retry');
  });
});

describe('the retention is recorded where it happens', () => {
  const SERVER = readFileSync(
    path.join(import.meta.dirname, '..', 'GameServer.ts'),
    'utf8'
  );

  it('the catch that retains a mixed recovery records it before returning', () => {
    // Not beside it and not on the next pass: the return IS the end of the
    // admission, so anything after it never runs. A retention that is not
    // recorded is indistinguishable from a healthy owner, which is exactly
    // how seventy-two events went silent for thirty-six hours.
    const admission = sliceMethod(SERVER, 'private async performTournamentManagerAdmission(');
    const retained = admission.slice(admission.indexOf('mixed_original_recovery_retained'));
    const returned = retained.indexOf('return;');
    expect(returned).toBeGreaterThan(0);
    expect(retained.slice(0, returned)).toMatch(/this\.retainMixedAdmission\(/);
  });

  it('the RUNNING pass settles retained admissions before it counts owners', () => {
    const settle = sliceMethod(SERVER, 'private settleQuarantinedTournamentManagers(');
    const settled = settle.indexOf('this.settleRetainedMixedAdmissions(');
    const counted = settle.indexOf('withoutOwner++');
    expect(settled).toBeGreaterThan(0);
    expect(counted).toBeGreaterThan(settled);
  });

  it('the retained pass gives the lease back rather than asking for a stop', () => {
    // retireTournamentManagerInDiscovery refuses an F06 recovery owner by
    // design. Dropping the lease authority is what ends that ownership, and
    // it is the only thing here that may release the slot.
    const pass = sliceMethod(SERVER, 'private settleRetainedMixedAdmissions(');
    expect(pass).toMatch(/manager\.fenceForTournamentLeaseLoss\(\)/);
    expect(pass).toMatch(/retainedMixedAdmissionVerdict\(/);
    expect(pass).toMatch(/continuation\.run\(\)/);
    // Blanked: the prose above the branch NAMES the stop path it must not
    // call, and documenting a method may never break the pin that guards it
    // (testHelpers/sourceWindow.ts).
    expect(blankNonCode(pass)).not.toMatch(/retireTournamentManagerInDiscovery/);
  });

  it('the quarantine names this retention with its own reason', () => {
    expect(RETAINED_MIXED_ADMISSION).toBe('GameServer.mixed_recovery_retained');
    expect(SERVER).toMatch(/RETAINED_MIXED_ADMISSION/);
  });
});
