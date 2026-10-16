/**
 * A WEEKLY CLOSE ACCEPTS A HISTORY-ONLY INVOICE (2026-10-16).
 *
 * Pinned on migration 20261016144115_a_weekly_close_accepts_a_history_only_invoice.sql.
 *
 * Dan's rule of 2026-10-15 (20261015184608): only cashout documents reach the
 * messenger; every other invoice is recorded in transaction history and marked
 * delivered "so the weekly close is satisfied". Seven readers still demanded a
 * messenger delivery row, and the union close for 2026-10-05 failed its own
 * round 1 receipt on 2026-10-16 ("union_close_invoice_receipt_missing"). They
 * now accept a marked-sent invoice other than cashier_cashout and still demand
 * deliveries for a cashout. Do not reintroduce a bare deliveries requirement
 * for history-only invoices.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261016144115_a_weekly_close_accepts_a_history_only_invoice.sql'),
  'utf8'
);

const FUNCTIONS = [
  'fn_union_weekly_rakeback_close',
  'fn_union_close_post_rake_debit',
  'fn_accounting_legacy_pay_week',
  'fn_club_weekly_accounting_summary',
  'fn_issue_scope_weekly_accounting',
  'fn_accounting_correction_assert_delivery',
  'fn_accounting_credit_reduction_assert_document',
];

describe('a weekly close accepts a history-only invoice', () => {
  it('is one transaction with a live proof that covers all seven readers', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    for (const f of FUNCTIONS) expect(sql).toContain(`'public.${f}(`);
  });

  it('rewrites from pinned preimages, one occurrence each, compiling each function once', () => {
    expect(sql.match(/'[0-9a-f]{32}',\n/g)?.length).toBe(9);
    expect(sql).toContain('IF md5(d) <> r.preimage THEN');
    expect(sql).toContain('IF n <> 1 THEN');
    expect(sql).toContain('IF cur_sig IS DISTINCT FROM r.sig THEN');
  });

  it('keeps the cashout delivery requirement and only relaxes history-only invoices', () => {
    expect(sql.match(/i\.invoice_type IS DISTINCT FROM ''cashier_cashout'' OR EXISTS\(SELECT 1 FROM public\.accounting_invoice_deliveries d WHERE d\.invoice_id=i\.id\)/g)?.length).toBe(3);
    expect(sql).toContain("OR (i.invoice_type IS NOT DISTINCT FROM ''cashier_cashout'' AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d");
    expect(sql).toContain('(SELECT si.message_sent IS NOT TRUE FROM public.settlement_invoices si WHERE si.id=invoice)');
    expect(sql.match(/IF \(actual_users IS NOT NULL AND actual_users IS DISTINCT FROM c\.audience_user_ids\)/g)?.length).toBe(2);
  });

  it('proves the inventory seal still holds after the rewrite', () => {
    expect(sql).toContain('smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true');
  });
});
