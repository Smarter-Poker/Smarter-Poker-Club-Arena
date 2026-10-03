/**
 * ROUND TWO IS PLANNED TWO HOURS AT A TIME (2026-10-03).
 *
 * Pinned on migration 20261003141618_round_two_is_planned_two_hours_at_a_time.sql.
 * In a chunked close, round 2's reads and tests run per two-hour window of the
 * closed week in attempts of their own, and the paying attempt combines them
 * into exactly the plan the stage's own reads build; nothing after the plan
 * changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003141618_round_two_is_planned_two_hours_at_a_time.sql'
  ),
  'utf8'
);

describe('round two is planned two hours at a time', () => {
  it('is one transaction with live proofs, on exact preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(3);
    expect(sql).toContain("IF md5(d)<>'9623803d7e99eb27c4efb9d18695aab3' THEN");
    expect(sql).toContain("IF md5(d)<>'d8b20829e2b832a22cd573f28447d23f' THEN");
    expect(sql.match(/ THEN RAISE EXCEPTION '[a-z ]+ postimage differs/g)?.length).toBe(2);
  });

  it('keeps every refusal of the stage, in its order', () => {
    for (const e of [
      'routed_commission_source_changed_after_payment',
      'legacy_commission_payment_requires_reconciliation',
      'unclassified_commission_source_requires_reconciliation',
      'routed_commission_hierarchy_ambiguous',
      'routed_commission_entitlement_disagrees_with_source',
    ]) {
      expect(sql).toContain(`RAISE EXCEPTION '${e}'`);
    }
    expect(sql).toContain(
      "IF (v_comb->>'full_path')::boolean THEN RAISE EXCEPTION 'routed_commission_window_needs_full_path'"
    );
  });

  it('combines the same nodes, edges and fingerprint', () => {
    expect(sql).toContain(
      "min(e->>'agent_min')::uuid,min(e->>'role_min'),sum((e->>'own')::numeric),sum((e->>'rows')::bigint)"
    );
    expect(sql).toContain("HAVING sum((e->>'amount')::numeric)>0;");
    expect(sql).toContain(
      "string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)"
    );
    expect(sql).toContain(
      'PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_clubs) ORDER BY c.id FOR NO KEY UPDATE;'
    );
  });

  it('proves windows in attempts of their own, never with a long preparation', () => {
    expect(sql).toContain(
      'AND (CASE WHEN public.fn_accounting_close_prepared_long(v_union.id,NULL,v_from,v_end) THEN true\n            ELSE public.fn_accounting_close_windows_pending(v_union.id,NULL,v_from,v_end) END) THEN'
    );
    expect(sql).toContain(
      'IF v_chunked AND (CASE WHEN public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN true\n            ELSE public.fn_accounting_close_windows_pending(NULL,v_club.id,v_from,v_end) END) THEN'
    );
    expect(sql).toContain(
      "IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN false; END IF;"
    );
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });
});
