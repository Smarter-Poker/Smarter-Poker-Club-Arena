/** Qualification-only issuer. Source/census/replay/numerics/holdout/rollback are
 * recomputed by their actual owners before a purpose-only signing key is read.
 * No upload, caller result flag, supplied catalog or digest can grant trust. */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { evidenceDigest } from './authority.js';
import { journalHash } from '../horseDecisionJournal/record.js';
import { correctiveReviewerChildEnvironment } from './reviewerEnvironment.js';
import { correctiveDomainKey } from './domain.js';
import {
  readCorrectivePredeclaration,
  isAuthenticatedCorrectivePredeclaration,
  type CorrectivePredeclarationRequest,
  type CashCorrectiveKernelPredeclaredPlan,
} from './kernelPredeclaration.js';
import {
  createRiverSourcePopulationReviewer,
  isVerifiedRiverSourcePopulation,
  type RiverSourcePopulation,
  riverSourceRequestsDigest,
} from './riverSourcePopulation.js';
import { createCorrectiveKernelEvidenceReviewer } from './kernelQualificationReview.js';
import {
  executeCorrectiveKernelRollback,
  isExecutedCorrectiveKernelRollback,
} from './kernelRollbackQualification.js';
import {
  correctiveKernelPolicyDigestOf,
  correctiveKernelBaselineSelectionsDigest,
} from './kernelPolicyDigest.js';
import { CORRECTIVE_KERNEL_CATALOG_VERSION } from './kernelCatalog.js';
import {
  CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA,
  TOURNAMENT_KERNEL_QUALIFICATION_SCHEMA,
} from './kernelAdmission.js';
import { kernelApprovalSigningBytes } from './kernelApproval.js';
import {
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  tournamentKernelDefinitionFor,
  tournamentKernelDefinitionForObjective,
  type TournamentKernelObjective,
} from './kernelTournamentDefinition.js';
import { TOURNAMENT_KERNEL_CATALOG_VERSION } from './kernelTournamentCatalog.js';
import { tournamentKernelApprovalSigningBytes } from './kernelTournamentApproval.js';
import {
  functionalKernelCatalogDigest,
  verifyFunctionalKernelApproval,
  validateFunctionalKernelCatalog,
  type CorrectiveFunctionalKernelCatalog,
  type CorrectiveFunctionalKernelApproval,
} from './kernelObjective.js';
import { RIVER_CORRECTION_KERNEL, RIVER_DECISION_MODEL } from './kernelDefinition.js';
import { readCurrentCorrectiveGeneration } from './kernelGenerationProvider.js';
import { checkCurrentCorrectiveIssuerControl } from './kernelIssuerControl.js';
import {
  PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256,
  PHASE14_ISSUER_SECRET_NAME,
} from './kernelIssuerTrust.js';

export const CORRECTIVE_KERNEL_ISSUER_VERSION = 'horse-corrective-kernel-issuer-v1';
const SHA = /^[a-f0-9]{40}$/,
  DIGEST = /^[a-f0-9]{64}$/;
interface ExecutingContext {
  sourceRelease: string;
  policyDigest: string;
  baselineSelectionsDigest: string;
}
function executingContext(): ExecutingContext | null {
  try {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const git = (args: string[]) =>
      execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 128 * 1024,
        env: correctiveReviewerChildEnvironment('git'),
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const sourceRelease = git(['rev-parse', 'HEAD']);
    if (!SHA.test(sourceRelease)) return null;
    git(['diff', '--quiet', '--no-ext-diff', 'HEAD', '--']);
    if (
      git([
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        'server/src',
        '.github/workflows/horse-phase14-qualification.yml',
      ])
    )
      return null;
    git([
      'ls-files',
      '--error-unmatch',
      'server/src/services/horseCorrectiveReview/kernelIssuer.ts',
      'server/src/services/horseCorrectiveReview/kernelIssuerTrust.ts',
    ]);
    const policyDigest = correctiveKernelPolicyDigestOf((path) =>
        readFileSync(join(root, 'server', path))
      ),
      baselineSelectionsDigest = correctiveKernelBaselineSelectionsDigest();
    if (!policyDigest || !DIGEST.test(policyDigest) || !DIGEST.test(baselineSelectionsDigest))
      return null;
    return { sourceRelease, policyDigest, baselineSelectionsDigest };
  } catch {
    return null;
  }
}
export function correctiveKernelProducerDigest(
  sourceRelease: string,
  policyDigest: string,
  objective?: TournamentKernelObjective
): string | null {
  if (!SHA.test(sourceRelease) || !DIGEST.test(policyDigest)) return null;
  const definition = tournamentKernelDefinitionForObjective(objective);
  if (objective !== undefined && !definition) return null;
  if (definition)
    return evidenceDigest({
      version: 'horse-river-qualified-producer-v2',
      sourceRelease,
      policyDigest,
      objective: definition.objective,
      utilityUnit: definition.utilityUnit,
      modelVersion: definition.model.version,
      kernelVersion: definition.kernel.version,
    });
  return evidenceDigest({
    version: 'horse-river-qualified-producer-v1',
    sourceRelease,
    policyDigest,
    modelVersion: RIVER_DECISION_MODEL.version,
    kernelVersion: RIVER_CORRECTION_KERNEL.version,
  });
}
/** Public plan-preparation identity from independently resolved executing
 * source bytes. This reports identity only, never qualification or approval. */
