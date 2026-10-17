/**
 * ===========================================================================
 *  LAW - THE CRASH SNAPSHOT READ FINDS ITS ONE ROW IN A CACHED PLAN
 * ===========================================================================
 *
 * ClubArenaEngineKillStorm, 2026-10-17 12:57Z: 74 engine kills on 42 tables.
 * The engine's boot read of a table's unfinished hand (getActiveHandSnapshotFull)
 * reaches PostgREST as `table_id = $1 AND is_complete = $2`, and a cached
 * generic plan cannot use the partial unique index
 * (table_id) WHERE is_complete = false whose predicate is a parameter. It
 * walked every snapshot the table had kept (up to 10,523 rows) and hit the
 * 8 s statement timeout 57 times. Migration 20261017170945 adds the index the
 * parameterised plan CAN use; scripts/ci/test-crash-snapshot-read-plan-postgres.py
 * proves the generic plan before (walk + filter) and after (both columns as
 * index conditions, one row) on native PostgreSQL.
 *
 * This holds the three pieces together: the index exists in the migration
 * corpus with exactly those columns, built online; the engine's read still
 * filters by exactly those two columns, so the index keeps serving it; and the
 * native proof stays wired into CI.
 *
 * Registry: docs/laws.d/the-crash-snapshot-read-finds-its-one-row-in-a-cached-plan.md
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationText } from './helpers/migrationCorpus';

const FILE = '20261017170945_the_crash_snapshot_read_finds_its_one_row_in_a_cached_plan.sql';
const squash = (s: string): string => s.replace(/\s+/g, ' ');
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the crash snapshot read finds its one row in a cached plan', () => {
  it('builds (table_id, is_complete) online, before the verifying transaction', () => {
    const sql = squash(migrationText(FILE));
    const build = sql.indexOf(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hand_state_snapshots_table_complete ON public.hand_state_snapshots (table_id, is_complete);'
    );
    expect(build).toBeGreaterThan(-1);
    // Outside the transaction: CONCURRENTLY cannot run inside one, and a plain
    // build would block every snapshot write for the length of the scan.
    expect(build).toBeLessThan(sql.indexOf('BEGIN;'));
    expect(sql).toMatch(/i\.indisvalid AND i\.indisready/);
  });

  it('serves the read the engine actually sends: table_id and is_complete, equality only', () => {
    const src = read('server/src/services/supabase/snapshots.ts');
    const start = src.indexOf('export async function getActiveHandSnapshotFull(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain(".eq('table_id', tableId)");
    expect(body).toContain(".eq('is_complete', false)");
    expect(body).toContain('.limit(1)');
  });

  it('keeps its native PostgreSQL proof in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('python3 scripts/ci/test-crash-snapshot-read-plan-postgres.py');
  });
});
