/**
 * THE FIRST CLOSE OF A LONG WEEK WAITS FOR A QUIET HOUR (2026-10-03).
 *
 * Pinned on migration 20261003155132_the_first_close_of_a_long_week_waits_for_a_quiet_hour.sql.
 * The first close attempt of the week 2026-09-28 -> 2026-10-05 (Midway Union,
 * Deep Stack Society) and that boundary's inventory seal wait until
 * 2026-10-06 13:00 UTC at the latest; a held visit files one warning, never a
 * critical; retries, other scopes and other weeks are not gated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003155132_the_first_close_of_a_long_week_waits_for_a_quiet_hour.sql'
  ),
  'utf8'
);

describe('the first close of a long week waits for a quiet hour', () => {
  it('is one transaction with live proofs, on exact preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(4);
    expect(sql).toContain("IF md5(d)<>'afc109b27abc4646c1c6878368579211' THEN");
    expect(sql).toContain("IF md5(c)<>'18926d48bccb3663097ce2ebea48ab5c' THEN");
    expect(sql).toContain(
      "THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'"
    );
  });

  it('gates exactly two scopes of one week, lifting by 2026-10-06 13:00 UTC at the latest', () => {
    expect(sql).toContain(
      "CHECK (gate_until > period_end AND gate_until <= period_end + interval '30 hours')"
    );
    expect(sql).toContain(
      "SELECT g.k, g.id, '2026-09-28 07:00:00+00', '2026-10-05 07:00:00+00', '2026-10-06 13:00:00+00',"
    );
    expect(sql).toContain(
      "FROM (VALUES ('union','fade0000-0000-0000-0000-000000000001'::uuid), ('club','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)) g(k, id);"
    );
    expect(sql).toContain(
      ' IF NOT FOUND OR clock_timestamp()>=g.gate_until THEN RETURN false; END IF;'
    );
  });

  it('holds only a first attempt and files a warning, never a critical', () => {
    expect(sql).toContain(
      ' IF EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.scope_kind=p_scope_kind AND q.scope_id=p_scope_id\n   AND q.period_start=p_period_start AND q.period_end=p_period_end) THEN\n  RETURN false;'
    );
    expect(sql).toContain(
      "VALUES(CASE WHEN p_scope_kind='union' THEN 'union_accounting_scheduler' ELSE 'weekly_club_accounting' END,'warning',"
    );
    expect(sql).not.toMatch(/,\s*'critical'/);
    expect(sql).not.toMatch(/SECURITY DEFINER/);
  });

  it('asks the gate before anything of the week runs, and calls the close when it lifts', () => {
    expect(sql).toContain('      IF v_now < v_due THEN EXIT; END IF;\n$a$;');
    expect(sql).toContain(
      "      IF public.fn_accounting_close_gate_holds('union',v_union.id,v_from,v_end) THEN EXIT; END IF;"
    );
    expect(sql).toContain(
      "        IF public.fn_accounting_close_gate_holds('club',v_club.id,v_from,v_end) THEN EXIT;END IF;"
    );
    expect(sql).toContain(
      '      AND NOT public.fn_accounting_close_seal_held(public.fn_union_week_start(v_now)) THEN'
    );
    expect(sql).toContain(
      ' OR public.fn_accounting_close_gate_lifted_unstarted() THEN public.fn_union_settlement_cascade_due() END;'
    );
  });
});
