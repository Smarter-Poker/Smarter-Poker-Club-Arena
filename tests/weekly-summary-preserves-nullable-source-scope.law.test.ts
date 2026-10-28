import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/weekly-summary-coordinator-scope/';
const read = (name: string) => readFileSync(base + name, 'utf8');
const normalized = (name: string) => read(name).trimEnd().replace(/;$/, '').trimEnd() + '\n';
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
describe('Weekly summary preserves nullable source scope', () => {
  it('changes only exact source selection and retains all financial branches', () => {
    const receipt = JSON.parse(read('source-receipt.json'));
    const before = normalized('summary-before.sql');
    const after = normalized('summary-after.sql');
    expect(md5(before)).toBe(receipt.before_md5);
    expect(md5(after)).toBe(receipt.after_md5);
    expect(before.replace(receipt.replacement.old, receipt.replacement.new)).toBe(after);
    const migration = readFileSync(receipt.migration_file, 'utf8');
    expect(migrationTransactionShape(receipt.migration_file.split('/').at(-1), migration).ok).toBe(
      true
    );
    expect(migration).toMatch(/^BEGIN;$/m);
    for (const guard of [
      'summary_scope_exact_preimage_required',
      'summary_scope_postimage_required',
      "to_jsonb(p)-'prosrc'",
      'original_inventory_proof_sources_match',
      'original_inventory_basis_generation',
      'pg_get_viewdef',
    ])
      expect(migration).toContain(guard);
    expect(migration).not.toMatch(
      /CREATE (?:OR REPLACE )?VIEW|ALTER TABLE|UPDATE public\.|DELETE FROM public\.|DISABLE TRIGGER|set_config\(/i
    );
  });
  it('enforces actual current view, full native statement and snapshot qualification', () => {
    const workflow = readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    expect(workflow).toContain('scripts/ci/fixtures/weekly-summary-coordinator-scope/**');
    expect(workflow).toContain(
      'python3 -B scripts/ci/test-weekly-summary-coordinator-scope-postgres.py'
    );
    const native = readFileSync(
      'scripts/ci/test-weekly-summary-coordinator-scope-postgres.py',
      'utf8'
    );
    for (const proof of [
      'actual_current_whole_summary_ready_baseline',
      'fullrows_nonNULL_coordinator',
      'fullrows_atomic_admitted_contract',
      'fullrows_funding_admission_redirect_in',
      'actual_STABLE_current_view_snapshot_concurrent_receipt_commit',
      'EXCEPT ALL',
      'original_issuer_amounts_and_immutable_issued_history',
    ])
      expect(native).toContain(proof);
  });
});
