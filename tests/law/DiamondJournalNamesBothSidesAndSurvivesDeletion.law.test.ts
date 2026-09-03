/**
 * ===========================================================================
 *  LAW: THE DIAMOND JOURNAL NAMES BOTH SIDES, AND IT SURVIVES DELETION
 * ===========================================================================
 *
 * Diamond Accounting Standard 2.2, 3.2 "Account deletion", DR3 / DR4 / DR5
 * (Lane C). Three things this pins, each of which was measured missing in
 * production on 2026-09-02:
 *
 *   1. Every journal row the two primitives write names its issuance class
 *      and its counterparty. Before this migration both columns existed and
 *      nothing wrote either one, so 1,432 rows say a user and a signed
 *      amount and nothing about where the diamonds came from or went.
 *   2. A positive credit with no reference is RECORDED (DR4) and still
 *      credited. Log only. If a later edit turns that record into a refusal,
 *      it stops being this law and needs Dan.
 *   3. A profile deleted with a balance leaves a burn in ca_mint_ledger
 *      under op_id 'deletion:<id>', and its journal rows are copied into
 *      ca_diamond_journal_archive before the ON DELETE CASCADE takes them.
 *      77 profiles were deleted on 2026-09-02 carrying 198,525 diamonds and
 *      the register recorded none of it.
 *
 * The archive must have NO foreign keys: a table that references profiles
 * cannot outlive a deleted profile, which is the entire point of it.
 *
 * The pins are on the TEXT of the migration that carries the rule, so a
 * later CREATE OR REPLACE started from a stale repo mirror cannot quietly
 * drop a side of the entry. Every pin is negative-controlled against the
 * pre-change body that production actually ran.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIGRATION =
  'supabase/migrations/20260903031500_diamond_c_the_journal_keeps_both_sides_and_survives_deletion.sql';
const SQL = read(MIGRATION);

/** The text of one CREATE OR REPLACE FUNCTION block, by name. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in ${MIGRATION}`).toBeGreaterThan(-1);
  const open = sql.slice(start).match(/\bAS\s+(\$[a-z_]*\$)/);
  expect(open, `${name} body is dollar-quoted`).not.toBeNull();
  const tag = open![1];
  const bodyStart = start + open!.index! + open![0].length;
  const end = sql.indexOf(`${tag};`, bodyStart);
  expect(end, `${name} body is terminated`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/**
 * The predicate the law is really about: does this function body put both
 * sides on the row it inserts into diamond_transactions?
 */
function namesBothSides(body: string): boolean {
  return (
    /INSERT INTO (public\.)?diamond_transactions/.test(body) &&
    /counterparty/.test(body) &&
    /issuance_class/.test(body) &&
    /v_counterparty/.test(body) &&
    /v_issuance_class/.test(body)
  );
}

/**
 * NEGATIVE CONTROL. This is the shape of the journal INSERT that production
 * ran until 2026-09-03: no counterparty, no class. It must fail the same
 * predicate the new bodies pass, or the predicate proves nothing.
 */
const PRE_CHANGE_INSERT = `
    INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, reference_id, metadata
    ) VALUES (
        p_user_id, v_actual_amount, p_type, p_type, p_description,
        v_new_balance, p_reference_id, '{}'::jsonb
    ) RETURNING id INTO v_txn_id;`;

/** NEGATIVE CONTROL for the retirement: the body that only recorded a name. */
const PRE_CHANGE_DELETION_BODY = `
BEGIN
  BEGIN
    INSERT INTO public.ca_profile_deletions
      (profile_id, username, is_horse, diamonds, diamond_balance, profile_created_at)
    VALUES
      (OLD.id, OLD.username, OLD.is_horse, OLD.diamonds, OLD.diamond_balance, OLD.created_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_profile_deletions could not record deletion';
  END;
  RETURN OLD;
END;`;

