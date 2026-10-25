/** Explicit, bounded, unsigned review. Calls the authenticated source reader
 * and exact worker replay itself; supplied oracle/replay/qualification JSON is
 * never accepted. Window census, predeclaration custody, rollback qualification
 * and independent signing are separate gates, never inferred from this batch. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { correctiveReviewerChildEnvironment } from './reviewerEnvironment.js';
import type { CorrectiveAction } from './contract.js';
import type { HorseDecision } from '../../types.js';
import { validateHorseJournalRecord, horseJournalJson } from '../horseDecisionJournal/record.js';
import { exactReplayHorseDecisionRecord } from '../../engine/horseDecision/replay/exactReplay.js';
import {
  createRiverAcceptedOracleReader,
  type RiverAcceptedOracleRequest,
  type RiverAcceptedOracleResult,
} from './riverAcceptedOracle.js';
import { resolveKernelOriginalInput } from './kernelOriginalInput.js';
import { evidenceDigest } from './authority.js';
import {
  isAuthenticatedCorrectivePredeclaration,
  type CorrectivePredeclaration,
} from './kernelPredeclaration.js';
import { reviewCorrectiveKernelNumerics } from './kernelIndependentReview.js';
import {
  evaluateRiverDecisionModelHoldout,
  type RiverModelHoldoutPlan,
  type RiverModelHoldoutCase,
  type RiverModelHoldoutResult,
} from './riverModelHoldout.js';
import {
  buildFunctionalRiverDecision as buildOriginalRiverDecision,
  isTournamentKernelReferenceInput,
} from './kernelModel.js';
import {
  evaluateTournamentDecisionModelHoldout,
  type TournamentModelHoldoutPlan,
  type TournamentModelHoldoutCase,
  type TournamentModelHoldoutResult,
} from './tournamentModelHoldout.js';
import { reviewTournamentModelNumerics } from './tournamentIndependentReview.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  tournamentKernelObjectiveIsKnown,
  tournamentKernelDefinitionFor,
} from './kernelTournamentDefinition.js';

/** Resolve executing checkout independently of the operator plan. A deployed
 * image without this retained Git/source verification is unavailable here;
 * environment labels alone are not a substitute for exact source bytes. */
function executingReviewSource(): string | null {
  try {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const git = (args: string[]) =>
      execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 128 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: correctiveReviewerChildEnvironment('git'),
      }).trim();
    const source = git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(source)) return null;
    git([
      'ls-files',
      '--error-unmatch',
      'server/src/services/horseCorrectiveReview/kernelQualificationReview.ts',
      'server/src/scripts/horseCorrectiveKernelReview.ts',
    ]);
    git(['diff', '--quiet', '--no-ext-diff', 'HEAD', '--']);
    if (git(['ls-files', '--others', '--exclude-standard', '--', 'server/src']).length) return null;
    return source;
  } catch {
    return null;
  }
}

export const CORRECTIVE_KERNEL_REVIEW_VERSION = 'horse-corrective-kernel-evidence-review-v1';
export const CORRECTIVE_KERNEL_UNRESOLVED_GATES = Object.freeze([
  'authenticated_predeclaration',
  'complete_source_window_census',
  'qualified_rollback',
  'independently_held_signer',
] as const);
export interface CorrectiveKernelEvidenceReview {
  version: typeof CORRECTIVE_KERNEL_REVIEW_VERSION;
  status: 'reviewed_unsigned' | 'unavailable';
  reason: string;
  checkedCases: number;
  reviewDigest: string | null;
  sourceCustodyDigest: string | null;
  numericReviewDigest: string | null;
  predeclarationDigest: string | null;
  measurement: RiverModelHoldoutResult | TournamentModelHoldoutResult | null;
  requiredBeforeIssuance: readonly string[];
  qualified: false;
  completePopulation: false;
  activationAllowed: false;
}
/** In-process seams for isolated tests. Production constructs its own configured
 * reader and calls the maintained exact replay owner. No CLI/JSON can supply
 * either function, a qualified flag or a signing key. */
