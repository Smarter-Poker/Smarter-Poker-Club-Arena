import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/private-cash-record-cover/';
const receipt = JSON.parse(readFileSync(base + 'source-receipt.json', 'utf8'));
describe('Private cash record index retains original facts', () => {
  it('covers only the six original scalar facts through one maintained concurrent index', () => {
    const sql = readFileSync(receipt.migration_file, 'utf8');
    const shape = migrationTransactionShape(receipt.migration_file.split('/').at(-1), sql);
    expect(shape.ok).toBe(true);
    expect(shape.ok && shape.indexes.length).toBe(1);
    expect(sql).toMatch(
      /\(rake_record_id\)\s+INCLUDE\(club_id,union_id,coordinator_union_id,earned_at,rake_credit\)/
    );
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
      expect(sql).toContain('private_record_cover_' + guard);
  });
  it('keeps exact original aggregate predicates and all existing index definitions', () => {
    const cg = readFileSync(base + 'original-cg.sql', 'utf8').trim();
    expect(createHash('sha256').update(cg).digest('hex')).toBe(receipt.exact_original_cg_sha256);
    const table = JSON.parse(readFileSync(base + 'source-table.json', 'utf8'));
    expect(table.columns).toHaveLength(10);
    expect(table.constraints).toHaveLength(6);
    expect(table.indexes).toHaveLength(12);
    expect(
      table.indexes.some((s: string) =>
        s.includes('UNIQUE INDEX accounting_cash_rake_sources_rake_record_id_player_id_key')
      )
    ).toBe(true);
    expect(
      table.indexes.some((s: string) => s.includes('accounting_cash_private_deposit_keys_cover'))
    ).toBe(true);
    expect(table.columns.find((c: { name: string }) => c.name === 'recorded_at').default).toBe(
      'clock_timestamp()'
    );
  });
  it('enforces the whole original bag, natural physical path, snapshot and installer refusals in CI', () => {
    const native = readFileSync('scripts/ci/test-private-cash-record-cover-postgres.py', 'utf8');
    for (const proof of [
      'FULL10002record_original_cg_bag_independent_oracle_all_count_sum_bad_mine',
      'FULL10002record_original_cg_bag_byte_equal_before_after',
      'original_exact_cg_after_natural_IndexOnly_zeroheap_no_forcing',
      'real_two_connection_repeatable_read_source_insert_snapshot_consistency',
      'maintained_CCI_replay_exact_catalog_no_source_changes',
      'actual_installer_',
    ])
      expect(native).toContain(proof);
    const workflow = readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    expect(workflow).toContain('scripts/ci/fixtures/private-cash-record-cover/**');
    expect(workflow).toContain('python3 -B scripts/ci/test-private-cash-record-cover-postgres.py');
  });
});
