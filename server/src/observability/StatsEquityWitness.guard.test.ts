import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(process.cwd(), '..');
const readRepo = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
const readReleaseMigration = (name: string): string => {
  const matches = readdirSync(join(repoRoot, 'supabase/migrations')).filter(
    (candidate) => candidate.endsWith(`_${name}.sql`) || candidate.endsWith(`_${name}.sql.pending`)
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one staged-or-promoted ${name} migration, found ${matches.length}`);
  }
  return readRepo(`supabase/migrations/${matches[0]}`);
};

const shape = readRepo(
  'supabase/migrations/20260908233111_all_in_equity_coverage_is_witnessed_at_runout.sql'
);
const indexGate = readReleaseMigration('stats_equity_witness_covering_index_is_ready');
const audit = readReleaseMigration('stats_witness_audit_uses_durable_runout_evidence');
const indexOps = readRepo('scripts/ops/build-stats-equity-witness-index-concurrently.sql');
const cutoverOps = readRepo('scripts/ops/set-stats-equity-witness-fleet-cutover.sql');
const runbook = readRepo('docs/runbooks/stats-equity-witness-cutover.md');
const runout = readRepo('server/src/engine/ServerTableEngineRunout.ts');
const facts = readRepo('server/src/services/supabase/handFacts.ts');
const monitor = readRepo('server/src/observability/StatsHealthMonitor.ts');

describe('all-in equity coverage is witnessed once at the runout boundary', () => {
  it('marks every canonical participant action before requesting optional worker evidence', () => {
    const handler = runout.slice(
      runout.indexOf('protected handleAllInRunout('),
      runout.indexOf(
        'protected async pacedAllInRunout(',
        runout.indexOf('protected handleAllInRunout(')
      )
    );
    expect(runout).toContain('private recordAllInRunoutObligation(');
    expect(runout).toContain('target.action.allInRunout = true');
    expect(handler.indexOf('this.recordAllInRunoutObligation(')).toBeGreaterThan(-1);
    expect(handler.indexOf('requestStandaloneEquity()')).toBeGreaterThan(
      handler.indexOf('this.recordAllInRunoutObligation(')
    );
  });

  it('materialises owed and equity from the same accepted action marker', () => {
    expect(facts).toContain('action.allInRunout === true');
    expect(facts).toContain('runoutMarker?.allInRunoutStreet ?? null');
    expect(facts).toContain('all_in_equity_owed: allInEquityOwed');
    expect(facts).toContain('all_in_equity: allInEquity');
    expect(facts).toContain('ev_returned: evReturned');
    expect(facts).not.toContain('captureAllInEquityObligation');
    expect(facts).not.toContain('takeAllInEquityObligation');
  });

  it('keeps shape, large-table index, and exact audit switch in separate stages', () => {
    expect(shape).toContain('ADD COLUMN IF NOT EXISTS all_in_equity_owed');
    expect(shape).not.toContain('CREATE INDEX CONCURRENTLY');
    expect(shape).not.toContain('CREATE OR REPLACE FUNCTION public.ca_stats_witness_audit');
    expect(indexOps).toContain('CREATE INDEX CONCURRENTLY idx_ca_hand_facts_equity_owed_played_at');
    expect(indexGate).toContain('ALL_IN_EQUITY_WITNESS_CONCURRENT_INDEX_REQUIRED');
    expect(indexGate).toContain('i.indisvalid');
    expect(indexGate).toContain('i.indisready');
    expect(indexGate).toContain('pg_get_expr(i.indpred, i.indrelid, false) =');
    expect(indexOps).toContain('pg_get_expr(i.indpred, i.indrelid, false) IS DISTINCT FROM');
    expect(audit).toContain("v_old_hash constant text := '3b3b9610697ea648ee94808ff7ca91b7'");
    expect(audit).toContain('ALL_IN_EQUITY_WITNESS_SOURCE_DRIFT');
    expect(audit).toContain('all_in_equity_owed IS TRUE');
    expect(audit).not.toContain('jsonb_array_elements(h.actions)');
  });

  it('uses an immutable operator-stamped fleet boundary, never the first TRUE row', () => {
    expect(audit).toContain('CREATE TABLE IF NOT EXISTS public.ca_stats_equity_witness_cutover');
    expect(audit).toContain('trg_ca_stats_equity_witness_cutover_immutable');
    expect(audit).toContain("CHECK (writer_sha ~ '^[0-9a-f]{40}$')");
    expect(audit).toContain("'writerCutoverAt', writer_cutover_at");
    expect(audit).toContain("'latestAuditAt', latest_audit_at");
    expect(audit).toContain("'windowLabel', window_label");
    expect(audit).toContain('a.latest_audit_at >= greatest(');
    expect(audit).toContain('c.recorded_at');
    expect(audit).not.toContain('ORDER BY f.played_at ASC');
    expect(cutoverOps).toContain("current_setting('ca.stats_equity_writer_sha')");
    expect(cutoverOps).toContain('ON CONFLICT (id) DO NOTHING');
    expect(cutoverOps).toContain('ALL_IN_EQUITY_WITNESS_CUTOVER_CONFLICT');
  });

  it('publishes readiness through the one health RPC and gates 7d metrics and alerts', () => {
    expect(audit).toContain("'equityWitnessReadiness', (SELECT value FROM equity_readiness)");
    expect(monitor).toContain('const equityReadiness = obj(r.equityWitnessReadiness)');
    expect(monitor).toContain('equityReadiness?.windowReady === true');
    expect(monitor).toContain("'poker_stats_ev_coverage_window_ready'");
    expect(monitor).toContain("'poker_stats_ev_coverage_window_seconds'");
    expect(monitor).toContain('if (readiness?.windowReady !== true) return');
  });

  it('recovers a failed concurrent build and documents the only valid staged order', () => {
    expect(indexOps).toContain(
      "SELECT pg_advisory_lock(hashtextextended('ca:stats-equity-witness-index', 0))"
    );
    expect(indexOps).toContain(
      'DROP INDEX CONCURRENTLY public.idx_ca_hand_facts_equity_owed_played_at'
    );
    expect(indexOps).not.toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(indexGate).toContain('DROP INDEX public.idx_ca_hand_facts_equity_owed_played_at');
    expect(runbook).toContain('Required order');
    expect(runbook.indexOf('2. Apply `20260908233111')).toBeLessThan(
      runbook.indexOf('4. From one direct PostgreSQL 17')
    );
    expect(runbook.indexOf('4. From one direct PostgreSQL 17')).toBeLessThan(
      runbook.indexOf('5. Apply the staged')
    );
    expect(runbook).toContain('ledger-assigned versions');
    expect(runbook).toContain('resubmit the shape migration in this cutover');
    expect(runbook).not.toContain('Supabase CLI-only fallback');
  });
});
