import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/cash-link-union-proof-index/';
const migration =
  'supabase/migrations/20261028184144_original_cash_proofs_select_their_union_before_the_hand_join.sql';
describe('cash link union index keeps the original proof', () => {
  it('stores only fixed-width keys while maintaining the exact original predicate', () => {
    const sql = readFileSync(migration, 'utf8');
    const shape = migrationTransactionShape(migration.split('/').at(-1), sql);
    expect(shape.ok).toBe(true);
    expect(shape.ok && shape.indexes.length).toBe(1);
    expect(sql).toContain("USING hash((game_scope->>'game_union_id'))");
    expect(sql).toContain('WHERE proof_md5=md5(proof::text)');
    expect(sql).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION|ALTER TABLE|INSERT INTO|UPDATE public\.|DELETE FROM|DROP INDEX/i
    );
    for (const guard of [
      'operator_refused',
      'source65_required',
      'generation_required',
      'original_reader_required',
      'window_refused',
      'original_tables_required',
      'exact_catalog_required',
      'original_authority_changed',
    ])
      expect(sql).toContain('cash_link_proof_index_' + guard);
  });
  it('preserves full original table contracts, original SQL and natural index plans', () => {
    const tables = JSON.parse(readFileSync(base + 'actual-tables.json', 'utf8'));
    expect(tables).toHaveLength(2);
    expect(tables.map((x: { columns: unknown[] }) => x.columns.length)).toEqual([8, 14]);
    expect(tables.map((x: { indexes: unknown[] }) => x.indexes.length)).toEqual([7, 3]);
    const linked = readFileSync(base + 'original-linked.sql', 'utf8');
    expect(
      createHash('md5')
        .update(linked.trimEnd().replace(/;$/, '') + '\n')
        .digest('hex')
    ).toBe('0c3a826553e9ef65a03030c3ef78eaaf');
    const evidence = JSON.parse(readFileSync(base + 'qualification-evidence.json', 'utf8'));
    expect(evidence.case_count).toBe(22);
    expect(evidence.qualification).toBe('passed');
    expect(evidence.candidate_sha256).toBe(
      createHash('sha256').update(readFileSync(migration)).digest('hex')
    );
    expect(evidence.cases).toContain('natural_custom_and_GENERIC_PLAN_union_hash_index_selected');
    expect(evidence.cases).toContain(
      'valid_16KB_payload_and_foreign_union_text_accepted_hash_index'
    );
    expect(evidence.cases).toContain('real_two_backend_RR_snapshot_index_maintained_valid_write');
  });
  it('binds every maintained qualified input', () => {
    const binding = JSON.parse(readFileSync(base + 'source-binding.json', 'utf8'));
    for (const [file, sha] of Object.entries(binding.sourceFiles))
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(sha);
  });
  it('wires the native and immutable source contract in the maintained workflow', () => {
    const flow = readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8');
    expect(flow).toContain('scripts/ci/test-cash-link-union-proof-index-postgres.py');
    expect(flow).toContain('scripts/ci/fixtures/cash-link-union-proof-index/**');
  });
});
