/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE AGENT'S BOOKS TELL THE TRUTH (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 7 of 7 of the agent credit and promotion lifecycle. Phase 6 built the
 * path that pays an agent; this is the pass that makes every surface in front of
 * it report the number the ledger holds.
 *
 * Every pin below is a thing that was live on production on 2026-09-01:
 *
 *   - fn_get_agent_commission_summary was a STUB returning zeros, in bigint
 *     columns, from a TABLE-returning function the client read as an object. It
 *     fills the four cards on the agent dashboard. Every agent saw 0.
 *   - The Records tab and its realtime listener read commission_records: zero
 *     rows since creation, and not in the supabase_realtime publication.
 *   - The Sub-Agents tab and fn_club_set_member_role read
 *     agents.pending_commission: 26,859.87 across 5 agents, against a ledger
 *     holding 408,809.59 across 114.
 *   - fn_ca_gdpr_financial_precheck summed that same column, so an account
 *     holding unclaimed commission could be cleared for deletion - and the claim
 *     pays auth.uid() and nobody else, so deletion is what makes it
 *     unrecoverable.
 *   - 548,987 rows carried settled_at '2026-08-20 17:18:22.456863+00' with no
 *     chip movement anywhere behind it. 256,765.50 chips, 75 agents, marked paid
 *     by a bulk statement that paid nobody.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MIGRATION = read('supabase/migrations/20260901133348_the_agents_books_tell_the_truth.sql');
const SQL = codeOnly(MIGRATION);
const DASHBOARD = read('src/components/agent/AgentCommissionDashboard.tsx');
const SERVICE = read('src/services/CommissionService.ts');
const FINANCIALS = read('src/pages/ClubFinancialsPage.tsx');

describe('the summary is answered from the ledger', () => {
  it('is not a stub any more', () => {
    const fn = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_get_agent_commission_summary'),
      SQL.indexOf('COMMENT ON FUNCTION public.fn_get_agent_commission_summary')
    );
    expect(fn).toMatch(/FROM public\.agent_commissions/);
    expect(fn).not.toMatch(/STUB/i);
    expect(fn).not.toMatch(/Return zeros/i);
  });

  it('answers in chips, not whole numbers', () => {
    // The old signature was TABLE(bigint, bigint, bigint, bigint, timestamptz).
    // A chip has two decimal places; bigint cannot carry them.
    expect(SQL).toMatch(/DROP FUNCTION IF EXISTS public\.fn_get_agent_commission_summary\(uuid\);/);
    const fn = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_get_agent_commission_summary'),
      SQL.indexOf('COMMENT ON FUNCTION public.fn_get_agent_commission_summary')
    );
    expect(fn).toMatch(/RETURNS jsonb/);
    expect(fn).not.toMatch(/bigint/);
  });

  it('pays out no information about anybody else', () => {
    // p_agent_id is honoured only for a trusted backend caller, the same rule
    // fn_club_set_member_role applies to p_actor_user_id, and the same reason
    // phase 6 gave the claim no payee parameter at all.
    const fn = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_get_agent_commission_summary'),
      SQL.indexOf('COMMENT ON FUNCTION public.fn_get_agent_commission_summary')
    );
    expect(fn).toMatch(/v_uid := auth\.uid\(\)/);
    expect(fn).toMatch(/COALESCE\(auth\.role\(\), 'service_role'\) = 'service_role'/);
    expect(fn).toMatch(/WHERE ac\.user_id = v_uid/);
  });

  it('separates what was earned from what was paid', () => {
    const fn = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_get_agent_commission_summary'),
      SQL.indexOf('COMMENT ON FUNCTION public.fn_get_agent_commission_summary')
    );
    expect(fn).toMatch(
      /'pending_payout',\s*COALESCE\(SUM\(ac\.amount\) FILTER \(WHERE ac\.settled_at IS NULL\), 0\)/
    );
    expect(fn).toMatch(/'last_payout',\s*MAX\(ac\.settled_at\)/);
  });

  it('anon cannot ask it anything', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_get_agent_commission_summary\(uuid, uuid\) FROM PUBLIC, anon;/
    );
  });
});

