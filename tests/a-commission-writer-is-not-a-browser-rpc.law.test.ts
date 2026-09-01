/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A COMMISSION WRITER IS NOT A BROWSER RPC (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * calculate_cascading_commission INSERTs into agent_commissions, INSERTs the
 * club-owner residual, and UPDATEs club_wallets.period_commission_paid and
 * lifetime_commission_paid. Its production ACL on 2026-09-01 was
 *
 *     {=X/postgres, postgres=X/postgres, anon=X/postgres,
 *      authenticated=X/postgres, service_role=X/postgres}
 *
 * so PUBLIC, anon and authenticated all held EXECUTE on it.
 *
 * It was not exploitable, and the pin says why rather than pretending
 * otherwise: the function is SECURITY INVOKER, so RLS stands behind its writes
 * and agent_commissions and club_wallets both admit writes only for
 * service_role. What makes the grant worth closing is that those two policies
 * are the ONLY thing holding it, nothing ties them to this grant, and the most
 * ordinary policy edit imaginable turns a dormant grant into a live money path.
 *
 * Follows the precedent in
 * 20260826150000_revoke_authenticated_execute_on_five_economy_functions.sql:
 * revoke per role, then assert it took and that service_role kept what the
 * World Hub API routes need.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const MIGRATION = read(
  'supabase/migrations/20260901090400_cascading_commission_is_not_a_browser_rpc.sql'
);

describe('the grant is closed per role', () => {
  /**
   * REVOKE ... FROM PUBLIC on its own does NOT close a function that also
   * carries an explicit grant to authenticated. A revoke naming the wrong role
   * reads as a fix and is a no-op -- the exact mistake that made an earlier
   * column-level revoke on club_members do nothing at all.
   */
  it('names authenticated, anon and PUBLIC, on the full signature', () => {
    expect(MIGRATION).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.calculate_cascading_commission\(uuid, uuid, uuid, numeric, uuid, uuid\)\s*\n\s*FROM authenticated, anon, PUBLIC;/
    );
  });

  it('never re-grants it to a browser role', () => {
    const code = MIGRATION.split('\n')
      .filter((l) => !/^\s*--/.test(l))
      .join('\n');
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.calculate_cascading_commission/);
  });
});

describe('the migration proves its own effect', () => {
  it('fails loudly if the revoke did not take', () => {
    expect(MIGRATION).toMatch(/has_function_privilege\(\s*\n?\s*r\.rolname,/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'REVOKE did not take effect for: %'/);
  });

  it('refuses to strand the server routes that legitimately call it', () => {
    expect(MIGRATION).toMatch(/has_function_privilege\('service_role',/);
    expect(MIGRATION).toMatch(/service_role lost EXECUTE on calculate_cascading_commission/);
  });

  /**
   * A revoke that names one signature while a second overload exists closes
   * nothing. The precedent migration learned this on fn_bbj_promo_payout_atomic.
   */
  it('asserts there is exactly one overload to close', () => {
    expect(MIGRATION).toMatch(/unexpected overload count/);
  });
});
