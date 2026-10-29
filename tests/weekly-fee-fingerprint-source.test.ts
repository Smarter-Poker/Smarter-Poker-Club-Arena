import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const base = 'scripts/ci/fixtures/weekly-fee-fingerprint/';
const read = (p: string) => readFileSync(p, 'utf8');
const hash = (kind: string, s: string) => createHash(kind).update(s).digest('hex');
describe('Weekly fee fingerprint single serialization', () => {
  it('binds exact maintained native source and evidence', () => {
    const pins = JSON.parse(read(base + 'source-binding.json'));
    for (const [path, expected] of Object.entries(pins.sourceFiles))
      expect(hash('sha256', read(path))).toBe(expected);
  });
  it('preserves exactly the versioned economic object and complete function authority', () => {
    const c = JSON.parse(read(base + 'source-contract.json'));
    const before = read(base + 'fingerprint-before.sql');
    const after = read(base + 'fingerprint-after.sql');
    expect(hash('md5', before)).toBe(c.before_full_md5);
    expect(hash('md5', after)).toBe(c.after_full_md5);
    const oldSelect = before.slice(before.indexOf(' SELECT md5('), before.indexOf('\n$function$'));
    const newSelect =
      ' SELECT md5(jsonb_build_object(' +
      c.economic_keys.map((k: string) => `'${k}',p_row.${k}`).join(',') +
      ')::text)';
    expect(c.economic_keys).toHaveLength(17);
    expect(new Set(c.economic_keys).size).toBe(17);
    expect(before.replace(oldSelect, newSelect)).toBe(after);
    expect(after).not.toContain('to_jsonb(p_row)');
    const migration = read(c.migration);
    expect(hash('sha256', migration)).toBe(c.migration_sha256);
    expect(migration).toContain(before);
    expect(migration).toContain(after);
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain("SET LOCAL statement_timeout='5s'");
    expect(migration).toContain("SET LOCAL statement_timeout='15s'");
    expect(migration).toContain("SET LOCAL lock_timeout='1s'");
    for (const fault of [
      'operator_refused',
      'history_replay',
      'window_refused',
      'scheduler_owned',
      'admission_owner_changed',
      'admission_abi_changed',
      'admission_triggers_changed',
      'rake_columns_changed',
      'exact_preimage_required',
      'exact_postimage_required',
      'source65_required',
      'generation_required',
    ])
      expect(migration).toContain('weekly_fee_fp_' + fault);
    expect(migration).not.toMatch(
      /UPDATE public\.|DELETE FROM public\.|INSERT INTO public\.|cron\.schedule|ca\.break_window_migration_override\s*=/i
    );
  });
  it('keeps native semantics and atomic fault checks in the required accounting floor', () => {
    const c = JSON.parse(read(base + 'source-contract.json'));
    const e = JSON.parse(read(base + 'qualification-evidence.json'));
    expect(e.qualification).toBe('passed');
    expect(e.actual_after_full_md5).toBe(c.after_full_md5);
    expect(e.migration_sha256).toBe(c.migration_sha256);
    expect(e.admission_guard_md5).toBe('98363a25bad4495a4b32e7cd99354c37');
    for (const name of [
      'postcondition_failure_rolls_back_exact_function_and_full_metadata',
      'exact_single_owner_install_metadata_ACL_ABI_source65_GEN_preserved',
      'exact_spent_admission_guard_sameABI_noop_and_immutable_reverse_delete_truncate',
      'unrelated_schema_addition_preserves_versioned_economic_hash',
    ])
      expect(e.cases).toContain(name);
    expect(read('scripts/ci/test_launch_reset_floor.py')).toContain(
      'test-weekly-fee-fingerprint-postgres.py'
    );
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 -B scripts/ci/test_launch_reset_floor.py'
    );
  });
});
