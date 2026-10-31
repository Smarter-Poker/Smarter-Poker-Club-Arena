import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/weekly-private-deposit-verdict/';
const receipt = JSON.parse(readFileSync(base + 'source-receipt.json', 'utf8'));
describe('Weekly private deposits retain original verdicts', () => {
  it('applies only the four qualified source deltas to the exact current whole function', () => {
    const before = readFileSync(base + 'summary-before.sql', 'utf8');
    const after = readFileSync(base + 'summary-after.sql', 'utf8');
    let changed = before;
    for (const patch of receipt.replacements) {
      expect(changed.split(patch.old)).toHaveLength(2);
      changed = changed.replace(patch.old, patch.new);
    }
    expect(changed).toBe(after);
    expect(receipt.before_md5).toBe('5225ca603c36cc72e905c337c94f3eae');
    expect(receipt.after_md5).toBe('b00039e968bc69a56046c2fe0634fc8b');
    const sql = readFileSync(receipt.migration_file, 'utf8');
    expect(migrationTransactionShape(receipt.migration_file.split('/').at(-1), sql).ok).toBe(true);
    expect(sql).toContain('summary_scope_exact_preimage_required');
    expect(sql).toContain('summary_scope_exact_patch_required');
    expect(sql).toContain('summary_scope_postimage_required');
    expect(sql).toContain('summary_scope_source65_required');
    expect(sql).toContain('summary_scope_scheduler_owned');
    expect(sql).not.toMatch(
      /GRANT |REVOKE |UPDATE public\.|DELETE FROM public\.|ALTER TABLE|set_config\(/i
    );
    expect(sql).toContain("m->>'provolatile'IS DISTINCT FROM's'");
  });
  it('preserves all judged rows and all original non-skipped verdict and aggregate semantics', () => {
    const after = readFileSync(base + 'summary-after.sql', 'utf8');
    expect(after).toContain('verdict AS MATERIALIZED');
    expect(after).toContain('WHERE NOT(j.n>0 AND NOT j.mine)');
    const native = readFileSync(
      'scripts/ci/test-weekly-private-deposit-verdict-postgres.py',
      'utf8'
    );
    for (const proof of [
      'ALL3_full_original_ordered_JSON',
      'private_mixed_mineTRUE_foreign_bad_retained',
      'private_missing_cash_source_N0',
      'actual_STABLE_current_view_snapshot_concurrent_receipt_commit',
      'exact_installer_fullmetadata_source65_GEN_preserved_and_replay_refused',
      'original_issuer_amounts_and_immutable_issued_history',
    ])
      expect(native).toContain(proof);
    const workflow = readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    expect(workflow).toContain('scripts/ci/fixtures/weekly-private-deposit-verdict/**');
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-weekly-private-deposit-verdict-postgres.py'
    );
    const command = workflow
      .split('\n')
      .find((line) =>
        line.includes('run: python3 -B scripts/ci/test-weekly-private-deposit-verdict-postgres.py')
      );
    expect(command).toBeDefined();
    expect(command).not.toContain('--candidate-function-only');
  });
});
