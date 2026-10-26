import type { CorrectiveReferenceDomain } from './domain.js';
import type { TournamentCorrectiveKernelApproval } from './kernelTournamentApproval.js';
import { isVerifiedTournamentCorrectiveKernelApproval } from './kernelTournamentApproval.js';
import { correctiveDomainIsValid } from './domain.js';
import { evidenceDigest, sha256 } from './authority.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
import {
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_OBJECTIVE,
  tournamentKernelDefinitionFor,
  type TournamentKernelObjective,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
} from './kernelTournamentDefinition.js';
export const TOURNAMENT_KERNEL_CATALOG_VERSION = 'horse-corrective-kernel-catalog-v2' as const;
export interface TournamentCorrectiveKernelCatalog {
  version: typeof TOURNAMENT_KERNEL_CATALOG_VERSION;
  kind: 'original_state_function';
  objective: TournamentKernelObjective;
  utilityUnit: typeof TOURNAMENT_KERNEL_UTILITY_UNIT;
  domain: CorrectiveReferenceDomain;
  sourceRelease: string;
  kernelVersion: string;
  modelVersion: string;
  policyDigest: string;
  baselineSelectionsDigest: string;
  holdoutDigest: string;
  maximumConditionalProbability: 0.05;
  minimumModelGainPrizeShare: number;
}
export type TournamentCorrectiveKernelCatalogValidation =
  | {
      status: 'validated';
      catalog: Readonly<TournamentCorrectiveKernelCatalog>;
      activationAllowed: false;
    }
  | { status: 'refused'; reason: string };
export const tournamentKernelCatalogDigest = (value: TournamentCorrectiveKernelCatalog): string =>
  evidenceDigest(value);
const KEYS = [
  'version',
  'kind',
  'objective',
  'utilityUnit',
  'domain',
  'sourceRelease',
  'kernelVersion',
  'modelVersion',
  'policyDigest',
  'baselineSelectionsDigest',
  'holdoutDigest',
  'maximumConditionalProbability',
  'minimumModelGainPrizeShare',
];
const validated = new WeakSet<object>();
/** Validate only the functional attachment. This is not another authority
 * issuer: protected Phase 14 selection and the existing S4 worker/main gates
 * are still required before any action or effect may change. Legacy literal
 * original-information-set catalogs cannot become a functional policy. */