interface ReviewDependencies {
  runningSource: string | null;
  readOracle: (request: RiverAcceptedOracleRequest) => Promise<RiverAcceptedOracleResult>;
  replay: typeof exactReplayHorseDecisionRecord;
}
export function createCorrectiveKernelEvidenceReviewer(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies?: ReviewDependencies
): (
  plan: RiverModelHoldoutPlan | TournamentModelHoldoutPlan,
  requests: readonly RiverAcceptedOracleRequest[],
  predeclaration?: Readonly<CorrectivePredeclaration>
) => Promise<CorrectiveKernelEvidenceReview> {
  const readOracle = dependencies?.readOracle ?? createRiverAcceptedOracleReader(environment);
  const replay = dependencies?.replay ?? exactReplayHorseDecisionRecord;
  const runningSource = dependencies ? dependencies.runningSource : executingReviewSource();
  let busy = false;
  return async (plan, requests, predeclaration) => {
    let checkedCases = 0;
    let predeclarationDigest: string | null = null;
    let requiredBeforeIssuance: readonly string[] = CORRECTIVE_KERNEL_UNRESOLVED_GATES;
    const finish = (
      reason: string,
      extra: Partial<CorrectiveKernelEvidenceReview> = {}
    ): CorrectiveKernelEvidenceReview =>
      Object.freeze({
        version: CORRECTIVE_KERNEL_REVIEW_VERSION,
        status: 'unavailable',
        reason,
        checkedCases,
        reviewDigest: null,
        sourceCustodyDigest: null,
        numericReviewDigest: null,
        predeclarationDigest,
        measurement: null,
        requiredBeforeIssuance,
        qualified: false,
        completePopulation: false,
        activationAllowed: false,
        ...extra,
      });
    if (busy) return finish('review_already_running');
    if (
      !plan ||
      !/^[a-f0-9]{40}$/.test(plan.sourceRelease) ||
      !Array.isArray(requests) ||
      requests.length < 2 ||
      requests.length > 10000
    )
      return finish('review_input_bounds');
    if (
      !runningSource ||
      !/^[a-f0-9]{40}$/.test(runningSource) ||
      plan.sourceRelease !== runningSource
    )
      return finish('review_running_source_identity_unavailable');
    // Detach all asynchronous inputs once. This is bounded per record and per
    // case; serializing a whole population under the journal limit is forbidden.
    let inputs: RiverAcceptedOracleRequest[];
    let lockedPlan: RiverModelHoldoutPlan | TournamentModelHoldoutPlan;
    try {
      lockedPlan = JSON.parse(horseJournalJson(plan));
      if (predeclaration !== undefined) {
        if (
          !isAuthenticatedCorrectivePredeclaration(predeclaration) ||
          evidenceDigest(predeclaration.plan) !== evidenceDigest(lockedPlan)
        )
          return finish('review_predeclaration_refused');
        predeclarationDigest = predeclaration.custodyDigest;
        requiredBeforeIssuance = CORRECTIVE_KERNEL_UNRESOLVED_GATES.filter(
          (gate) => gate !== 'authenticated_predeclaration'
        );
      }
      let totalBytes = 0;
      inputs = requests.map((request) => {
        if (
          !request ||
          Object.keys(request).sort().join(',') !== 'handKey,input,records' ||
          !Array.isArray(request.records) ||
          request.records.length < 3 ||
          request.records.length > 256 ||
          !/^[a-f0-9]{64}$/.test(request.handKey)
        )
          throw Error();
        const inputBytes = JSON.stringify(request.input);
        if (typeof inputBytes !== 'string' || Buffer.byteLength(inputBytes) > 1024 * 1024)
          throw Error();
        totalBytes += Buffer.byteLength(inputBytes);
        const records = request.records.map((record: unknown) => {
          validateHorseJournalRecord(record);
          // The validated record body already owns the per-record ceiling;
          // its transport wrapper must not consume that same allowance twice.
          const bytes = JSON.stringify(record);
          totalBytes += Buffer.byteLength(bytes);
          if (totalBytes > 256 * 1024 * 1024) throw Error();
          return JSON.parse(bytes);
        });
        return {
          handKey: request.handKey,
          input: JSON.parse(inputBytes),
          records,
        };
      });
    } catch {
      return finish('review_input_unreadable');
    }
    busy = true;
    const source = createHash('sha256')
      .update(CORRECTIVE_KERNEL_REVIEW_VERSION + '\0')
      .update(predeclarationDigest ?? 'unverified_predeclaration');
    const rows: RiverModelHoldoutCase[] = [],
      tournamentRows: TournamentModelHoldoutCase[] = [];
    const tournament =
      'objective' in lockedPlan && tournamentKernelObjectiveIsKnown(lockedPlan.objective);
    try {
      for (const request of inputs) {
        const binding = request.input.binding;
        const decision = request.records.find(
          (record) => record.kind === 'decision' && record.sha256 === binding.decisionDigest
        );
        const execution = request.records.find(
          (record) => record.kind === 'execution' && record.sha256 === binding.executionDigest
        );
        const accepted = request.records.find(
          (record) =>
            record.kind === 'accepted_hand' && record.sha256 === binding.acceptedHandDigest
        );
        if (
          !decision ||
          !execution ||
          !accepted ||
          request.records.some(
            (record) =>
              record.handKey !== request.handKey ||
              record.sourceRelease !== lockedPlan.sourceRelease
          )
        )
          return finish('review_original_binding_refused');
        const resolved = resolveKernelOriginalInput(request.records, decision, execution, accepted);
        if (
          resolved.status !== 'resolved' ||
          evidenceDigest(resolved.binding) !== evidenceDigest(binding) ||
          horseJournalJson(resolved.original.snapshot) !==
            horseJournalJson(request.input.original.snapshot) ||
          horseJournalJson(resolved.original.readFrame) !==
            horseJournalJson(request.input.original.readFrame)
        )
          return finish('review_original_binding_refused');
        const capture = JSON.parse(decision.body);
        const planReceipts = request.records.filter(
          (record) => record.kind === 'plan_receipt' && record.turnKey === decision.turnKey
        );
        if (planReceipts.length > 1) return finish('review_ambiguous_plan_receipt');
        const replayed = await replay(decision, {
          runningSource,
          execution,
          planReceipt: planReceipts[0] ?? null,
          originalFastRecords: request.records,
        });
        if (
          replayed.outcome !== 'replayed_exact' ||
          !replayed.replayVerified ||
          replayed.recordSha256 !== decision.sha256 ||
          replayed.recordedSource !== lockedPlan.sourceRelease ||
          replayed.runningSource !== runningSource ||
          replayed.acceptance.status !== 'joined' ||
          replayed.acceptance.selectedEqualsDecision !== true ||
          replayed.acceptance.executionStatus !== 'intended' ||
          !['no_effects', 'applied'].includes(replayed.acceptance.durableEffectReceipt)
        )
          return finish('review_exact_replay_refused');
        const model = buildOriginalRiverDecision(request.input.original);
        if (model.status !== 'built') return finish('review_model_unavailable');
        const input = {
          ...request.input,
          ...model.input,
          finalRake: model.prices.finalRake,
        };
        if (tournament !== isTournamentKernelReferenceInput(input))
          return finish('review_objective_mismatch');
        const oracle = await readOracle({ ...request, input });
        if (
          oracle.status !== 'accepted_source_oracle' ||
          !/^[a-f0-9]{64}$/.test(oracle.custodyDigest) ||
          !/^[a-f0-9]{64}$/.test(oracle.oracleDigest)
        )
          return finish('review_authenticated_oracle_refused');
        const playedAt = (oracle as RiverAcceptedOracleResult & { playedAt?: unknown }).playedAt;
        if (
          typeof playedAt !== 'string' ||
          !Number.isFinite(Date.parse(playedAt)) ||
          new Date(playedAt).toISOString() !== playedAt
        )
          return finish('review_authenticated_window_time_unavailable');
        const committedAt = (oracle as RiverAcceptedOracleResult & { committedAt?: unknown })
          .committedAt;
        if (
          typeof committedAt !== 'string' ||
          !Number.isFinite(Date.parse(committedAt)) ||
          new Date(committedAt).toISOString() !== committedAt
        )
          return finish('review_authenticated_commit_time_unavailable');
        if (committedAt < lockedPlan.holdoutStartsAt || committedAt >= lockedPlan.holdoutEndsAt)
          return finish('review_commit_window_mismatch');
        const baselineDecision = capture.decision as HorseDecision;
        if (
          !baselineDecision ||
          !['fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(baselineDecision.action)
        )
          return finish('review_baseline_outside_family');
        if (tournament) {
          if (
            !('objective' in lockedPlan) ||
            oracle.oracle.objective !== lockedPlan.objective ||
            oracle.oracle.utilityUnit !== TOURNAMENT_KERNEL_UTILITY_UNIT ||
            typeof oracle.oracle.fold !== 'number' ||
            typeof oracle.oracle.call !== 'number'
          )
            return finish('review_oracle_objective_mismatch');
          tournamentRows.push({
            handKey: request.handKey,
            playedAt,
            sourceRelease: input.binding.sourceRelease,
            producerDigest: input.producerDigest,
            qualificationId: input.qualificationId,
            evidenceClass: input.evidenceClass,
            decisionDigest: input.binding.decisionDigest,
            acceptedHandDigest: input.binding.acceptedHandDigest,
            original: input.original,
            baselineDecision,
            oracle: { fold: oracle.oracle.fold, call: oracle.oracle.call },
          });
        } else {
          if (oracle.oracle.foldBb !== 0 || typeof oracle.oracle.callBb !== 'number')
            return finish('review_oracle_objective_mismatch');
          rows.push({
            handKey: request.handKey,
            playedAt,
            input,
            baselineDecision,
            baseline: {
              action: baselineDecision.action as CorrectiveAction['action'],
              amount: baselineDecision.action === 'fold' ? 0 : (baselineDecision.amount ?? 0),
            },
            oracle: { foldBb: 0, callBb: oracle.oracle.callBb },
          });
        }
        source.update('\n').update(
          evidenceDigest({
            handKey: request.handKey,
            decisionDigest: decision.sha256,
            originalBinding: resolved.binding,
            originalFastDecisionDigest: resolved.originalFastRecord.sha256,
            executionDigest: execution.sha256,
            acceptedHandDigest: accepted.sha256,
            oracleDigest: oracle.oracleDigest,
            custodyDigest: oracle.custodyDigest,
            replay: replayed,
            playedAt,
            committedAt,
          })
        );
        checkedCases++;
      }
      const numeric = tournament
        ? (() => {
            const hash = createHash('sha256').update('horse-wta-spin-numerical-batch-v1\0');
            let checkedCases = 0;
            for (const row of tournamentRows) {
              const value = reviewTournamentModelNumerics(row.original);
              if (value.status !== 'reviewed')
                return { status: 'unavailable', checkedCases, reviewDigest: null };
              hash.update('\n').update(
                evidenceDigest({
                  decision: row.decisionDigest,
                  accepted: row.acceptedHandDigest,
                  value,
                })
              );
              checkedCases++;
            }
            return {
              status: 'numerically_consistent',
              checkedCases,
              reviewDigest: hash.digest('hex'),
            };
          })()
        : reviewCorrectiveKernelNumerics(rows.map((row) => row.input));
      if (
        numeric.status !== 'numerically_consistent' ||
        numeric.checkedCases !== inputs.length ||
        !numeric.reviewDigest
      )
        return finish('review_independent_numerics_refused');
      const measurement = tournament
        ? evaluateTournamentDecisionModelHoldout(
            lockedPlan as TournamentModelHoldoutPlan,
            tournamentRows
          )
        : evaluateRiverDecisionModelHoldout(lockedPlan as RiverModelHoldoutPlan, rows);
      if (
        measurement.status !== 'measured' ||
        measurement.samples !== inputs.length ||
        !measurement.measurementDigest
      )
        return finish('review_holdout_refused');
      const sourceCustodyDigest = source.digest('hex');
      return finish('independent_issuance_gates_unavailable', {
        status: 'reviewed_unsigned',
        sourceCustodyDigest,
        numericReviewDigest: numeric.reviewDigest,
        measurement,
        reviewDigest: evidenceDigest({
          version: CORRECTIVE_KERNEL_REVIEW_VERSION,
          plan: lockedPlan,
          sourceCustodyDigest,
          numericReviewDigest: numeric.reviewDigest,
          measurementDigest: measurement.measurementDigest,
          predeclarationDigest,
        }),
      });
    } catch {
      return finish('review_dependency_unavailable');
    } finally {
      busy = false;
    }
  };
}
