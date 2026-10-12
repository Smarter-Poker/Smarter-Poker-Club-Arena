/**
 * THE INVENTORY SEAL IS COMPUTED SIX HOURS AT A TIME (2026-10-03).
 *
 * Pinned on migration 20261003180832_the_inventory_seal_is_computed_six_hours_at_a_time.sql.
 * A closed week's original inventory can be sealed in six-hour layers, each
 * fn_union_pnl_inventory_state over the snapshot at the layer's start, and
 * assembled into exactly the checkpoint the one-transaction seal writes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003180832_the_inventory_seal_is_computed_six_hours_at_a_time.sql'
  ),
  'utf8'
);

describe('the inventory seal is computed six hours at a time', () => {
  it('is one transaction with live proofs and unlogged staging', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(2);
    expect(sql.match(/CREATE UNLOGGED TABLE public\.union_pnl_inventory_seal_layer/g)?.length).toBe(
      3
    );
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });

  it('continues each row from its latest layer, else the base checkpoint', () => {
    expect(sql).toContain('ORDER BY t.sn,t.rid,s.layer DESC NULLS LAST');
    expect(sql).toContain(
      'SELECT t.sn,t.rid FROM t JOIN b ON b.sn=t.sn AND b.rid=t.rid WHERE t.min_id<b.eid'
    );
    expect(sql).toContain(
      "SELECT 'issue',pi.sn,pi.rid,pi.eid,NULL::text,NULL::jsonb FROM pi WHERE NOT EXISTS(SELECT 1 FROM x WHERE x.sn=pi.sn AND x.rid=pi.rid)"
    );
  });

  it('seals exactly as the one-transaction seal, or verifies against a sealed week', () => {
    expect(sql).toContain('-- From here on, exactly fn_union_pnl_inventory_checkpoint_seal.');
    expect(sql).toContain('v_projection:=public.fn_union_pnl_inventory_population(p_at,p_at);');
    expect(sql).toContain("IF done_any AND clock_timestamp()>began+interval '120 seconds' THEN");
    expect(sql).toContain(
      'AND v_issues_md5=v_prior.issues_md5 AND v_max IS NOT DISTINCT FROM v_prior.max_event_id THEN'
    );
  });
});
