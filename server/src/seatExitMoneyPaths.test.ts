/**
 * THE BOOT SWEEP MUST NOT DESTROY, AND MUST NOT LOOK LIKE IT DESTROYED.
 *
 * `GameServer.cleanupStaleData` used to credit one AGGREGATE per user and then
 * bulk-DELETE the seat rows. Two round trips, so a boot that died between them
 * paid the chips and left the seat occupied - and the next boot rebuilt the
 * IDENTICAL `startup-cashout:{user}:{seat ids}` idempotency key, which
 * correctly deduped and wrote NO fresh ledger row. The seats were deleted
 * anyway, so 1,033 seat exits a day (~432K chips) reached
 * `fn_unaccounted_seat_exits` with no credit to match, indistinguishable from
 * chips actually being destroyed.
 *
 * Source-level assertions on purpose: `cleanupStaleData` is a private method
 * that talks to Supabase on every line, and what is being pinned is a
 * STRUCTURAL property of the code - which RPC it takes and what it never
 * issues - not a runtime behaviour a mock could show.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod } from './testHelpers/sourceWindow.js';

const ROOT = process.cwd();
const GS = fs.readFileSync(path.join(ROOT, 'src/GameServer.ts'), 'utf8');

/** Strip block and line comments so prose about a rule never satisfies it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const GS_CODE = stripComments(GS);

describe('GameServer boot - horses keep their seats across a restart (Dan 2026-09-02, CLAUDE.md 10.5)', () => {
  /* The boot path used to cash out and vacate every HORSE seat at every cash
     table, and the fleet then re-seeded fresh horses into the holes: measured
     on the 2026-09-02 20:55 break as 383 seats / 78,575.13 chips off the felt
     in one boot, every one a horse, zero humans. A seat row is the persisted
     state for horse and human alike; nothing on the boot path may remove one. */
  const cleanup = sliceMethod(GS_CODE, 'private async cleanupStaleData(');

  it('the boot path is still there to be measured', () => {
    expect(cleanup.length).toBeGreaterThan(200);
    expect(cleanup).toContain("horse_status: 'available'");
  });

  it('does not cash out any seat on boot', () => {
    expect(cleanup).not.toMatch(/atomic_seat_cashout_locked/);
    expect(cleanup).not.toMatch(/atomic_credit_wallet_and_log/);
    expect(cleanup).not.toMatch(/credit_player_wallet/);
  });

  it('does not reconcile finished-tournament seats on process startup', () => {
    // Historical terminal orphans are closed exactly once by the database
    // migration cutover. Process startup is never a seat-exit authority.
    expect(cleanup).not.toContain('orphan seat release failed');
    expect(cleanup).not.toMatch(/orphanPageSize|releasedOrphanSeats/);
    expect(cleanup).not.toMatch(/from\('table_seats'\)/);
    expect(cleanup).not.toMatch(/staleSweep\.seats/);
  });

  it('nothing on the boot path tells a horse apart from a human (10.5)', () => {
    // No horse id list, no is_horse filter on a seat write, no horseIdSet.
    // The horse_status reset above is a health-reporting flag the fleet
    // ignores for seating, and touches no seat.
    expect(cleanup).not.toMatch(/horseIdSet|horseIdList|horsePage/);
    expect(cleanup).not.toMatch(/from\('table_seats'\)[\s\S]{0,400}is_horse/);
  });

  it('does not build a horse list to treat horses differently from humans', () => {
    // 10.5: the only legitimate horse branch is the one that MAKES a horse
    // equal (seating, funding, steering). A list of horses gathered so they
    // can be removed is the bug this test exists to stop coming back.
    expect(cleanup).not.toMatch(/staleSweep\.horses/);
    expect(cleanup).not.toMatch(/canSweepSeats/);
  });

  it('never issues a table_seats DELETE anywhere in GameServer', () => {
    /* CLAUDE.md 11.5: deleting a seat row skips the refund and destroys the
       chips. A vacated seat (left_at set) is the audit trail. */
    expect(GS_CODE).not.toMatch(/from\('table_seats'\)[\s\S]{0,200}\.delete\(/);
  });

  it('the aggregate startup-cashout idempotency key is gone', () => {
    expect(GS_CODE).not.toMatch(/startup-cashout:/);
  });
});

