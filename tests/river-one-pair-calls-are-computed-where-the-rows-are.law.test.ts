/**
 * LAW: the river one-pair measurement is computed where the rows are, by a
 *      service-only, read-only database function that agrees with the
 *      TypeScript reader on the same fixture hands - and CI proves it.
 *
 * The first version of the Hold'em live measure pulled a day of
 * horse_hand_reviews (actions JSON and all) through PostgREST to compute three
 * numbers. fn_horse_river_one_pair_calls (20261031024652) does the arithmetic
 * in the database; scripts/dev/test-horse-river-one-pair-calls.sh loads the
 * fixture hands server/scripts/river-one-pair-fixture.ts writes and requires
 * the SQL and TypeScript answers to match cell for cell, in the accounting
 * shard that has a real PostgreSQL. The CLI prefers the function and falls
 * back to rows only when the function is ABSENT, never when it refused.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const migrationName = readdirSync(join(ROOT, 'supabase', 'migrations')).find((f) => f.startsWith('20261031024652_'));
const migration = readFileSync(join(ROOT, 'supabase', 'migrations', migrationName ?? ''), 'utf8');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const cli = readFileSync(join(ROOT, 'server', 'scripts', 'holdem-live-measure.ts'), 'utf8');
const parity = readFileSync(join(ROOT, 'scripts', 'dev', 'test-horse-river-one-pair-calls.sh'), 'utf8');
const fixture = readFileSync(join(ROOT, 'server', 'scripts', 'river-one-pair-fixture.ts'), 'utf8');

describe('river one-pair calls are computed where the rows are', () => {
  it('installs one STABLE, service-only, bounded function in one transaction and reads no horse flag', () => {
    expect(migrationName).toBe('20261031024652_horse_river_one_pair_calls_by_size_class.sql');
    expect(migration.match(/^BEGIN;$/m) ?? []).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/m) ?? []).toHaveLength(1);
    const fn = sliceBetween(migration, 'CREATE OR REPLACE FUNCTION public.fn_horse_river_one_pair_calls(', '\n$fn$;');
    expect(fn).toContain('STABLE');
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toContain('SET search_path = pg_catalog, public');
    expect(fn).toContain("p_since must be within the last 14 days");
    expect(fn).toContain('p_limit must be 1..20000');
    expect(fn).toContain("hr.game_variant = 'nlh'");
    expect(fn).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|LOCK TABLE/);
    expect(migration).not.toMatch(/is_horse|horse_id/);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.fn_horse_river_one_pair_calls(timestamptz, integer) FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.fn_horse_river_one_pair_calls(timestamptz, integer) TO service_role;');
    // The same three classes as HorseEval.v62SizeClass.
    expect(fn).toContain('IF aggr >= 2 OR frac >= 0.7 THEN');
    expect(fn).toContain('ELSIF frac >= 0.4 THEN');
  });

  it('is proved against the TypeScript reader on shared fixture hands, in CI', () => {
    expect(parity).toContain('npx tsx scripts/river-one-pair-fixture.ts');
    expect(parity).toContain('20261031024652_horse_river_one_pair_calls_by_size_class.sql');
    expect(parity).toContain('SQL and TypeScript agree');
    expect(parity).toContain("has_function_privilege('anon'");
    expect(fixture).toContain("import { riverOnePairCalls, type ReviewAction, type ReviewRow } from '../src/benchmark/HoldemLiveMeasure.js'");
    const step = sliceBetween(ci, '- name: River one-pair calls agree between SQL and TypeScript', '\n      - name: ');
    expect(step).toContain('run: bash scripts/dev/test-horse-river-one-pair-calls.sh');
    expect(step).toContain('if: matrix.shard == 2');
    // Inside the accounting job, which installs server dependencies and PostgreSQL 17.
    const job = sliceBetween(ci, '\n  accounting_postgres:\n', '\n  server_shards:\n');
    expect(job).toContain('River one-pair calls agree between SQL and TypeScript');
  });

  it('is what the CLI asks first, falling back to rows only when the function is absent', () => {
    expect(cli).toContain("await rpc('fn_horse_river_one_pair_calls', { p_since: since.toISOString(), p_limit: REVIEW_ROW_CAP })");
    expect(cli).toContain("throw new Error('fn_horse_river_one_pair_calls answered outside its contract')");
    expect(cli).toContain("answer.status === 404 || (answer.body as { code?: string } | null)?.code === 'PGRST202'");
    expect(cli).toContain('while (!riverOnePair && reviews.length < REVIEW_ROW_CAP)');
  });
});
