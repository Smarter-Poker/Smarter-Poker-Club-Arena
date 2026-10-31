import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027201555_foreign_certificates_match_their_original_allocations_once.sql',
  'utf8'
);
const native = readFileSync(
  'scripts/ci/fixtures/foreign-certificate-allocations-once/native-hook.py',
  'utf8'
);
const shard = readFileSync('scripts/dev/test-agent-accounting-statements.sh', 'utf8');
describe('strict foreign certificates match their original allocation bag once', () => {
  it('changes only the pinned original bad join and preserves all metadata', () => {
    expect(sql).toContain('154b8afb11b7a9c7617d16fd047c9918');
    expect(sql).toContain('9f8457664adb8bc0b171ca75d831126b');
    expect(sql).toContain('before_metadata IS DISTINCT FROM after_metadata');
    expect(sql).toContain('allocation_rows AS MATERIALIZED');
    expect(sql).toContain('FROM allocation_rows foreign_cert');
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toMatch(/CREATE\s+(?:TEMP\s+)?TABLE|cron\.|source65\s*:=|DISABLE\s+TRIGGER/i);
  });
  it('retains the complete original bad-source party and rate tests', () => {
    for (const condition of [
      'fs.source_id IS NULL',
      'fs.club_id IS DISTINCT FROM foreign_cert.club_id',
      'fs.player_id IS DISTINCT FROM foreign_cert.player_id',
      'fs.coordinator_union_id IS DISTINCT FROM foreign_cert.coordinator_union_id',
      'fs.rake_record_id IS DISTINCT FROM',
      "'NaN','Infinity','-Infinity'",
      'foreign_cert.payer_kind',
      'foreign_cert.payer_user_id',
    ])
      expect(sql).toContain(condition);
    expect(native).toContain('originalHelperResultOrErrorParity');
    expect(native).toContain('invalidSourceUUIDStillRefuses');
  });
  it('runs native original financial and independent helper parity through the required shard', () => {
    expect(shard).toContain('scripts/ci/test-foreign-certificate-allocations-once-postgres.py');
    expect(native).toContain(
      'allocation-once-exact-installer-rollback-replay-full-metadata-unchanged'
    );
    expect(native).toContain('own-null-coordinator');
    expect(native).toContain('duplicate-allocation');
  });
});
