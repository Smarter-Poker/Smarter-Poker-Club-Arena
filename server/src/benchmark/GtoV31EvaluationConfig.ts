import type { GtoV31EvaluationFamily, GtoV31EvaluationKind } from './GtoV31CandidateEvaluation.js';
import { gtoV31PolicyContractIdentity } from '../engine/GtoPostflopV31.js';

/** Pure configuration identity shared by the evaluator and its boundary tests. */
export function evaluationConfig(args: {
  feature_contract_version?: 'rank-suit-count-v1' | 'holdem-board-relative-v2';
  policy_export_schema?: 'smarter-poker.pio-policy.v4';
  datasetChecksum: string;
  kind: GtoV31EvaluationKind;
  family: GtoV31EvaluationFamily;
  scenarios: string[];
  engineCommit: string;
}) {
  return {
    ...gtoV31PolicyContractIdentity(args),
    ...(args.feature_contract_version !== undefined
      ? { feature_contract_version: args.feature_contract_version }
      : {}),
    evaluation_contract: 'gto_v31_candidate.v2',
    evaluation_kind: args.kind,
    game_family: args.family,
    dataset_checksum: args.datasetChecksum,
    candidate: 'v31_certified',
    evaluation_profile:
      args.kind === 'paired_replay'
        ? 'policy_only_duplicate_deals'
        : 'full_brain_duplicate_deal_league',
    scenarios: args.scenarios,
    evaluation_engine_commit: args.engineCommit,
  };
}
