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
import { sliceEnclosingBlock, sliceMethod } from './testHelpers/sourceWindow.js';

const ROOT = process.cwd();
const GS = fs.readFileSync(path.join(ROOT, 'src/GameServer.ts'), 'utf8');

/** Strip block and line comments so prose about a rule never satisfies it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const GS_CODE = stripComments(GS);

describe('GameServer boot sweep - chips leave the felt the way everyone else does', () => {
  /* Bounded by the structure it is about, never by a byte count - a window
     that can drift off the end of what it guards can also drift off it while
     staying green. See tests/unit/noFixedSizeSourceWindows.test.ts. */
  const sweep = sliceEnclosingBlock(GS_CODE, 'let cashedOut = 0;');

  it('cashes each seat out through the locked RPC', () => {
    expect(sweep).toMatch(/rpc\(\s*'atomic_seat_cashout_locked'/);
    expect(sweep).toMatch(/p_seat_number:\s*seat\.seat_number/);
  });

  it('never issues a table_seats DELETE', () => {
    /* CLAUDE.md 11.5: deleting a seat row skips the refund and destroys the
       chips. A vacated seat (left_at set) is the audit trail, and
       atomic_table_buyin clears the rathole rows it needs to reuse a number. */
    expect(GS_CODE).not.toMatch(/from\('table_seats'\)[\s\S]{0,200}\.delete\(/);
  });

  it('does not credit a wallet itself', () => {
    /* A credit outside the RPC is a second transaction, and the second
       transaction is what the aggregate key made invisible on retry. */
    expect(sweep).not.toMatch(/atomic_credit_wallet_and_log/);
    expect(sweep).not.toMatch(/credit_player_wallet/);
  });

  it('the aggregate startup-cashout idempotency key is gone', () => {
    // Keyed on a set of seat ids, so a re-run of the same set was deduped into
    // silence while the seats were deleted regardless.
    expect(GS_CODE).not.toMatch(/startup-cashout:/);
  });

  it('does not stamp left_at itself', () => {
    expect(sweep).not.toMatch(/left_at:\s*new Date\(\)/);
  });
});

describe('the bomb-pot award ledger is repaired, not just retried', () => {
  it('the repair sweep is armed on start and cleared on stop', () => {
    expect(GS_CODE).toMatch(/this\.startBombLedgerRepairSweep\(\)/);
    expect(GS_CODE).toMatch(/clearInterval\(this\.bombLedgerRepairTimer\)/);
  });

  it('it runs on a schedule and calls the arithmetic backfill for real', () => {
    const body = sliceMethod(GS_CODE, 'private startBombLedgerRepairSweep');
    expect(body).toMatch(/rpc\(\s*'fn_backfill_bomb_pot_award_units'/);
    expect(body).toMatch(/p_dry_run:\s*false/);
    expect(body).toMatch(/setInterval\(/);
    // Housekeeping never fails a boot: every path reports and returns.
    expect(body).toMatch(/reportError\(/);
  });
});

describe('a bomb hand that awards nothing says so', () => {
  const settlement = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/engine/ServerTableEngineSettlement.ts'), 'utf8')
  );

  it('winners with an empty per-pot award array are reported', () => {
    /* Otherwise the hole is indistinguishable from a transport loss, and the
       repair sweep chases it forever - the units were never computed, so no
       backfill can reconstruct them. */
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
