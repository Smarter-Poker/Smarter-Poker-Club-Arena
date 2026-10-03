/**
 * A CLOSE ATTEMPT THAT PREPARED A LONG WEEK PAYS IN THE NEXT (2026-10-03).
 *
 * Pinned on migration 20261003121635_a_close_attempt_that_prepared_a_long_week_pays_in_the_next.sql.
 * In a chunked close, an attempt whose preparation did durable work of its own
 * (a kept P&L step, a recorded weekly recompute) for more than 60 seconds ends
 * as a committed 'prepared' step, so preparing a long week and paying a round
 * never share one transaction; a preparation that only reused receipts never
 * stops this way, so the close always moves forward.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003121635_a_close_attempt_that_prepared_a_long_week_pays_in_the_next.sql'
  ),
  'utf8'
);

describe('a close attempt that prepared a long week pays in the next', () => {
  it('is one transaction with live proofs, on the exact preimage', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(2);
    expect(sql).toContain("IF md5(d)<>'d02595b5d3c4c91971e47d6dfb106ead' THEN");
    expect(sql).toContain('IF pg_get_functiondef(s)<>d THEN');
  });

  it('stops only after durable work of its own and 60 seconds', () => {
    expect(sql).toContain("AND (current_setting('app.accounting_close_certified',true)='on'");
    expect(sql).toContain(
      'OR EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q\n         WHERE q.attempted_at>=now()'
    );
    expect(sql).toContain("+interval '60 seconds'");
    expect(sql).toContain(
      "SELECT COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'"
    );
  });

  it('ends the union and the standalone attempt as a committed prepared step', () => {
    expect(sql).toContain(
      "ELSIF v_chunked AND v_preparation->>'success'='true' AND v_preparation->>'paid_scope_replay' IS DISTINCT FROM 'true'\n          AND public.fn_accounting_close_prepared_long(v_union.id,NULL,v_from,v_end) THEN"
    );
    expect(sql).toContain(
      'IF v_chunked AND public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN'
    );
    expect(
      sql.match(/'chunk_committed',true,'committed_round',0,'stage','prepared'/g)?.length
    ).toBe(2);
  });

  it('creates one private invoker function', () => {
    expect(sql).not.toMatch(/SECURITY DEFINER/);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_close_prepared_long(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;'
    );
  });
});
