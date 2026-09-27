import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Find A Player native privacy qualification', () => {
  it.each([
    'scripts/ci/test-player-search-privacy-postgres.py',
    'scripts/ci/fixtures/player-search-privacy/setup.sql',
    'scripts/ci/fixtures/player-search-privacy/cases.sql',
    'tests/playerSearchPrivacyRegression.test.ts',
  ])('routes isolated fixture changes through the PostgreSQL job for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('is wired into the required accounting PostgreSQL job', () => {
    const workflow = read('.github/workflows/ci.yml');
    const accounting = workflow.split('\n  accounting_postgres:')[1].split('\n  server:')[0];
    expect(accounting).toContain('run: python3 scripts/ci/test-player-search-privacy-postgres.py');
  });

  it('executes the exact migration and keeps the sensitive assertions native', () => {
    const runner = read('scripts/ci/test-player-search-privacy-postgres.py');
    expect(runner).toContain('MIGRATION.read_text()');
    expect(runner).toContain("player['sensitive_accounts'] == []");
    expect(runner).toContain("'role' not in affiliations['clubs'][0]");
    expect(runner).toContain("player['tables'] == []");
    expect(runner).toContain("player['display_name'] is None");
    expect(runner).toContain('fn_get_table_watch_access');
  });
});
