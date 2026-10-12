/**
 * A PAYOUT WAITS ONLY FOR FINISHES THAT SHARE ITS BANK (2026-10-01)
 *
 * 440 payouts were refused in two hours at the platform-wide finish lane F
 * (pg_advisory_xact_lock on 'ca:tournament-finish-lane:v1', 8 s lock timeout):
 * every payout on the platform waited for every other one. An ordinary finish
 * now takes F shared and F(scope) exclusive, scope = the host club's union or
 * the host club, so payouts of different banks run side by side, payouts that
 * share a bank stay one at a time, and satellite finishes and sweeps (F
 * exclusive) still exclude every ordinary finish.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20261001232124_a_payout_waits_only_for_finishes_that_share_its_bank.sql'
  ),
  'utf8'
);
const start = SQL.indexOf(
  'CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_finish('
);
const open = SQL.indexOf('$function$', start) + '$function$'.length;
const BODY = SQL.slice(open, SQL.indexOf('$function$', open));

describe('a payout waits only for finishes that share its bank', () => {
  it('replaces the reviewed production pre-image in one transaction', () => {
    expect(start).toBeGreaterThan(0);
    expect(SQL).toContain("md5(p.prosrc) = '58962520e072fe177eaa29809db909f3'");
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
  });

  it('never takes the platform-wide finish lane exclusively for an ordinary finish', () => {
    expect(BODY).not.toMatch(
      /pg_advisory_xact_lock\(\s*hashtextextended\('ca:tournament-finish-lane:v1', 0\)\)/
    );
    expect(BODY).toMatch(
      /pg_advisory_xact_lock_shared\(\s*hashtextextended\('ca:tournament-finish-lane:v1', 0\)\)/
    );
  });

  it('serializes finishes per bank scope, in the lane order G, F, F(scope), T', () => {
    const fresh = BODY.slice(BODY.indexOf('-- G SHARED'));
    const g = fresh.indexOf("'ca:tournament-terminal-settlement:v1', 0");
    const f = fresh.indexOf("'ca:tournament-finish-lane:v1', 0");
    const scope = fresh.indexOf("'ca:tournament-finish-lane:v1:scope:' || v_scope, 0");
    const t = fresh.indexOf("'ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0");
    expect(g).toBeGreaterThanOrEqual(0);
    expect(f).toBeGreaterThan(g);
    expect(scope).toBeGreaterThan(f);
    expect(t).toBeGreaterThan(scope);
    expect(BODY).toContain("COALESCE(c.union_id::text, t.club_id::text, '')");
  });

  it('keeps satellites and unscoped events on the global lane, and re-entry takes nothing new', () => {
    expect(BODY).toMatch(
      /IF v_satellite OR COALESCE\(v_scope, ''\) = '' THEN\s+PERFORM public\.fn_ca_lock_settlement_lane_global\(\);/
    );
    expect(BODY).toContain("RAISE EXCEPTION 'finish lane is held for tournament %, refused for %'");
    expect(BODY).toContain("PERFORM set_config('ca.finish_lane_scope', v_scope, true);");
  });

  it('proves the lane doctrine after the change and keeps the grants', () => {
    expect(SQL).toContain("public.fn_ca_settlement_lane_doctrine() ->> 'ok'");
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) TO service_role;'
    );
  });
});
