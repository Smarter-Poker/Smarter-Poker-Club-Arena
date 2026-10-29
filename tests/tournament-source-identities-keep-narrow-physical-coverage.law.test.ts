import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { migrationTransactionShape } from '../scripts/ci/migration-transaction-shape.mjs';
const base = 'scripts/ci/fixtures/tournament-source-identity-cover/';
const migration =
  'supabase/migrations/20261029020140_weekly_fee_source_identities_retain_their_tournament_and_rak.sql';
describe('tournament source identities retain narrow physical coverage', () => {
  it('adds exactly one fixed-width UUID cover through the existing CCI transaction route', () => {
    const sql = readFileSync(migration, 'utf8');
    const shape = migrationTransactionShape(migration.split('/').at(-1), sql);
    expect(shape.ok).toBe(true);
    expect(shape.ok && shape.indexes.length).toBe(1);
    expect(sql).toMatch(/\(id\) INCLUDE\(tournament_id,rake_record_id\)/);
    expect(sql).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION|ALTER TABLE|DROP INDEX|INSERT INTO|DELETE FROM|UPDATE public\./i
    );
    for (const guard of [
      'operator_refused',
      'history_replay',
      'window_refused',
      'source65_required',
      'original_generation_required',
      'actual_table_required',
      'exact_catalog_required',
      'original_authority_changed',
    ])
      expect(sql).toContain('fee_source_identity_cover_' + guard);
    expect(sql).toContain("SET LOCAL statement_timeout='15s'");
    expect(sql).toContain("SET LOCAL statement_timeout='5s'");
    expect(sql).toContain("qualified->'raw_triggers'");
  });
  it('binds the full actual table and both unchanged query snapshots', () => {
    const table = JSON.parse(readFileSync(base + 'actual-table-authority.json', 'utf8')).table;
    expect(table.columns).toHaveLength(15);
    expect(table.constraints).toHaveLength(5);
    expect(table.indexes).toHaveLength(14);
    expect(table.triggers).toHaveLength(8);
    const evidence = JSON.parse(readFileSync(base + 'qualification-evidence.json', 'utf8'));
    expect(evidence.qualification).toBe('passed');
    expect(evidence.plan_count).toBe(24);
    expect(evidence.cases).toContain(
      'real_CCI_old_RR_snapshot_and_concurrent_FK_writer_complete_without_source_mutation'
    );
    expect(evidence.cases).toContain(
      'actual_atomic_history_template_failure_retains_VALID_prefix_without_history'
    );
    expect(evidence.cases).toContain(
      'INVALID_prefix_is_not_repaired_by_IF_NOT_EXISTS_and_cannot_record_history'
    );
    expect(evidence.cases).toContain('after_full_FOR_wrong_event_receipt_bags_all3_modes');
  });
  it('runs the actual PG17 qualification once in the required accounting aggregate and retains evidence', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const steps = ci.jobs.accounting_postgres.steps;
    const matching = steps.filter((step: { run?: string }) =>
      step.run?.includes('python3 -B scripts/ci/test-tournament-source-identity-cover-postgres.py')
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].if).toBe('matrix.shard == 2');
    expect(
      steps.some((step: { with?: { path?: string } }) =>
        step.with?.path?.includes('tournament-source-identity-cover.json')
      )
    ).toBe(true);
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
  });
});
