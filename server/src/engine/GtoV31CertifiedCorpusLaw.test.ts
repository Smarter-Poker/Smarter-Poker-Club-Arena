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
const RAISE_LINE_PROOF = read(
  'supabase/migrations/20260908201302_the_solver_raise_bucket_uses_the_raisers_call.sql'
);
const RANK_HOLDOUT = read(
  'supabase/migrations/20260908201749_the_solver_holdout_must_change_board_ranks.sql'
);
const CANONICAL_IDENTITY = read(
  'supabase/migrations/20260908203000_certified_solver_identity_text_is_canonical.sql'
);
const EVALUATION_EXECUTION = read(
  'supabase/migrations/20260909022146_certified_solver_evaluation_executes_sampled_action.sql'
);
const PROMOTION_PROVENANCE = read(
  'supabase/migrations/20260909024950_candidate_promotion_rechecks_execution_provenance.sql'
);
const RELEASE_SERIALIZATION = read(
  'supabase/migrations/20260909025949_solver_release_gate_is_serialized.sql'
);
const INPUT_BOOTSTRAP = read(
  'supabase/migrations/20260909063025_the_v31_input_bundle_can_bootstrap.sql'
);
const INPUT_CANONICAL_TYPES = read(
  'supabase/migrations/20260909071759_v31_input_identity_requires_json_strings.sql'
);
const TWO_HOLE_SUIT_KEY = read(
  'supabase/migrations/20260909165541_v31_hand_keys_bind_both_hole_card_suits.sql'
);
const POSSIBLE_DECK_KEY = read(
  'supabase/migrations/20260909170039_v31_hand_keys_reject_impossible_decks.sql'
);
const STREET_BOUND_KEY = read(
  'supabase/migrations/20260909170749_v31_hand_key_counts_match_street.sql'
);
const CANONICAL_POLICY_JSON = read(
  'supabase/migrations/20260909171644_v31_policy_json_is_canonical.sql'
);
const CANONICAL_DATASET_DECLARATION = read(
  'supabase/migrations/20260909172537_v31_dataset_and_source_integers_are_canonical.sql'
);
const CONTROL_RECEIPT_TYPES = read(
  'supabase/migrations/20260909175000_v31_control_receipts_use_exact_json_types.sql'
);
const V31_AGREEMENT = read(
  'supabase/migrations/20260909180000_v31_agreement_receipts_bind_the_runtime_cell.sql'
);
const STORE = read('server/src/engine/GtoPostflopV31.ts');
const LOGIC = read('server/src/engine/HorseLogic.ts');
const AGREEMENT_SCORER = read('server/src/benchmark/HorseSolverAgreementV31.ts');
const LEAGUE = read('server/src/benchmark/HorseLeague.ts');
const LOADER = read('server/src/services/GtoPostflopV31Loader.ts');
const EVALUATOR = read('server/src/scripts/gtoV31Evaluate.ts');
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

  it('constructs the immutable bundle identity before the final manifest is approved', () => {
    expect(INPUT_BOOTSTRAP).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_input_bundle_checksum(p_bundle jsonb)'
    );
    expect(INPUT_BOOTSTRAP).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_input_bundle_id(p_bundle_checksum text)'
    );
    expect(INPUT_BOOTSTRAP).toContain("WHERE value->>'kind' <> 'scenario_manifest'");
    expect(INPUT_BOOTSTRAP).toContain(
      "'contract','smarter-poker.horse-solver-v31-input-bundle.v2'"
    );
    expect(INPUT_BOOTSTRAP).toContain(
      'input_bundle_id,bundle_key,bundle_checksum,range_bundle_checksum'
    );
    expect(INPUT_BOOTSTRAP).toContain('gto_v31_input_bundles_deterministic_id_chk');
    expect(INPUT_BOOTSTRAP).not.toContain(
      'v_checksum := public.fn_gto_v31_json_checksum(p_bundle)'
    );
    expect(INPUT_CANONICAL_TYPES).toContain(
      "jsonb_typeof(p_bundle->'bundle_version') IS DISTINCT FROM 'string'"
    );
    expect(INPUT_CANONICAL_TYPES).toContain(
      "jsonb_typeof(v_file->'checksum') IS DISTINCT FROM 'string'"
    );
    expect(INPUT_CANONICAL_TYPES).toContain("LIKE '%//%'");
    expect(INPUT_CANONICAL_TYPES).toContain("LIKE '%/./%'");
    expect(INPUT_CANONICAL_TYPES).toContain('CALLED ON NULL INPUT');
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

  it('classifies a raise from the raiser pot-after-call and latest hero aggression', () => {
    expect(RAISE_LINE_PROOF).toContain(
      'v_last_raise_pot_after_call:=v_pot+(v_current_target-v_contributions[v_actor+1])'
    );
    expect(RAISE_LINE_PROOF).toContain(
      'v_fraction:=(v_last_target-v_last_prior_target)/v_last_raise_pot_after_call'
    );
    expect(RAISE_LINE_PROOF).toContain(
      'SELECT max(i) INTO v_hero_aggressive FROM generate_subscripts(v_types,1) i'
    );
    expect(RAISE_LINE_PROOF).toContain("'r:0:b50:b250',NULL,100,1000");
    expect(RAISE_LINE_PROOF).toContain("'r:0:b50:b150:b300:b600',NULL,100,1000");
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

  it('rejects suit-isomorphic holdouts instead of calling them unseen boards', () => {
    expect(RANK_HOLDOUT).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_board_rank_signature(p_board text)'
    );
    expect(RANK_HOLDOUT).toContain(
      "public.fn_gto_v31_board_rank_signature(holdout.node#>>'{node_context,board}')="
    );
    expect(RANK_HOLDOUT).toContain(
      "public.fn_gto_v31_board_rank_signature(train.node#>>'{node_context,board}')"
    );
    expect(RANK_HOLDOUT).toContain('rank-disjoint train and holdout sources');
    expect(RANK_HOLDOUT).toContain("fn_gto_v31_board_rank_signature('AsKd7c') IS DISTINCT FROM");
    expect(RANK_HOLDOUT).toContain("fn_gto_v31_board_rank_signature('7hAcKd')");
    expect(RANK_HOLDOUT).toContain(
      "fn_gto_v31_board_rank_signature('AsKd7c') IS NOT DISTINCT FROM"
    );
    expect(RANK_HOLDOUT).toContain("fn_gto_v31_board_rank_signature('AhQc6d')");
  });

  it('binds every compact holding to both rank-specific hole-card suits', () => {
    expect(TWO_HOLE_SUIT_KEY).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_key_valid(p_key text)'
    );
    expect(TWO_HOLE_SUIT_KEY).toContain(
      "public.fn_gto_v31_hand_key(1321,'Qs7s2c') IS DISTINCT FROM 'AKo:20'"
    );
    expect(TWO_HOLE_SUIT_KEY).toContain(
      "public.fn_gto_v31_hand_key(1272,'Qs7s2c') IS DISTINCT FROM 'AKo:02'"
    );
    expect(TWO_HOLE_SUIT_KEY).toContain(
      "public.fn_gto_v31_hand_key(1172,'Qs7s2c3c') IS DISTINCT FROM 'AKs:22'"
    );
    expect(TWO_HOLE_SUIT_KEY).toContain(
      'cannot change the V31 hand-key contract while certified datasets exist'
    );
    expect(TWO_HOLE_SUIT_KEY).toContain('IF NOT public.fn_gto_v31_hand_key_valid(v_hand.key)');
    expect(STORE).toContain('/^([AKQJT98765432])([AKQJT98765432])([so]?):([0-5])([0-5])$/');
    expect(STORE).not.toContain('export function boardFlushSuit');
    expect(POSSIBLE_DECK_KEY).toContain("public.fn_gto_v31_hand_key(1321,'QsQs2c') IS NOT NULL");
    expect(POSSIBLE_DECK_KEY).toContain("public.fn_gto_v31_hand_key(1321,'As7d2c') IS NOT NULL");
    expect(STREET_BOUND_KEY).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_key_valid(p_key text,p_street text)'
    );
    expect(STREET_BOUND_KEY).toContain('gto_v31_runtime_cells_hand_keys_match_street_chk');
    expect(STREET_BOUND_KEY).toContain(
      "IF NOT public.fn_gto_v31_hand_key_valid(v_hand.key,p_cell->>'street')"
    );
    expect(STREET_BOUND_KEY).toContain("public.fn_gto_v31_hand_key_valid('AKo:31','flop')");
    expect(STORE).toContain('canonicalHandKey(handKey, row.street)');
    expect(CANONICAL_POLICY_JSON).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_action_specs_valid(p_specs jsonb)'
    );
    expect(CANONICAL_POLICY_JSON).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_compact_matrices_valid('
    );
    expect(CANONICAL_POLICY_JSON).toContain('gto_v31_runtime_cells_compact_matrices_valid_chk');
    expect(CANONICAL_POLICY_JSON).toContain(
      'OR NOT public.fn_gto_v31_source_node_scalar_types_valid(p_node)'
    );
    expect(STORE).toContain('spec.size_value <= 20');
    expect(STORE).toContain('row.source_rows === row.train_source_rows + row.holdout_source_rows');
    expect(CANONICAL_DATASET_DECLARATION).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_json_safe_integer('
    );
    expect(CANONICAL_DATASET_DECLARATION).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_declared_coverage_valid(p_coverage jsonb)'
    );
    expect(CANONICAL_DATASET_DECLARATION).toContain('gto_v31_datasets_declared_coverage_valid_chk');
    expect(CANONICAL_DATASET_DECLARATION).toContain('gto_v31_datasets_quality_gates_valid_chk');
    expect(CANONICAL_DATASET_DECLARATION).toContain(
      "jsonb_typeof(p_dataset->v_key) IS DISTINCT FROM 'string'"
    );
  });

  it('keeps solver and manifest identities byte-stable across attestation and provenance', () => {
    expect(CANONICAL_IDENTITY).toContain('gto_v31_datasets_solver_version_canonical_chk');
    expect(CANONICAL_IDENTITY).toContain('gto_v31_datasets_manifest_version_canonical_chk');
    expect(CANONICAL_IDENTITY).toContain("solver_version !~ '^[[:space:]]|[[:space:]]$'");
    expect(CANONICAL_IDENTITY).toContain("solver_version !~ '[[:cntrl:]]'");
    expect(CANONICAL_IDENTITY).toContain("manifest_version !~ '[[:cntrl:]]'");
  });

  it('requires eight bound candidate results and never accepts a silent policy', () => {
    expect(EVALUATION_EXECUTION).toContain('v_result.hands<10000');
    expect(EVALUATION_EXECUTION).toContain('v_result.candidate_policy_hits<=0');
    expect(EVALUATION_EXECUTION).toContain('v_result.candidate_execution_mismatches<>0');
    expect(EVALUATION_EXECUTION).toContain('v_result.candidate_benchmark_components');
    expect(EVALUATION_EXECUTION).toContain('v_component_duration<>v_result.duration_ms');
    expect(EVALUATION_EXECUTION).toContain('v_component_hits<>v_result.candidate_policy_hits');
    expect(EVALUATION_EXECUTION).toContain(
      'v_component_mismatches<>v_result.candidate_execution_mismatches'
    );
    expect(EVALUATION_EXECUTION).toContain('v_component_roles IS DISTINCT FROM v_result_roles');
    expect(EVALUATION_EXECUTION).toContain("'policy_only_duplicate_deals'");
    expect(EVALUATION_EXECUTION).toContain("'full_brain_duplicate_deal_league'");
    expect(CORPUS).toContain(
      "CROSS JOIN unnest(ARRAY['open','cbet','probe','delayed_cbet','barrel',"
    );
    expect(CORPUS).toContain("e.evaluation_kind='paired_replay'");
    expect(CORPUS).toContain("e.evaluation_kind='league'");
    expect(CORPUS).toContain('))<>9 THEN');
  });

  it('counts only the post-legalization action and binds every gate to one exact evaluator', () => {
    expect(LOGIC.indexOf('const final31 = this.legalize')).toBeLessThan(
      LOGIC.indexOf('opts.onGtoV31Decision({', LOGIC.indexOf('const final31 = this.legalize'))
    );
    expect(LOGIC).toContain('executedAsIntended: executedAsIntended31');
    expect(LOGIC).toContain('sampledAmount: sampledAmount31');
    expect(LOGIC).toContain('const executedAsIntended31 = gtoV31ExecutionMatches({');
    expect(LOGIC).toContain('return args.finalAction === args.sampledFamily && amountPreserved;');
    expect(LOGIC).not.toContain("action31.family === 'raise' && final31.action === 'all_in'");
    expect(LOGIC).not.toContain("action31.family === 'bet' && final31.action === 'all_in'");
    expect(EVALUATION_EXECUTION).toContain("'evaluation_contract'<>'gto_v31_candidate.v2'");
    expect(EVALUATION_EXECUTION).toContain("'evaluation_engine_commit']::text[]");
    expect(EVALUATION_EXECUTION).toContain(
      "v_result.matchup<>'gto_v31_'||p_evaluation_kind||'_'||p_game_family||'_'||v_dataset.dataset_checksum"
    );
    expect(EVALUATION_EXECUTION).toContain(
      'candidate evaluations were produced by different engine commits'
    );
    expect(EVALUATOR).toContain("['status', '--porcelain', '--untracked-files=all']");
    expect(EVALUATOR).toContain("['merge-base', '--is-ancestor', head, 'origin/main']");
    expect(EVALUATOR).toContain('`gto_v31_${args.kind}_${args.family}_${args.datasetChecksum}`');
  });

  it('rechecks execution provenance at both candidate and promotion boundaries', () => {
    expect(PROMOTION_PROVENANCE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_gto_v31_candidate_evaluations_valid('
    );
    expect(PROMOTION_PROVENANCE).toContain('CREATE TRIGGER gto_v31_evaluation_source_is_immutable');
    expect(PROMOTION_PROVENANCE).toContain('r.candidate_execution_mismatches<>0');
    expect(PROMOTION_PROVENANCE).toContain(
      "component.value->'candidate_execution_mismatches' IS DISTINCT FROM '0'::jsonb"
    );
    expect(PROMOTION_PROVENANCE).toContain(
      "r.config_a->>'evaluation_contract'<>'gto_v31_candidate.v2'"
    );
    expect(PROMOTION_PROVENANCE).toContain('v_engine_commits<>1');
    expect(PROMOTION_PROVENANCE.match(/fn_gto_v31_candidate_evaluations_valid\(/g)).toHaveLength(4);
    expect(PROMOTION_PROVENANCE).toContain('v_dataset.paired_replay IS DISTINCT FROM v_paired');
    expect(PROMOTION_PROVENANCE).toContain('v_dataset.league_gate IS DISTINCT FROM v_league');
    expect(RELEASE_SERIALIZATION).toContain('VOLATILE');
    expect(RELEASE_SERIALIZATION).toContain('pg_advisory_xact_lock(');
    expect(RELEASE_SERIALIZATION).toContain('smarter-poker:gto-v31-release-gate');
    expect(RELEASE_SERIALIZATION).toContain('fn_gto_v31_candidate_evaluations_valid(uuid,text)');
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
      'const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;'
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
    expect(V31_AGREEMENT).toContain(
      'CREATE TABLE IF NOT EXISTS public.horse_solver_agreement_v31_decisions'
    );
    expect(V31_AGREEMENT).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_v31_decision('
    );
    expect(V31_AGREEMENT).toContain('v_distribution<>v_cell.hand_matrix->');
    expect(V31_AGREEMENT).toContain(
      "v_seal->>'cell_payload_checksum'<>v_cell.cell_payload_checksum"
    );
    expect(V31_AGREEMENT).toContain('smarter-poker:gto-v31-release-gate');
    expect(V31_AGREEMENT).toContain('solver_agreement_v31_stale_dataset');
    expect(V31_AGREEMENT).toContain('solver_agreement_v31_missing_scenarios');
    expect(V31_AGREEMENT).toContain(
      'Agreement is execution/reference evidence, not exploitability'
    );
    expect(AGREEMENT_SCORER).toContain('buildGtoV31EvaluationScenarios');
    expect(AGREEMENT_SCORER).toContain('executedAsIntended ? selectedProbability : 0');
    expect(AGREEMENT_SCORER).toContain('scenarioSpots !== targetForScenario');
    expect(AGREEMENT_SCORER).toContain('decisions.length !== maxSpots');
    expect(LEAGUE).toContain("reportError(err, 'HorseLeague.agreement.v31')");
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
    expect(CONTROL_RECEIPT_TYPES).toContain(
      '(SELECT count(*) FROM jsonb_object_keys(p_heartbeat)) <> 21'
    );
    expect(CONTROL_RECEIPT_TYPES).toContain(
      '(SELECT count(*) FROM jsonb_object_keys(p_heartbeat)) <> 18'
    );
    expect(CONTROL_RECEIPT_TYPES).toContain("jsonb_typeof(p_artifact->'stack_depth')<>'number'");
    expect(CONTROL_RECEIPT_TYPES).toContain("NOT (p_specs ? 'c')");
    expect(CONTROL_RECEIPT_TYPES).toContain("v_action.key !~ '^(c|f|b[1-9][0-9]{0,78})$'");
    expect(CONTROL_RECEIPT_TYPES).toContain("'^r:0(:c|:f|:b[1-9][0-9]{0,78}|:[2-9TJQKA][cdhs])*$'");
    expect(CONTROL_RECEIPT_TYPES).toContain('s.solved_v2_at=v_solved_at');
    expect(CONTROL_RECEIPT_TYPES).toContain('v_rows_written + v_invalid <> v_rows_done');
    expect(AUDIT).toContain("'gto_v31_runtime_cells'");
    expect(AUDIT).toContain("'horse_solver_agreement_decisions'");
    expect(AUDIT).toContain("'horse_solver_agreement_v31_decisions'");
  });

  it('keeps a committed PostgreSQL 17 adversarial harness for the full release sequence', () => {
    const runner = read('scripts/ci/probes/horse-phase4-certified-solver/run-pg17.sh');
    const certified = read('scripts/ci/probes/horse-phase4-certified-solver/certified-v31.sql');
    const decisions = read('scripts/ci/probes/horse-phase4-certified-solver/solver-agreement.sql');
    const pulses = read('scripts/ci/probes/horse-phase4-certified-solver/pipeline-liveness.sql');
    const ci = read('.github/workflows/ci.yml');
    const bootstrap = read(
      'scripts/ci/probes/horse-phase4-certified-solver/input-bundle-bootstrap.sql'
    );
    expect(runner).toContain('PostgreSQL 17 or Docker is required');
    expect(ci).toContain('Certified V31 PostgreSQL 17 behavior gate');
    expect(ci).toContain('needs.changes.outputs.phase4');
    expect(V31_AGREEMENT).toContain('AND run_date=p_day');
    expect(V31_AGREEMENT).toContain('solver_agreement_v31_imbalanced_scenarios');
    expect(certified).toContain('database did not seal the checksum-less worker node');
    expect(certified).toContain('false all-in source node was accepted');
    expect(certified).toContain('semantic open-role forgery was accepted');
    expect(certified).toContain('unreconciled component duration was accepted');
    expect(certified).toContain('a legacy evaluation receipt passed the candidate gate');
    expect(certified).toContain('a changed release receipt passed the promotion gate');
    expect(certified).toContain('a certified evaluation source remained mutable');
    expect(certified).toContain('forged V31 cell seal was accepted');
    expect(certified).toContain('forged V31 regret was accepted');
    expect(certified).toContain('shared agreement drill-down did not route the V31 reference');
    expect(certified).toContain('certification status did not reconcile');
    expect(decisions).toContain('SOLVER_AGREEMENT_BEHAVIOR_OK');
    expect(pulses).toContain('LIVENESS_BEHAVIOR_OK');
    expect(bootstrap).toContain('V31_INPUT_BUNDLE_BOOTSTRAP_OK');
    expect(bootstrap).toContain(
      'database input identity does not match the cross-language fixture'
    );
  });
});
