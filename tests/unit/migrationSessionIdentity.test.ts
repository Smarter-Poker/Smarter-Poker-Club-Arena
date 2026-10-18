import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain ESM helper shared with the installer
import { bindMigrationSession } from '../../scripts/ci/migration-session-identity.mjs';

describe('migration identity belongs to the owning transaction', () => {
  it('binds after BEGIN while preserving migration settings and embedded history bytes', () => {
    const original = "-- Qualified file\nBEGIN;\nSET LOCAL statement_timeout = '8min';\nCOMMIT;";
    const history = original.replace('COMMIT;', `SELECT $history$${original}$history$;\nCOMMIT;`);
    const result = bindMigrationSession(history);
    expect(result).toContain("BEGIN;\nSET LOCAL application_name = 'apply-recorded-migration';");
    expect(result).toContain("SET LOCAL statement_timeout = '8min';");
    expect(result).toContain(`$history$${original}$history$`);
    expect(result.match(/SET LOCAL application_name/g)).toHaveLength(1);
  });
  it('copies the installer root imports into both isolated native fixtures', () => {
    for (const path of [
      'scripts/ci/test_launch_reset_installer.py',
      'scripts/ci/fixtures/launch-reset/maintenance-thaw-repair/qualify.py',
    ]) {
      expect(readFileSync(path, 'utf8')).toContain("original.decode('utf-8')):copy_module(dep)");
    }
  });
  it('refuses to send an unbound transaction', () => {
    expect(() => bindMigrationSession('SELECT 1;')).toThrow(/BEGIN/);
  });
  it('binds both the ordinary and settlement-lane owning send, with native enforcement', () => {
    const door = readFileSync('scripts/ci/apply-recorded-migration.mjs', 'utf8');
    expect(door).toContain('bindMigrationSession(SETTLEMENT_LANE ? atomicSQL : admittedSQL)');
    expect(door.match(/client\.query\(transactionSQL\)/g)).toHaveLength(2);
    expect(readFileSync('scripts/ci/test-data-console-postgres-contracts.sh', 'utf8')).toContain(
      'python3 -B "$repo/scripts/ci/test-a-long-outside-snapshot-does-not-stall-the-tables.py"'
    );
  });
});
