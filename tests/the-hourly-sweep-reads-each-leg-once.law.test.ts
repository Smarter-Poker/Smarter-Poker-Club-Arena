/**
 * LAW: THE HOURLY SWEEP READS EACH LEDGER LEG ONCE (2026-10-22).
 *
 * Migration 20261022162545. ca-conservation-sweep-hourly (job 233) still ran
 * 72-121 s after 20261022062934, and every hour most of it re-read history
 * that cannot change: every player wallet leg since the chip baseline (3.65M),
 * every BBJ leg since the epoch (7.1M), every hand of 24 hours (1.48M) only to
 * ask whether there was one. The journal is append-only and a leg's created_at
 * is its transaction's start, so the sums of legs older than every open
 * transaction are kept and only the legs after them are read.
 *
 * This pins those shapes so a later replacement cannot quietly put the minutes
 * back, and pins that no check was removed and nothing repairs anything. The
 * native qualification (scripts/ci/test-the-hourly-sweep-reads-each-leg-once.py)
 * proves every answer equals the production definition at every step.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const SQL = readFileSync(
  join(ROOT, 'supabase/migrations/20261022162545_the_hourly_sweep_reads_each_ledger_leg_once.sql'),
  'utf8'
);
const CI = readFileSync(join(ROOT, '.github/workflows/the-hourly-sweep-reads-each-leg-once.yml'), 'utf8');
const code = SQL.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const body = (fn: string): string => {
  const at = SQL.indexOf(`FUNCTION public.${fn}(`);
  expect(at, fn).toBeGreaterThan(-1);
  const open = SQL.indexOf('$function$', at);
  return SQL.slice(open, SQL.indexOf('$function$', open + 10));
};

describe('the hourly sweep reads each ledger leg once', () => {
  it('is one transaction with a lock budget, preceded only by concurrent indexes', () => {
    const begin = SQL.search(/^BEGIN;$/m);
    expect(begin).toBeGreaterThan(-1);
    expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '3s';/);
    const before = SQL.slice(0, begin)
      .split('\n')
      .filter((l) => !/^\s*--/.test(l) && l.trim() !== '');
    for (const l of before) expect(l).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
    expect(before).toHaveLength(3);
  });

  it('replaces only pinned production definitions', () => {
    for (const [sig, pin] of [
      ['public.fn_chip_drift_since_baseline()', '6e7f006fb462ab5e008f94a6d6df63e8'],
      ['public.fn_bbj_conservation_check()', 'ffbdd5f2fab8e7a8f8dbd32a667a0b5a'],
      ['public.fn_chip_integrity_report()', 'f87b9efb48d0bb8930358fabb7ebd870'],
      ['public.fn_ca_payout_rows_without_money(integer)', '7d1f46dce13044b7cb90823ed08e1be4'],
      ['public.fn_tournament_prize_disbursement_audit(integer)', 'd62ceae6005e91ab678155a826bc50e5'],
      ['public.fn_ca_conservation_sweep()', '81995d0a3590cab15132df5b1ef609e8'],
    ]) {
      expect(SQL).toContain(`('${sig}', '${pin}')`);
    }
    expect(SQL).toContain("RAISE EXCEPTION 'the hourly sweep checkpoint is already installed'");
    expect(SQL).toContain("IF current_user NOT IN ('postgres', 'supabase_admin') THEN");
  });

  it('keeps only sums of legs older than every open transaction', () => {
    const adv = body('fn_ca_ledger_audit_checkpoint_advance');
    expect(adv).toContain("LEAST(now() - interval '6 hours', COALESCE(min(a.xact_start), now()) - interval '1 minute')");
    expect(adv).toContain('FROM pg_stat_activity a WHERE a.xact_start IS NOT NULL');
    expect(adv).toContain('cl.created_at >= v_through AND cl.created_at < v_horizon');
    expect(adv).toContain('l.created_at > v_from AND l.created_at >= v_through AND l.created_at < v_horizon');
    // A checkpoint from another starting point is rebuilt, never reused.
    expect(adv).toContain("WHERE m.metric = 'chip_drift' AND m.from_at = v_from FOR UPDATE");
    expect(adv).toContain("WHERE m.metric = 'bbj_epoch' AND m.from_at = v_from FOR UPDATE");
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.fn_ca_ledger_audit_checkpoint_advance() FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('the readers add the legs after the kept sums, and use them only from the same start', () => {
    const drift = body('fn_chip_drift_since_baseline');
    expect(drift).toContain("WHERE m.metric = 'chip_drift' AND m.from_at = span.t0");
    expect(drift).toContain('cl.created_at >= tail.t');
    expect(drift).toMatch(/SELECT cl\.club_id, cl\.to_entity_id, cl\.amount[\s\S]*?AND cl\.to_type = 'player_wallet'/);
    expect(drift).toMatch(/SELECT cl\.club_id, cl\.from_entity_id, -cl\.amount[\s\S]*?AND cl\.from_type = 'player_wallet'/);
    const bbj = body('fn_bbj_conservation_check');
    expect(bbj).toContain("WHERE m.metric = 'bbj_epoch' AND m.from_at = v_epoch_at;");
    expect(bbj).toContain("l.created_at >= COALESCE(v_cp_through, '-infinity'::timestamptz)");
    expect(bbj).toContain('WHEN o.kept_absorbed_to = o.opened_at THEN o.kept_absorbed');
    expect(bbj).toContain('v_epoch_unexp := round(v_epoch_unexp + v_absorbed, 2);');
    expect(bbj).toContain('v_in := v_in + v_late_seeds;');
    expect(bbj).toContain('v_out := v_out + v_late_burns;');
  });

  it('the liveness verdict asks whether a hand was dealt, and counts them only to print them', () => {
    const rep = body('fn_chip_integrity_report');
    expect(rep).toContain("v_dealt := EXISTS (SELECT 1 FROM public.hand_history WHERE created_at > now() - interval '24 hours');");
    expect(rep.match(/SELECT count\(\*\) INTO v_hands/g)).toHaveLength(1);
    expect(rep.indexOf('SELECT count(*) INTO v_hands')).toBeGreaterThan(rep.indexOf('AND v_ledger = 0 THEN'));
    for (const check of ['ledger_liveness', 'drift_since_baseline', 'ledger_write_failures', 'unaccounted_seat_exits',
      'unpriced_tournaments', 'bot_flag_disagreement', 'legacy_wallets_frozen']) {
      expect(rep).toContain(`check_name := '${check}'`);
    }
  });

  it('the sweep advances first, in its own exception block, and still runs every check', () => {
    const sweep = body('fn_ca_conservation_sweep');
    const advance = sweep.indexOf('PERFORM public.fn_ca_ledger_audit_checkpoint_advance();');
    expect(advance).toBeGreaterThan(-1);
    expect(advance).toBeLessThan(sweep.indexOf('FOR c IN'));
    const ownBlock = sliceBetween(sweep, 'PERFORM public.fn_ca_ledger_audit_checkpoint_advance();', 'END;');
    expect(ownBlock).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(sweep.match(/\('fn_[a-z_]+',\s*\n?\s*'select/g)?.length ?? 0).toBeGreaterThanOrEqual(25);
    for (const check of ['fn_chip_integrity_report', 'fn_bbj_conservation_check', 'fn_ca_payout_rows_without_money',
      'fn_tournament_prize_disbursement_audit', 'fn_bbj_promo_bank_check', 'fn_tournament_guarantee_check',
      'fn_ca_rake_rollup_writer_silent', 'fn_union_governance_check']) {
      expect(sweep).toContain(`('${check}',`);
    }
  });

  it('adds no job and no repair, and filters nobody out', () => {
    expect(code).not.toMatch(/cron\.(schedule|unschedule|alter_job)\s*\(/);
    expect(code).not.toMatch(/^\s*DROP\s/im);
    expect(code).not.toMatch(/is_horse\s*(=|<>|IS\b)|NOT\s+COALESCE\(\s*[a-z_.]*is_horse/i);
    expect(code).not.toMatch(/fn_[a-z_]*_(repair|backpay|redrive|sweep|catchup|heal)_[a-z_]*\s*\(/);
    expect(code).not.toMatch(/REFERENCES\s/i);
  });

  it('declares its proof and runs its native qualification in CI', () => {
    expect(SQL).toMatch(/^-- @live-proof: /m);
    expect(CI).toContain('python3 scripts/ci/test-the-hourly-sweep-reads-each-leg-once.py');
    expect(CI).toContain('pull_request:');
    expect(CI).not.toMatch(/schedule:/);
  });
});
