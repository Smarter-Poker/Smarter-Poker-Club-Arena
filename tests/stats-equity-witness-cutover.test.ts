import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readReleaseMigration = (name: string) => {
  const matches = readdirSync(resolve(root, 'supabase/migrations')).filter(
    (candidate) => candidate.endsWith(`_${name}.sql`) || candidate.endsWith(`_${name}.sql.pending`)
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one staged-or-promoted ${name} migration, found ${matches.length}`);
  }
  return read(`supabase/migrations/${matches[0]}`);
};
const shape = read(
  'supabase/migrations/20260908233111_all_in_equity_coverage_is_witnessed_at_runout.sql'
);
const index = read('scripts/ops/build-stats-equity-witness-index-concurrently.sql');
const stamp = read('scripts/ops/set-stats-equity-witness-fleet-cutover.sql');
const runbook = read('docs/runbooks/stats-equity-witness-cutover.md');
const indexGate = readReleaseMigration('stats_equity_witness_covering_index_is_ready');
const audit = readReleaseMigration('stats_witness_audit_uses_durable_runout_evidence');
const probe = read('scripts/dev/probe-stats-equity-witness-pg17.sh');
const runout = read('server/src/engine/ServerTableEngineRunout.ts');
const facts = read('server/src/services/supabase/handFacts.ts');
const monitor = read('server/src/observability/StatsHealthMonitor.ts');

describe('durable all-in equity witness cutover', () => {
  it('keeps transactional shape DDL separate from the concurrent production index', () => {
    expect(shape).toContain('BEGIN;');
    expect(shape).toContain('COMMIT;');
    expect(shape).not.toContain('CREATE INDEX CONCURRENTLY');
    expect(shape).not.toContain('CREATE OR REPLACE FUNCTION public.ca_stats_witness_audit');
    expect(index).toContain('CREATE INDEX CONCURRENTLY idx_ca_hand_facts_equity_owed_played_at');
    expect(index).toContain(
      'DROP INDEX CONCURRENTLY public.idx_ca_hand_facts_equity_owed_played_at'
    );
    expect(index).not.toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(index).not.toMatch(/^BEGIN;/m);
    expect(index).not.toMatch(/^COMMIT;/m);
    expect(indexGate).toContain('ALL_IN_EQUITY_WITNESS_CONCURRENT_INDEX_REQUIRED');
    expect(indexGate).toContain("pg_total_relation_size('public.ca_hand_facts'::regclass)");
    expect(indexGate).toContain('v_large_table_limit constant bigint := 134217728');
    expect(indexGate).toContain('CREATE INDEX idx_ca_hand_facts_equity_owed_played_at');
    expect(indexGate).toContain('pg_get_expr(i.indpred, i.indrelid, false) =');
    expect(indexGate).toContain('i.indnkeyatts = 1');
  });

  it('switches the audit only after a valid covering index and exact source hashes', () => {
    expect(audit).toContain("v_old_hash constant text := '3b3b9610697ea648ee94808ff7ca91b7'");
    expect(audit).toMatch(/v_new_hash constant text := '[0-9a-f]{32}'/);
    expect(audit).not.toContain('00000000000000000000000000000000');
    expect(audit.indexOf('i.indisvalid')).toBeLessThan(audit.indexOf('EXECUTE v_definition'));
    expect(audit).toContain('all_in_equity_owed IS TRUE');
    expect(audit).not.toContain('jsonb_array_elements(h.actions)');
    expect(audit).toContain(
      'CREATE OR REPLACE FUNCTION public.ca_stats_equity_witness_readiness()'
    );
    expect(audit).toContain('CREATE TABLE IF NOT EXISTS public.ca_stats_equity_witness_cutover');
    expect(audit).toContain("'writerCutoverAt', writer_cutover_at");
    expect(audit).toContain("'latestAuditAt', latest_audit_at");
    expect(audit).toContain("'windowLabel', window_label");
    expect(audit).toContain('a.latest_audit_at >= greatest(');
    expect(audit).toContain('c.recorded_at');
    expect(audit).not.toContain('ORDER BY f.played_at ASC');
    expect(audit).toContain('ORDER BY f.played_at DESC');
    expect(stamp).toContain("v_sha text := current_setting('ca.stats_equity_writer_sha')");
    expect(stamp).toContain('ALL_IN_EQUITY_WITNESS_CUTOVER_CONFLICT');
    expect(monitor).toContain('if (readiness?.windowReady !== true) return');
    expect(monitor).toContain("'poker_stats_ev_coverage_window_ready'");
    expect(runbook).toContain('ledger-assigned versions');
    expect(runbook).toContain('resubmit the shape migration in this cutover');
    expect(runbook).not.toContain('Supabase CLI-only fallback');
  });

  it('carries obligation and value in the atomic action record without volatile maps', () => {
    expect(runout).toContain('target.action.allInRunout = true');
    expect(runout).toContain('target.action.allInEquity = target.equity');
    expect(runout).toContain('currentHandAllInEquityDeferredForPineapple');
    expect(facts).toContain('action.allInRunout === true');
    expect(facts).not.toContain('captureAllInEquityObligation');
    expect(facts).not.toContain('takeAllInEquityObligation');
  });

  it('rehearses the exact predecessor, all three stages, query plan, and replay on PG17', () => {
    expect(probe).toContain(
      '20260908204006_stats_witness_checks_showdown_without_money_reconstruction.sql'
    );
    expect(probe).toContain('build-stats-equity-witness-index-concurrently.sql');
    expect(probe).toContain('stats_equity_witness_covering_index_is_ready');
    expect(probe).toContain('stats_witness_audit_uses_durable_runout_evidence');
    expect(probe).toContain('resolve_staged_or_promoted_migration');
    expect(probe).toContain("old_hash\" != '3b3b9610697ea648ee94808ff7ca91b7'");
    expect(probe).toContain('idx_ca_hand_facts_equity_owed_played_at');
    expect(probe).toContain('A clean three-stage replay changed the installed audit source');
    expect(probe).toContain("SELECT public.ca_stats_equity_witness_readiness()->>'windowReady'");
    expect(probe).toContain('set-stats-equity-witness-fleet-cutover.sql');
    expect(probe).toContain('invalid concurrent index was not rebuilt');
    expect(probe).toContain('valid same-name index with a narrowed predicate was not rebuilt');
  });
});
