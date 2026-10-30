import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { declaredFunctions } from '../scripts/ci/check-definer-authorization.mjs';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const read = (p: string) => readFileSync(p, 'utf8');
const sql = read(
  'supabase/migrations/20261029190331_original_cash_link_union_expression_has_real_statistics.sql'
);
describe('original linked cash collects genuine union expression statistics', () => {
  it('creates only one expression object and one bounded ANALYZE, preserving source and schema', () => {
    expect(declaredFunctions(sql)).toHaveLength(0);
    expect(splitConcurrentPreamble(sql).indexes).toHaveLength(0);
    expect(sql.match(/^CREATE STATISTICS /gm)).toHaveLength(1);
    expect(sql).toContain(
      "ON ((game_scope->>'game_union_id')) FROM public.union_pnl_cash_outcome_link_resolutions"
    );
    expect(
      sql.match(/^ANALYZE public\.union_pnl_cash_outcome_link_resolutions \(game_scope\);/gm)
    ).toHaveLength(1);
    expect(sql).toContain("statement_timeout='15s'");
    expect(sql).toContain("transaction_timeout='60s'");
    expect(sql).toContain("lock_timeout='1s'");
    expect(sql.match(/^SET LOCAL default_statistics_target='10';/gm)).toHaveLength(1);
    expect(sql).toContain('linked_union_statistics_inherited_sample_target_required');
    expect(sql).not.toMatch(/ALTER\s+(?:TABLE|STATISTICS|INDEX).*SET\s+STATISTICS/i);
    expect(sql).toContain("qualified->'schema_metadata'");
    expect(sql).toContain("qualified->'function_authorities'");
    expect(sql).toContain("qualified->'raw_triggers'");
    expect(sql).toContain('linked_union_statistics_installed_selector_changed');
    expect(sql).toContain('linked_union_statistics_real_expression_distribution_required');
    expect(sql).not.toMatch(
      /^\s*(?:UPDATE|DELETE|ALTER TABLE|CREATE INDEX|CREATE OR REPLACE FUNCTION|SET plan_cache_mode)/im
    );
  });
  it('binds exact maintained source and directly executes native causal/atomic controls', () => {
    const binding = JSON.parse(
      read('scripts/ci/fixtures/original-linked-cash-statistics/source-binding.json')
    );
    for (const [path, hash] of Object.entries(binding.source_sha256))
      expect(createHash('sha256').update(read(path)).digest('hex'), path).toBe(hash);
    expect(read('scripts/ci/test_launch_reset_floor.py')).toContain(
      "'test-original-linked-cash-statistics-postgres.py'"
    );
    const runner = read('scripts/ci/test-original-linked-cash-statistics-postgres.py');
    for (const proof of [
      'ordinary_analyze_partial_index_stats_leave_union_default_selectivity',
      'single_expression_stats_correct_custom_union_estimate_to_sampled_majority',
      'post_failure_atomic_rollback_no_orphan_statistics',
      'history_replay_refuses',
    ])
      expect(runner).toContain(proof);
  });
});
