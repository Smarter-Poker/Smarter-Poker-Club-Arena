import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/tournament-source-credit-cover/';
const receipt = JSON.parse(readFileSync(base + 'source-receipt.json', 'utf8'));
describe('tournament credit sums retain all original records', () => {
  it('adds only one global record/credit physical cover', () => {
    const sql = readFileSync(receipt.migration_file, 'utf8');
    const shape = migrationTransactionShape(receipt.migration_file.split('/').at(-1), sql);
    expect(shape.ok).toBe(true);
    expect(shape.ok && shape.indexes.length).toBe(1);
    expect(sql).toMatch(/\(rake_record_id\)\s+INCLUDE\(rake_credit\)/);
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
      'original_triggers_changed',
      'original_source_changed',
    ])
      expect(sql).toContain('tournament_source_credit_cover_' + guard);
  });
  it('preserves the exact original two-field sum and every table/source contract', () => {
    const sql = readFileSync(base + 'original-src-sum.sql', 'utf8').trim();
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      receipt.exact_original_aggregate_sha256
    );
    expect(sql).toContain('SELECT s.rake_record_id,sum(s.rake_credit) AS credited');
    expect(sql).toContain('ANY((SELECT array_agg(rr.id) FROM rr)::uuid[])');
    expect(sql).not.toMatch(/DISTINCT|club_id|charged_at|coordinator_union_id|tournament_id/);
    const table = JSON.parse(readFileSync(base + 'source-table.json', 'utf8'));
    expect(table.columns).toHaveLength(15);
    expect(table.constraints).toHaveLength(5);
    expect(table.indexes).toHaveLength(13);
    const actual = JSON.parse(readFileSync(base + 'actual-source-contract30330.json', 'utf8'));
    expect(actual.triggers).toHaveLength(8);
    expect(actual.columns).toHaveLength(15);
  });
  it('enforces independent original bags, natural index-only access and snapshot/refusal tests', () => {
    const native = readFileSync(
      'scripts/ci/test-tournament-source-credit-cover-postgres.py',
      'utf8'
    );
    for (const proof of [
      'FULL2008group_original2field_credit_sum_independent_integer_cent_oracle',
      'FULLoriginal_credit_sum_ordered_bag_byte_equal_before_after',
      'mixed_NULL_duplicate_record_array_exact_bag',
      'natural_original_point_IndexOnly_zero_heap_without_forcing',
      'real_two_backend_repeatable_read_INSERT_credit_sum_snapshot',
      'maintained_CCI_replay_exact_catalog_preserves_original_rows',
    ])
      expect(native).toContain(proof);
    const ci = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');
    expect(ci).toContain('scripts/ci/fixtures/tournament-source-credit-cover/**');
    expect(ci).toContain('python3 -B scripts/ci/test-tournament-source-credit-cover-postgres.py');
    const evidence = JSON.parse(readFileSync(base + 'qualification-evidence.json', 'utf8'));
    expect(evidence.qualification).toBe('passed');
    expect(evidence.case_count).toBe(28);
  });
});
