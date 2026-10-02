/**
 * THE SUPPLY METER COUNTS A LATE COMMIT IN ITS OWN HOUR (2026-10-02,
 * incidents 2e00634c / d9ebce90 / 035e55db).
 *
 * chip_ledger.created_at is the writing transaction's START. A certification
 * club's 100,000.00 retirement started at 14:04:56, committed after the 14:05
 * supply reading, and so fell between the 14:05 and 15:05 windows: the 15:05
 * reading said -100,005.30 unexplained, crossed the kill-switch threshold and
 * failed the engine deploy gate, for chips that left with their legs.
 *
 * The law:
 *  - the meter reads every balance and its ledger window in ONE statement
 *    (one MVCC snapshot), with the window ceiling read inside it;
 *  - each reading records the range it saw (seen_from / seen_mint /
 *    seen_burn) and the next reading recounts exactly that range, counting
 *    whatever committed late in the hour it became visible;
 *  - the 15:05 reading is recomputed from the journal with its original kept;
 *  - a chip shop refund names its counterparty (issuance_reserve, refund,
 *    keyed by the purchase) instead of reaching fn_credit_chips undeclared.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const name = readdirSync(MIG).find((n) =>
  /^\d{14}_the_supply_meter_counts_a_late_commit_in_its_own_hour\.sql$/.test(n)
);
const sql = name ? readFileSync(resolve(MIG, name), 'utf8') : '';

const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  return a >= 0 && b > a ? s.slice(a, b) : '';
};
const meter = between(
  sql,
  'CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()',
  '$function$;'
);
const recompute = between(sql, 'DO $r$', 'END $r$;');
const refund = between(sql, 'DO $refund$', 'END $refund$;');
const credit = between(sql, 'DO $credit$', 'END $credit$;');
const proof = between(sql, 'DO $proof$', 'END $proof$;');

describe('the supply meter counts a late commit in its own hour', () => {
  it('the migration exists, runs as one transaction and edits only reviewed pre-images', () => {
    expect(name, 'migration file').toBeTruthy();
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
    expect(sql).toContain("IS DISTINCT FROM '05bf43e4990f11cbf0f20b6788c64449' THEN");
    expect(sql).toContain("IS DISTINCT FROM 'eaa3996bab8e8d4b6fa6a20b79f326f3' THEN");
    expect(sql).toContain("IS DISTINCT FROM 'abf4bf54c469a4fe019d540d4fd11923' THEN");
    expect(sql).not.toMatch(/DROP\s+(TRIGGER|POLICY|FUNCTION|TABLE|COLUMN)/i);
    expect(sql).toMatch(/^-- @live-proof: /m);
  });

  it('reads the balances and the ledger window in one statement, with the ceiling inside it', () => {
    expect(meter).toBeTruthy();
    expect(meter).toContain('WITH c AS MATERIALIZED (SELECT clock_timestamp() AS cut)');
    expect(meter).toMatch(/\bINTO s\s+FROM c;/);
    // the window, the recount and the seen range are columns of that one SELECT
    for (const col of [
      'AS window_mint',
      'AS window_burn',
      'AS recount_mint',
      'AS recount_burn',
      'AS seen_mint',
      'AS seen_burn',
    ]) {
      expect(meter).toContain(col);
    }
    expect(meter).toContain('l.created_at > prev.taken_at AND l.created_at <= c.cut');
    // no second statement reads the journal after the balances
    expect(meter).not.toMatch(/INTO v_mint, v_burn/);
    expect(meter).not.toMatch(/v_cut timestamptz := clock_timestamp\(\)/);
  });

  it('a late commit is counted in the hour it becomes visible', () => {
    expect(meter).toContain("v_horizon CONSTANT interval := interval '3 hours';");
    expect(meter).toContain('v_recount_from := prev.seen_from;');
    expect(meter).toContain('l.created_at > v_recount_from AND l.created_at <= prev.taken_at');
    expect(meter).toContain('v_late_mint := s.recount_mint - COALESCE(prev.seen_mint, 0);');
    expect(meter).toContain('v_late_burn := s.recount_burn - COALESCE(prev.seen_burn, 0);');
    // a reading written before this migration recounts its own window
    expect(meter).toContain('v_late_mint := s.recount_mint - COALESCE(prev.mint_since_prev, 0);');
    expect(meter).toContain('v_mint := s.window_mint + v_late_mint;');
    expect(meter).toContain('v_burn := s.window_burn + v_late_burn;');
    expect(meter).toContain('s.cut - v_horizon, s.seen_mint, s.seen_burn)');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS seen_from timestamptz/);
  });

  it('keeps the stores, the basis, the thresholds, the incident and the kill switch', () => {
    expect(meter).toContain("v_basis CONSTANT text := 'pending-addon-v4';");
    expect(meter).toContain('abs(v_unexplained) > 100 AND abs(v_trailing) > 300');
    expect(meter).toContain('v_critical := abs(v_unexplained) > 25000');
    expect(meter).toContain("PERFORM public.fn_ca_raise_drift_incident(\n      'fn_ca_supply_snapshot'");
    expect(meter).toContain("PERFORM public.fn_ca_kill_switch_trip('fn_ca_supply_snapshot', v_unexplained,");
    expect(meter).toContain('public.fn_ca_ticket_escrow_float()');
    expect(meter).toContain('AS pending_addons');
    expect(meter).toContain("c.asset = 'diamonds'");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot() TO service_role;');
    expect(sql).toContain("public.fn_ca_declare_guard_redefinition(\n  'fn_ca_supply_snapshot',");
  });

  it('the 15:05 reading is recomputed from the journal and its original is kept', () => {
    expect(recompute).toContain("WHERE taken_at = '2026-10-02 15:05:01.719765+00'");
    expect(recompute).toContain('IF r.unexplained IS DISTINCT FROM -100005.30 THEN');
    expect(recompute).toContain('IF v_late_mint <> 0 OR v_late_burn <> 100000.00 THEN');
    expect(recompute).toContain("'late_commit_counted_in_its_own_hour'");
    expect(recompute).toContain('original_unexplained');
    expect(recompute).toContain('unexplained = unexplained - v_late_mint + v_late_burn');
    expect(recompute).toContain('IS DISTINCT FROM -5.30 THEN');
    // only the derived figures move; the balances are measurements
    expect(recompute).not.toMatch(/SET\s+(total|member_wallets|treasuries|felt)\s*=/);
  });

  it('a chip shop refund names where its chips come from and restores the caller', () => {
    expect(refund).toContain('v_saved := public.fn_ca_ledger_declaration_save(NULL);');
    expect(refund).toContain(
      "PERFORM public.fn_ca_declare_ledger(''refund'', ''issuance_reserve'', NULL, NULL,"
    );
    expect(refund).toContain("''ca-shop-refund-'' || p_purchase_id::text, NULL);");
    expect(refund).toContain('PERFORM public.fn_ca_ledger_declaration_restore(v_saved);');
    expect(refund).toMatch(/IF md5\(replace\(replace\(replace\(pg_get_functiondef\(v_oid\)/);
    expect(credit).toContain(
      "COALESCE(NULLIF(current_setting(''app.ledger_category'', true), ''''), ''player_funding'')"
    );
    expect(credit).toMatch(/IF md5\(replace\(pg_get_functiondef\(v_oid\), v_new, v_old\)\)/);
  });

  it('proves itself at apply with a reading it rolls back', () => {
    expect(proof).toContain("RAISE EXCEPTION 'SUPPLY_METER_PROBE_ROLLBACK';");
    expect(proof).toContain("IF SQLERRM <> 'SUPPLY_METER_PROBE_ROLLBACK' THEN RAISE; END IF;");
    expect(proof).toContain('v_row.mint_since_prev IS DISTINCT FROM v_row.window_mint + v_row.late_mint');
    expect(proof).toContain('abs(v_unexplained) > 1000');
    expect(proof).toContain('SUPPLY_METER_SELFCHECK_OK');
  });
});
