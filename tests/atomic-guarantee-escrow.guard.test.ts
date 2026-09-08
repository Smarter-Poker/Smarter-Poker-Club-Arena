import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const sql = readFileSync(
  root(
    'supabase/migrations/20260908012648_tournament_cash_settlement_has_one_atomic_authority.sql'
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
  const hardening = taggedBody('harden_guarantee_escrow_journal');

  it('patches only the audited authority baseline and rejects a split identity', () => {
    expect(hardening).toContain("md5(v_definition) <> '6c758a4b130d057c49c7e941461ce74c'");
    expect(hardening).toContain('guarantee_overlay_identity_conflict');
    expect(hardening).toContain('v_claim_needle');
    expect(hardening).toContain('v_claim_replacement');
    expect(hardening).toContain(
      'v_hardened := replace(v_hardened,v_claim_needle,v_claim_replacement)'
    );
  });

  it('journals the claimed overlay before prize-pool finalization and verifies exact delta', () => {
    const escrow = hardening.indexOf('perform public.fn_ca_escrow_apply(');
    const finalized = hardening.lastIndexOf('set prize_pool = v_final');
    expect(escrow).toBeGreaterThan(-1);
    expect(finalized).toBeGreaterThan(escrow);
    expect(hardening).toContain('p_overlay_in => v_overlay');
    expect(hardening).toContain('v_escrow_before.overlay_in + v_overlay');
    expect(hardening).toContain('v_escrow_before.prize_balance + v_overlay');
    expect(hardening).toContain('guarantee_first_escrow_mismatch');
    expect(hardening).toContain("'overlay_journaled'");
    expect(sql).toContain("position('update public.clubs' IN v_guarantee)");
    expect(sql).toContain("position('fn_ca_escrow_apply(' IN v_guarantee)");
    expect(sql).toContain('fn_apply_prize_guarantee lost its atomic escrow journal ordering');
  });

  it('makes both cash authorities refuse a positive overlay without escrow proof', () => {
    expect(sql.match(/v_guarantee_result->>'overlay_journaled'/g)).toHaveLength(2);
    expect(sql.match(/v_guarantee_result->>'overlay'\)::numeric,0\) > 0/g)).toHaveLength(2);
    expect(sql).toContain('fn_apply_prize_guarantee lost its atomic escrow journal ordering');
  });
});
