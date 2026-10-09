import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error - maintained ESM migration installer parser
import { splitConcurrentPreamble } from '../../scripts/ci/migration-concurrent-preamble.mjs';
const migration = readdirSync('supabase/migrations').filter((f) =>
  f.endsWith('_recovery_cash_manifest_counts_have_covering_keys.sql')
);
const sql =
  migration.length === 1 ? readFileSync(`supabase/migrations/${migration[0]}`, 'utf8') : '';
const executable = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
describe('recovery counts keep financial semantics and build only a covering index without blocking writers', () => {
  it('uses one uniquely reserved migration and the exact sanctioned concurrent preamble', () => {
    expect(migration).toHaveLength(1);
    expect(migration[0]).toMatch(/^\d{14}_/);
    const shape = splitConcurrentPreamble(sql);
    expect(shape.ok).toBe(true);
    expect(shape.indexes).toHaveLength(1);
    expect(shape.indexes[0]).toMatchObject({
      schema: 'public',
      table: 'cash_hand_participant_manifests',
      name: 'ca_cash_manifest_snapshot_cover_idx',
    });
    expect(shape.indexes[0].statement.replace(/\s+/g, ' ')).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_cash_manifest_snapshot_cover_idx ON public.cash_hand_participant_manifests (table_id, hand_number) INCLUDE (funding_provenance_complete);'
    );
    expect(shape.body.trim().endsWith('COMMIT;')).toBe(true);
  });
  it('a blocking build or implicit outside-transaction write cannot pass the existing door', () => {
    expect(splitConcurrentPreamble(sql.replace('INDEX CONCURRENTLY', 'INDEX')).ok).toBe(false);
    expect(
      splitConcurrentPreamble(
        sql.replace('BEGIN;', 'DELETE FROM public.cash_hand_participant_manifests;\nBEGIN;')
      ).ok
    ).toBe(false);
  });
  it('refuses an invalid, unfinished, foreign or structurally different same-name index', () => {
    for (const predicate of [
      "i.indrelid = 'public.cash_hand_participant_manifests'::regclass",
      "n.nspname = 'public'",
      "pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'",
      "a.amname = 'btree'",
      'i.indisvalid AND i.indisready AND i.indislive',
      'NOT i.indisunique AND NOT i.indisprimary',
      'i.indnkeyatts = 2 AND i.indnatts = 3',
      'i.indexprs IS NULL AND i.indpred IS NULL',
      "c.relkind = 'i' AND c.relpersistence = 'p'",
      'pg_catalog.pg_get_indexdef(i.indexrelid) =',
    ])
      expect(executable).toContain(predicate);
    expect(executable).toContain("USING ERRCODE = '55000'");
  });
  it('keeps the original table, indexes, all fourteen projections and role/security owners unchanged', () => {
    expect(executable).not.toMatch(
      /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|GRANT|REVOKE|VACUUM|ANALYZE|TRUNCATE)\b/i
    );
    expect(executable).not.toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TABLE|TRIGGER|POLICY)/i
    );
    expect(executable).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    expect(executable.match(/CREATE INDEX CONCURRENTLY/g)).toHaveLength(1);
  });
  it('asserts only inside one short transaction and never overrides the maintenance refusal', () => {
    const shape = splitConcurrentPreamble(sql);
    expect(shape.body).toContain("SET LOCAL lock_timeout = '2s';");
    expect(shape.body).toContain("SET LOCAL statement_timeout = '5s';");
    expect(executable).not.toContain('break_window_migration_override');
    expect(executable.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(executable.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
