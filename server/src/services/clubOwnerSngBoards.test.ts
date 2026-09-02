/**
 * Dan 2026-09-01 (Deep Stack Society directive): heads-up / SNG boards must
 * open for activated CLUB owners, not just the house board.
 *
 * Before this change checkAndLaunchSNGs ran exactly one ensureBoardOpen pass
 * against this.houseOwner, so a standalone club that had activated and funded
 * its games (Deep Stack Society, club 11192) could never list a heads-up
 * game: the Spin pass looped activatedSpinOwners() but the SNG pass did not.
 * createSNG was already owner-ready -- it stamps club_id/union_id from the
 * BoardOwner it is handed -- the loop was the only missing piece.
 *
 * These are source pins in the same style as
 * ClosedTableHuskCannotAbsorbTheBoard: the call site is where the regression
 * would come back. Each pin was run against the pre-change source and
 * observed red before the change shipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);

/** The body of checkAndLaunchSNGs, from its declaration to the next method. */
function sngPassSource(): string {
  const start = RECURRING.indexOf('private async checkAndLaunchSNGs');
  expect(start).toBeGreaterThan(-1);
  const rest = RECURRING.slice(start);
  const end = rest.indexOf('private async', 'private async'.length);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the SNG board opens for activated club owners', () => {
  it('the SNG pass loops activatedSpinOwners, like the Spin pass', () => {
    expect(sngPassSource()).toMatch(/for\s*\(const owner of await this\.activatedSpinOwners\(\)\)/);
  });

  it("an owner board only offers buy-ins the owner's stake covers", () => {
    expect(sngPassSource()).toMatch(/SNG_CONFIGS\.filter\(\(c\) => c\.buyIn <= owner\.maxStake\)/);
  });

  it('the house board still opens FIRST, so owner boards cannot starve it', () => {
    const src = sngPassSource();
    const house = src.indexOf('this.houseOwner');
    const ownerLoop = src.indexOf('activatedSpinOwners');
    expect(house).toBeGreaterThan(-1);
    expect(ownerLoop).toBeGreaterThan(-1);
    expect(house).toBeLessThan(ownerLoop);
  });

  it('every owner gets its OWN creation budget, like the Spin pass', () => {
    /* 2026-09-02: this used to pin `if (budget.left <= 0) break;` - one BURST
       shared by the house and every owner. Measured on production, the house
       board consumed all 12 every tick ("44 still to fill") and the loop
       broke before Deep Stack Society was reached, so its board sat at zero
       for an hour. The pin now guards the fix: no shared budget, no break,
       a fresh { left: BURST } for the house and for each owner
       (boardBudgetPerOwner.test.ts pins the same shape for both passes). */
    const src = sngPassSource();
    expect(src).not.toMatch(/if \(budget\.left <= 0\) break;/);
    expect(src).not.toMatch(/const budget = \{ left: BURST \};/);
    expect((src.match(/\{ left: BURST \}/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
