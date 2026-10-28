import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/private-deposit-source-cover/';
const receipt = JSON.parse(readFileSync(base + 'source-receipt.json', 'utf8'));
describe('Private deposit key index keeps original sources', () => {
  it('covers exactly the current five scalar witnesses without rewriting any owner', () => {
    const sql = readFileSync(receipt.migration_file, 'utf8');
    const shape = migrationTransactionShape(receipt.migration_file.split('/').at(-1), sql);
    expect(shape.ok).toBe(true);
    expect(shape.ok && shape.indexes.length).toBe(1);
    expect(sql).toMatch(
      /\(club_id,coordinator_union_id,earned_at\)\s+INCLUDE\(rake_record_id,union_id\)/
    );
    expect(sql).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION|ALTER TABLE|UPDATE public\.|DELETE FROM public\.|DROP INDEX|jsonb_build_object|set_config\(/i
    );
    for (const guard of [
      'private_keys_cover_exact_catalog_required',
      'private_keys_cover_source65_required',
      'private_keys_cover_original_source_changed',
      'private_keys_cover_operator_refused',
      'private_keys_cover_window_refused',
    ])
      expect(sql).toContain(guard);
  });
  it('enforces original key bags, native physical path, current constraints and metadata', () => {
    const native = readFileSync('scripts/ci/test-private-deposit-source-cover-postgres.py', 'utf8');
    for (const proof of [
      'independent_scope_and_both_week_boundaries_exact_keys',
      'natural_exact_selector_IndexOnly_zeroheap_no_forcing',
      'full_key_bags_source_contract_rows_table_metadata_ACL_source65_GEN_unchanged',
      'original_nullable_new_plan',
      'original_nonfinite_NULL_duplicate_constraints_preserved',
    ])
      expect(native).toContain(proof);
    const workflow = readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    expect(workflow).toContain('scripts/ci/fixtures/private-deposit-source-cover/**');
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-private-deposit-source-cover-postgres.py'
    );
  });
});
