import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_ADMISSION_SOURCES,
  ACCOUNTING_ADMISSION_SQL,
  accountingAdmissionSQL,
} from '../../scripts/ci/accounting-migration-admission.mjs';
const file = '20261015182133_a_proving_week_advances_on_its_own_tick.sql';
const source = readFileSync('supabase/migrations/' + file, 'utf8');
describe('Accounting migration admission stays inside the original owning transaction', () => {
  it('leaves every unselected file byte exact', () => {
    expect(accountingAdmissionSQL('other.sql', 'anything', source)).toBe(source);
    expect(Object.keys(ACCOUNTING_ADMISSION_SOURCES)).toHaveLength(10);
  });
  it('binds every selected migration to its reviewed bytes, including compatible Phase 7', () => {
    for (const selected of Object.keys(ACCOUNTING_ADMISSION_SOURCES)) {
      const text = readFileSync('supabase/migrations/' + selected, 'utf8');
      expect(
        accountingAdmissionSQL(selected, text, text).replace('\n' + ACCOUNTING_ADMISSION_SQL, '')
      ).toBe(text);
      expect(() => accountingAdmissionSQL(selected, text + '\n', text)).toThrow('exact qualified');
    }
  });
  it('preserves source, history literals, final COMMIT and original guards', () => {
    const original = source.replace(
      /COMMIT;\s*$/,
      () => 'SELECT $literal$' + source + '$literal$;\nCOMMIT;'
    );
    const wrapped = accountingAdmissionSQL(file, source, original);
    expect(wrapped.replace('\n' + ACCOUNTING_ADMISSION_SQL, '')).toBe(original);
    expect(wrapped.indexOf(ACCOUNTING_ADMISSION_SQL)).toBeLessThan(
      wrapped.indexOf("SET LOCAL lock_timeout='2s'")
    );
  });
  it('refuses changed bytes, missing BEGIN and duplicate wrapping', () => {
    expect(() => accountingAdmissionSQL(file, source + '\n', source)).toThrow('exact qualified');
    expect(() => accountingAdmissionSQL(file, source, 'SELECT 1;')).toThrow('original transaction');
    expect(() =>
      accountingAdmissionSQL(file, source, accountingAdmissionSQL(file, source, source))
    ).toThrow('prior admission');
  });
  it('bounds the single transaction wait and rechecks original maintenance authority', () => {
    expect(ACCOUNTING_ADMISSION_SQL).toContain("lock_timeout='245s'");
    expect(ACCOUNTING_ADMISSION_SQL).toContain("statement_timeout='250s'");
    expect(ACCOUNTING_ADMISSION_SQL.match(/pg_advisory_xact_lock\(/g)).toHaveLength(1);
    expect(ACCOUNTING_ADMISSION_SQL).not.toContain('pg_advisory_lock(');
    const [before, after] = ACCOUNTING_ADMISSION_SQL.split(
      'PERFORM pg_catalog.pg_advisory_xact_lock'
    );
    for (const part of [before, after]) {
      expect(part).toContain('fn_platform_frozen() IS DISTINCT FROM false');
      expect(part).toContain('fn_active_maintenance_release_boundary() IS NOT NULL');
      expect(part).toContain('fn_ca_break_window_refuses_migrations(clock_timestamp())');
    }
    expect(before).toContain("interval '310 seconds'");
    expect(after).toContain("interval '60 seconds'");
  });
  it('is exercised by the required actual TLS installer driver', () => {
    const driver = readFileSync('scripts/ci/test_launch_reset_installer.py', 'utf8');
    expect(driver).toContain("copy_module('accounting-migration-admission.mjs')");
    expect(driver).toContain('scripts/ci/fixtures/accounting-migration-admission/qualify.py');
  });
});
