/**
 * ===========================================================================
 *  LAW: A NEW MIGRATION'S NAME SURVIVES THE LEDGER, AND THE WHOLE LEDGER IS
 *  READ ONCE A WEEK
 * ===========================================================================
 *
 * WHY THIS EXISTS (2026-09-28)
 *
 * On 2026-09-28, 194 migrations production had applied had no file in either
 * repository by the rule of scripts/ci/check-applied-migrations-are-recorded.mjs,
 * and about 45 of them DID have a file: the author's, under a name or stamp the
 * ledger could not match (a letter-suffixed stamp such as `20260724f_...`, or a
 * name production stored cut at 60 characters). Two fixes pin here:
 *
 *   1. check-new-migration-version-collisions.mjs refuses a NEW migration whose
 *      stamp carries a letter or whose name is longer than 60 characters. A
 *      verified recording (scripts/ci/recording-only.mjs) keeps the version and
 *      name production wrote and is exempt.
 *   2. applied-migrations-recorded.yml reads the whole history since
 *      2026-04-01 on its Monday-morning run, on the timer it already had.
 *
 * And the exporter stops deleting files.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_MIGRATION_NAME,
  namingProblems,
} from '../scripts/ci/check-new-migration-version-collisions.mjs';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('a new migration name survives the ledger', () => {
  it('accepts a reserved 14-digit stamp with a name of at most 60 characters', () => {
    const name = 'a'.repeat(MAX_MIGRATION_NAME);
    expect(MAX_MIGRATION_NAME).toBe(60);
    expect(namingProblems(`supabase/migrations/20260928031500_${name}.sql`)).toEqual([]);
    expect(namingProblems('supabase/migrations/20260928031500_the_rail_asks_once.sql')).toEqual([]);
  });

  it('refuses a name longer than 60 characters', () => {
    const name = 'a'.repeat(MAX_MIGRATION_NAME + 1);
    const problems = namingProblems(`supabase/migrations/20260928031500_${name}.sql`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/61 characters/);
  });

  it('refuses a letter-suffixed stamp', () => {
    const problems = namingProblems('supabase/migrations/20260724f_atomic_distribute_rake.sql');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/letter suffix/);
  });

  it('judges only new work: a verified recording keeps the name production wrote', () => {
    const gate = read('scripts/ci/check-new-migration-version-collisions.mjs');
    expect(gate).toContain("from './recording-only.mjs'");
    expect(gate).toMatch(/classifyMigration\(path\)\.state !== 'recorded'/);
    expect(gate).toMatch(/misnamed\.length > 0\) process\.exit\(1\)/);
  });
});

describe('the whole ledger is read once a week', () => {
  const wf = read('.github/workflows/applied-migrations-recorded.yml');

  it('runs full history since 2026-04-01 with --fail on the existing Monday-morning run', () => {
    expect(wf).toContain('SINCE_ARGS="--since 20260401"');
    expect(wf).toMatch(/date -u \+%u\)" = "1"/);
    expect(wf).toContain('check-applied-migrations-are-recorded.mjs --fail $SINCE_ARGS');
  });

  it('adds no new timer to do it', () => {
    expect([...wf.matchAll(/^\s*-\s*cron:/gm)]).toHaveLength(1);
  });
});

describe('the exporter follows the CI rule and never deletes', () => {
  const sh = read('scripts/dev/export-applied-migrations.sh');
  const code = sh
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  it('decides "missing" with the same functions the scheduled audit uses', () => {
    expect(code).toContain('indexFrom');
    expect(code).toContain('recordedBy');
    expect(code).toContain('siblingMigrationFiles');
  });

  it('has no rm and refuses to overwrite', () => {
    expect(code).not.toMatch(/\brm\s+-/);
    expect(code).toContain("flag: 'wx'");
  });

  it('reads production read-only and writes the byte-exact fn_ca_migration_text body', () => {
    expect(code).toContain('default_transaction_read_only=on');
    expect(code).toContain("array_to_string(statements, E';\\n')");
  });
});
