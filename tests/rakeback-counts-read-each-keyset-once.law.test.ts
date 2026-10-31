import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20261027015808_rakeback_source_windows_read_each_keyset_once.sql';
const migration = readFileSync(migrationPath, 'utf8');
const fixture = 'scripts/ci/fixtures/rakeback-counts-bulk-joins/';
const receipt = JSON.parse(readFileSync(`${fixture}replacement.json`, 'utf8'));
const original = readFileSync(`${fixture}original.sql`, 'utf8');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('Rakeback source windows read each original keyset once', () => {
  it('changes only the exact incomplete source query at its original owner', () => {
    expect(md5(original)).toBe(receipt.original_full_md5);
    expect(original.split(receipt.old)).toHaveLength(2);
    expect(md5(original.replace(receipt.old, receipt.new))).toBe(receipt.candidate_full_md5);
    expect(migration).toContain(receipt.old);
    expect(migration).toContain(receipt.new);
    expect(migration).toContain(receipt.original_full_md5);
    expect(migration).toContain(receipt.candidate_full_md5);
    expect(migration).toContain('weekly_count_bulk_join_metadata_changed');
    expect(migration).toContain('weekly_count_bulk_installation_frozen');
  });

  it('preserves missing rows and multiplicity behind complete hash joins', () => {
    expect(receipt.new).toContain('incomplete_source_pairs AS MATERIALIZED');
    expect(receipt.new).toContain('FULL JOIN week_sources s');
    expect(receipt.new).toContain('incomplete_batch_pairs AS MATERIALIZED');
    expect(receipt.new).toContain('FULL JOIN week_batches b');
    expect(receipt.new).toContain('j.attribution_id IS NOT NULL');
    expect(receipt.new).toContain("j.batch_status IS DISTINCT FROM 'accrued'");
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE FROM|INSERT INTO)\s+public\./i);
    expect(migration).not.toMatch(/cron\.(?:schedule|alter_job)/i);
  });

  it('runs actual original-owner parity, fault cases and installer guards in native PostgreSQL', () => {
    const nativePath = 'scripts/ci/test-rakeback-counts-bulk-joins-postgres.py';
    const native = readFileSync(nativePath, 'utf8');
    const workflow = readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    expect(workflow).toContain(`python3 -B ${nativePath}`);
    expect(workflow).toContain('scripts/ci/fixtures/rakeback-counts-bulk-joins/**');
    expect(native).toContain('force_generic_plan');
    expect(native).toContain('force_custom_plan');
    expect(native).toContain('relaxed_duplicate_bad_source');
    expect(native).toContain('source_elsewhere_in_full_week');
    expect(native).toContain('assert verify()==old');
    expect(native).toContain('weekly_count_bulk_join_preimage_changed');
    expect(native).toContain('weekly_count_bulk_join_metadata_changed');
    expect(native).toContain('weekly_count_bulk_installation_frozen');
    expect(native).toContain('len(full)==2');
  });
});
