import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027052225_zero_standalone_books_validate_foreign_paid_commission_receipts.sql',
  'utf8'
);
const native = readFileSync('scripts/ci/test-zero-standalone-foreign-postgres.py', 'utf8');
const shard = readFileSync('scripts/dev/test-agent-accounting-statements.sh', 'utf8');
describe('zero standalone books independently validate paid foreign commission', () => {
  it('keeps one pinned transaction and the original source and money owners', () => {
    expect(sql).toMatch(/^-- @live-proof:/);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('zero_standalone_original_owner_preimage_changed');
    expect(sql).toContain('zero_standalone_original_owner_postimage_changed');
    expect(sql).toContain("p_scope_kind='club'AND source_count=0");
    expect(sql).toContain('node_count IS DISTINCT FROM 0');
    expect(sql).toContain(
      "public.fn_settle_accounting_commission_combine('union',f,p_start,p_end)"
    );
    expect(sql).not.toMatch(/n_expected\s*(?:<>|!=|=)\s*84/);
  });
  it('binds own rows and real money rather than trusting matching aggregates', () => {
    for (const token of [
      'cs.amount=n.own_amount',
      'cs.rows_count=n.rows_count',
      'cs.settlement_ref=key',
      'zero_standalone_foreign_actual_edge_receipt_not_bound',
      'existing_rakeback_transfer_complete',
      'zero_standalone_positive_or_unknown_bank_basis_refused',
      '_zero_saved_r2_clubs',
      '_zero_saved_r2_windows',
    ])
      expect(sql).toContain(token);
  });
  it('runs exact native original cached/direct/main/v3 and duplicate proof in the financial shard', () => {
    expect(shard).toContain('scripts/ci/test-zero-standalone-foreign-postgres.py');
    expect(native).toContain('exact52225-migration-rollback-install-postimages-acl-replay-refusal');
    expect(native).toContain('foreign-aggregate-preserving-cs-own-tamper');
    expect(native).toContain('actual_effective_payable_views');
  });
});
