import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const migration = read(
  'supabase/migrations/20261013120756_spent_dss_one_off_wallet_operations_are_retired.sql'
);

describe('spent DSS operations are not money doors', () => {
  it('qualifies the exact installed history without invoking its financial bodies', () => {
    expect(
      createHash('md5').update(read('scripts/dev/spent-dss-operations/installed.sql')).digest('hex')
    ).toBe('1e37a105a1c11d7a6d7aa313c8c5053e');
    for (const hash of [
      'c21ae1d35c9570a54f15ebff5002dbbc',
      'cb960711b56000d71cd7b54db8d91f00',
      '6f48b385af8e854b354dbf9f9b872308',
    ])
      expect(migration).toContain(hash);
    expect(migration).toContain("prokind IN ('f','p')");
    expect(migration).toContain('AND oid NOT IN');
    expect(migration).not.toContain('AND proname NOT IN');
    expect(migration).not.toMatch(/\bCASCADE\b/i);
    expect(migration.match(/DROP FUNCTION .* RESTRICT;/g)).toHaveLength(3);
    expect(migration).not.toMatch(
      /(?:SELECT|PERFORM)\s+(?:public\.)?ops_dss_midway_(?:sweep|go_live)\s*\(/i
    );
  });
  it('runs the native refusal and retirement proof in the existing accounting check', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain('python3 scripts/dev/test-spent-dss-retirement.py');
    const runner = read('scripts/dev/test-spent-dss-retirement.py');
    for (const witness of [
      'CREATE PROCEDURE',
      'qualification_abort',
      'spent_dss_operation_has_caller',
      'spent_dss_operation_still_scheduled',
      'spent_dss_registry_preimage_changed',
      'spent_dss_operation_preimage_changed',
      'SET ROLE service_role',
    ])
      expect(runner).toContain(witness);
  });
});