describe('the three dead objects are gone, and nothing reaches for them', () => {
  it('drops the column and both empty tables', () => {
    expect(SQL).toMatch(/ALTER TABLE public\.agents DROP COLUMN IF EXISTS pending_commission;/);
    expect(SQL).toMatch(/DROP TABLE IF EXISTS public\.commission_records;/);
    expect(SQL).toMatch(/DROP TABLE IF EXISTS public\.commission_history;/);
  });

  it('drops the four functions that only ever touched them', () => {
    for (const fn of [
      'get_agent_commission_history',
      'generate_period_settlement',
      'atomic_pay_agent_settlement',
      'increment_agent_rake',
    ]) {
      expect(SQL).toContain(`DROP FUNCTION IF EXISTS public.${fn}(`);
    }
  });

  it('refuses to commit while any function still names one of them', () => {
    // A dropped column that a function still mentions is a runtime error
    // waiting for its first caller. The migration asserts on pg_proc.prosrc,
    // which includes comments - so the comments do not name it either.
    expect(SQL).toMatch(
      /WHERE n\.nspname = 'public'\s*\n\s*AND p\.prosrc ~ '\(pending_commission\|commission_records\|commission_history\)'/
    );
    expect(SQL).toMatch(/RAISE EXCEPTION 'these functions still reference a dropped object/);
  });

  it('takes the dropped payout function off both guard lists', () => {
    // fn_union_money_path_check treats a named function that no longer exists
    // as a breach in its own words, so leaving the name behind would make an
    // hourly estate guard report a failure nobody could fix.
    const start = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_money_path_check');
    const guards = SQL.slice(
      start,
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write')
    );
    expect(start).toBeGreaterThan(-1);
    expect(guards).not.toMatch(/'atomic_pay_agent_settlement'/);
    const walletGuard = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write'),
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_gdpr_financial_precheck')
    );
    expect(walletGuard).not.toMatch(/'atomic_pay_agent_settlement'/);
    expect(SQL).toMatch(
      /RAISE EXCEPTION 'the wallet guard still allows a function that no longer exists'/
    );
    expect(SQL).toMatch(
      /RAISE EXCEPTION 'the union money-path guard still requires a function that no longer exists'/
    );
  });
});

describe('deleting an account cannot erase what the club owes it', () => {
  it('blocks the GDPR precheck on unclaimed commission, per club', () => {
    const fn = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_gdpr_financial_precheck')
    );
    expect(fn).toMatch(/unclaimed commission/);
    expect(fn).toMatch(/FROM public\.agent_commissions ac/);
    expect(fn).toMatch(/ac\.settled_at IS NULL/);
    expect(fn).toMatch(/GROUP BY ac\.club_id/);
  });
});

describe('the phantom settlement is reversed, and no chips move to do it', () => {
  it('targets that one timestamp and nothing else', () => {
    expect(SQL).toMatch(/settled_at = TIMESTAMPTZ '2026-08-20 17:18:22\.456863\+00'/);
  });

  it('refuses if a payment ever turns up in that window', () => {
    expect(SQL).toMatch(/transaction_type ILIKE '%commission%' OR ct\.notes ILIKE '%commission%'/);
    expect(SQL).toMatch(
      /RAISE EXCEPTION\s*\n?\s*'a commission payment exists in the window this migration calls a phantom/
    );
  });

  it('does it in batches, with the timeout lifted for the transaction', () => {
    // As one statement it is killed at 120 seconds by statement_timeout, which
    // applies to a DO block as a whole - so batching alone does not escape it.
    expect(SQL).toMatch(/SET LOCAL statement_timeout = '0';/);
    expect(SQL).toMatch(/LIMIT 20000/);
    expect(SQL).toMatch(/EXIT WHEN v_batch = 0;/);
  });

  it('collects the set once instead of re-scanning for every batch', () => {
    expect(SQL).toMatch(/CREATE TEMP TABLE p7_phantom ON COMMIT DROP AS/);
    expect(SQL).toMatch(/DELETE FROM p7_phantom/);
  });

  it('journals what it did, without inventing a human to blame', () => {
    // audit_trail.actor_id is NOT NULL with a foreign key into auth.users.
    expect(SQL).toMatch(/INSERT INTO public\.ca_ledger_mutation_log/);
    expect(SQL).not.toMatch(/INSERT INTO public\.audit_trail/);
  });

  it('creates no chips: it restores a debt and leaves the paying to the claim', () => {
    const reversal = SQL.slice(SQL.indexOf('DO $reverse$'), SQL.indexOf('$reverse$;'));
    expect(reversal).not.toMatch(/chip_treasury/);
    expect(reversal).not.toMatch(/chip_balance/);
    expect(reversal).not.toMatch(/credit_used/);
  });
});

