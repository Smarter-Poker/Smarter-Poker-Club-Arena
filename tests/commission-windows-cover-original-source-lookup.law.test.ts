import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(p, 'utf8');
const files = readdirSync('supabase/migrations').filter((f) =>
  f.endsWith('_commission_windows_cover_the_original_source_lookup.sql')
);
describe('Commission windows cover their unchanged original source lookup', () => {
  it('adds one sanctioned covering index and refuses invalid or incompatible catalogue state', () => {
    expect(files).toHaveLength(1);
    const sql = read('supabase/migrations/' + files[0]);
    expect(sql.match(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /gm)).toHaveLength(1);
    expect(sql).toContain('btree(source_id,source_type,club_id)');
    expect(sql).toContain(
      'INCLUDE(user_id,amount,commission_rate,settled_at) WHERE source_id IS NOT NULL'
    );
    for (const term of [
      'indisvalid',
      'indisready',
      'indislive',
      'indnkeyatts<>3',
      'indnatts<>7',
      'indclass',
      'indcollation',
      'indoption',
      'commission_source_cover_shape_changed',
    ])
      expect(sql).toContain(term);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION|ALTER FUNCTION|CREATE TABLE|UPDATE public\.|INSERT INTO public\.|cron\.(schedule|alter_job)/
    );
  });
  it('ties the actual projected query to the original whole owner and enforces native parity', () => {
    const fixture = 'scripts/ci/fixtures/commission-source-cover/';
    const original = JSON.parse(read(fixture + 'original-window.json'));
    expect(original.md5).toBe('c99fd8bcf27dee2047db451d8c65111e');
    expect(original.definition).toContain(read(fixture + 'original-ac-query.sql').trim());
    const native = read('scripts/ci/test-commission-source-cover-postgres.py');
    for (const term of [
      'before_projection==after_projection',
      'before_full==json.loads(q(call))',
      'before_faults==fault_outputs()',
      "'Index Only Scan'",
      'Heap Fetches',
      'could not create unique index',
      'invalid=identity()',
      'authority==q(authority_sql)',
    ])
      expect(native).toContain(term);
    expect(read('.github/workflows/unpaid-lightning-funding-contracts.yml')).toContain(
      'python3 -B scripts/ci/test-commission-source-cover-postgres.py'
    );
  });
});
