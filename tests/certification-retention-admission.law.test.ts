import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(
  'supabase/migrations/20261026174122_certification_cleanup_reserves_a_turn_before_retention.sql',
  'utf8'
);
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('certification cleanup gets a turn without queueing player operations', () => {
  it('the prerequisite drains only its existing cron lane before altering the private cursor', () => {
    const prerequisite = readFileSync(
      'supabase/migrations/20261026174211_the_retention_scan_bounds_work_before_evaluating_guards.sql',
      'utf8'
    );
    expect(prerequisite).toContain("SET LOCAL lock_timeout='125s'");
    expect(prerequisite).toContain("pg_advisory_xact_lock(hashtext('sp-prune-hand-history'))");
    expect(
      prerequisite.indexOf("pg_advisory_xact_lock(hashtext('sp-prune-hand-history'))")
    ).toBeLessThan(prerequisite.indexOf('ALTER TABLE'));
    expect(prerequisite).toContain(
      "SET LOCAL lock_timeout='2s';\nSET LOCAL statement_timeout='60s';\nALTER TABLE"
    );
  });

  it('reserves only the retention lane with a bounded private helper', () => {
    const helper = migration.split('CREATE FUNCTION')[1].split('DO $patch$')[0];
    expect(helper).toContain("SET lock_timeout = '32s'");
    expect(helper).toContain('pg_advisory_xact_lock(530090,2)');
    expect(helper).not.toContain('pg_advisory_xact_lock(530090,1)');
    expect(helper).toContain('FROM PUBLIC, anon, authenticated, service_role');
  });
  it('retention declines its next batch before touching the original platform gate', () => {
    const replacement = migration.split('new_fragment := $newprune$')[1].split('$newprune$')[0];
    expect(replacement).toContain(
      'pg_try_advisory_xact_lock_shared(530090,2) IS NOT TRUE THEN RETURN 0'
    );
    expect(replacement).not.toMatch(/(?<!try_)advisory_xact_lock/);
    expect(replacement.indexOf('(530090,2)')).toBeLessThan(
      replacement.indexOf('Preserve the original maintenance')
    );
  });
  it('preserves the original fixture platform gate and all five complete bodies by reversible hash', () => {
    const replacement = migration.split('new_fragment := $newfixture$')[1].split('$newfixture$')[0];
    expect(replacement).toBe(
      '    PERFORM smarter_private.certification_retention_admission();\n    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP\n'
    );
    expect(migration.match(/^ {4}\('public\./gm)).toHaveLength(5);
    expect(migration).toContain(
      'md5(replace(after_text,new_fragment,old_fragment)) <> item.pre_hash'
    );
    expect(migration).toContain('IS DISTINCT FROM prior_acl');
    expect(migration).toContain("has_function_privilege('authenticated',signature,'EXECUTE')");
  });
  it('changes no maintenance functions, cron schedules, retention rules or retry limits', () => {
    expect(migration).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION public\.|cron\.(?:schedule|unschedule)|ALTER TABLE|LOCK TABLE|DELETE FROM/
    );
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it('runs the real PostgreSQL concurrency proof in required accounting CI', () => {
    expect(ci).toContain('run: python3 -B scripts/ci/test-certification-retention-admission.py');
    const proof = readFileSync('scripts/ci/test-certification-retention-admission.py', 'utf8');
    expect(proof).toContain('MIGRATION.read_text()');
    expect(proof).toContain('PREIMAGE.read_text()');
    expect(proof).toContain('31 <= elapsed <= 35');
    expect(proof).toContain('clusterRemoved');
  });
});
