/**
 * A UNION JOIN CLOSURE COUNTS AS A PROMO SWEEP ONLY FOR ITS PROMO PART (2026-10-12).
 *
 * Pinned on migration 20261012113912_a_union_join_closure_is_promo_only.sql.
 * fn_close_club_wallets_on_union_join writes the whole BBJ pool (main, backup
 * and promo) as one bbj_promo_sweep row so the whole-pool check counts it as
 * an outflow. The promo-only readers counted all of it as promo and the promo
 * bank read 68,795.45 over-swept. They now count such a row by its bbj_promo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261012113912_a_union_join_closure_is_promo_only.sql'),
  'utf8'
);

describe('a union join closure is promo only for its promo part', () => {
  it('is one transaction with a live proof and pinned preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("'f9d81c25d63969a6cc76a446386e29c9'");
    expect(sql).toContain("'91d4875621299c2af678081bfa3c84e7'");
  });

  it('reads a union_join closure by its own promo amount in both promo readers', () => {
    expect(sql).toContain("THEN COALESCE((metadata->>'bbj_promo')::numeric,0) ELSE amount END),0)");
    expect(sql).toContain(
      "THEN COALESCE((t.metadata->>'bbj_promo')::numeric,0) ELSE t.amount END)"
    );
  });

  it('leaves the whole-pool conservation check alone and proves the promo bank reconciles', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_bbj_conservation_check/);
    expect(sql).toContain("IF (v_r->>'reconciles')::boolean IS NOT TRUE THEN");
  });
});
