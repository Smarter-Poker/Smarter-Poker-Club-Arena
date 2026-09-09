/**
 * Evaluate one sealed V31 dataset without activating it.
 *
 *   npm run horse:gto-v31-evaluate -- --dataset=<uuid>
 *   npm run horse:gto-v31-evaluate -- --dataset=<uuid> --promote
 *
 * The first form runs every missing paired-replay and league family, writes
 * immutable evidence, and asks PostgreSQL to mark the dataset as a candidate.
 * `--promote` additionally requests the guarded active cutover. Both database
 * functions independently recompute every gate. This script never moves real
 * chips and never runs inside the live dealer process.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  buildGtoV31EvaluationScenarios,
  runGtoV31EvaluationFamily,
  type GtoV31EvaluationFamily,
  type GtoV31EvaluationKind,
} from '../benchmark/GtoV31CandidateEvaluation.js';
import { gtoPostflopV31Dataset } from '../engine/GtoPostflopV31.js';
import {
  loadGtoPostflopV31,
  loadGtoPostflopV31Evaluation,
} from '../services/GtoPostflopV31Loader.js';
import { supabase } from '../services/supabase/client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAMILIES: GtoV31EvaluationFamily[] = ['cash', 'spin', 'tourney_ev', 'tourney_icm'];
const KINDS: GtoV31EvaluationKind[] = ['paired_replay', 'league'];
const HEX40 = /^[0-9a-f]{40}$/;

interface StatusEvaluation {
  kind: GtoV31EvaluationKind | 'heldout';
  game_family: GtoV31EvaluationFamily | 'all';
  verdict: 'win' | 'tie' | 'loss' | 'pass' | 'fail';
}

interface DatasetStatus {
  dataset_id: string;
  dataset_checksum: string;
  state: string;
  evaluations: StatusEvaluation[];
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function seedFor(
  checksum: string,
  kind: GtoV31EvaluationKind,
  family: GtoV31EvaluationFamily
): number {
  return createHash('sha256').update(`${checksum}:${kind}:${family}`).digest().readUInt32BE(0) || 1;
}

function snakeComponents(result: Awaited<ReturnType<typeof runGtoV31EvaluationFamily>>) {
  return result.benchmarkComponents.map((component) => ({
    scenario: component.scenario,
    hands: component.hands,
    bb100: component.bb100,
    stderr: component.stderr,
    duration_ms: component.durationMs,
    illegal_actions: component.illegalActions,
    truncated_streets: component.truncatedStreets,
    candidate_policy_hits: component.candidatePolicyHits,
    candidate_execution_mismatches: component.candidateExecutionMismatches,
    candidate_node_roles: component.candidateNodeRoles,
  }));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const scalar = JSON.stringify(value);
  if (scalar === undefined) throw new Error('evaluation configuration is not JSON');
  return scalar;
}

function evaluationProfile(kind: GtoV31EvaluationKind): string {
  return kind === 'paired_replay'
    ? 'policy_only_duplicate_deals'
    : 'full_brain_duplicate_deal_league';
}

function evaluationEngineCommit(): string {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!HEX40.test(head)) throw new Error('cannot prove the evaluation engine commit');
  const worktreeChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (worktreeChanges) {
    throw new Error('the evaluation checkout is not clean; commit or remove changes before gating');
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, 'origin/main'], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch {
    throw new Error('the evaluation engine commit is not published on origin/main');
  }
  const declared = process.env.GIT_COMMIT_SHA?.trim().toLowerCase();
  if (declared && (!HEX40.test(declared) || declared !== head)) {
    throw new Error(`GIT_COMMIT_SHA does not match the checked-out evaluation engine (${head})`);
  }
  return head;
}

function evaluationConfig(args: {
  datasetChecksum: string;
  kind: GtoV31EvaluationKind;
  family: GtoV31EvaluationFamily;
  scenarios: string[];
  engineCommit: string;
}) {
  return {
    evaluation_contract: 'gto_v31_candidate.v2',
    evaluation_kind: args.kind,
    game_family: args.family,
    dataset_checksum: args.datasetChecksum,
    candidate: 'v31_certified',
    evaluation_profile: evaluationProfile(args.kind),
    scenarios: args.scenarios,
    evaluation_engine_commit: args.engineCommit,
  };
}

async function certificationStatus(datasetId: string): Promise<DatasetStatus> {
  const { data, error } = await supabase.rpc('ca_gto_v31_certification_status', {
    p_dataset_id: datasetId,
  });
  if (error) throw new Error(error.message);
  const datasets = (data as { datasets?: DatasetStatus[] } | null)?.datasets;
  if (!Array.isArray(datasets) || datasets.length !== 1) {
    throw new Error('the requested V31 dataset does not exist or is not visible');
  }
  return datasets[0];
}

async function existingResult(args: {
  runDate: string;
  matchup: string;
  configA: Record<string, unknown>;
  configB: Record<string, unknown>;
}): Promise<number | null> {
  const { data, error } = await supabase
    .from('horse_league_results')
    .select(
      'id,hands,illegal_actions,truncated_streets,candidate_policy_hits,candidate_execution_mismatches,candidate_benchmark_components,config_a,config_b'
    )
    .eq('run_date', args.runDate)
    .eq('matchup', args.matchup)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as {
    id: number;
    hands: number;
    illegal_actions: number;
    truncated_streets: number;
    candidate_policy_hits: number;
    candidate_execution_mismatches: number;
    candidate_benchmark_components: unknown[];
    config_a: unknown;
    config_b: unknown;
  };
  if (
    row.hands < 10_000 ||
    row.illegal_actions !== 0 ||
    row.truncated_streets !== 0 ||
    row.candidate_policy_hits <= 0 ||
    row.candidate_execution_mismatches !== 0 ||
    !Array.isArray(row.candidate_benchmark_components) ||
    row.candidate_benchmark_components.length === 0 ||
    row.candidate_benchmark_components.some(
      (component) =>
        !component ||
        typeof component !== 'object' ||
        (component as { candidate_execution_mismatches?: unknown })
          .candidate_execution_mismatches !== 0
    ) ||
    canonicalJson(row.config_a) !== canonicalJson(args.configA) ||
    canonicalJson(row.config_b) !== canonicalJson(args.configB)
  ) {
    throw new Error(
      `existing evaluation result ${row.id} is incomplete or has different provenance; refusing to reuse it`
    );
  }
  return row.id;
}

async function persistEvaluation(args: {
  datasetId: string;
  datasetChecksum: string;
  incumbentChecksum: string;
  engineCommit: string;
  kind: GtoV31EvaluationKind;
  family: GtoV31EvaluationFamily;
}): Promise<void> {
  const runDate = new Date().toISOString().slice(0, 10);
  const matchup = `gto_v31_${args.kind}_${args.family}_${args.datasetChecksum}`;
  const scenarios = buildGtoV31EvaluationScenarios(
    args.family,
    args.kind,
    args.datasetChecksum
  ).map((scenario) => scenario.key);
  const configA = evaluationConfig({ ...args, scenarios });
  const configB = {
    incumbent_dataset_checksum: args.incumbentChecksum,
    candidate: 'incumbent',
  };
  let resultId = await existingResult({ runDate, matchup, configA, configB });
  if (resultId === null) {
    const result = await runGtoV31EvaluationFamily({
      family: args.family,
      kind: args.kind,
      datasetChecksum: args.datasetChecksum,
      runSeed: seedFor(args.datasetChecksum, args.kind, args.family),
    });
    if (
      result.hands < 10_000 ||
      result.illegalActions !== 0 ||
      result.truncatedStreets !== 0 ||
      result.candidateExecutionMismatches !== 0 ||
      result.candidatePolicyHits <= 0 ||
      result.benchmarkComponents.some(
        (component) =>
          component.candidatePolicyHits <= 0 || component.candidateExecutionMismatches !== 0
      )
    ) {
      throw new Error(
        `${args.kind}/${args.family} did not safely exercise the candidate in every context: ` +
          `hands=${result.hands} hits=${result.candidatePolicyHits} illegal=${result.illegalActions} ` +
          `truncated=${result.truncatedStreets} execution_mismatches=${result.candidateExecutionMismatches}`
      );
    }
    const { data, error } = await supabase
      .from('horse_league_results')
      .insert({
        run_date: runDate,
        matchup,
        hands: result.hands,
        bb100: result.bb100,
        stderr: result.stderr,
        config_a: configA,
        config_b: configB,
        duration_ms: result.durationMs,
        illegal_actions: result.illegalActions + result.truncatedStreets,
        truncated_streets: result.truncatedStreets,
        candidate_policy_hits: result.candidatePolicyHits,
        candidate_execution_mismatches: result.candidateExecutionMismatches,
        candidate_node_roles: result.candidateNodeRoles,
        candidate_benchmark_components: snakeComponents(result),
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new Error(`${args.kind}/${args.family} insert returned no evaluation receipt`);
    }
    resultId = Number((data as { id: number }).id);
    console.log(
      `[gto-v31-evaluate] ${args.kind}/${args.family}: ${result.bb100.toFixed(4)} bb/100 ` +
        `(se ${result.stderr.toFixed(4)}), ${result.candidatePolicyHits} candidate hits`
    );
  } else {
    console.log(
      `[gto-v31-evaluate] reusing complete result ${resultId} for ${args.kind}/${args.family}`
    );
  }

  const { error } = await supabase.rpc('fn_gto_v31_record_evaluation', {
    p_dataset_id: args.datasetId,
    p_evaluation_kind: args.kind,
    p_game_family: args.family,
    p_source_result_id: resultId,
  });
  if (error) throw new Error(error.message);
}

async function main(): Promise<void> {
  const datasetId = arg('dataset');
  if (!datasetId || !UUID.test(datasetId)) {
    throw new Error('--dataset=<uuid> is required');
  }
  const engineCommit = evaluationEngineCommit();
  await loadGtoPostflopV31();
  const incumbentChecksum = gtoPostflopV31Dataset()?.checksum ?? 'legacy_v30';
  const loaded = await loadGtoPostflopV31Evaluation(datasetId);
  let status = await certificationStatus(datasetId);
  if (status.dataset_checksum !== loaded.checksum) {
    throw new Error('candidate status and loaded cells disagree on dataset checksum');
  }
  if (!['evaluating', 'candidate'].includes(status.state)) {
    throw new Error(`dataset state ${status.state} cannot be evaluated`);
  }

  for (const kind of KINDS) {
    for (const family of FAMILIES) {
      const prior = status.evaluations.find(
        (evaluation) => evaluation.kind === kind && evaluation.game_family === family
      );
      if (prior) {
        if (prior.verdict === 'loss') {
          throw new Error(`${kind}/${family} already failed; the candidate must not be promoted`);
        }
        console.log(`[gto-v31-evaluate] ${kind}/${family}: already ${prior.verdict}`);
        continue;
      }
      await persistEvaluation({
        datasetId,
        datasetChecksum: loaded.checksum,
        incumbentChecksum,
        engineCommit,
        kind,
        family,
      });
      status = await certificationStatus(datasetId);
    }
  }

  if (status.state === 'evaluating') {
    const { error } = await supabase.rpc('fn_gto_v31_mark_candidate', {
      p_dataset_id: datasetId,
    });
    if (error) throw new Error(error.message);
    status = await certificationStatus(datasetId);
  }
  if (status.state !== 'candidate') {
    throw new Error(`all evaluation calls returned but dataset state is ${status.state}`);
  }
  console.log(`[gto-v31-evaluate] candidate gates passed for ${loaded.checksum}`);

  if (process.argv.includes('--promote')) {
    const { error } = await supabase.rpc('fn_gto_v31_promote_dataset', {
      p_dataset_id: datasetId,
    });
    if (error) throw new Error(error.message);
    console.log(`[gto-v31-evaluate] promoted ${loaded.checksum}`);
  } else {
    console.log('[gto-v31-evaluate] not activated; rerun with --promote after reviewing receipts');
  }
}

main().catch((error) => {
  console.error('[gto-v31-evaluate] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
