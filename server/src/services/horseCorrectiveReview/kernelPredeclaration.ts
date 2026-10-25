/** Finite read-only provider custody for a plan committed before its future
 * holdout. No authored timestamp, uploaded JSON or caller flag grants custody. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  evaluateRiverDecisionModelHoldout,
  type RiverModelHoldoutPlan,
} from './riverModelHoldout.js';
import { evidenceDigest } from './authority.js';
import {
  tournamentModelHoldoutPlanIsValid,
  type TournamentModelHoldoutPlan,
} from './tournamentModelHoldout.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  tournamentKernelObjectiveIsKnown,
  tournamentKernelDefinitionFor,
} from './kernelTournamentDefinition.js';
import {
  CORRECTIVE_DOMAIN_KEYS,
  correctiveDomainIsValid,
  type CorrectiveReferenceDomain,
} from './domain.js';
import { correctiveReviewerChildEnvironment } from './reviewerEnvironment.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
const REPOSITORY = 'Smarter-Poker/Smarter-Poker-Club-Arena';
export const CORRECTIVE_PREDECLARATION_VERSION = 'horse-corrective-provider-predeclaration-v1';
const verified = new WeakSet<object>();
export const CORRECTIVE_KERNEL_POPULATION_BASIS = 'accepted-commit-and-immutable-played-v1';
export interface CashCorrectiveKernelPredeclaredPlan extends RiverModelHoldoutPlan {
  objective?: never;
  utilityUnit?: never;
  populationBasis: typeof CORRECTIVE_KERNEL_POPULATION_BASIS;
  domain: CorrectiveReferenceDomain;
}
export type CorrectiveKernelPredeclaredPlan =
  | CashCorrectiveKernelPredeclaredPlan
  | TournamentModelHoldoutPlan;
export interface CorrectivePredeclarationRequest {
  commitSha: string;
  path: string;
  contentSha256: string;
}
export interface CorrectivePredeclaration {
  version: typeof CORRECTIVE_PREDECLARATION_VERSION;
  repository: typeof REPOSITORY;
  commitSha: string;
  path: string;
  contentSha256: string;
  pullRequest: number;
  mergedAt: string;
  plan: Readonly<CorrectiveKernelPredeclaredPlan>;
  custodyDigest: string;
}
export type CorrectivePredeclarationResult =
  | {
      status: 'authenticated_predeclaration';
      predeclaration: Readonly<CorrectivePredeclaration>;
      qualified: false;
      activationAllowed: false;
    }
  | { status: 'unavailable'; reason: string; qualified: false; activationAllowed: false };
const keys = [
  'sourceRelease',
  'producerDigest',
  'qualificationId',
  'evidenceClass',
  'declaredAt',
  'holdoutStartsAt',
  'holdoutEndsAt',
  'selectionHandKeys',
  'minimumSamples',
  'maximumAbsoluteDeltaBb',
  'familyWiseAlpha',
  'familySize',
  'modelVersion',
  'policyVersion',
  'populationBasis',
  'domain',
]
  .sort()
  .join(',');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** gh uses its configured authenticated credential helper. No token or other
 * secret is read, printed or passed as a process argument. Query count <=5,
 * each timeout10s and output<=1MiB, no retry or mutation. */