export function validateTournamentCorrectiveKernelCatalog(
  raw: unknown,
  approval: TournamentCorrectiveKernelApproval | null,
  running: { policyDigest: string; baselineSelectionsDigest: string; nowMs: number }
): TournamentCorrectiveKernelCatalogValidation {
  const no = (reason: string): TournamentCorrectiveKernelCatalogValidation => ({
    status: 'refused',
    reason,
  });
  try {
    if (!isVerifiedTournamentCorrectiveKernelApproval(approval))
      return no('kernel_approval_unverified');
    if (
      !Number.isFinite(running.nowMs) ||
      running.nowMs < Date.parse(approval.issuedAt) ||
      running.nowMs >= Date.parse(approval.expiresAt)
    )
      return no('kernel_approval_expired');
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== KEYS.length ||
      !KEYS.every((k) => Object.hasOwn(raw, k))
    )
      return no('kernel_catalog_schema_mismatch');
    const c = raw as TournamentCorrectiveKernelCatalog;
    const definition = tournamentKernelDefinitionFor(c.objective, c.domain);
    if (
      c.version !== TOURNAMENT_KERNEL_CATALOG_VERSION ||
      c.kind !== 'original_state_function' ||
      !definition ||
      c.utilityUnit !== TOURNAMENT_KERNEL_UTILITY_UNIT ||
      !correctiveDomainIsValid(c.domain) ||
      c.kernelVersion !== definition.kernel.version ||
      c.modelVersion !== definition.model.version ||
      c.maximumConditionalProbability !== definition.kernel.conditionalProbability ||
      c.minimumModelGainPrizeShare !== definition.kernel.minimumModelGainPrizeShare ||
      typeof c.sourceRelease !== 'string' ||
      !/^[a-f0-9]{40}$/.test(c.sourceRelease) ||
      !sha256(c.policyDigest) ||
      !sha256(c.baselineSelectionsDigest) ||
      !sha256(c.holdoutDigest)
    )
      return no('kernel_catalog_definition_mismatch');
    if (!sha256(running.policyDigest) || c.policyDigest !== running.policyDigest)
      return no('kernel_running_policy_mismatch');
    if (
      !sha256(running.baselineSelectionsDigest) ||
      c.baselineSelectionsDigest !== running.baselineSelectionsDigest
    )
      return no('kernel_baseline_selections_mismatch');
    if (
      c.objective !== approval.objective ||
      c.utilityUnit !== approval.utilityUnit ||
      c.baselineSelectionsDigest !== approval.baselineSelectionsDigest ||
      c.sourceRelease !== approval.sourceRelease ||
      c.policyDigest !== approval.policyDigest ||
      c.holdoutDigest !== approval.holdoutDigest ||
      c.kernelVersion !== approval.kernelVersion ||
      c.modelVersion !== approval.modelVersion ||
      evidenceDigest(c.domain) !== evidenceDigest(approval.domain) ||
      tournamentKernelCatalogDigest(c) !== approval.catalogDigest
    )
      return no('kernel_catalog_approval_mismatch');
    const catalog = JSON.parse(horseJournalJson(c)) as TournamentCorrectiveKernelCatalog;
    Object.freeze(catalog.domain);
    Object.freeze(catalog);
    validated.add(catalog);
    return { status: 'validated', catalog, activationAllowed: false };
  } catch {
    return no('kernel_catalog_unreadable');
  }
}
export function isValidatedTournamentCorrectiveKernelCatalog(
  value: unknown
): value is Readonly<TournamentCorrectiveKernelCatalog> {
  return !!value && typeof value === 'object' && validated.has(value);
}

/**
 * Dan's 2026-10-26 order ("FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING",
 * `engine/HorseOwnerForcedActivation.ts`): the tournament corrective catalog
 * for the running code where a tournament kernel exists for the domain (no-limit
 * hold'em spins: winner-take-all; MTT, SNG and heads-up SNG: the closed
 * heads-up ladder), issued by the owner instead of a signed holdout approval.
 * A domain with no tournament kernel definition has nothing to activate.
 */
export function ownerForcedTournamentCorrectiveKernelCatalog(
  domain: CorrectiveReferenceDomain,
  running: {
    sourceRelease: string;
    policyDigest: string | null;
    baselineSelectionsDigest: string;
    holdoutDigest: string;
  }
): Readonly<TournamentCorrectiveKernelCatalog> | null {
  if (!correctiveDomainIsValid(domain)) return null;
  const objective = [TOURNAMENT_KERNEL_OBJECTIVE, CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE].find(
    (o) => tournamentKernelDefinitionFor(o, domain) !== null
  );
  const definition = objective ? tournamentKernelDefinitionFor(objective, domain) : null;
  if (
    !objective ||
    !definition ||
    !/^[a-f0-9]{40}$/.test(running.sourceRelease) ||
    !sha256(running.policyDigest) ||
    !sha256(running.baselineSelectionsDigest) ||
    !sha256(running.holdoutDigest)
  )
    return null;
  const catalog: TournamentCorrectiveKernelCatalog = {
    version: TOURNAMENT_KERNEL_CATALOG_VERSION,
    kind: 'original_state_function',
    objective,
    utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
    domain: { variant: domain.variant, format: domain.format, mode: domain.mode },
    sourceRelease: running.sourceRelease,
    kernelVersion: definition.kernel.version,
    modelVersion: definition.model.version,
    policyDigest: running.policyDigest as string,
    baselineSelectionsDigest: running.baselineSelectionsDigest,
    holdoutDigest: running.holdoutDigest,
    maximumConditionalProbability: definition.kernel.conditionalProbability,
    minimumModelGainPrizeShare: definition.kernel.minimumModelGainPrizeShare,
  };
  Object.freeze(catalog.domain);
  Object.freeze(catalog);
  validated.add(catalog);
  return catalog;
}
