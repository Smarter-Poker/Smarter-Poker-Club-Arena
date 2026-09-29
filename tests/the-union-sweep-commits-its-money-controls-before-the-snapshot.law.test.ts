/**
 * THE UNION SWEEP COMMITS ITS MONEY CONTROLS BEFORE THE SNAPSHOT (2026-09-26)
 *
 * pg_cron job 123 runs fn_union_integrity_sweep_all as one statement under a
 * 2 minute statement_timeout. Its per-step handlers are WHEN OTHERS, which
 * does not match query_canceled, so a timeout anywhere rolled back every
 * money control the sweep ran that hour: stop-loss suspensions, invoice
 * ageing, lock hygiene, period closes. The open-week rake basis refresh ran
 * FIRST inside the union loop and had grown to 70-95 s of the 120 s.
 *
 * Two laws:
 *
 * 1. The refresh runs after every money control, in its own subtransaction
 *    that traps query_canceled and stops refreshing for the hour. A slow
 *    report can then never roll a suspension or a period close back.
 *
 * 2. The refresh records what it read (the cursor-bounded through and the
 *    counts of its append-only inputs) and does not recompute an unchanged
 *    stamp.
 *
 * Each is proved on the body in force and refuted on the body it replaced
 * (the sweep preimage is the live body read from pg_proc before this change,
 * md5 9c30a4e71afe57fc694c797df7d0c6e0, kept as a fixture because it was
 * spliced by string replacement and no single migration declares it).
 *
 * 20260926073120. docs/changelog/2026-09-26-the-union-sweep-commits-its-money-controls-before-the-snapshot.md
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring, migrationFiles, readMigration } from './helpers/migrations';

const SWEEP_PREIMAGE = readFileSync(
  resolve(__dirname, 'fixtures/union-sweep/sweep-all-preimage.sql'),
  'utf8'
);

function sweepViolations(body: string): string[] {
  const v: string[] = [];
  const refresh = body.indexOf('fn_union_rake_basis_refresh(u.id');
  const stopLoss = body.indexOf('public.fn_union_enforce_stop_loss(u.id)');
  const ageing = body.indexOf('public.fn_union_age_invoices(u.id)');
  const closes = body.indexOf('public.fn_close_due_settlement_periods()');
  const hygiene = body.indexOf('public.fn_settlement_lock_hygiene()');
  if (refresh < 0) return ['the open-week snapshot is never refreshed'];
  if (stopLoss < 0 || ageing < 0 || closes < 0 || hygiene < 0)
    return ['a money control has left the sweep'];
  if (refresh < stopLoss || refresh < ageing || refresh < closes || refresh < hygiene)
    v.push(
      'the snapshot refresh runs before a money control, so its cost can roll that control back'
    );
  const firstLoopEnd = body.indexOf('END LOOP;');
  if (firstLoopEnd > 0 && refresh < firstLoopEnd)
    v.push('the snapshot refresh shares the money controls loop');
  const handlerEnd = body.indexOf('END LOOP;', refresh);
  const trap = body.indexOf('WHEN query_canceled THEN', refresh);
  if (trap < 0 || (handlerEnd > 0 && trap > handlerEnd))
    v.push('a statement timeout inside the refresh is not trapped, so it aborts the whole sweep');
  else {
    const exit = body.indexOf('EXIT;', trap);
    if (exit < 0 || exit > handlerEnd)
      v.push('after the timer is spent the sweep goes on refreshing with no timeout at all');
    const dedupe = body.indexOf("a.context->>'kind' = 'out_of_time'", trap);
    if (dedupe < 0 || dedupe > handlerEnd)
      v.push('a refresh that runs out of time files a new warning every hour');
  }
  return v;
}

function refreshViolations(body: string): string[] {
  const v: string[] = [];
  const stamp = body.indexOf('v_stamp := jsonb_build_object(');
  const compute = body.indexOf(
    'public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true)'
  );
  if (compute < 0) return ['the refresh no longer reads the certified basis through the cursor'];
  if (stamp < 0 || stamp > compute) v.push('the refresh does not record what it is about to read');
  else {
    const s = body.slice(stamp, compute);
    if (!s.includes("'through', v_through"))
      v.push('the stamp does not carry the cursor it read to');
    for (const t of [
      'public.union_wallet_transactions',
      'public.accounting_cash_bank_receipts',
      'public.accounting_tournament_fee_recognitions',
      'public.accounting_payable_earning_sources',
      'public.accounting_agreement_history',
    ])
      if (!s.includes(t)) v.push(`the stamp does not count ${t}`);
    const skip = s.indexOf('IF v_prev IS NOT NULL AND v_prev = v_stamp THEN');
    if (skip < 0 || !s.slice(skip).includes("'skipped', true"))
      v.push('an unchanged stamp is recomputed');
  }
  if (!/INSERT INTO public\.union_rake_basis_snapshot \([^)]*input_stamp\)/.test(body))
    v.push('the stamp is not stored with the snapshot');
  if (!body.includes('input_stamp = EXCLUDED.input_stamp'))
    v.push('a recompute leaves the previous stamp in place');
  if (!/v_through := LEAST\(p_end, now\(\), v_accrued\)/.test(body))
    v.push('the snapshot reads past what the accrual has reached');
  return v;
}

describe('the union sweep commits its money controls before the snapshot', () => {
  it('holds for the body in force', () => {
    const { name, sql } = latestDeclaring('fn_union_integrity_sweep_all');
    expect(name >= '20260926073120').toBe(true);
    expect(sweepViolations(functionBody(sql, 'fn_union_integrity_sweep_all'))).toEqual([]);
  });
  it('refutes the live body it replaced (negative proof)', () => {
    const v = sweepViolations(SWEEP_PREIMAGE);
    expect(v).toContain(
      'the snapshot refresh runs before a money control, so its cost can roll that control back'
    );
    expect(v).toContain('the snapshot refresh shares the money controls loop');
    expect(v).toContain(
      'a statement timeout inside the refresh is not trapped, so it aborts the whole sweep'
    );
  });
  it('the preimage fixture is the one the migration asserts', () => {
    const sql = readMigration(migrationFiles().find((f) => f.startsWith('20260926073120_'))!);
    expect(sql).toContain("IS DISTINCT FROM '9c30a4e71afe57fc694c797df7d0c6e0'");
    expect(SWEEP_PREIMAGE).toContain('PERFORM public.fn_union_rake_basis_refresh(u.id');
  });
});

describe('the open-week refresh does not recompute what it already read', () => {
  it('holds for the body in force', () => {
    const { name, sql } = latestDeclaring('fn_union_rake_basis_refresh');
    expect(name >= '20260926073120').toBe(true);
    expect(refreshViolations(functionBody(sql, 'fn_union_rake_basis_refresh'))).toEqual([]);
  });
  it('refutes the body that recomputed every hour (negative proof)', () => {
    const name = migrationFiles().find((f) => f.startsWith('20260926042119_'))!;
    const v = refreshViolations(functionBody(readMigration(name), 'fn_union_rake_basis_refresh'));
    expect(v).toContain('the refresh does not record what it is about to read');
    expect(v).toContain('the stamp is not stored with the snapshot');
  });
});
