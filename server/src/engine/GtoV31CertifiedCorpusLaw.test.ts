/**
 * LAW: V31 IS A CERTIFIED CORPUS, NOT A LABEL (Phase 4, 2026-09-08).
 *
 * These source-level pins complement the PostgreSQL 17 behavior harness under
 * scripts/ci/probes/horse-phase4-certified-solver. They stop later migrations
 * or runtime refactors from quietly restoring a caller-authored compact cell,
 * mixing a candidate into the live store, or dropping one of the release and
 * liveness gates that makes "certified" mean something.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const CORPUS = read(
  'supabase/migrations/20260908181657_the_horse_reads_only_a_certified_solver_dataset.sql'
);
const AGREEMENT = read(
  'supabase/migrations/20260908181714_the_solver_score_keeps_every_decision_receipt.sql'
);
const LIVENESS = read(
  'supabase/migrations/20260908181724_both_solver_hosts_and_the_compactor_leave_receipts.sql'
);
const STORE = read('server/src/engine/GtoPostflopV31.ts');
const LOADER = read('server/src/services/GtoPostflopV31Loader.ts');
const AUDIT = read('server/src/engine/HorseDataLedger.ts');

describe('the certified V31 release boundary', () => {
  it('lets PostgreSQL derive cells, checksums, heldout scores and verdicts', () => {
    expect(CORPUS).toContain('CREATE OR REPLACE FUNCTION public.fn_gto_v31_build_cell(');
    expect(CORPUS).toContain('CREATE OR REPLACE FUNCTION public.fn_gto_v31_heldout_metrics(');
    expect(CORPUS).toContain('CREATE OR REPLACE FUNCTION public.fn_gto_v31_record_evaluation(');
    expect(CORPUS).toContain('CREATE OR REPLACE FUNCTION public.fn_gto_v31_worker_contract(');
    expect(CORPUS).toContain('pipeline_bundle_checksum');
    expect(CORPUS).toContain('DROP FUNCTION IF EXISTS public.fn_gto_v31_put_cells(uuid,jsonb);');
    expect(CORPUS).toContain(
      'DROP FUNCTION IF EXISTS public.fn_gto_v31_put_source_receipts(uuid,jsonb);'
    );
    expect(CORPUS).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_gto_v31_put_(?:cells|source_receipts)/
    );
    expect(CORPUS).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_gto_v31_mark_candidate\([^)]*,/
    );
  });

  it('requires every Phase 4 family, street, utility and genuine node role', () => {
    for (const family of ['cash', 'spin', 'tourney_ev', 'tourney_icm']) {
      expect(CORPUS, family).toContain(`'${family}'`);
    }
    for (const street of ['flop', 'turn', 'river']) {
      expect(CORPUS, street).toContain(`street='${street}'`);
    }
    for (const utility of [
      'cash_ev',
      'chip_ev',
      'spin_ladder',
      'satellite',
      'bubble',
      'final_table',
      'in_money',
      'ladder',
    ]) {
      expect(CORPUS, utility).toContain(`'${utility}'`);
    }
    for (const role of [
      'open',
      'cbet',
      'probe',
      'delayed_cbet',
      'barrel',
      'facing_bet',
      'facing_raise',
      'check_raise',
      'bet_raise',
      'all_in',
    ]) {
      expect(CORPUS, role).toContain(`'${role}'`);
    }
    expect(CORPUS).toContain('facing_target_chips');
    expect(CORPUS).toContain('facing_actor_total_chips');
    expect(CORPUS).toContain('CREATE OR REPLACE FUNCTION public.fn_gto_v31_node_line_proof(');
    expect(CORPUS).toContain("'derived_node_role',v_role");
    expect(CORPUS).toContain('v_line_role<>v_role');
    expect(CORPUS).toContain("f.value->>'kind'='scenario_manifest'");
    expect(CORPUS).toContain(
      "v_node#>>'{line_proof,manifest_checksum}' IS DISTINCT FROM v_dataset.manifest_checksum"
    );
    expect(CORPUS).toContain('v_facing_target <> substring(v_last_token FROM 2)::numeric');
    expect(CORPUS).toContain("v_role='all_in' AND v_facing_target<>v_facing_actor_total");
    expect(CORPUS).toContain("CROSS JOIN unnest(ARRAY['flop','turn','river'])");
  });

  it('computes the canonical node checksum in the database when a worker omits it', () => {
    expect(CORPUS).toContain("v_normalized_nodes jsonb := '[]'::jsonb");
    expect(CORPUS).toContain("AND NOT (v_node?'node_checksum')");
    expect(CORPUS).toContain("'node_checksum',public.fn_gto_v31_node_checksum(v_node)");
    expect(CORPUS).toContain("v_matrix:=jsonb_set(v_matrix,'{nodes}',v_normalized_nodes,false);");
  });

  it('scores an independent holdout globally and for every family before evaluation', () => {
    expect(CORPUS).toContain(
      "FOREACH v_family IN ARRAY ARRAY['cash','spin','tourney_ev','tourney_icm'] LOOP"
    );
    expect(CORPUS).toContain('source_frequency-compact_frequency');
    expect(CORPUS).toContain('source_size-compact_size');
    expect(CORPUS).toContain('source_policy_ev-compact_policy_ev');
    expect(CORPUS).toContain('best_action_ev-compact_mixed_ev');
    expect(CORPUS).toContain("'by_family',v_by_family");
    expect(CORPUS).toContain("CASE WHEN a.machine_id='M2' THEN 'holdout' ELSE 'train' END");
    expect(CORPUS).toContain('v_machine_variants<>2');
    expect(CORPUS).toContain("state=CASE WHEN v_pass THEN 'evaluating' ELSE 'rejected' END");
  });

  it('requires eight bound candidate results and never accepts a silent policy', () => {
    expect(CORPUS).toContain('v_result.hands<10000');
    expect(CORPUS).toContain('v_result.candidate_policy_hits<=0');
    expect(CORPUS).toContain('v_result.candidate_benchmark_components');
    expect(CORPUS).toContain('v_component_duration<>v_result.duration_ms');
    expect(CORPUS).toContain('v_component_hits<>v_result.candidate_policy_hits');
    expect(CORPUS).toContain('v_component_roles IS DISTINCT FROM v_result_roles');
    expect(CORPUS).toContain("'policy_only_duplicate_deals'");
    expect(CORPUS).toContain("'full_brain_duplicate_deal_league'");
    expect(CORPUS).toContain(
      "CROSS JOIN unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel',"
    );
    expect(CORPUS).toContain("e.evaluation_kind='paired_replay'");
    expect(CORPUS).toContain("e.evaluation_kind='league'");
    expect(CORPUS).toContain('))<>9 THEN');
  });
});

describe('candidate and active policy stay physically separate', () => {
  it('uses exact-checksum evaluation storage instead of swapping the active store', () => {
    expect(STORE).toContain('const activeStore: Store = makeStore();');
    expect(STORE).toContain('const evaluationStores = new Map<string, Store>();');
    expect(STORE).toContain('replaceGtoPostflopV31Evaluation');
    expect(STORE).toContain('evaluationStores.get(input.datasetChecksum)');
    expect(LOADER).toContain("supabase.rpc('fn_gto_v31_evaluation_cells'");
    expect(LOADER).toContain('replaceGtoPostflopV31Evaluation(rows);');
    expect(LOADER).toContain(
      'const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;'
    );
  });
});

describe('agreement and liveness are daily evidence', () => {
  it('persists decision-level state, distribution, regret and source seals', () => {
    for (const field of [
      'decision_state',
      'final_action',
      'reference_distribution',
      'action_regret_bb',
      'source_artifact_checksum',
      'eligible_spots',
      'reconciled_spots',
    ]) {
      expect(AGREEMENT, field).toContain(field);
    }
    expect(AGREEMENT).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_decision('
    );
    expect(AGREEMENT).toContain(
      'CREATE OR REPLACE FUNCTION public.ca_horse_solver_agreement_decisions('
    );
  });

  it('requires independent M1, M2 and compactor receipts and splices every audit', () => {
    expect(LIVENESS).toContain("machine_id IN ('M1','M2')");
    expect(LIVENESS).toContain('CREATE TABLE IF NOT EXISTS public.solver_ingress_nonces');
    expect(LIVENESS).toContain('CREATE OR REPLACE FUNCTION public.fn_solver_ingress_claim(');
    expect(LIVENESS).toContain('solver ingress nonce was replayed');
    expect(LIVENESS).toContain('solver_worker_stalled');
    expect(LIVENESS).toContain('solver_worker_provenance_split');
    expect(LIVENESS).toContain('solver_compactor_unhealthy');
    expect(LIVENESS).toContain('ca_gto_v31_certification_status');
    expect(LIVENESS).toContain('fn_audit_solver_agreement(p_day)');
    expect(LIVENESS).toContain('fn_audit_gto_v31_certified(p_day)');
    expect(LIVENESS).toContain('fn_audit_solver_pipeline_liveness(p_day)');
    expect(AUDIT).toContain("'gto_v31_runtime_cells'");
    expect(AUDIT).toContain("'horse_solver_agreement_decisions'");
  });

  it('keeps a committed PostgreSQL 17 adversarial harness for the full release sequence', () => {
    const runner = read('scripts/ci/probes/horse-phase4-certified-solver/run-pg17.sh');
    const certified = read('scripts/ci/probes/horse-phase4-certified-solver/certified-v31.sql');
    const decisions = read('scripts/ci/probes/horse-phase4-certified-solver/solver-agreement.sql');
    const pulses = read('scripts/ci/probes/horse-phase4-certified-solver/pipeline-liveness.sql');
    expect(runner).toContain('PostgreSQL 17 is required');
    expect(certified).toContain('database did not seal the checksum-less worker node');
    expect(certified).toContain('false all-in source node was accepted');
    expect(certified).toContain('semantic open-role forgery was accepted');
    expect(certified).toContain('unreconciled component duration was accepted');
    expect(certified).toContain('certification status did not reconcile');
    expect(decisions).toContain('SOLVER_AGREEMENT_BEHAVIOR_OK');
    expect(pulses).toContain('LIVENESS_BEHAVIOR_OK');
  });
});
