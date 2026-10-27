import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027142512_zero_books_keep_historical_agent_roles.sql',
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
    expect(sql).toContain('5f24e7244d59db5f2d5e3b6ad18e620b');
    expect(sql).toContain('c7a3a18fd098b9cde222107007aae316');
    expect(sql).toContain('a267a0f650cf4dcb2337d85d638ebc62');
    expect(native).toContain('historical-promotion-foreign-v3-R2-R3-then-zero-R2-R3');
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
    expect(native).toContain(
      'exact142512-migration-rollback-install-postimages-acl-replay-refusal'
    );
    expect(native).toContain('foreign-aggregate-preserving-cs-own-tamper');
    expect(native).toContain('actual_effective_payable_views');
  });
});