describe('a downline figure an upline is allowed to see', () => {
  it('is answered by a definer function, because RLS is per agent', () => {
    const fn = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_agent_downline_commission')
    );
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/JOIN public\.agents d ON d\.parent_agent_id = me\.id/);
    expect(fn).toMatch(/WHERE me\.user_id = v_uid/);
    expect(fn).toMatch(/ac\.settled_at IS NULL/);
  });

  it('and the club aggregate checks the caller is staff of that club', () => {
    const fn = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_club_commission_accrued')
    );
    expect(fn).toMatch(/public\.fn_is_club_admin_uid\(p_club_id\)/);
  });
});

describe('the client asks the ledger', () => {
  it('the dashboard reads commission rows from the ledger, through the view that knows both payers', () => {
    // THE PIN MOVED, THE LAW DID NOT (2026-09-08, phase 7). It used to require
    // .from('agent_commissions') because this screen had been reading
    // commission_records, a table that never held a row. That is still
    // forbidden below. What changed is that reading the bare table is no longer
    // the truth either: since 20260908025653 round 2 pays a whole period and
    // records it in agent_commission_settlements instead of stamping settled_at
    // on two million rows, so a row can be PAID with settled_at still null.
    // v_agent_commissions is the reader that knows both mechanisms -
    // settled_at is COALESCE(own stamp, the settlement's paid_at) and
    // settled_via says which one paid it. Reading the table directly showed
    // agents money they had already been paid as 'unclaimed'.
    expect(DASHBOARD).toMatch(/\.from\('v_agent_commissions'\)/);
    expect(DASHBOARD).not.toMatch(/\.from\('commission_records'\)/);
    // and it must actually use the flag it now asks for
    expect(DASHBOARD).toMatch(/settled_via/);
  });

  it('the realtime listener is on a table that is actually published', () => {
    // It listened to commission_records, which is not in supabase_realtime and
    // never held a row, so it could not fire even in principle.
    expect(DASHBOARD).toMatch(/table: 'agent_commissions'/);
    expect(DASHBOARD).toMatch(/filter: `user_id=eq\.\$\{user\.id\}`/);
  });

  it('the summary is asked for the club being looked at', () => {
    expect(DASHBOARD).toMatch(/p_agent_id: user\.id, p_club_id: canonicalClubId/);
    expect(DASHBOARD).toMatch(/await resolveClubUUIDStrict\(clubId\)/);
  });

  it('sub-agent earnings come from the ledger, not the dropped column', () => {
    // codeOnly, because the comments in that file explain the column by name -
    // which is history worth keeping, and is not a read.
    expect(codeOnly(DASHBOARD)).not.toMatch(/pending_commission/);
    expect(DASHBOARD).toMatch(/CommissionService\.downlineCommission/);
    expect(SERVICE).toMatch(/fn_agent_downline_commission/);
  });

  it('the club financials page stops summing an empty table', () => {
    expect(FINANCIALS).not.toMatch(/from\('commission_history'\)/);
    // 2026-09-04, phase 6: the aggregate moved from fn_club_commission_accrued
    // (a 608,280-row scan per page load, growing by ~300,000 rows a day) to
    // ca_club_commission_daily, the per-day rollup the same statement-level
    // triggers maintain, read through the one gated call this page now makes.
    expect(FINANCIALS).toMatch(/ca_club_financials/);
    const migration = read(
      'supabase/migrations/20260904220000_the_money_is_read_from_the_ledger.sql'
    );
    expect(migration).toMatch(/FROM ca_club_commission_daily k/);
  });

  it('and binds the error rather than reading a denied read as zero', () => {
    // The refusal is now a permission state, not a zero: a denied read and a
    // club that has accrued nothing are still not the same thing.
    expect(FINANCIALS).toMatch(/isAuthzError\(error\)/);
    expect(FINANCIALS).toMatch(/setDenied\(true\)/);
    expect(FINANCIALS).toMatch(/ClubFinancialsPage\.load/);
  });
});
