/**
 * LAW: THE HOURLY AUDITS READ LESS AND ANSWER THE SAME (2026-10-22).
 *
 * Migration 20261022062934. Five integrity nets ran for minutes every hour
 * (rake-bbj-invariant-audit 213 s, club-rake-rollup-catchup 157 s,
 * ca-conservation-sweep 99 s, rake-attribution-drift-audit 97 s,
 * union-integrity-sweep 87 s) holding reads on clubs, tables and the rake
 * tables. The cause in each was a read shape, not the check: a parameter the
 * planner could not see, the same table read three times, a complete day
 * rebuilt 24 times a day, every horse seat read to find the human ones.
 *
 * This pins the shapes so a later replacement of these functions cannot quietly
 * put the minutes back, and pins that no check was removed. The native
 * qualification (scripts/ci/test-the-hourly-audits-stop-holding-the-hot-tables.py)
 * proves every answer is identical before and after.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SQL = readFileSync(
  join(
    ROOT,
    'supabase/migrations/20261022062934_the_hourly_audits_read_only_what_changed_since_they_last_loo.sql'
  ),
  'utf8'
);
const CI = readFileSync(join(ROOT, '.github/workflows/the-hourly-audits-read-less.yml'), 'utf8');

describe('the hourly audits read less and answer the same', () => {
  it('is one transaction with a lock budget, preceded only by concurrent indexes', () => {
    const begin = SQL.search(/^BEGIN;$/m);
    expect(begin).toBeGreaterThan(-1);
    expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '3s';/);
    const before = SQL.slice(0, begin)
      .split('\n')
      .filter((l) => !/^\s*--/.test(l) && l.trim() !== '');
    for (const l of before) expect(l).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
    expect(before).toHaveLength(3);
  });

  it('replaces every function from a pinned preimage and proves the postimage', () => {
    for (const sig of [
      'public.fn_rake_attribution_drift(integer)',
      'public.fn_bbj_promo_bank_check()',
      'public.fn_club_table_daily_catchup(integer)',
      'public.fn_union_integrity_sweep(uuid,integer)',
      'public.fn_ca_payout_rows_without_money(integer)',
    ]) {
      expect(SQL).toContain(`  '${sig}',`);
    }
    expect(SQL).toContain("IF md5(v_def) <> p_before THEN");
    expect(SQL).toMatch(/owner, security, settings or grants moved/);
  });

  it('a parameterised window is planned with its value', () => {
    expect(SQL).toContain("ALTER FUNCTION public.fn_bbj_reconcile(uuid) SET plan_cache_mode = 'force_generic_plan';");
    expect(SQL.match(/SET plan_cache_mode TO 'force_custom_plan'/g)?.length).toBe(2);
  });

  it('removes no check and adds no job or repair', () => {
    expect(SQL).not.toMatch(/cron\.(schedule|unschedule)\s*\(/);
    expect(SQL).not.toMatch(/^\s*DROP\s/im);
    expect(SQL).toContain("SELECT cron.alter_job(123, schedule := '33 * * * *');");
    // The ledger-against-rollup check of every complete day lies outside every
    // anchor, so the substitution cannot touch it (the native run calls it).
    expect(SQL).not.toContain('Rake is conserved across attribution');
    // Co-seating still counts human-with-horse pairs and still drops only horse pairs.
    expect(SQL).toContain('WHERE NOT COALESCE(hp.is_horse, false)) pr');
    expect(SQL).toContain('HAVING count(DISTINCT pr.table_id) >= 8');
  });

  it('a complete day is rebuilt when it moves, today stays the triggers', () => {
    expect(SQL).toContain('CREATE TABLE public.club_table_daily_refresh_marks');
    expect(SQL).toContain('ALTER TABLE public.club_table_daily_refresh_marks ENABLE ROW LEVEL SECURITY;');
    expect(SQL).toContain("now() < v_hi + interval '12 hours'");
  });

  it('declares its proof and runs its native qualification in CI', () => {
    expect(SQL).toMatch(/^-- @live-proof: /m);
    expect(CI).toContain('python3 scripts/ci/test-the-hourly-audits-stop-holding-the-hot-tables.py');
    expect(CI).toContain('pull_request:');
  });
});
