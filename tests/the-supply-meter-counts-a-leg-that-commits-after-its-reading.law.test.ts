/**
 * THE SUPPLY METER COUNTS A LEG THAT COMMITS AFTER ITS READING (2026-10-02).
 *
 * Pinned on migration 20261002164500. chip_ledger.created_at is the writer's
 * transaction start, so a leg can be stamped inside a window that was already
 * read and commit afterwards; its balance then appears one reading later
 * with no leg in that window. The kill switch tripped at 15:05 UTC on
 * exactly that (-100,005.30, a certification burn). fn_ca_supply_snapshot now
 * reads the balances, this window's ledger and the previous six windows in
 * ONE statement, counts a leg found late in the reading where its balance
 * first appears, and marks the earlier window restated so it is never counted
 * twice. The money-path check names fn_register_for_tournament, the live
 * registration door, instead of the retired atomic_tournament_register.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(
  HERE,
  '../supabase/migrations/20261002164500_the_supply_meter_counts_a_leg_that_commits_after_its_reading.sql'
);
const sql = readFileSync(FILE, 'utf8');
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the supply meter counts a leg that commits after its reading', () => {
  it('is one transaction with a preimage on every body it replaces', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    for (const f of ['fn_ca_supply_snapshot', 'fn_union_money_path_check']) {
      expect(sql).toMatch(new RegExp(`\\('${f}',\\s+'[0-9a-f]{32}'\\)`));
    }
    expect(sql).not.toMatch(/^\s*DROP\b/im);
  });

  it('reads balances, this window and the earlier windows in one statement under one cut', () => {
    const f = body('fn_ca_supply_snapshot');
    expect(f).toMatch(/WITH c AS MATERIALIZED \(SELECT clock_timestamp\(\) AS cut\)/);
    expect(f).toMatch(/ORDER BY taken_at DESC LIMIT 6\) r/);
    expect(f).toMatch(/l\.created_at > prev\.taken_at AND l\.created_at <= c\.cut/);
    expect(f).toMatch(/AS windows\s+INTO s\s+FROM c;/);
    // the old separate ledger statement and the pre-read cut are gone
    expect(f).not.toMatch(/v_cut timestamptz := clock_timestamp\(\)/);
  });

  it('counts a late leg once, where its balance appears, and keeps the reading recorded at the time', () => {
    const f = body('fn_ca_supply_snapshot');
    expect(f).toMatch(/v_late_mint := v_late_mint \+ \(v_win\.vm - v_win\.rm\);/);
    expect(f).toMatch(/v_late_burn := v_late_burn \+ \(v_win\.vb - v_win\.rb\);/);
    expect(f).toMatch(/SET restated_mint = v_win\.vm, restated_burn = v_win\.vb, restated_at = s\.cut/);
    expect(f).toMatch(/COALESCE\(r\.restated_mint, r\.mint_since_prev, 0\) AS rec_mint/);
    expect(f).toMatch(/v_total - prev\.total - s\.mint \+ s\.burn - v_late_mint \+ v_late_burn/);
    // the alarm and the kill switch still read the same unexplained number
    expect(f).toMatch(/PERFORM public\.fn_ca_kill_switch_trip\('fn_ca_supply_snapshot', v_unexplained,/);
    expect(f).toMatch(/abs\(v_unexplained\) > 25000/);
  });

  it('restates the 14:05 window once, by the same rule', () => {
    expect(sql).toMatch(/WHERE id = 778 AND restated_burn = 902036\.92/);
  });

  it('the money-path check names the live registration door', () => {
    const f = body('fn_union_money_path_check');
    expect(f).toMatch(/\('fn_register_for_tournament'\)/);
    expect(f).not.toMatch(/\('atomic_tournament_register'\)/);
    expect(f).toMatch(/fn_money_path_reaches_club_scope\(x\.fn, 6\)/);
    expect(sql).toMatch(/postimage: fn_union_money_path_check still reports a finding/);
  });
});
