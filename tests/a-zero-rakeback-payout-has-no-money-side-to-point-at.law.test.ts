/**
 * LAW: A ZERO RAKEBACK PAYOUT HAS NO MONEY SIDE TO POINT AT (2026-10-03).
 *
 * The routed rakeback stage writes one 'paid' payout row per certified period
 * and moves chips only when the amount is above zero. A 0.00 row (0.08 of
 * rake at 5%) therefore never has a wallet transaction, and the settlement
 * correctness check filed a permanent evidence warning for it (period payout
 * e7f0b9bc, 28 hourly sightings). Only a payout or transfer that moved chips
 * owes an evidence pointer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';

const FILE = '20261003135041_a_zero_rakeback_payout_has_no_money_side_to_point_at.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

function declaration(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_settlement_correctness_check(');
  expect(start, 'the function is declared').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start)) + '$function$\n';
}

function newestFile(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?fn_ca_settlement_correctness_check\s*\(/i;
  let hit = '';
  for (const m of migrationCorpus()) if (re.test(m.sql)) hit = m.name;
  return hit;
}

const FN = declaration(MIG);

describe('a zero rakeback payout has no money side to point at', () => {
  it('is one pinned transaction whose live proof is the declared text', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    const md5 = createHash('md5').update(FN).digest('hex');
    expect(md5).toBe('72ddf644e991f750039e4fe399598fed');
    expect(MIG).toContain(`= '${md5}')`);
    expect(MIG).toContain("IS DISTINCT FROM 'a58c53d6d111fe2d9a9b966a2144e769'");
    for (const c of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'RESULT_CHANGED'])
      expect(MIG).toContain('SETTLEMENT_CHECK_' + c);
    expect(MIG).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });

  it('carries the change', () => {
    expect(FN).toContain('AND p.wallet_transaction_id IS NULL\n       AND p.payout_amount > 0');
    expect(FN).toContain('AND d.chip_transfer_id IS NULL\n       AND d.rakeback_amount > 0');
  });

  it('keeps every other check of the function', () => {
    for (const k of ['cross_club', 'rakeback-overattr:', 'rakeback-overpay:', 'rakeback-evidence:', 'ticket:', 'insurance-pair:', 'ticket-value:', 'fallback-regression:', 'settler-lag:'])
      expect(FN, k).toContain(k);
    expect(MIG).toContain("SELECT public.fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check', 'migration a_zero_rakeback_payout_has_no_money_side_to_point_at');");
  });

  it('is closed to browsers and is the newest declaration on disk', () => {
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.fn_ca_settlement_correctness_check() FROM PUBLIC, anon, authenticated;');
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_correctness_check() TO service_role;');
    expect(newestFile()).toBe(FILE);
  });
});