export function correctiveKernelProducerIdentity(objective?: TournamentKernelObjective):
  | (ExecutingContext & {
      producerDigest: string;
      objective?: TournamentKernelObjective;
      utilityUnit?: typeof TOURNAMENT_KERNEL_UTILITY_UNIT;
      modelVersion: string;
      kernelVersion: string;
      qualified: false;
    })
  | null {
  const definition = tournamentKernelDefinitionForObjective(objective);
  if (objective !== undefined && !definition) return null;
  const context = executingContext();
  if (!context) return null;
  const producerDigest = correctiveKernelProducerDigest(
    context.sourceRelease,
    context.policyDigest,
    objective
  );
  return producerDigest
    ? {
        ...context,
        producerDigest,
        ...(definition
          ? { objective: definition.objective, utilityUnit: definition.utilityUnit }
          : {}),
        modelVersion: definition ? definition.model.version : RIVER_DECISION_MODEL.version,
        kernelVersion: definition ? definition.kernel.version : RIVER_CORRECTION_KERNEL.version,
        qualified: false,
      }
    : null;
}
export function correctiveKernelRequestsDigest(
  requests: RiverSourcePopulation['requests']
): string {
  return riverSourceRequestsDigest(requests);
}

export type CorrectiveKernelProducerResult =
  | {
      status: 'produced_unsigned_population';
      sourceRelease: string;
      producerRequestsDigest: string;
      predeclarationDigest: string;
      acceptedHands: number;
      eligibleCases: number;
      qualified: false;
      completePopulation: false;
      activationAllowed: false;
    }
  | {
      status: 'unavailable';
      reason: string;
      diagnostics?: {
        sourceRelease: string;
        predeclarationDigest: string;
        measurement: NonNullable<
          import('./kernelQualificationReview.js').CorrectiveKernelEvidenceReview['measurement']
        >;
      };
      qualified: false;
      completePopulation: false;
      activationAllowed: false;
    };
/** The source job has no signer or key access. Its public commitment is an
 * additional handoff check; the issuer independently reacquires the source. */
export async function produceCorrectiveKernelSource(
  environment: Readonly<Record<string, string | undefined>>,
  request: CorrectivePredeclarationRequest
): Promise<CorrectiveKernelProducerResult> {
  const no = (reason: string): CorrectiveKernelProducerResult => ({
    status: 'unavailable',
    reason,
    qualified: false,
    completePopulation: false,
    activationAllowed: false,
  });
  try {
    const before = executingContext();
    if (!before) return no('producer_source_identity_unavailable');
    const declared = readCorrectivePredeclaration(request);
    if (
      declared.status !== 'authenticated_predeclaration' ||
      !isAuthenticatedCorrectivePredeclaration(declared.predeclaration)
    )
      return no('producer_predeclaration_unavailable');
    const plan = declared.predeclaration.plan;
    if (plan.objective !== undefined && !tournamentKernelDefinitionFor(plan.objective, plan.domain))
      return no('producer_objective_domain_mismatch');
    if (
      plan.sourceRelease !== before.sourceRelease ||
      plan.evidenceClass !== 'reviewed_reference' ||
      plan.producerDigest !==
        correctiveKernelProducerDigest(before.sourceRelease, before.policyDigest, plan.objective) ||
      Date.now() < Date.parse(plan.holdoutEndsAt)
    )
      return no('producer_plan_source_or_window_refused');
    const population = await createRiverSourcePopulationReviewer(environment)(
      declared.predeclaration
    );
    if (
      !isVerifiedRiverSourcePopulation(population) ||
      population.predeclarationDigest !== declared.predeclaration.custodyDigest ||
      population.planDigest !== evidenceDigest(plan) ||
      population.sourceRelease !== before.sourceRelease ||
      population.requestsDigest !== correctiveKernelRequestsDigest(population.requests)
    )
      return no('producer_complete_population_unavailable');
    const after = executingContext();
    if (!after || evidenceDigest(before) !== evidenceDigest(after))
      return no('producer_source_changed');
    return {
      status: 'produced_unsigned_population',
      sourceRelease: before.sourceRelease,
      producerRequestsDigest: population.requestsDigest,
      predeclarationDigest: declared.predeclaration.custodyDigest,
      acceptedHands: population.acceptedHands,
      eligibleCases: population.eligibleCases,
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
    };
  } catch {
    return no('producer_dependency_unavailable');
  }
}

