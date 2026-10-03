/**
 * A FINISH WAITS FOR A COMMISSION KEY HOLDING NOTHING (2026-10-03).
 *
 * Pinned on migration 20261003201157_a_finish_waits_for_a_commission_key_holding_nothing.sql.
 * A finish waited for a cash batch's club commission key inside recognition,
 * after increment_union_wallet had taken the union's one union_wallets row,
 * so the union's raked hands queued behind a finish that was itself waiting.
 * The finish now waits for those keys holding nothing (before its lane, and
 * again just before the union credit) and still takes them where it always did.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003201157_a_finish_waits_for_a_commission_key_holding_nothing.sql'
  ),
  'utf8'
);
const helper = sql.slice(
  sql.indexOf('CREATE FUNCTION public.fn_ca_await_commission_keys_free('),
  sql.indexOf('$function$;')
);

describe('a finish waits for a commission key holding nothing', () => {
  it('is one transaction with a live proof and no index preamble', () => {
    expect(sql.trimStart().startsWith('--')).toBe(true);
    expect(sql).not.toMatch(/CREATE\s+INDEX/i);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('the wait holds nothing: a shared session lock released by the next statement', () => {
    expect(helper).toContain('IF NOT pg_try_advisory_lock_shared(v_key) THEN');
    expect(helper).toContain('PERFORM pg_advisory_lock_shared(v_key);');
    expect(helper).toContain('PERFORM pg_advisory_unlock_shared(v_key);');
    expect(helper).not.toMatch(/pg_advisory_xact_lock/);
    expect(helper).not.toMatch(/pg_advisory_lock\(/);
    expect(helper).toContain("hashtextextended('agent-commission:' || v_club::text, 0)");
  });

  it('a refused wait is not an error, and a cancellation releases the lock before it propagates', () => {
    expect(helper).toContain('WHEN lock_not_available OR deadlock_detected THEN');
    expect(helper).toMatch(
      /WHEN query_canceled THEN\s+-- [^\n]*\n\s+PERFORM pg_advisory_unlock_shared\(v_key\);\s+RAISE;/
    );
  });

  it('waits for the clubs the rollup trigger keys on, in club order', () => {
    expect(helper).toContain('FROM public.accounting_tournament_fee_sources s');
    expect(helper).toContain('WHERE s.tournament_id = p_tournament_id');
    expect(helper).toContain("THEN (tier.value->>'amount')::numeric ELSE 0 END > 0");
    expect(helper).toContain('ORDER BY 1');
  });

  it('the finish waits before its lane, from its exact preimage', () => {
    expect(sql).toContain("IF md5(d) <> 'c64e049911fd99c1d784cdb042ca714b' THEN");
    expect(sql).toMatch(
      /E' {2}PERFORM public\.fn_ca_await_commission_keys_free\(p_tournament_id\);\\n'\s+\|\| E' {2}PERFORM public\.fn_ca_lock_settlement_lane_for_finish\(p_tournament_id\);\\n'/
    );
  });

  it('the rake settle waits again immediately before the union credit, from its exact preimage', () => {
    expect(sql).toContain("IF md5(d) <> '15acb041213e75e30cefdff37e04179b' THEN");
    expect(sql).toMatch(
      /E' {3}PERFORM public\.fn_ca_await_commission_keys_free\(p_tournament_id\);\\n'\s+\|\| E' {3}v_res:=public\.increment_union_wallet\(v_union,v_net,v_t\.club_id,\\n'/
    );
    expect(sql).toContain(
      "RAISE EXCEPTION 'rake settle postimage differs from the substituted text'"
    );
  });

  it('is owner-only, re-asks the lane doctrine, and changes no table, index, grant or schedule', () => {
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).toContain('public.fn_ca_settlement_lane_doctrine()');
    expect(sql).not.toMatch(/^\s*GRANT\s/im);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/cron\.(schedule|alter_job|unschedule)\(/);
  });
});
