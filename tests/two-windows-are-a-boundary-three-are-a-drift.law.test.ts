/**
 * LAW: TWO WINDOWS ARE A BOUNDARY, THREE ARE A DRIFT (2026-10-03).
 *
 * A leg is windowed by its stamp and a balance by the snapshot that first
 * sees it, so a movement split across a cut reads +x in one window and -x in
 * the next. Over 31 hourly readings (2026-10-02 07:20 to 2026-10-03 13:20)
 * every player_wallets and tournament_liability difference summed to 0.00,
 * yet the two-window rule filed both. A real leak does not reverse: a drift is
 * filed only after three consecutive readings over the line, same direction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';

const FILE = '20261003135514_two_windows_are_a_boundary_three_are_a_drift.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

function declaration(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance_watch(');
  expect(start, 'the function is declared').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start)) + '$function$\n';
}

function newestFile(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?fn_ca_trial_balance_watch\s*\(/i;
  let hit = '';
  for (const m of migrationCorpus()) if (re.test(m.sql)) hit = m.name;
  return hit;
}

const FN = declaration(MIG);

describe('two windows are a boundary three are a drift', () => {
  it('is one pinned transaction whose live proof is the declared text', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    const md5 = createHash('md5').update(FN).digest('hex');
    expect(md5).toBe('8b7943c6499f505c8d30d7ece01a9ef6');
    expect(MIG).toContain(`= '${md5}')`);
    expect(MIG).toContain("IS DISTINCT FROM 'ca853ed6b8fea0121f2662fa75cf1ce2'");
    for (const c of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'RESULT_CHANGED'])
      expect(MIG).toContain('TRIAL_BALANCE_WATCH_' + c);
    expect(MIG).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });

  it('carries the change', () => {
    expect(FN).toContain('ORDER BY ran_at DESC OFFSET 1 LIMIT 1) x;');
    expect(FN).toContain('CONTINUE WHEN abs(v_prev_d) <= v_thr OR sign(v_prev_d) <> sign(r.difference);');
    expect(FN).toContain('CONTINUE WHEN abs(v_prev2_d) <= v_thr OR sign(v_prev2_d) <> sign(r.difference);');
    expect(FN).toContain('\'difference_before_that\', v_prev2_d');
  });

  it('keeps the severity, the dedupe key and the reading it records', () => {
    expect(FN).toContain("'fn_ca_trial_balance_watch', 'ledger_imbalance', 'info',");
    expect(FN).toContain("'tb:' || r.account || ':' || to_char(r.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD')");
    expect(FN).toContain("INSERT INTO public.ca_detector_runs (detector, detail)");
    expect(FN.split('fn_ca_raise_drift_incident(').length - 1).toBe(1);
  });

  it('is closed to browsers and is the newest declaration on disk', () => {
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) FROM PUBLIC, anon, authenticated;');
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) TO service_role;');
    expect(newestFile()).toBe(FILE);
  });
});