export interface CorrectiveKernelIssueRequest {
  predeclaration: CorrectivePredeclarationRequest;
  scratchRoot: string;
  producerRequestsDigest: string;
}
export interface CorrectiveKernelQualificationFile {
  schema:
    | typeof CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA
    | typeof TOURNAMENT_KERNEL_QUALIFICATION_SCHEMA;
  catalog: CorrectiveFunctionalKernelCatalog;
  approval: {
    approval: CorrectiveFunctionalKernelApproval;
    publicKeyPem: string;
    signature: string;
  };
}
export type CorrectiveKernelIssueResult =
  | {
      status: 'issued_qualification';
      version: typeof CORRECTIVE_KERNEL_ISSUER_VERSION;
      qualification: CorrectiveKernelQualificationFile;
      trustedSignerKeySha256: string;
      qualificationSha256: string;
      producerRequestsDigest: string;
      sourcePopulationDigest: string;
      rollbackDigest: string;
      activationAllowed: false;
    }
  | {
      status: 'unavailable';
      version: typeof CORRECTIVE_KERNEL_ISSUER_VERSION;
      reason: string;
      diagnostics?: {
        sourceRelease: string;
        predeclarationDigest: string;
        measurement: NonNullable<
          import('./kernelQualificationReview.js').CorrectiveKernelEvidenceReview['measurement']
        >;
      };
      qualified: false;
      activationAllowed: false;
    };
const unavailable = (
  reason: string,
  diagnostics?: {
    sourceRelease: string;
    predeclarationDigest: string;
    measurement: NonNullable<
      import('./kernelQualificationReview.js').CorrectiveKernelEvidenceReview['measurement']
    >;
  }
): CorrectiveKernelIssueResult =>
  Object.freeze({
    status: 'unavailable',
    version: CORRECTIVE_KERNEL_ISSUER_VERSION,
    reason,
    ...(diagnostics ? { diagnostics } : {}),
    qualified: false,
    activationAllowed: false,
  });
/** No key parsing at construction or import. The secret is deliberately read
 * only after every actual evidence owner and the final source recheck pass. */
