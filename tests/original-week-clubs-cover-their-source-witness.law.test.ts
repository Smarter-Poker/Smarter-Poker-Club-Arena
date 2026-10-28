import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const migration =
  'supabase/migrations/20261027151555_original_week_clubs_cover_the_coordinator_club_and_event.sql';
const sql = fs.readFileSync(migration, 'utf8');
describe('Original weekly club discovery covers the unchanged source witness', () => {
  it('uses the maintained one-build concurrent route and one guarded transaction', () => {
    const result = splitConcurrentPreamble(sql);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0].name).toBe('accounting_tournament_week_club_event_cover');
    expect(result.indexes[0].statement).toContain('(coordinator_union_id,club_id,tournament_id)');
    expect(result.indexes[0].statement).toContain(
      'INCLUDE(id,charged_at,rake_credit,union_id) WHERE coordinator_union_id IS NOT NULL'
    );
    for (const guard of [
      'indisvalid',
      'indisready',
      'indislive',
      'indnkeyatts<>3',
      'indnatts<>7',
      'indclass',
      'indcollation',
      'indoption',
      'indpred',
    ])
      expect(result.body).toContain(guard);
    const statements = result.body.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(
      /\b(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER|TABLE)\b/i
    );
    expect(statements).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/SET\s+(?:LOCAL\s+)?(?:jit|enable_)/i);
  });
  it('retains native whole-original-owner before/after and actual index-only proof', () => {
    const native = fs.readFileSync('scripts/ci/test-original-week-clubs-cover-postgres.py', 'utf8');
    for (const contract of [
      'before=verify_cases()',
      'after=verify_cases()',
      'assert before==after',
      'Heap Fetches',
      'Index Only Scan',
      'coordinator_union_id',
      'club_id',
      'tournament_id',
      'actual_invalid_concurrent_build',
      'source_fingerprint_unchanged',
      'old_metadata',
    ])
      expect(native).toContain(contract);
    const original = fs.readFileSync(
      'scripts/ci/fixtures/original-week-clubs/original.sql',
      'utf8'
    );
    expect(original).toContain('FUNCTION public.fn_accounting_week_clubs');
    expect(original).toContain('STABLE SECURITY DEFINER');
    const workflow = fs.readFileSync(
      '.github/workflows/unpaid-lightning-funding-contracts.yml',
      'utf8'
    );
    expect(workflow).toContain('scripts/ci/test-original-week-clubs-cover-postgres.py');
    expect(workflow).toContain('scripts/ci/fixtures/original-week-clubs/**');
  });
});
