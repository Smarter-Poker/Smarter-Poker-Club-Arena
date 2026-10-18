import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(path, 'utf8');
describe('current retained retirement qualification', () => {
  it('runs the actual compound-key scene in the required retirement job', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: python3 scripts/ci/test-certification-retirement-postgres.py'
    );
    expect(read('scripts/ci/test-certification-retirement-postgres.py')).toContain(
      "str(ROOT/'tests/sql/run-club-retirement-member-lock.py')"
    );
    const scene = read('tests/sql/run-club-retirement-member-lock.py');
    expect(scene).toContain(
      'CREATE TABLE club_members(club_id uuid,user_id uuid,PRIMARY KEY(club_id,user_id))'
    );
    expect(scene).toContain('\'column "id" does not exist\'');
    expect(scene).toContain("result['records_retained']");
    expect(scene).toContain("replay['already_retired']");
  });
});
