import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const base = 'scripts/ci/fixtures/weekly-quality-typed-source-maps/';
const migration =
  'supabase/migrations/20261028185823_weekly_quality_reads_exact_event_aggregate_maps.sql';
const read = (path: string) => readFileSync(path, 'utf8');
describe('Weekly quality typed source maps preserve original verdicts', () => {
  it('installs only the qualified complete function with exact authority and no native metadata rebinding', () => {
    const source = read(migration);
    for (const guard of [
      'operator_refused',
      'window_refused',
      'scheduler_owned',
      'history_replay',
      'exact_preimage_required',
      'source65_required',
      'generation_required',
      'exact_patch_required',
      'postimage_required',
    ])
      expect(source).toContain('weekly_quality_bags_' + guard);
    expect(source).toContain("SET LOCAL lock_timeout='1s'");
    expect(source).toContain("SET LOCAL statement_timeout='5s'");
    expect(source).toContain('5c8b31d9f75c4b3b84cfd17fefb666a0');
    expect(source).toContain('28a130f35342357a4dfa61043f1ce2a2');
    expect(source).toContain('a9271e7d468df1e2453aafbd3674a1ee');
    expect(source).not.toMatch(
      /expected_metadata\s*:=|CREATE TABLE|cron\.schedule|UPDATE public\./i
    );
  });
  it('preserves all 83 original fault, bag and snapshot cases', () => {
    const evidence = JSON.parse(read(base + 'qualification-evidence.json'));
    expect(evidence.qualification).toBe('passed');
    expect(evidence.case_count).toBe(83);
    expect(evidence.migration_sha256).toBe(
      createHash('sha256').update(readFileSync(migration)).digest('hex')
    );
    for (const name of [
      'authentic_positive_for_query_5000_all_fields_equal',
      'large_positive_real_quality_full_result_equal',
      'actual_STABLE_SQL_snapshot_concurrent_recognition_commit',
      'four_selected_sets_typed_bag_NULL_selected_receipt_recognized',
      'fee_scope_original_four_fields_independent_mixed',
      'installer_bad_postcondition_atomic_rollback',
    ])
      expect(evidence.cases).toContain(name);
    expect(
      createHash('md5')
        .update(
          read(base + 'quality-after.sql')
            .trimEnd()
            .replace(/;$/, '') + '\n'
        )
        .digest('hex')
    ).toBe('28a130f35342357a4dfa61043f1ce2a2');
  });
  it('keeps the native proof directly enforced in the existing weekly-close workflow', () => {
    const workflow = read('.github/workflows/weekly-close-hour-guard.yml');
    for (const command of [
      'test-weekly-close-hour-guard-postgres.py',
      'test-payout-receipt-payer-reuse-postgres.py',
      'test-readonly-payer-receipts-postgres.py',
      'test-weekly-quality-typed-source-maps-postgres.py',
    ])
      expect(workflow).toContain(command);
    expect(workflow).toContain('scripts/ci/fixtures/weekly-quality-typed-source-maps/**');
  });
  it('binds every maintained exact input', () => {
    const binding = JSON.parse(read(base + 'source-binding.json'));
    for (const [file, hash] of Object.entries(binding.sourceFiles))
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash);
  });
});
