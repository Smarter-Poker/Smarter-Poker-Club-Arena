/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN AFTER-THE-FACT CAPTURE MAY RELAX PROVENANCE AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_ca_capture_tournament_fee_from_recorded_evidence` exists because
 * `fn_capture_accounting_tournament_fee` cannot capture a fee once the
 * transaction that charged it has ended, and on 2026-09-17 a cutover armed
 * mid-flight left 649 live tournaments holding 2,673 such fees. 553 of them
 * were decided by the cards with their winners unpaid.
 *
 * The danger in an authority like this is not that it exists. It is that the
 * next person who needs one more record to go through relaxes one more check,
 * and the check they relax is an evidence check rather than a provenance one.
 * At that point the platform is inventing commission splits.
 *
 * So this pins the boundary. Exactly two rules are absent relative to the
 * producer, both about WHEN the capture happens and neither about WHAT the
 * evidence says, and three conditions the producer never needed are present in
 * their place. Every window here is bounded by the structure it is about, per
 * tests/helpers/sourceWindow.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBetween, sliceDollarQuoted } from './helpers/sourceWindow';

const MIGRATIONS = resolve(__dirname, '..', 'supabase/migrations');
const read = (version: string): string => {
  const name = readdirSync(MIGRATIONS).find((f) => f.startsWith(`${version}_`));
  if (!name) throw new Error(`no migration ${version}`);
  return readFileSync(resolve(MIGRATIONS, name), 'utf8');
};

const INSTALL = read('20260918080939');
const RENAME = read('20260918082420');
const ROLLBACK = readFileSync(
  resolve(__dirname, '..', 'docs/changelog/2026-09-18-a-fee-whose-producer-died.rollback.sql'),
  'utf8'
);
const BODY = sliceDollarQuoted(INSTALL, '$reconcile$');

describe('a fee whose producer died can still be attributed', () => {
  it('each migration is one transaction, because every DDL fires a cache reload', () => {
    for (const sql of [INSTALL, RENAME]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    }
  });

  it('refuses to install against a producer body it was not written for', () => {
    const pre = sliceDollarQuoted(INSTALL, '$pre$');
    // All three bodies it mirrors or must satisfy, pinned by md5.
    expect(pre).toContain('fn_capture_accounting_tournament_fee(uuid,jsonb)');
    expect(pre).toContain('fn_stamp_accounting_tournament_fee(uuid)');
    expect(pre).toContain('fn_accounting_tournament_fee_net_plan(uuid)');
    expect(pre.match(/IS DISTINCT FROM '[0-9a-f]{32}'/g) ?? []).toHaveLength(3);
  });

  it('relaxes provenance and only provenance', () => {
    // The producer's two provenance rules are the ones that must be absent,
    // and each is a COMPARISON rather than a mention: the body legitimately
    // calls transaction_timestamp() to stamp the audit row, and asserting on
    // the bare call would forbid that and teach the next person to delete the
    // assertion rather than read it.
    expect(BODY).not.toMatch(/created_at\s+IS DISTINCT FROM\s+transaction_timestamp\(\)/);
    expect(BODY).not.toMatch(/charged_at\s*<\s*cutoff/);
    // transaction_timestamp() survives for exactly one purpose.
    const audit = sliceBetween(BODY, 'INSERT INTO public.accounting_tournament_fee_batches', ';');
    expect(audit).toContain("'reconciled_at', transaction_timestamp()");
    // And in their place, three conditions the producer never needed.
    expect(BODY).toContain('tournament_fee_is_the_producers_to_capture');
    expect(BODY).toContain('tournament_fee_already_has_a_batch');
    expect(BODY).toContain('tournament_fee_event_is_not_live');
    expect(BODY).toMatch(/NOT IN \('RUNNING','BREAK','REGISTERING','COMPLETING'\)/);
  });

  it('keeps every evidence refusal the producer makes', () => {
    for (const refusal of [
      'positive_chip_tournament_fee_required',
      'chip_tournament_fee_required',
      'tournament_fee_source_unsupported',
      'tournament_fee_exact_player_required',
      'tournament_fee_exact_registration_required',
      'tournament_fee_exact_charge_ambiguous',
      'tournament_fee_contributor_count_invalid',
      'tournament_fee_contributor_invalid',
      'tournament_fee_charge_evidence_mismatch',
      'tournament_fee_amount_evidence_mismatch',
      'tournament_fee_wallet_evidence_mismatch',
      'tournament_fee_ticket_evidence_mismatch',
      'tournament_fee_satellite_evidence_mismatch',
      'spin_fee_exact_paid_contributors_required',
      'spin_fee_entry_club_missing',
      'spin_fee_exact_charge_ambiguous',
      'spin_fee_exact_reserve_required',
      'spin_fee_charge_evidence_mismatch',
      'spin_fee_reserve_evidence_mismatch',
      'tournament_fee_contract_scope_mismatch',
      'tournament_fee_credit_not_conserved',
    ]) {
      expect(BODY, `${refusal} must survive`).toContain(refusal);
    }
  });

  it('takes the producer lock, so it cannot race a live capture', () => {
    expect(BODY).toContain("pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'");
  });

  it('uses the producer arithmetic, not an approximation of it', () => {
    expect(BODY).toContain('(r.rake_amount * 100)::bigint');
    expect(BODY).toContain('largest');
    expect(BODY).toMatch(/row_number\(\) OVER/);
    // Conservation is checked before anything is believed.
    expect(BODY).toContain('allocated IS DISTINCT FROM r.rake_amount');
  });

  it('checks its own work against the plan before returning', () => {
    const check = sliceBetween(BODY, "-- The plan's own test", 'END IF;');
    expect(check).toContain("b.status IS DISTINCT FROM 'captured'");
    expect(check).toContain('fn_accounting_tournament_fee_fingerprint');
    expect(check).toContain('sum(s.rake_credit)');
    expect(BODY).toContain('tournament_fee_reconciled_batch_would_not_satisfy_the_plan');
  });

  it('writes attribution and never money', () => {
    // No wallet, treasury, ledger or payout write may appear in this body.
    for (const forbidden of [
      'increment_union_wallet',
      'club_wallets',
      'chip_ledger',
      'fn_ca_burn',
      'tournament_obligations',
      'fn_recognize_accounting_tournament_fees',
    ]) {
      // chip_ledger is READ for evidence; it must never be written.
      const writes = new RegExp(`(INSERT INTO|UPDATE)\\s+public\\.${forbidden}\\b`, 'i');
      expect(BODY, `${forbidden} must not be written`).not.toMatch(writes);
    }
    expect(BODY).toContain('INSERT INTO public.accounting_tournament_fee_batches');
    expect(BODY).toContain('INSERT INTO public.accounting_tournament_fee_sources');
    expect(BODY).toContain('INSERT INTO public.ca_stranded_fee_reconciliations');
  });

  it('is reachable by nobody a browser can be', () => {
    expect(INSTALL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_reconcile_stranded_tournament_fee\(uuid\) FROM PUBLIC, anon, authenticated/
    );
    expect(INSTALL).toContain('ENABLE ROW LEVEL SECURITY');
    expect(INSTALL).toMatch(
      /REVOKE ALL ON TABLE public\.ca_stranded_fee_reconciliations FROM PUBLIC, anon, authenticated/
    );
  });

  it('records every use in a table that cannot be edited', () => {
    expect(INSTALL).toContain('CREATE TABLE public.ca_stranded_fee_reconciliations');
    expect(INSTALL).toContain('BEFORE UPDATE OR DELETE ON public.ca_stranded_fee_reconciliations');
    expect(INSTALL).toContain('BEFORE TRUNCATE ON public.ca_stranded_fee_reconciliations');
    // The audit row cannot claim a post-cutover charge.
    expect(INSTALL).toContain('CHECK (charged_at < cutover_at)');
  });

  it('the rename moves the name and provably not the body', () => {
    expect(RENAME).toContain('ALTER FUNCTION public.fn_ca_reconcile_stranded_tournament_fee(uuid)');
    expect(RENAME).toContain('RENAME TO fn_ca_capture_tournament_fee_from_recorded_evidence');
    // The old, repair-shaped name is retired in the same branch that declares it.
    expect(RENAME).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_reconcile_stranded_tournament_fee(uuid)'
    );
    // Same prosrc md5 on both sides is what makes "only the name moved" a fact.
    const pre = sliceDollarQuoted(RENAME, '$pre$');
    const post = sliceDollarQuoted(RENAME, '$post$');
    expect(pre).toContain('dcc3bc8cad78ec0d934a386a20804023');
    expect(post).toContain('dcc3bc8cad78ec0d934a386a20804023');
    expect(post).toContain('the old name still resolves');
  });

  it('the rollback removes the ability and never the record', () => {
    expect(ROLLBACK).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'
    );
    // Settled money and the audit trail are not a rollback's to delete.
    expect(ROLLBACK).not.toMatch(/DROP TABLE/i);
    expect(ROLLBACK).not.toMatch(/DELETE FROM/i);
    expect(ROLLBACK).not.toMatch(/TRUNCATE/i);
  });
});
