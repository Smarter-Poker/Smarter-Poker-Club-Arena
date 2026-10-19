/**
 * A TERMS-REFUSED TOURNAMENT FEE IS RECAPTURED AT ITS CLOSE (2026-10-19).
 *
 * Pinned on migration 20261019211349_a_terms_refused_tournament_fee_is_recaptured_at_its_close.sql.
 * A fee whose original capture was refused only for unobserved accounting
 * terms was saved 'legacy_unverified' and stranded its tournament's prize for
 * ever: 1,011 decided tournaments could not finish on 2026-10-19. The close now
 * recaptures it through the producer's own evidence and contract, and the net
 * plan accepts exactly that receipt. The original batch is never rewritten.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261019211349_a_terms_refused_tournament_fee_is_recaptured_at_its_close.sql'
  ),
  'utf8'
);

describe('a terms-refused tournament fee is recaptured at its close', () => {
  it('is one transaction with live proofs and pinned preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(4);
    for (const md5 of [
      '0708c0296e82262735aea1fd626d5ada',
      '506dc1f10ee2c9a6cfdef17db555de43',
      '15acb041213e75e30cefdff37e04179b',
    ])
      expect(sql).toContain(`'${md5}'`);
  });

  it('runs the recapture inside the close, before the net plan, in the same subtransaction', () => {
    const settle = sql.slice(sql.indexOf("recapture_patch('public.fn_settle_tournament_rake"));
    const call = settle.indexOf(
      'PERFORM public.fn_accounting_recapture_terms_refused_tournament_fee(v_raw.id);'
    );
    const plan = settle.lastIndexOf(
      'v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);'
    );
    expect(call).toBeGreaterThan(0);
    expect(plan).toBeGreaterThan(call);
  });

  it('prices through the producer contract at the charge instant and never rewrites the batch', () => {
    expect(sql).toContain(
      "contract:=public.fn_accounting_earning_contract((item->>'club_id')::uuid"
    );
    expect(sql).toMatch(
      /terms_at'\)::timestamptz IS DISTINCT FROM \(item->>'charged_at'\)::timestamptz/
    );
    expect(sql).not.toMatch(/UPDATE public\.accounting_tournament_fee_batches/);
    expect(sql).not.toMatch(/DELETE FROM public\.accounting_tournament_fee_batches/);
    expect(sql).not.toMatch(/DISABLE TRIGGER/i);
  });

  it('accepts the receipt exactly where a mixed-cutover Spin proof is accepted', () => {
    expect(sql).toContain(
      'AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(b.rake_record_id) AND NOT public.fn_accounting_terms_recapture_valid(b.rake_record_id))'
    );
    expect(sql).toContain(
      'AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id) AND NOT public.fn_accounting_terms_recapture_valid(rr.id))'
    );
  });

  it('treats a horse exactly like a human (CLAUDE.md 10.5)', () => {
    expect(sql).not.toMatch(/is_horse/);
  });

  it('writes no wallet and builds no schedule (CLAUDE.md 10.12)', () => {
    expect(sql).not.toMatch(/chip_balance|wallet_transactions|cron\.schedule|fn_credit_and_log/);
  });
});
