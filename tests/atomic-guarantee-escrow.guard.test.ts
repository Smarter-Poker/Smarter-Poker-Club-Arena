import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const sql = readFileSync(
  root(
    'supabase/migrations/20260909014410_tournament_cash_settlement_has_one_atomic_authority.sql'
  ),
  'utf8'
);

function taggedBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = sql.indexOf(delimiter);
  const second = sql.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return sql.slice(first + delimiter.length, second);
}

describe('a funded guarantee is escrow money in the same transaction', () => {
  const hardening = taggedBody('guarantee_receipt');

  it('uses one source-controlled canonical wrapper, never a dynamic body patch', () => {
    expect(sql).toContain('RENAME TO fn_ca_apply_prize_guarantee_core');
    expect(hardening).toContain('public.fn_ca_apply_prize_guarantee_core(');
    expect(sql).not.toMatch(/EXECUTE\s+(?:replace\(|v_hardened)/i);
    expect(sql).not.toContain('$harden_guarantee_escrow_journal$');
  });

  it('re-proves the exact journal identity and live enforced escrow before success', () => {
    expect(hardening).toContain("'tourney:'||p_tournament_id::text||':guarantee_overlay'");
    expect(hardening).toContain("l.to_type='prize_liability'");
    expect(hardening).toContain("l.category='overlay'");
    expect(hardening).toContain('COALESCE(v_escrow.enforced,false) IS NOT TRUE');
    expect(hardening).toContain("(v_result->>'escrow_after')::numeric");
    expect(hardening).toContain('v_ledger_count<>1');
    expect(hardening).toContain("'overlay_journaled'");
    expect(sql).toContain('fn_apply_prize_guarantee lost its atomic escrow journal ordering');
  });

  it('makes both cash authorities refuse a positive overlay without escrow proof', () => {
    expect(sql.match(/v_guarantee_result->>'overlay_journaled'/g)).toHaveLength(2);
    expect(sql.match(/v_guarantee_result->>'overlay'\)::numeric,0\) > 0/g)).toHaveLength(2);
    expect(sql).toContain('fn_apply_prize_guarantee lost its atomic escrow journal ordering');
  });
});