describe('the bomb-pot award ledger cannot need repairing', () => {
  /**
   * RETIRED 2026-09-22. This block used to pin an HOURLY SWEEP in GameServer
   * that called fn_backfill_bomb_pot_award_units to rebuild award units the
   * settlement write had lost: that write is fire-and-forget by design, so a
   * blip outlasting its third retry left a PERMANENT hole, roughly 17 a day,
   * and only a human backfill closed one.
   *
   * The hole is closed at the source, so the sweep has nothing left to find.
   * fn_ca_insert_hand_with_awards writes hand_history and bomb_pot_award_units
   * in ONE transaction, and the constraint trigger
   * zz_ca_bomb_hand_keeps_its_award_units, DEFERRABLE INITIALLY DEFERRED,
   * refuses at commit any bomb hand that distributes chips without its units.
   *
   * MEASURED ON PRODUCTION 2026-09-24 03:18 UTC: 0 bomb hands in retention
   * missing their award units, all time, against 70,534 award units written in
   * the preceding 7 days. CLAUDE.md 10.12: deleting the repair loop is part of
   * the fix, once the writer is correct and its candidate set is empty.
   */
  it('the engine runs no bomb-ledger repair sweep', () => {
    // Comment-stripped source: prose about a retired sweep must not read as one.
    expect(GS_CODE).not.toMatch(/startBombLedgerRepairSweep/);
    expect(GS_CODE).not.toMatch(/bombLedgerRepairTimer/);
    expect(GS_CODE).not.toMatch(/fn_backfill_bomb_pot_award_units/);
  });

  it('the guarantee that replaced it is pinned by a law of its own', () => {
    /* Not circular: if someone deletes the law that keeps the bomb guard
       attached, the negative assertions above would quietly become the only
       thing left, and an empty rule passes. This fails instead. */
    const law = fs.readFileSync(
      path.join(ROOT, 'src/services/noEngineTimerReDrivesAFeeTheHandOwes.law.test.ts'),
      'utf8'
    );
    expect(law).toContain('zz_ca_bomb_hand_keeps_its_award_units');
    expect(law).toContain('fn_ca_bomb_hand_keeps_its_award_units');
  });
});

describe('a bomb hand that awards nothing says so', () => {
  const settlement = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/engine/ServerTableEngineSettlement.ts'), 'utf8')
  );

  it('winners with an empty per-pot award array are reported', () => {
    /* Otherwise the hole is indistinguishable from a transport loss. The
       units were never COMPUTED, so no backfill could ever have reconstructed
       them, which is why reporting it is the only honest answer and why the
       retired sweep above was never the thing that closed this case. */
    expect(settlement).toMatch(/bomb_award_units_empty/);
    // 2026-08-31 stale-continuation sweep: postHandTasks reads the per-hand
    // SNAPSHOT (snap.*), never the live fields - the pin follows the rename.
    expect(settlement).toMatch(/snap\.perPotAwards\.length === 0/);
  });
});

describe('remove_horse is retired in a committed migration', () => {
  const MIGRATION = path.join(
    ROOT,
    '../supabase/migrations/20260831120000_retire_remove_horse_the_delete_that_refunds_nothing.sql'
  );

  it('the migration file exists', () => {
    expect(fs.existsSync(MIGRATION), `${MIGRATION} is missing`).toBe(true);
  });

  it('it retires the function and names its replacement', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.remove_horse/);
    expect(sql).toMatch(/retired: use atomic_seat_cashout_locked/);
  });

  it('it carries a pasted ROLLBACK section (Tier 3)', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/ROLLBACK/);
    expect(sql).toMatch(/--\s+CREATE OR REPLACE FUNCTION public\.remove_horse/);
  });
});