function githubJson(path: string): unknown {
  const bytes = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: correctiveReviewerChildEnvironment('github'),
  });
  return JSON.parse(bytes);
}
/** Optional API function is a trusted local test seam, never operator JSON. */
export function readCorrectivePredeclaration(
  request: CorrectivePredeclarationRequest,
  api: (path: string) => unknown = githubJson
): CorrectivePredeclarationResult {
  const no = (reason: string): CorrectivePredeclarationResult =>
    Object.freeze({ status: 'unavailable', reason, qualified: false, activationAllowed: false });
  if (
    !object(request) ||
    Object.keys(request).sort().join(',') !== 'commitSha,contentSha256,path' ||
    !/^[a-f0-9]{40}$/.test(request.commitSha) ||
    !/^[a-f0-9]{64}$/.test(request.contentSha256) ||
    !/^docs\/evidence\/phase14\/plans\/[a-z0-9][a-z0-9_.-]{0,120}\.json$/.test(request.path)
  )
    return no('predeclaration_request_invalid');
  try {
    const prefix = `repos/${REPOSITORY}`;
    const main = api(`${prefix}/branches/main`);
    if (
      !object(main) ||
      main.name !== 'main' ||
      main.protected !== true ||
      !object(main.commit) ||
      typeof main.commit.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(main.commit.sha)
    )
      return no('predeclaration_main_protection_unknown');
    const comparison = api(`${prefix}/compare/${request.commitSha}...${main.commit.sha}`);
    if (
      !object(comparison) ||
      !['ahead', 'identical'].includes(String(comparison.status)) ||
      !object(comparison.base_commit) ||
      comparison.base_commit.sha !== request.commitSha ||
      !object(comparison.merge_base_commit) ||
      comparison.merge_base_commit.sha !== request.commitSha
    )
      return no('predeclaration_not_protected_ancestor');
    const pulls = api(`${prefix}/commits/${request.commitSha}/pulls?per_page=100`);
    if (!Array.isArray(pulls) || pulls.length > 100)
      return no('predeclaration_merge_custody_unknown');
    const matches = pulls.filter(
      (p) =>
        object(p) &&
        p.state === 'closed' &&
        p.merge_commit_sha === request.commitSha &&
        typeof p.merged_at === 'string' &&
        Number.isFinite(Date.parse(p.merged_at)) &&
        Number.isSafeInteger(p.number) &&
        Number(p.number) > 0 &&
        object(p.base) &&
        p.base.ref === 'main' &&
        object(p.base.repo) &&
        p.base.repo.full_name === REPOSITORY
    );
    if (matches.length !== 1) return no('predeclaration_merge_custody_unknown');
    const pull = matches[0] as Record<string, unknown>;
    const file = api(`${prefix}/contents/${request.path}?ref=${request.commitSha}`);
    if (
      !object(file) ||
      file.type !== 'file' ||
      file.path !== request.path ||
      file.encoding !== 'base64' ||
      typeof file.content !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 1 ||
      Number(file.size) > 512 * 1024
    )
      return no('predeclaration_file_unavailable');
    const encoded = file.content.replace(/\s/g, ''),
      bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.toString('base64') !== encoded ||
      bytes.length !== file.size ||
      createHash('sha256').update(bytes).digest('hex') !== request.contentSha256
    )
      return no('predeclaration_content_hash_mismatch');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(value)) return no('predeclaration_plan_invalid');
    const tournament = tournamentKernelObjectiveIsKnown(value.objective);
    const expectedKeys = tournament
      ? [
          ...keys.split(',').filter((k) => k !== 'maximumAbsoluteDeltaBb'),
          'maximumAbsoluteDelta',
          'objective',
          'utilityUnit',
        ]
          .sort()
          .join(',')
      : keys;
    if (Object.keys(value).sort().join(',') !== expectedKeys)
      return no('predeclaration_plan_invalid');
    const plan = value as unknown as CorrectiveKernelPredeclaredPlan;
    if (
      !correctiveDomainIsValid(plan.domain) ||
      (tournament
        ? !tournamentKernelDefinitionFor(plan.objective, plan.domain)
        : plan.domain.mode !== 'cash' || plan.domain.format !== 'cash')
    )
      return no('predeclaration_domain_invalid');
    if (plan.populationBasis !== CORRECTIVE_KERNEL_POPULATION_BASIS)
      return no('predeclaration_population_basis_invalid');
    const validation = tournament
      ? null
      : evaluateRiverDecisionModelHoldout(plan as CashCorrectiveKernelPredeclaredPlan, []);
    if (
      (tournament
        ? !tournamentModelHoldoutPlanIsValid(plan)
        : validation?.reasons.length !== 1 ||
          validation.reasons[0] !== 'holdout_sample_count_invalid') ||
      plan.minimumSamples > 10000 ||
      plan.familySize < CORRECTIVE_DOMAIN_KEYS.length
    )
      return no('predeclaration_plan_invalid');
    const sourceAncestry = api(`${prefix}/compare/${plan.sourceRelease}...${request.commitSha}`);
    if (
      !object(sourceAncestry) ||
      !['ahead', 'identical'].includes(String(sourceAncestry.status)) ||
      !object(sourceAncestry.base_commit) ||
      sourceAncestry.base_commit.sha !== plan.sourceRelease ||
      !object(sourceAncestry.merge_base_commit) ||
      sourceAncestry.merge_base_commit.sha !== plan.sourceRelease
    )
      return no('predeclaration_engine_source_not_protected_ancestor');
    const mergedAt = new Date(pull.merged_at as string).toISOString();
    if (
      Date.parse(plan.declaredAt) > Date.parse(mergedAt) ||
      Date.parse(mergedAt) >= Date.parse(plan.holdoutStartsAt)
    )
      return no('predeclaration_committed_after_holdout_start');
    const locked = JSON.parse(horseJournalJson(plan)) as CorrectiveKernelPredeclaredPlan;
    Object.freeze(locked.domain);
    Object.freeze(locked.selectionHandKeys);
    Object.freeze(locked);
    const fields: Omit<CorrectivePredeclaration, 'custodyDigest'> = {
      version: CORRECTIVE_PREDECLARATION_VERSION,
      repository: REPOSITORY,
      commitSha: request.commitSha,
      path: request.path,
      contentSha256: request.contentSha256,
      pullRequest: pull.number as number,
      mergedAt,
      plan: locked,
    };
    const predeclaration = Object.freeze({ ...fields, custodyDigest: evidenceDigest(fields) });
    verified.add(predeclaration);
    return Object.freeze({
      status: 'authenticated_predeclaration',
      predeclaration,
      qualified: false,
      activationAllowed: false,
    });
  } catch {
    return no('predeclaration_provider_unavailable');
  }
}
export function isAuthenticatedCorrectivePredeclaration(
  value: unknown
): value is Readonly<CorrectivePredeclaration> {
  return !!value && typeof value === 'object' && verified.has(value);
}