describe('LAW: the diamond journal names both sides and survives deletion', () => {
  describe('negative control', () => {
    it('the pre-change journal INSERT fails the both-sides predicate', () => {
      expect(namesBothSides(PRE_CHANGE_INSERT)).toBe(false);
    });

    it('the pre-change deletion body records no burn and no archive', () => {
      expect(PRE_CHANGE_DELETION_BODY).not.toContain('deletion:');
      expect(PRE_CHANGE_DELETION_BODY).not.toContain('ca_diamond_journal_archive');
      expect(PRE_CHANGE_DELETION_BODY).not.toContain('ca_mint_ledger');
    });
  });

  describe('DR3: both sides on every row the primitives write', () => {
    it('add_diamonds_to_balance derives the class and the counterparty', () => {
      const body = functionBody(SQL, 'add_diamonds_to_balance');
      expect(namesBothSides(body)).toBe(true);
      // Every branch of the derivation, by the class it produces.
      for (const cls of [
        "v_issuance_class := 'purchased'",
        "v_issuance_class := 'refund'",
        "v_issuance_class := 'transferred'",
        "v_issuance_class := 'admin'",
        "v_issuance_class := 'promotional'",
        "v_issuance_class := 'spend'",
        "v_issuance_class := 'earned'",
      ]) {
        expect(body).toContain(cls);
      }
      expect(body).toContain("v_counterparty   := 'purchase_clearing'");
      expect(body).toContain("v_counterparty   := 'promo_budget:' || v_type_key");
    });

    it('deduct_diamonds classes a debit as spend, and a gift as transferred', () => {
      const body = functionBody(SQL, 'deduct_diamonds');
      expect(namesBothSides(body)).toBe(true);
      expect(body).toContain("v_issuance_class := 'spend'");
      expect(body).toContain(
        "v_counterparty   := 'revenue:' || COALESCE(p_source, p_transaction_type, 'unknown')"
      );
      expect(body).toContain("v_issuance_class := 'transferred'");
      expect(body).toContain(
        "v_counterparty   := 'player:' || COALESCE(p_metadata->>'recipient_id', 'unknown')"
      );
    });

    it('both primitives keep the guards they had before', () => {
      const add = functionBody(SQL, 'add_diamonds_to_balance');
      expect(add).toContain("'error', 'reference_id_required'");
      expect(add).toContain("'error', 'duplicate_reference'");
      expect(add).toContain("'error', 'profile_not_found'");
      expect(add).toContain("'error', 'insufficient_diamonds'");
      expect(add).toContain('FROM public.profiles WHERE id = p_user_id FOR UPDATE');
      expect(add).toContain('diamonds = v_new_balance, diamond_balance = v_new_balance');

      const ded = functionBody(SQL, 'deduct_diamonds');
      expect(ded).toContain("'error', 'Cannot deduct diamonds for another user'");
      expect(ded).toContain("'error', 'Insufficient diamonds'");
      expect(ded).toContain("'cooldown_active', true");
      expect(ded).toContain('FROM profiles WHERE id = p_user_id FOR UPDATE');
    });
  });

  describe('DR4: a credit without a reference is recorded, never refused', () => {
    it('add_diamonds_to_balance files the incident', () => {
      const body = functionBody(SQL, 'add_diamonds_to_balance');
      expect(body).toContain("'DR4:credit_without_reference', 'warning'");
      expect(body).toContain('IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN');
    });

    it('the DR4 block cannot refuse the credit (log only)', () => {
      const body = functionBody(SQL, 'add_diamonds_to_balance');
      const start = body.indexOf('IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN');
      expect(start).toBeGreaterThan(-1);
      const block = body.slice(start, body.indexOf('RETURN jsonb_build_object(', start));
      expect(block).not.toContain('RAISE EXCEPTION');
      expect(block).not.toMatch(/RETURN jsonb_build_object\('success', false/);
      // The incident is fired AFTER the journal row, so a credit that
      // happened is what gets recorded.
      expect(start).toBeGreaterThan(body.indexOf('INSERT INTO public.diamond_transactions'));
    });
  });

  describe('DR5: retirement is recorded, and the history outlives the player', () => {
    it('the deletion trigger writes the burn under op_id deletion:<id>', () => {
      const body = functionBody(SQL, 'fn_ca_journal_profile_deletion');
      expect(body).toContain('INSERT INTO public.ca_mint_ledger');
      expect(body).toContain("'deletion:' || OLD.id::text");
      expect(body).toContain("'burn', 'diamonds', 'player'");
      expect(body).toContain("'DR5:deleted_with_balance', 'warning'");
      expect(body).toContain('IF COALESCE(OLD.diamonds, 0) > 0 THEN');
    });

    it('the deletion trigger archives the journal before the cascade', () => {
      const body = functionBody(SQL, 'fn_ca_journal_profile_deletion');
      expect(body).toContain('INSERT INTO public.ca_diamond_journal_archive');
      expect(body).toContain('FROM public.diamond_transactions t');
      expect(body).toContain('WHERE t.user_id = OLD.id');
      expect(body).toContain('ON CONFLICT (id) DO NOTHING');
    });

    it('the deletion trigger can never be the reason a deletion fails', () => {
      const body = functionBody(SQL, 'fn_ca_journal_profile_deletion');
      expect(body).not.toContain('RAISE EXCEPTION');
      // Three added steps, three exception handlers, plus the pre-existing one.
      expect(body.match(/EXCEPTION WHEN OTHERS THEN/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
      expect(body.trimEnd().endsWith('RETURN OLD;\nEND;')).toBe(true);
    });

    it('the append-only bypass archives what it lets through, and still refuses', () => {
      const body = functionBody(SQL, 'fn_ca_journal_append_only');
      expect(body).toContain("ERRCODE = 'P0403'");
      expect(body).toContain("IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN");
      expect(body).toContain("'DR5:journal_row_deleted_under_maintenance', 'info'");
      expect(body).toContain('INSERT INTO public.ca_diamond_journal_archive');
      // The chip journals must be untouched by the addition.
      expect(body).toContain("IF TG_TABLE_NAME = 'chip_transactions' THEN");
      expect(body).toContain("ELSIF TG_TABLE_NAME = 'chip_ledger' THEN");
    });

    it('the archive has no foreign keys, so it outlives profiles and auth.users', () => {
      const start = SQL.indexOf('CREATE TABLE IF NOT EXISTS public.ca_diamond_journal_archive');
      expect(start).toBeGreaterThan(-1);
      const table = SQL.slice(start, SQL.indexOf(');', start));
      expect(table).not.toMatch(/REFERENCES/);
      expect(table).toContain('id                 uuid PRIMARY KEY');
      expect(table).toContain('deleted_profile_id uuid');
      expect(table).toContain('deletion_reason    text');
      // Nothing else in the migration may add one later.
      expect(SQL).not.toMatch(
        /ALTER TABLE (public\.)?ca_diamond_journal_archive[\s\S]*?ADD CONSTRAINT[\s\S]*?FOREIGN KEY/
      );
    });

    it('the archive is service_role only', () => {
      expect(SQL).toContain(
        'REVOKE ALL ON public.ca_diamond_journal_archive FROM PUBLIC, anon, authenticated;'
      );
      expect(SQL).toContain(
        'GRANT SELECT, INSERT ON public.ca_diamond_journal_archive TO service_role;'
      );
      expect(SQL).toContain(
        'ALTER TABLE public.ca_diamond_journal_archive ENABLE ROW LEVEL SECURITY;'
      );
    });
  });

  describe('the shape of the migration', () => {
    it('one migration, one transaction', () => {
      const opens = SQL.split('\n').filter((l) => l.trim() === 'BEGIN;');
      expect(opens).toHaveLength(1);
      expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
      expect(SQL).toContain("SET LOCAL lock_timeout = '4s';");
    });

    it('it moves no diamonds and creates no trigger on profiles', () => {
      const outside = SQL.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, '').replace(
        /DO \$assert\$[\s\S]*?\$assert\$;/g,
        ''
      );
      expect(outside).not.toMatch(/UPDATE (public\.)?profiles/);
      expect(outside).not.toMatch(/INSERT INTO (public\.)?diamond_transactions/);
      expect(outside).not.toMatch(/INSERT INTO (public\.)?ca_mint_ledger/);
      expect(SQL).not.toMatch(/CREATE TRIGGER[\s\S]*?ON (public\.)?profiles/);
    });

    it('the CASCADE foreign keys are left alone (Dan: no refusal of a live flow)', () => {
      expect(SQL).not.toMatch(/ON DELETE RESTRICT/);
      expect(SQL).not.toMatch(/DROP CONSTRAINT[\s\S]*?diamond_transactions_user_id_fkey/);
    });

    it('no em dash anywhere in the migration', () => {
      expect(SQL.includes(String.fromCharCode(0x2014))).toBe(false);
    });
  });
});
