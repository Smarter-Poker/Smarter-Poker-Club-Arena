/**
 * THE OPEN-WEEK RAKE BASIS IS REFRESHED TWO HOURS AT A TIME (2026-10-03).
 *
 * Pinned on migration 20261003224956_the_open_week_rake_basis_is_refreshed_two_hours_at_a_time.sql.
 * Job 123's open-week rake basis snapshot is combined from proved two-hour
 * windows of the earned plan, the closed ones kept while their input stamp is
 * unchanged, instead of proving the whole week so far every hour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003224956_the_open_week_rake_basis_is_refreshed_two_hours_at_a_time.sql'
  ),
  'utf8'
);

describe('the open-week rake basis is refreshed two hours at a time', () => {
  it('is one anchored transaction with live proofs', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(3);
    expect(sql).toContain("IF md5(d)<>'3417a860ca6fa00907e7e7ef2f8b1c85'");
    expect(sql).toContain('ALTER TABLE public.union_rake_basis_windows ENABLE ROW LEVEL SECURITY;');
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });

  it('proves each window with the chunked close window and reuses it only under the same stamp', () => {
    expect(sql).toContain(
      'SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);'
    );
    expect(sql).toContain('AND b.window_end=w.window_end AND b.input_stamp=st;');
    expect(sql).toContain(
      "'agreements',(SELECT jsonb_build_array(count(*),max(h.id)) FROM public.accounting_agreement_history h WHERE h.observed_at<win.window_end),"
    );
    expect(sql).toContain("closed:=w.window_end=w.window_start+interval '2 hours';");
  });

  it('combines exactly as the close combines, and falls back to the one-read plan', () => {
    expect(sql).toContain('IF src IS DISTINCT FROM bank THEN RETURN NULL; END IF;');
    expect(sql).toContain("trunc(sum((e->>'weighted')::numeric),2) AS payout");
    expect(sql).toContain(
      'FROM public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true) b;\n  END IF;'
    );
    expect(sql).toContain(
      "RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'windows_in_progress',"
    );
  });

  it('stays inside the sweep budget and no longer reads the sources view for its stamp', () => {
    expect(sql).toContain(
      "IF clock_timestamp()>began+(CASE WHEN closed THEN interval '120 seconds' ELSE interval '180 seconds' END) THEN"
    );
    expect(sql).toContain(
      "'batches', (SELECT count(*) FROM public.accounting_cash_accrual_batches b"
    );
  });
});
