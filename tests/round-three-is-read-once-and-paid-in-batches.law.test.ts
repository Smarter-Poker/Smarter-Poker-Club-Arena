/**
 * ROUND THREE IS READ ONCE AND PAID IN BATCHES (2026-10-03).
 *
 * Pinned on migration 20261003162308_round_three_is_read_once_and_paid_in_batches.sql.
 * In a chunked close, round 3's week is read in two-hour windows and its
 * certificates once, in attempts of their own; the paying attempt uses that
 * read only when it holds every locked period's certificate, and pays in
 * batches that each commit, recognising earlier batches only by their own
 * evidence; the last batch writes the receipt the single loop writes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003162308_round_three_is_read_once_and_paid_in_batches.sql'
  ),
  'utf8'
);

describe('round three is read once and paid in batches', () => {
  it('is one transaction with live proofs, on exact preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(5);
    for (const m of [
      'd26e5bb97db6245ba78dfab7df5c4f5d',
      '938d51161f05ac629704a10b13516e6a',
      'e4c537a653cb577dc4c12d909a01c206',
      '5b0ffee25e034a08cbe13df5fd64332a',
    ]) {
      expect(sql).toContain(`IF md5(d)<>'${m}' THEN`);
    }
    expect(sql.match(/ THEN RAISE EXCEPTION '[a-z0-9 ]+ postimage differs/g)?.length).toBe(4);
  });

  it('uses the kept read only when it holds every locked period and certificate', () => {
    expect(sql).toContain(
      'WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rr3_plan_alloc a WHERE a.period_id=pr.id AND a.cert_id=pc.id AND a.club_id=pr.club_id AND a.user_id=pr.user_id)) THEN'
    );
    expect(sql).toContain(
      'COALESCE((e->>8)::boolean,true) OR q2.d1 IS DISTINCT FROM (e->>9)::numeric OR q2.d2 IS DISTINCT FROM (e->>10)::numeric'
    );
    expect(sql).toContain(
      "AND p.value->>'failed'='false' AND p_legacy IS FALSE AND p.value->>'legacy'='false'"
    );
  });

  it('pays in batches, recognising an earlier batch only by its own evidence', () => {
    expect(sql).toContain(
      "AND CASE WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text"
    );
    expect(sql).toContain('  IF v_batched AND clock_timestamp()>v_stop THEN EXIT; END IF;');
    expect(sql).toContain(
      " IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.status IS DISTINCT FROM 'pending'"
    );
    expect(sql).toContain('paid:=paid+v_paid_before;payees:=payees+v_payees_before;');
    expect(sql).toContain("IF v_chunked AND v_r3->>'batch_committed' = 'true' THEN");
    expect(sql).toContain("IF v_chunked AND v_stage3->>'batch_committed'='true' THEN");
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });
});
