import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '../../supabase/migrations/20260901000100_leaderboard_phase2_release_gate.sql'),
  'utf8'
);
const indexMigration = readFileSync(
  join(
    __dirname,
    '../../supabase/migrations/20260901000101_leaderboard_phase2_foreign_key_indexes.sql'
  ),
  'utf8'
);

describe('leaderboard phase two production release gate', () => {
  it('makes compatibility settings RPC-only for browser roles', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS "Managers can manage leaderboard settings"');
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE');
    expect(migration).toContain('ON public.club_leaderboard_settings FROM anon, authenticated');
    expect(migration).toContain('ON public.leaderboard_reward_program_versions FROM authenticated');
  });

  it('rejects null and non-number prize fields at the server boundary', () => {
    expect(migration).toContain("jsonb_typeof(v_prize -> 'rank') <> 'number'");
    expect(migration).toContain("jsonb_typeof(v_prize -> 'amount') <> 'number'");
    expect(migration).toContain('SELECT count(*) FROM jsonb_object_keys(v_prize)');
  });

  it('uses one fail-closed union affiliation resolver on every reward path', () => {
    expect(migration).toContain('fn_leaderboard_funding_union_id');
    expect(migration.match(/fn_leaderboard_funding_union_id\(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(migration).toContain('Conflicting Union Affiliation');
  });

  it('binds each operation id to one immutable publication intent', () => {
    expect(migration).toContain(
      'Leaderboard Publication Retry Key Was Reused For Different Prize Rules'
    );
    expect(migration).toContain('v_existing.program_hash <> v_requested_hash');
  });

  it('makes the compatibility funding foreign key agree with its non-null scope check', () => {
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS club_leaderboard_settings_funding_union_id_fkey'
    );
    expect(migration).toContain('ON DELETE RESTRICT');
  });

  it('covers every reward-program foreign key reported by the production advisor', () => {
    expect(indexMigration).toContain('(funding_union_id)');
    expect(indexMigration).toContain('(setup_completed_by)');
    expect(indexMigration).toContain('(updated_by)');
    expect(indexMigration).toContain('(supersedes_program_id)');
  });
});
