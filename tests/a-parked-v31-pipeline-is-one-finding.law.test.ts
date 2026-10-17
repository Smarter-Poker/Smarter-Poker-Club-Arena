import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Since 2026-10-07 the daily horse audit raised three criticals for one
 * standing fact: the V31 pilot finished (M1 and M2 report 'completed'), the
 * compactor refused to certify 8 cells, and the licensed solver hosts were
 * switched off. Dan, 2026-10-16: fix the alarm, do not launch a solve.
 * fn_audit_solver_pipeline_liveness now reports that state as one warn,
 * solver_pipeline_parked; every other state is judged as before.
 */
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20261016105000_a_parked_v31_pipeline_is_one_finding_not_three.sql'
  ),
  'utf8'
);

describe('a parked V31 pipeline is one finding, not three', () => {
  it('needs BOTH hosts completed and silent, and a compactor that stopped with them', () => {
    expect(MIGRATION).toMatch(
      /WHERE machine_id='M1'\s+AND worker_state='completed' AND received_at < now\(\)-interval '15 minutes'/
    );
    expect(MIGRATION).toMatch(
      /WHERE machine_id='M2'\s+AND worker_state='completed' AND received_at < now\(\)-interval '15 minutes'/
    );
    expect(MIGRATION).toContain("c.received_at < now()-interval '20 minutes'");
    expect(MIGRATION).toContain("+ interval '1 hour'");
  });

  it('reports it once, as a warn, with the last facts of every process', () => {
    expect(MIGRATION).toContain(
      "'severity','warn','category','gto','code','solver_pipeline_parked'"
    );
    expect(MIGRATION).toContain("'M1',jsonb_build_object('state',v_worker.worker_state");
    expect(MIGRATION).toContain("'compactor',jsonb_build_object('state',v_compact.compact_state");
  });

  it('keeps every critical for every other state', () => {
    for (const code of [
      'solver_pipeline_not_commissioned',
      'solver_worker_missing',
      'solver_worker_stale',
      'solver_worker_failed',
      'solver_worker_stalled',
      'solver_worker_provenance_split',
      'solver_compactor_missing',
      'solver_compactor_unhealthy',
      'solver_pipeline_live',
    ]) {
      expect(MIGRATION).toContain(`'${code}'`);
    }
  });

  it('checks the parked state after the never-commissioned note and before the host loop', () => {
    const notCommissioned = MIGRATION.indexOf("'solver_pipeline_not_commissioned'");
    const parked = MIGRATION.indexOf("'solver_pipeline_parked'");
    const loop = MIGRATION.indexOf("FOREACH v_machine IN ARRAY ARRAY['M1','M2'] LOOP");
    expect(notCommissioned).toBeGreaterThan(0);
    expect(parked).toBeGreaterThan(notCommissioned);
    expect(loop).toBeGreaterThan(parked);
  });

  it('is service_role only and runs in one transaction', () => {
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) TO service_role;'
    );
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
