/**
 * ===========================================================================
 *  LAW: A WRITER A BROWSER CAN CALL NAMES ITS CALLER IN ITS OWN BODY
 * ===========================================================================
 *
 * WHAT HAPPENED. union_weekly_accounting_atomic_activation_20260917
 * (recorded 20260917181100) installed fn_reduce_agent_credit_v1 and
 * fn_retire_agent_credit_reduction_v1: SECURITY DEFINER, writing, EXECUTE
 * granted to authenticated, and neither body mentioning auth.uid(),
 * auth.role() or auth.jwt(). Both were bound to the caller, but only through
 * the private helper fn_credit_reduction_lock_v1, which refuses 42501 unless
 * auth.uid() is the named actor. Every net for this shape reads the writer's
 * OWN text and cannot follow the call:
 *
 *   fn_definer_exposure_audit()  question 1   "live: 3, baselined: 2, new: 2"
 *   check-definer-authorization.mjs  rule 1
 *   trg_autorevoke_privileged_anon   "behavioural: definer + writes + no auth.uid()"
 *
 * and nothing tied the writers to the helper, so a later CREATE OR REPLACE of
 * the helper that lost its actor check would have opened both to every
 * signed-in account while all three nets reported what they report today.
 *
 * THE FIX, which this pins. Revoking was wrong: the club manager's
 * credit-reduction flow calls both from the browser
 * (src/services/CreditReductionOperation.ts). Baselining was wrong:
 * reviewedExceptions is shrink-only and is for writers that cannot be pointed
 * at anything. So migration 20260922160600 states the helper's own condition
 * in each writer's own body, with the helper's own error, changing nothing
 * else - proved by undoing the replace and getting the old definition back.
 *
 * THE SHAPE IT MUST KEEP. The binding refuses a caller with NO identity. The
 * rebuy hole of 2026-08-28 was `IF auth.uid() IS NOT NULL AND auth.uid() <>
 * p_user_id`, which skips itself exactly when there is nobody signed in.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs, code } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FIX = 'supabase/migrations/20260922160600_credit_reduction_writers_ask_who_is_calling.sql';
const SQL = read(FIX);
/** Comments out, dollar-quoted bodies kept: the binding lives in a literal. */
const BODY = SQL.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

const REDUCE =
  'public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text)';
const RETIRE = 'public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)';
const WRITERS = ['fn_reduce_agent_credit_v1', 'fn_retire_agent_credit_reduction_v1'];
const BINDING =
  'IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_actor_id THEN\n' +
  "  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;";

describe('a writer a browser can call names its caller in its own body', () => {
  it('is one transaction, with the timeouts the production DDL policy requires', () => {
    expect((SQL.match(/^BEGIN;/gm) || []).length).toBe(1);
    expect((SQL.match(/^COMMIT;/gm) || []).length).toBe(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout\s*=/);
    expect(SQL).toMatch(/SET LOCAL statement_timeout\s*=/);
  });

  it('binds both credit-reduction writers, right after the helper that already binds them', () => {
    expect(BODY).toContain(REDUCE);
    expect(BODY).toContain(RETIRE);
    expect(BODY).toContain(
      'PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);\n ' +
        BINDING
    );
  });

  it('refuses a caller with no identity, never skips itself for one', () => {
    expect(BINDING).toMatch(/auth\.uid\(\) IS NULL OR/);
    // Neither shape that lets a caller with no auth.uid() through.
    expect(BODY).not.toMatch(/auth\.uid\(\)\s+IS\s+NOT\s+NULL\s+AND/i);
    expect(BODY).not.toMatch(/coalesce\s*\(\s*auth\.uid\(\)/i);
  });

  it('changes nothing else, and refuses to run on a source nobody reviewed', () => {
    // The accounting contract's reviewed source md5s, from
    // supabase/accounting/credit-reduction-v1/guard-installed-function-sources.json.
    expect(BODY).toContain("'2921345d6b7eda01404fc77e2e130c29'");
    expect(BODY).toContain("'7ef3a5839666732fb2e6f39fd653b8a6'");
    const contract = read(
      'supabase/accounting/credit-reduction-v1/guard-installed-function-sources.json'
    );
    expect(contract).toContain('"source_md5": "2921345d6b7eda01404fc77e2e130c29"');
    expect(contract).toContain('"source_md5": "7ef3a5839666732fb2e6f39fd653b8a6"');
    // Undoing the replace must give back the old definition byte for byte, and
    // the grants, owner, config and OID must not move.
    expect(BODY).toContain('IF replace(v_after, v_new, v_old) IS DISTINCT FROM v_before THEN');
    expect(BODY).toContain('IF v_shape_after IS DISTINCT FROM v_shape_before THEN');
    expect(BODY).toContain(
      "v_acl constant text := '{postgres=X/postgres,authenticated=X/postgres}';"
    );
    // Nothing is retyped: the change is made on the live definition.
    expect(BODY).toContain('EXECUTE replace(v_before, v_old, v_new);');
    expect(code(SQL)).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
  });

  it('proves both directions before it commits', () => {
    // A caller with no account cannot execute either; the signed-in manager
    // still can; no server role gained anything.
    expect(BODY).toContain("has_function_privilege('anon', r.sig, 'EXECUTE')");
    expect(BODY).toContain("has_function_privilege('public', r.sig, 'EXECUTE')");
    expect(BODY).toContain('authenticated lost EXECUTE on %');
    expect(BODY).toContain('service_role gained EXECUTE on %');
    // The auditor that went red clears both on their own text.
    expect(BODY).toContain('fn_definer_exposure_audit still lists a credit-reduction writer');
    // And a caller who is not the named actor is still refused, 42501, with
    // nobody signed in and with somebody else signed in.
    expect(BODY).toMatch(/EXCEPTION WHEN insufficient_privilege THEN/);
    expect(BODY).toContain('accepted a caller with no identity');
    expect(BODY).toContain('accepted a caller naming somebody else');
  });

  it('declares a live proof for each writer', () => {
    const proofs = declaredProofs(SQL);
    expect(proofs).toHaveLength(2);
    expect(proofs.some((p: string) => p.includes(REDUCE) && p.includes('position('))).toBe(true);
    expect(proofs.some((p: string) => p.includes(RETIRE) && p.includes('position('))).toBe(true);
  });
});

describe('and it is answered, not forgiven', () => {
  const LIVE = JSON.parse(read('scripts/ci/definer-exposure-baseline.json'));
  const GATE = JSON.parse(read('scripts/ci/definer-authorization.allowlist.json'));

  it.each(WRITERS)('%s is in no baseline and no allowlist', (fn) => {
    expect(Object.keys(LIVE.reviewedExceptions ?? {})).not.toContain(fn);
    expect(Object.keys(LIVE.reviewedAnonReaders ?? {})).not.toContain(fn);
    expect(Object.keys(GATE.reviewedExceptions ?? {})).not.toContain(fn);
    expect(Object.keys(GATE.anonPublicSurface ?? {})).not.toContain(fn);
  });

  it('the signed-in caller the authenticated grant exists for is still there', () => {
    // If this ever fails because the browser stopped calling them, the grant
    // to authenticated is the thing to remove.
    const caller = read('src/services/CreditReductionOperation.ts');
    for (const fn of WRITERS) expect(caller).toContain(`'${fn}'`);
  });
});
