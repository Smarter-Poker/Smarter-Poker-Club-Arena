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
 *
 * 2026-09-03: the budget pins changed with the rule. The house used to open
 * FIRST on one shared BURST "so owner boards cannot starve it", and being
 * thirty-odd games short every tick it spent all twelve and starved every
 * owner board instead (Deep Stack Society's spin board sat empty from 11:32).
 * Every board now gets its own share of BURST up front (boardBudgetShares),
 * so neither side can starve the other and the order no longer carries the
 * guarantee. See theClubProgrammeMirrorsTheHouse.test.ts.
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
    const src = sngPassSource();
    expect(src).toMatch(/const owners = await this\.activatedSpinOwners\(\);/);
    expect(src).toMatch(/for \(const owner of owners\) \{/);
  });

  it("an owner board only offers buy-ins the owner's stake covers", () => {
    expect(sngPassSource()).toMatch(/SNG_CONFIGS\.filter\(\(c\) => c\.buyIn <= owner\.maxStake\)/);
  });

  it('the house board and every owner board each get their own share of BURST', () => {
    const src = sngPassSource();
    expect(src).toMatch(/const share = boardBudgetShares\(owners\.length \+ 1\);/);
    // Both ensureBoardOpen calls on the SNG board hand in `{ left: share }`.
    const sngCalls = src.split(/this\.ensureBoardOpen\(\s*'sng',/).slice(1);
    expect(sngCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of sngCalls) {
      expect(call.slice(0, call.indexOf(');'))).toMatch(/\{ left: share \}/);
    }
  });

  it('nobody breaks out of the owner loop on a spent shared budget any more', () => {
    expect(sngPassSource()).not.toMatch(/if \(budget\.left <= 0\) break;/);
    expect(sngPassSource()).not.toMatch(/const budget = \{ left: BURST \};/);
  });
});
