/**
 * THE WEEKLY CLOSE SEALS ITS INVENTORY SIX HOURS AT A TIME (2026-10-03).
 *
 * Pinned on migration 20261003183034_the_weekly_close_seals_its_inventory_six_hours_at_a_time.sql.
 * Inside a chunked close tick the missing seal is computed with
 * fn_union_pnl_inventory_seal_advance and the tick visits no scope while it is
 * still 'sealing'; the gated week's seal is no longer held.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003183034_the_weekly_close_seals_its_inventory_six_hours_at_a_time.sql'
  ),
  'utf8'
);

describe('the weekly close seals its inventory six hours at a time', () => {
  it('is one anchored transaction with live proofs', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(4);
    expect(sql).toContain("IF md5(d)<>'5f7ed8154e218b7cd17b3402f6989bca'");
    expect(sql).toContain("IF md5(d)<>'a55a0e4c2aa8f2c9d810af063a6060ec'");
    expect(sql).toContain("IF md5(d)<>'91f022b937ebd5c2175db82ece254198'");
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });

  it('seals six hours at a time only inside a chunked tick', () => {
    expect(sql).toContain(
      "IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN"
    );
    expect(sql).toContain('v_step:=public.fn_union_pnl_inventory_seal_advance(b,false);');
    expect(sql).toContain(
      "RETURN jsonb_build_object('status','sealing','boundary',b,'progress',v_step,'sealed',v_sealed);"
    );
  });

  it('visits no scope while the seal is still sealing, nor on the tick that sealed', () => {
    expect(sql).toContain(
      "IF v_seal->>'status'='sealing' OR jsonb_array_length(COALESCE(v_seal->'sealed','[]'::jsonb))>0 THEN"
    );
    expect(sql).toContain("'more_remaining',true");
    expect(sql).toContain("'inventory_seal',v_seal");
  });

  it('job 272 calls the close on every tick while a split seal is in progress', () => {
    expect(sql).toContain("IF md5(c)<>'44f3e5a5345938b92158e569d8f0fd70'");
    expect(sql).toContain(
      'OR public.fn_accounting_close_gate_lifted_unstarted() OR public.fn_union_pnl_inventory_seal_in_progress() THEN'
    );
    expect(sql).toContain(
      'AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now()))'
    );
  });

  it('starts no layer 90 s into a call and no longer holds the seal', () => {
    expect(sql).toContain("IF done_any AND clock_timestamp()>began+interval '90 seconds' THEN");
    expect(sql).toMatch(
      /fn_accounting_close_seal_held\(p_boundary timestamptz\)[\s\S]*?SELECT false\n\$f\$;/
    );
  });
});
