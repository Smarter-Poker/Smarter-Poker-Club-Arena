import type { CorrectiveReferenceDomain } from './domain.js';
import type { TournamentCorrectiveKernelApproval } from './kernelTournamentApproval.js';
import { isVerifiedTournamentCorrectiveKernelApproval } from './kernelTournamentApproval.js';
import { correctiveDomainIsValid } from './domain.js';
import { evidenceDigest, sha256 } from './authority.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
import {
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
