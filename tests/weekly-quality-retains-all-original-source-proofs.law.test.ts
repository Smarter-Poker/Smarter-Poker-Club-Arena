import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const root = 'scripts/ci/fixtures/weekly-quality-source-bags/';
const read = (name: string) => readFileSync(root + name, 'utf8');
const receipt = JSON.parse(read('source-receipt.json'));
const before = read('quality-before.sql').trimEnd().replace(/;$/, '') + '\n';
const after = read('quality-after.sql').trimEnd().replace(/;$/, '') + '\n';
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
describe('Weekly quality retains all original source proofs', () => {
  it('changes only the complete FOR query of the exact current function', () => {
    expect(md5(before)).toBe('f0d1ca9dace0da884c6b7e77f250604f');
    expect(md5(after)).toBe('5c8b31d9f75c4b3b84cfd17fefb666a0');
    expect(before.replace(receipt.replacement.old, receipt.replacement.new)).toBe(after);
    for (const owner of [
      'fn_accounting_owner_direct_fee_proof_valid',
      'fn_accounting_mixed_cutover_spin_proof_valid',
      'fn_accounting_tournament_fee_net_plan',
    ]) {
      expect(after.split(owner).length).toBe(before.split(owner).length);
    }
    const migration = readFileSync(receipt.migration_file, 'utf8');
    expect(migration).toContain("to_jsonb(p)-'prosrc'");
    expect(migration).toContain('weekly_quality_bags_postimage_required');
    expect(migration).toContain('IS DISTINCT FROM seal_definition');
    expect(migration).not.toMatch(
      /UPDATE public\.|DELETE FROM public\.|DISABLE TRIGGER|ALTER TABLE|set_config\(/i
    );
  });
  it('executes the full native and concurrent snapshot proof in the maintained workflow', () => {
    const workflow = readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    const native = readFileSync('scripts/ci/test-weekly-quality-source-bags-postgres.py', 'utf8');
    expect(workflow).toContain('scripts/ci/fixtures/weekly-quality-source-bags/**');
    expect(workflow).toContain('python3 -B scripts/ci/test-weekly-quality-source-bags-postgres.py');
    for (const proof of [
      'actual_STABLE_SQL_snapshot_concurrent_recognition_commit',
      'installer_bad_postcondition_atomic_rollback',
      'actual_PG_only_ACL_preserved',
      'authentic_positive_for_query_5000_all_fields_equal',
    ])
      expect(native).toContain(proof);
    expect(JSON.parse(read('additional-cases.json'))).toHaveLength(12);
  });
});
