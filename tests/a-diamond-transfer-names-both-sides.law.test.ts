/**
 * A DIAMOND THAT ONLY MOVES IS NEVER BURNED, AND A TRANSFER NAMES BOTH SIDES.
 *
 * Measured on production 2026-09-11. ca_drift_incidents
 * 1610f514-d6cc-40ca-b543-6daac6cb159c, raised by fn_ca_diamond_snapshot at
 * 08:10Z: "player diamond supply (fixtures excluded) moved by 100.00 more than
 * the Mint register explains - a diamond writer is bypassing the register".
 *
 * One paid Diamond Wheel spin, at 07:21:45.149667Z. fn_wheel_spin_core charges
 * the price and hands it to the host's owner, which is Dan's 2026-09-10 ruling
 * and which the function itself calls "a transfer, not an issuance". The two
 * legs of that one transfer were journaled differently:
 *
 *   -100 smarterpoker   deduct_diamonds(p_source => 'wheel_spin')
 *                       -> issuance_class 'spend'      -> register BURNED 100
 *   +100 kingfish       add_diamonds_to_balance('transfer')
 *                       -> issuance_class 'transferred'-> register wrote nothing
 *
 * deduct_diamonds decided "is this a transfer?" from a hardcoded list of
 * sources. 'wheel_spin' was not on it. So the register retired 100 diamonds
 * that were sitting in kingfish's balance: balances moved 0, the register
 * moved -100, and an hour later the detector said so.
 *
 * Reproduced against production before the fix and again after it, each time
 * inside one call whose own RAISE rolled it back (CLAUDE.md 11.5 rule 1):
 *
 *   before  debit_class=spend        balances_moved=0  register_moved=-100.00  UNEXPLAINED=100.00
 *   after   debit_class=transferred  balances_moved=0  register_moved=0.00     UNEXPLAINED=0.00
 *                                    unnamed_transfer=REFUSED P0408
 *
 * WHAT IS PINNED HERE
 *
 *   1. the classification follows the money: a debit that NAMES a recipient is
 *      a transfer whatever its source is called;
 *   2. the wheel names the host owner on the spin price, so both legs are
 *      transfers and the register follows neither;
 *   3. a transfer CREDIT can name where it came from, and the three diamond
 *      game paths do;
 *   4. ONE definition decides whether a row is a transfer, read by the
 *      register's skip and by the guard, so they cannot drift apart;
 *   5. the guard refuses a transfer that names nobody;
 *   6. the 100 already moved is corrected in the REGISTER, forward, and no
 *      player balance is touched;
 *   7. the detector is not softened: no threshold change, no exclusion.
 *
 * Pin 7 is the one to read twice. The cheap way to close this incident was to
 * raise the 50-diamond threshold or teach fn_ca_diamond_snapshot to skip the
 * wheel. Either would have made the alarm stop without making the books true.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const all = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const fixFile = all.find((f) => f.includes('a_diamond_transfer_names_both_sides'));
const echoFile = all.find((f) => f.includes('the_register_correction_is_the_drift'));
const fix = fixFile ? readFileSync(join(MIGRATIONS, fixFile), 'utf8') : '';
const echo = echoFile ? readFileSync(join(MIGRATIONS, echoFile), 'utf8') : '';

describe('a diamond transfer names both sides and never burns what it moved', () => {
  it('the migration exists', () => {
    expect(fixFile, 'the diamond register-bypass migration must not be deleted').toBeTruthy();
    expect(
      echoFile,
      'the migration explaining the correction echo must not be deleted'
    ).toBeTruthy();
  });

  it('1. a debit that names a recipient is a transfer, whatever its source is called', () => {
    // the root cause: deduct_diamonds used to decide this from a source list alone
    expect(fix).toContain("IF COALESCE(p_metadata->>'recipient_id', '') <> ''");
    // and the old list survives underneath it, for the paths that name nobody
    expect(fix).toContain(
      "OR COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')"
    );
  });

  it('2. the wheel names the host owner on the spin price', () => {
    expect(fix).toContain("'recipient_id', v_owner");
    expect(fix).toContain("'fn_wheel_spin_core'");
  });

  it('3. a transfer credit can name where it came from, and every diamond game path does', () => {
    expect(fix).toContain('p_counterparty_id uuid DEFAULT NULL::uuid');
    expect(fix).toContain(
      "v_counterparty := 'player:' || COALESCE(p_counterparty_id::text, 'unknown');"
    );
    // wheel intake, crash/plinko intake, and the diamond prize, both legs
    expect(fix).toContain("':intake', v_user)");
    expect(fix).toContain("':intake', p_user)");
    expect(fix).toContain("':host', p_user)");
    expect(fix).toContain('p_note, p_reference, p_owner)');
    // and no overload is left behind for a five-argument call to trip over
    expect(fix).toContain(
      'DROP FUNCTION IF EXISTS public.add_diamonds_to_balance(uuid, integer, text, text, text);'
    );
  });

  it('4. ONE definition decides what a transfer is, and both readers read it', () => {
    expect(fix).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_is_transfer');
    // the register's own skip now calls it instead of holding a second copy
    expect(fix).toContain(
      'IF public.fn_ca_diamond_journal_is_transfer(p_type, p_transaction_type, p_source, p_issuance_class) THEN'
    );
    // and so does the guard
    expect(fix).toContain(
      'public.fn_ca_diamond_journal_is_transfer(NEW.type, NEW.transaction_type'
    );
    // factoring it out must reclassify nothing that already exists
    expect(fix).toContain('zz_origin_before');
    expect(fix).toContain('the register rule changed for % existing journal rows');
  });

  it('5. the guard refuses a transfer that names nobody, and it fires after the classifier', () => {
    expect(fix).toContain('CREATE TRIGGER ab_ca_diamond_transfer_names_its_counterparty');
    expect(fix).toContain('BEFORE INSERT ON public.diamond_transactions');
    expect(fix).toContain("USING ERRCODE = 'P0408'");
    expect(fix).toContain('a diamond transfer must name the player on the other side');
    // the named counterparty has to be a player who exists, not just well shaped
    expect(fix).toContain(
      'EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = substring(v_cp from 8)::uuid)'
    );
    // 'ab_' sorts after 'aa_ca_diamond_journal_classifier', which fills counterparty first
    expect(fix).toContain(
      "IF 'ab_ca_diamond_transfer_names_its_counterparty' <= 'aa_ca_diamond_journal_classifier' THEN"
    );
    // and it proves itself rather than asserting itself
    expect(fix).toContain('accepted a transfer credit naming nobody');
  });

  it('6. the 100 already moved is corrected in the register, and no balance is touched', () => {
    expect(fix).toContain("'register-correction:wheel:84aba5a7-32e0-4aec-a1c2-d7fbdc32466b'");
    expect(fix).toContain('INSERT INTO public.ca_mint_ledger');
    expect(fix).toContain('ON CONFLICT (op_id) DO NOTHING');
    // balance_before and balance_after are the same figure: supply is corrected, a wallet is not
    expect(fix).toContain('COALESCE(p.diamonds, 0), COALESCE(p.diamonds, 0),');
    // history is corrected forward, never edited
    expect(fix).not.toMatch(/DELETE\s+FROM\s+public\.ca_mint_ledger/i);
    expect(fix).not.toMatch(/UPDATE\s+public\.ca_mint_ledger/i);
    // and no UPDATE of profiles.diamonds anywhere in either migration
    expect(fix).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(echo).not.toMatch(/UPDATE\s+public\.profiles/i);
    // it refuses to correct a board that has moved
    expect(fix).toContain('is not the 100-diamond burn it was measured to be');
    expect(fix).toContain('correcting again would double count');
  });

  it('7. the detector is not softened: no threshold change, no exclusion, no reclassification', () => {
    for (const sql of [fix, echo]) {
      expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ca_diamond_snapshot/i);
      expect(sql).not.toMatch(/abs\(v_unexplained\)\s*>\s*(?!50\b)\d+/i);
      expect(sql).not.toMatch(/fn_ca_is_fixture_account\s*\(\s*[^)]*\)\s*:?=?\s*true/i);
    }
    // and the echo migration says out loud what it refused to do
    expect(echo).toContain("origin 'operator'");
    expect(echo).toContain('50-diamond threshold');
  });

  it('the migration proves the identity it claims, in a transaction it rolls back', () => {
    expect(fix).toContain('the fix does not hold: a wheel spin still leaves %');
    // 11.5: one call, one self-aborting block. The RAISE is what undoes it.
    expect(fix).toContain("RAISE EXCEPTION 'ZZPROBE:%:%:%'");
    expect(fix).toContain(
      '-- The RAISE is what undoes every row above. An error is the success case.'
    );
  });

  it('the follow-on incident is explained as the correction, not as a second writer', () => {
    expect(echo).toContain('647c1dc6-99b1-4a21-9d77-2d733106f4e3');
    expect(echo).toContain('Not a writer.');
    // it refuses to close an incident whose figure is not the one it accounts for
    expect(echo).toContain('not the -100 the correction accounts for');
  });
});
