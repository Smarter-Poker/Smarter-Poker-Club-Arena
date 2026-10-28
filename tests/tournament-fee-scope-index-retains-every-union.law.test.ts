import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/tournament-fee-scope-union-cover/';
const receipt = JSON.parse(readFileSync(base + 'source-receipt.json', 'utf8'));
describe('Tournament fee scope index retains every union', () => {
  it('adds one global two-scalar cover without changing source owners or eligibility', () => {
    const sql = readFileSync(receipt.migration_file, 'utf8');
    const shape = migrationTransactionShape(receipt.migration_file.split('/').at(-1), sql);
    expect(shape.ok).toBe(true);
    expect(shape.ok && shape.indexes.length).toBe(1);
    expect(sql).toMatch(/\(tournament_id\)\s+INCLUDE\(union_id\)/);
    expect(sql).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION|ALTER TABLE|INSERT INTO|UPDATE public\.|DELETE FROM|DROP INDEX|set_config\(/i
    );
    for (const guard of [
      'operator_refused',
      'source65_required',
      'generation_required',
      'window_refused',
      'source_access_refused',
      'columns_refused',
      'constraints_refused',
      'existing_indexes_refused',
      'exact_catalog_required',
      'original_source_changed',
    ])
      expect(sql).toContain('fee_scope_union_cover_' + guard);
  });
  it('retains the exact allsource count, private NULL scope and minimum union semantics', () => {
    const sql = readFileSync(base + 'original-fee-scope.sql', 'utf8').trim();
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      receipt.exact_original_aggregate_sha256
    );
    expect(sql).toContain("count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count");
    expect(sql).toContain('min(s.union_id::text)::uuid AS one_union');
    expect(sql).not.toMatch(/club_id|charged_at|coordinator_union_id/);
    const table = JSON.parse(readFileSync(base + 'source-table.json', 'utf8'));
    expect(table.columns).toHaveLength(15);
    expect(table.constraints).toHaveLength(5);
    expect(table.indexes).toHaveLength(12);
    expect(table.columns.find((c: { name: string }) => c.name === 'recorded_at').default).toBe(
      'transaction_timestamp()'
    );
  });
  it('enforces full original group bags, snapshot visibility and exact installer guards in CI', () => {
    const native = readFileSync(
      'scripts/ci/test-tournament-fee-scope-union-cover-postgres.py',
      'utf8'
    );
    for (const proof of [
      'FULL10004group_original4field_fee_scope_independent_oracle',
      'FULLoriginal_fee_scope_ordered_bag_byte_equal_before_after',
      'natural_original_point_IndexOnly_zero_heap_without_forcing',
      'real_two_backend_repeatable_read_INSERT_mixed_scope_snapshot',
      'maintained_CCI_replay_exact_catalog_preserves_original_rows',
      'actual_installer_',
    ])
      expect(native).toContain(proof);
    const workflow = readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    expect(workflow).toContain('scripts/ci/fixtures/tournament-fee-scope-union-cover/**');
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-tournament-fee-scope-union-cover-postgres.py'
    );
  });
});