export function createCorrectiveKernelIssuer(
  environment: Readonly<Record<string, string | undefined>>
) {
  const populationReviewer = createRiverSourcePopulationReviewer(environment),
    reviewer = createCorrectiveKernelEvidenceReviewer(environment);
  let busy = false;
  return async (request: CorrectiveKernelIssueRequest): Promise<CorrectiveKernelIssueResult> => {
    if (busy) return unavailable('issuer_already_running');
    if (
      !request ||
      Object.keys(request).sort().join(',') !==
        'predeclaration,producerRequestsDigest,scratchRoot' ||
      !DIGEST.test(request.producerRequestsDigest) ||
      typeof request.scratchRoot !== 'string'
    )
      return unavailable('issuer_request_invalid');
    if (
      !PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256 ||
      !DIGEST.test(PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256)
    )
      return unavailable('issuer_public_trust_unconfigured');
    busy = true;
    try {
      const before = executingContext();
      if (!before) return unavailable('issuer_source_identity_unavailable');
      const declared = readCorrectivePredeclaration(request.predeclaration);
      if (
        declared.status !== 'authenticated_predeclaration' ||
        !isAuthenticatedCorrectivePredeclaration(declared.predeclaration)
      )
        return unavailable('issuer_predeclaration_unavailable');
      const predeclaration = declared.predeclaration,
        plan = predeclaration.plan;
      const initialGeneration = readCurrentCorrectiveGeneration(correctiveDomainKey(plan.domain));
      if (initialGeneration.status !== 'current_generation')
        return unavailable('issuer_current_generation_unknown');
      const initialControl = checkCurrentCorrectiveIssuerControl(initialGeneration.receipt.mainSha);
      if (!initialControl) return unavailable('issuer_current_control_mismatch');
      if (
        plan.sourceRelease !== before.sourceRelease ||
        plan.evidenceClass !== 'reviewed_reference' ||
        plan.producerDigest !==
          correctiveKernelProducerDigest(
            before.sourceRelease,
            before.policyDigest,
            plan.objective
          ) ||
        Date.now() < Date.parse(plan.holdoutEndsAt)
      )
        return unavailable('issuer_plan_source_or_window_refused');
      const population = await populationReviewer(predeclaration);
      if (
        !isVerifiedRiverSourcePopulation(population) ||
        population.sourceRelease !== before.sourceRelease ||
        population.predeclarationDigest !== predeclaration.custodyDigest ||
        population.planDigest !== evidenceDigest(plan) ||
        population.requestsDigest !== request.producerRequestsDigest ||
        population.requestsDigest !== correctiveKernelRequestsDigest(population.requests) ||
        population.eligibleCases !== population.requests.length ||
        population.requests.some(
          (row) => evidenceDigest(row.input.domain) !== evidenceDigest(plan.domain)
        )
      )
        return unavailable('issuer_complete_population_unavailable');
      const review = await reviewer(plan, population.requests, predeclaration);
      const measurement = review.measurement;
      const tournamentDefinition = tournamentKernelDefinitionFor(plan.objective, plan.domain);
      if (plan.objective !== undefined && !tournamentDefinition)
        return unavailable('issuer_objective_domain_mismatch');
      const tournament = tournamentDefinition !== null;
      // The authenticated plan chooses units; a measurement cannot choose its
      // own branch or carry both BB and share fields into signing.
      const gains =
        measurement && measurement.status === 'measured'
          ? tournament
            ? 'objective' in measurement &&
              measurement.objective === tournamentDefinition!.objective &&
              measurement.utilityUnit === TOURNAMENT_KERNEL_UTILITY_UNIT &&
              'meanGain' in measurement &&
              !('meanGainBb' in measurement) &&
              'maximumAbsoluteDelta' in plan &&
              plan.maximumAbsoluteDelta === tournamentDefinition!.kernel.conditionalProbability
              ? { mean: measurement.meanGain, lower: measurement.lowerGain }
              : null
            : !('objective' in measurement) &&
                'meanGainBb' in measurement &&
                !('meanGain' in measurement)
              ? { mean: measurement.meanGainBb, lower: measurement.lowerGainBb }
              : null
          : null;
      if (
        review.status !== 'reviewed_unsigned' ||
        [...review.requiredBeforeIssuance].sort().join(',') !==
          'complete_source_window_census,independently_held_signer,qualified_rollback' ||
        review.checkedCases !== population.requests.length ||
        review.predeclarationDigest !== predeclaration.custodyDigest ||
        !review.reviewDigest ||
        !review.sourceCustodyDigest ||
        !review.numericReviewDigest ||
        !measurement ||
        measurement.status !== 'measured' ||
        measurement.samples !== population.requests.length ||
        !measurement.measurementDigest ||
        measurement.changed < 1 ||
        measurement.modelVersion !==
          (tournament ? tournamentDefinition!.model.version : RIVER_DECISION_MODEL.version) ||
        measurement.policyVersion !==
          (tournament ? tournamentDefinition!.kernel.version : RIVER_CORRECTION_KERNEL.version) ||
        !gains ||
        gains.lower === null ||
        gains.mean === null ||
        !Number.isFinite(gains.lower) ||
        !Number.isFinite(gains.mean) ||
        gains.lower <= 0
      )
        return unavailable(
          'issuer_independent_holdout_not_qualified',
          measurement && review.status === 'reviewed_unsigned'
            ? {
                sourceRelease: before.sourceRelease,
                predeclarationDigest: predeclaration.custodyDigest,
                measurement,
              }
            : undefined
        );
      const rollback = executeCorrectiveKernelRollback(before, request.scratchRoot);
      if (
        rollback.status !== 'verified_rollback_mechanism' ||
        !isExecutedCorrectiveKernelRollback(rollback.evidence, before) ||
        rollback.evidence.effectsScope !== 'fold-call-reference-plans-retired' ||
        rollback.evidence.replayScope !== 'exact-worker-answer-and-withdrawn-controller-join'
      )
        return unavailable('issuer_rollback_unavailable');
      const after = executingContext();
      if (!after || evidenceDigest(before) !== evidenceDigest(after))
        return unavailable('issuer_source_changed_during_review');
      const nowMs = Date.now(),
        issuedAt = new Date(nowMs).toISOString(),
        expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
      const domain = correctiveDomainKey(plan.domain);
      const generationRead = readCurrentCorrectiveGeneration(domain);
      if (generationRead.status !== 'current_generation')
        return unavailable('issuer_current_generation_unknown');
      const generationReceipt = generationRead.receipt;
      const finalControl = checkCurrentCorrectiveIssuerControl(generationReceipt.mainSha);
      if (!finalControl || finalControl.fingerprint !== initialControl.fingerprint)
        return unavailable('issuer_current_control_changed');
      if (generationReceipt.ledgerSha256 !== initialGeneration.receipt.ledgerSha256)
        return unavailable('issuer_generation_advanced_during_review');
      const generation = generationReceipt.nextGeneration;
      if (!Number.isSafeInteger(generation) || generation < 1)
        return unavailable('issuer_generation_unavailable');
      const catalog: CorrectiveFunctionalKernelCatalog = tournament
        ? {
            version: TOURNAMENT_KERNEL_CATALOG_VERSION,
            kind: 'original_state_function',
            objective: tournamentDefinition!.objective,
            utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
            domain: { ...plan.domain },
            sourceRelease: before.sourceRelease,
            kernelVersion: tournamentDefinition!.kernel.version,
            modelVersion: tournamentDefinition!.model.version,
            policyDigest: before.policyDigest,
            baselineSelectionsDigest: before.baselineSelectionsDigest,
            holdoutDigest: measurement.measurementDigest,
            maximumConditionalProbability: 0.05,
            minimumModelGainPrizeShare: tournamentDefinition!.kernel.minimumModelGainPrizeShare,
          }
        : {
            version: CORRECTIVE_KERNEL_CATALOG_VERSION,
            kind: 'original_state_function',
            domain: { ...plan.domain },
            sourceRelease: before.sourceRelease,
            kernelVersion: RIVER_CORRECTION_KERNEL.version,
            modelVersion: RIVER_DECISION_MODEL.version,
            policyDigest: before.policyDigest,
            baselineSelectionsDigest: before.baselineSelectionsDigest,
            holdoutDigest: measurement.measurementDigest,
            maximumConditionalProbability: 0.05,
            minimumModelGainBb: RIVER_CORRECTION_KERNEL.minimumModelGainBb,
          };
      const sourcePopulationDigest = evidenceDigest({
        version: tournament ? 'horse-river-qualified-source-v2' : 'horse-river-qualified-source-v1',
        ...(tournament
          ? {
              objective: tournamentDefinition!.objective,
              utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
            }
          : {}),
        generationReceipt,
        currentControl: finalControl,
        predeclarationDigest: population.predeclarationDigest,
        planDigest: population.planDigest,
        censusDigest: population.censusDigest,
        windowDigest: population.windowDigest,
        requestsDigest: population.requestsDigest,
        sourceRelease: population.sourceRelease,
        acceptedHands: population.acceptedHands,
        eligibleCases: population.eligibleCases,
        exclusions: population.exclusions,
        independentCustodyDigest: review.sourceCustodyDigest,
        reviewDigest: review.reviewDigest,
      });
      const approval: CorrectiveFunctionalKernelApproval = tournament
        ? {
            version: 2,
            objective: tournamentDefinition!.objective,
            utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
            role: 'original_state_kernel_holdout',
            evidenceClass: 'reviewed_reference',
            qualificationId: plan.qualificationId,
            domain: { ...plan.domain },
            sourceRelease: before.sourceRelease,
            kernelVersion: tournamentDefinition!.kernel.version,
            modelVersion: tournamentDefinition!.model.version,
            policyDigest: before.policyDigest,
            baselineSelectionsDigest: before.baselineSelectionsDigest,
            catalogDigest: functionalKernelCatalogDigest(catalog),
            holdoutDigest: measurement.measurementDigest,
            selectionWindowDigest: evidenceDigest({
              version: 'horse-tournament-selection-window-v1',
              objective: tournamentDefinition!.objective,
              utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
              selectionHandKeys: plan.selectionHandKeys,
              declaredAt: plan.declaredAt,
            }),
            holdoutWindowDigest: population.windowDigest,
            sourceCustodyDigest: sourcePopulationDigest,
            numericReviewDigest: review.numericReviewDigest,
            rollbackDigest: rollback.evidence.rollbackDigest,
            approvalGeneration: generation,
            issuedAt,
            expiresAt,
            measurement: {
              samples: measurement.samples,
              changed: measurement.changed,
              meanGain: gains.mean!,
              lowerGain: gains.lower!,
              familyWiseConfidence: 1 - plan.familyWiseAlpha,
              familySize: plan.familySize,
              maximumAbsoluteDelta: tournamentDefinition!.kernel.conditionalProbability,
            },
          }
        : {
            version: 1,
            role: 'original_state_kernel_holdout',
            evidenceClass: 'reviewed_reference',
            qualificationId: plan.qualificationId,
            domain: { ...plan.domain },
            sourceRelease: before.sourceRelease,
            kernelVersion: RIVER_CORRECTION_KERNEL.version,
            modelVersion: RIVER_DECISION_MODEL.version,
            policyDigest: before.policyDigest,
            catalogDigest: functionalKernelCatalogDigest(catalog),
            holdoutDigest: measurement.measurementDigest,
            selectionWindowDigest: evidenceDigest({
              version: 'horse-river-selection-window-v1',
              selectionHandKeys: plan.selectionHandKeys,
              declaredAt: plan.declaredAt,
            }),
            holdoutWindowDigest: population.windowDigest,
            sourceCustodyDigest: sourcePopulationDigest,
            numericReviewDigest: review.numericReviewDigest,
            rollbackDigest: rollback.evidence.rollbackDigest,
            approvalGeneration: generation,
            issuedAt,
            expiresAt,
            measurement: {
              samples: measurement.samples,
              changed: measurement.changed,
              meanGainBb: gains.mean!,
              lowerGainBb: gains.lower!,
              familyWiseConfidence: 1 - plan.familyWiseAlpha,
              familySize: plan.familySize,
              maximumAbsoluteDeltaBb: (plan as CashCorrectiveKernelPredeclaredPlan)
                .maximumAbsoluteDeltaBb,
            },
          };
      // Only now may this purpose-only credential enter a KeyObject. It is never
      // written, printed or passed through a child environment or CLI argument.
      const secret = environment[PHASE14_ISSUER_SECRET_NAME];
      if (!secret || secret.length > 8192 || !secret.startsWith('-----BEGIN PRIVATE KEY-----'))
        return unavailable('issuer_purpose_key_unavailable');
      const keyBytes = Buffer.from(secret);
      let key;
      try {
        key = createPrivateKey({ key: keyBytes, format: 'pem', type: 'pkcs8' });
      } finally {
        keyBytes.fill(0);
      }
      if (key.asymmetricKeyType !== 'ed25519') return unavailable('issuer_purpose_key_refused');
      const publicKey = createPublicKey(key),
        publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        pin = journalHash(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
      if (pin !== PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256)
        return unavailable('issuer_public_pin_mismatch');
      const envelope: CorrectiveKernelQualificationFile['approval'] = {
        approval,
        publicKeyPem,
        signature: sign(
          null,
          approval.version === 2
            ? tournamentKernelApprovalSigningBytes(approval)
            : kernelApprovalSigningBytes(approval),
          key
        ).toString('base64'),
      };
      const verifiedApproval = verifyFunctionalKernelApproval(
        envelope,
        PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256,
        nowMs
      );
      if (
        !verifiedApproval ||
        validateFunctionalKernelCatalog(catalog, verifiedApproval, { ...before, nowMs }).status !==
          'validated'
      )
        return unavailable('issuer_consumer_verification_refused');
      const qualification: CorrectiveKernelQualificationFile = {
        schema: tournament
          ? TOURNAMENT_KERNEL_QUALIFICATION_SCHEMA
          : CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA,
        catalog,
        approval: envelope,
      };
      return {
        status: 'issued_qualification',
        version: CORRECTIVE_KERNEL_ISSUER_VERSION,
        qualification,
        trustedSignerKeySha256: pin,
        qualificationSha256: createHash('sha256')
          .update(JSON.stringify(qualification) + '\n')
          .digest('hex'),
        producerRequestsDigest: population.requestsDigest,
        sourcePopulationDigest,
        rollbackDigest: rollback.evidence.rollbackDigest,
        activationAllowed: false,
      };
    } catch {
      return unavailable('issuer_dependency_unavailable');
    } finally {
      busy = false;
    }
  };
}
