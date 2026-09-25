/**
 * A HAND HISTORY ROW CANNOT BE WRITTEN WITH NO TABLE.
 *
 * Board issue #5070, incident cash-pot-conservation-no-winner-recorded-null-table
 * (the table_id half). Four hand_history rows had table_id NULL, players = [],
 * winners = []. Every settlement RPC door (fn_ca_commit_hand_settlement, its
 * exact-generation core, and the nine-argument
 * fn_ca_commit_hand_settlement_before_lease_generation) independently refuses
 * a missing or NULL table_id before any INSERT - so does the protocol-2
 * retained-submission path, which re-enters the same door. The one function
 * that performs the literal INSERT, fn_ca_insert_hand_with_awards, is granted
 * EXECUTE to `postgres` only (not service_role, not authenticated), so it is
 * reachable only from another SECURITY DEFINER function in that guarded chain,
 * or from a session logged in AS postgres calling it directly by name - which
 * is exactly what the bomb-guard trigger's own probes legitimately do to test
 * it without going near the settlement RPCs.
 *
 * Migration 20260925032029 makes fn_ca_insert_hand_with_awards refuse a
 * missing/NULL table_id BY ITSELF, so a future direct call (an investigation's
 * own probe included) cannot repeat this - independent of every caller above
 * it. It must keep accepting a syntactically valid table_id that names no
 * real table, because the bomb-guard migration's own probes rely on exactly
 * that shape (a synthetic '00000000-...-aa' table_id) continuing to work.
 *
 * The same migration deletes the four proven-orphan rows: zero players, zero
 * rake, and zero linkage to any hand_atomic_commits, bomb_pot_award_units,
 * hand_projection_outbox, rake_records or rake_attributions row - which every
 * genuine hand receives unconditionally in the same transaction that inserts
 * it. Nothing paid, nothing to reconcile, nobody to make whole.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .find((f) => f.includes('a_hand_history_row_cannot_be_written_with_no_table'));
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';

describe('a hand history row cannot be written with no table', () => {
  it('the migration exists', () => {
    expect(file, 'the guard migration must not be deleted').toBeTruthy();
  });

  it('fn_ca_insert_hand_with_awards refuses a missing or NULL table_id before naming a column list', () => {
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_insert_hand_with_awards'),
      sql.indexOf('COMMENT ON FUNCTION public.fn_ca_insert_hand_with_awards')
    );
    expect(fn).toContain("NOT (p_row ? 'table_id')");
    expect(fn).toContain("NULLIF(p_row->>'table_id', '') IS NULL");
    expect(fn).toContain('names no table_id');
    expect(fn).toContain("USING ERRCODE = 'integrity_constraint_violation'");
    // The guard must run BEFORE the column-list build and the INSERT, not after.
    const guardAt = fn.indexOf("NOT (p_row ? 'table_id')");
    const colsAt = fn.indexOf('SELECT string_agg');
    const insertAt = fn.indexOf('INSERT INTO public.hand_history');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(colsAt);
    expect(colsAt).toBeLessThan(insertAt);
  });

  it('the migration proves refusal on a missing key, refusal on an explicit NULL, and continued acceptance of a synthetic table_id, then rolls every probe back', () => {
    expect(sql).toMatch(/VERIFY FAILED: a hand with no table_id key committed/);
    expect(sql).toMatch(/VERIFY FAILED: a hand with an explicit NULL table_id committed/);
    expect(sql).toContain("v_table   uuid := '00000000-0000-0000-0000-0000000000aa'");
    expect(sql).toContain('v_still_accepted := true');
    expect(sql).toContain("RAISE EXCEPTION 'ca_verify_rollback'");
    expect(sql).toContain('IF EXISTS (SELECT 1 FROM public.hand_history WHERE hand_number = -1)');
    expect(sql).toContain('HAND_HISTORY_TABLE_ID_GUARD_PROVED');
  });

  it('the cleanup names the four orphan rows by id and requires proof of zero settlement linkage before deleting them', () => {
    const cleanup = sql.slice(
      sql.indexOf('DO $cleanup$'),
      sql.indexOf('ORPHAN_NULL_TABLE_ID_HANDS_REMOVED')
    );
    for (const id of [
      'db62bc9f-5bca-4956-a0e9-02d0cab88d04',
      'aac82004-2253-4455-ab2b-a6f17329215a',
      '8c64fa89-a3ec-424e-be62-1dcc3c9979af',
      'f8fe7f26-27c0-454f-ae33-30f58590fbf0',
    ]) {
      expect(cleanup).toContain(id);
    }
    expect(cleanup).toContain('table_id IS NULL');
    expect(cleanup).toContain("players = '[]'::jsonb");
    expect(cleanup).toContain("winners = '[]'::jsonb");
    expect(cleanup).toContain('public.hand_atomic_commits');
    expect(cleanup).toContain('public.bomb_pot_award_units');
    expect(cleanup).toContain('public.hand_projection_outbox');
    expect(cleanup).toContain('public.rake_records');
    expect(cleanup).toContain('public.rake_attributions');
    expect(sql).toContain('expected to delete exactly 4 verified-orphan rows');
  });

  it('the whole change is one transaction', () => {
    expect(sql.trim().startsWith('-- 20260925032029')).toBe(true);
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^BEGIN;/gm)?.length).toBe(1);
    expect(sql.match(/^COMMIT;/gm)?.length).toBe(1);
  });
});
