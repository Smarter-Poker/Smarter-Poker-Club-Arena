import type { CorrectiveReferenceDomain } from './domain.js';
import type { CorrectiveKernelApproval } from './kernelApproval.js';
import { isVerifiedCorrectiveKernelApproval } from './kernelApproval.js';
import { correctiveDomainIsValid } from './domain.js';
import { evidenceDigest, sha256 } from './authority.js';
import { horseJournalJson } from '../horseDecisionJournal/record.js';
import { RIVER_CORRECTION_KERNEL } from './kernelDefinition.js';
import { RIVER_DECISION_MODEL } from './kernelDefinition.js';
export const CORRECTIVE_KERNEL_CATALOG_VERSION = 'horse-corrective-kernel-catalog-v1' as const;
export interface CorrectiveKernelCatalog {
  version: typeof CORRECTIVE_KERNEL_CATALOG_VERSION;
  kind: 'original_state_function';
  domain: CorrectiveReferenceDomain;
  sourceRelease: string;
  kernelVersion: string;
  modelVersion: string;
  policyDigest: string;
  baselineSelectionsDigest: string;
  holdoutDigest: string;
  maximumConditionalProbability: 0.05;
  minimumModelGainBb: number;
}
export type CorrectiveKernelCatalogValidation =
  | { status: 'validated'; catalog: Readonly<CorrectiveKernelCatalog>; activationAllowed: false }
  | { status: 'refused'; reason: string };
export const correctiveKernelCatalogDigest = (value: CorrectiveKernelCatalog): string =>
  evidenceDigest(value);
const KEYS = [
  'version',
  'kind',
  'domain',
  'sourceRelease',
  'kernelVersion',
  'modelVersion',
  'policyDigest',
  'baselineSelectionsDigest',
  'holdoutDigest',
  'maximumConditionalProbability',
  'minimumModelGainBb',
];
const validated = new WeakSet<object>();
/** Validate only the functional attachment. This is not another authority
 * issuer: protected Phase 14 selection and the existing S4 worker/main gates
 * are still required before any action or effect may change. Legacy literal
 * original-information-set catalogs cannot become a functional policy. */
export function validateCorrectiveKernelCatalog(
  raw: unknown,
  approval: CorrectiveKernelApproval | null,
  running: { policyDigest: string; baselineSelectionsDigest: string; nowMs: number }
): CorrectiveKernelCatalogValidation {
  const no = (reason: string): CorrectiveKernelCatalogValidation => ({ status: 'refused', reason });
  try {
    if (!isVerifiedCorrectiveKernelApproval(approval)) return no('kernel_approval_unverified');
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
    const c = raw as CorrectiveKernelCatalog;
    if (
      c.version !== CORRECTIVE_KERNEL_CATALOG_VERSION ||
      c.kind !== 'original_state_function' ||
      !correctiveDomainIsValid(c.domain) ||
      c.domain.format !== 'cash' ||
      c.domain.mode !== 'cash' ||
      c.kernelVersion !== RIVER_CORRECTION_KERNEL.version ||
      c.modelVersion !== RIVER_DECISION_MODEL.version ||
      c.maximumConditionalProbability !== RIVER_CORRECTION_KERNEL.conditionalProbability ||
      c.minimumModelGainBb !== RIVER_CORRECTION_KERNEL.minimumModelGainBb ||
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
      c.sourceRelease !== approval.sourceRelease ||
      c.policyDigest !== approval.policyDigest ||
      c.holdoutDigest !== approval.holdoutDigest ||
      c.kernelVersion !== approval.kernelVersion ||
      c.modelVersion !== approval.modelVersion ||
      evidenceDigest(c.domain) !== evidenceDigest(approval.domain) ||
      correctiveKernelCatalogDigest(c) !== approval.catalogDigest
    )
      return no('kernel_catalog_approval_mismatch');
    const catalog = JSON.parse(horseJournalJson(c)) as CorrectiveKernelCatalog;
    Object.freeze(catalog.domain);
    Object.freeze(catalog);
    validated.add(catalog);
    return { status: 'validated', catalog, activationAllowed: false };
  } catch {
    return no('kernel_catalog_unreadable');
  }
}
export function isValidatedCorrectiveKernelCatalog(
  value: unknown
): value is Readonly<CorrectiveKernelCatalog> {
  return !!value && typeof value === 'object' && validated.has(value);
}

/**
 * Dan's 2026-10-26 order ("FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING",
 * `engine/HorseOwnerForcedActivation.ts`): the cash corrective catalog for the
 * running code, issued by the owner instead of a signed holdout approval. Every
 * definition check above still applies; only the approval is the owner's.
 */
export function ownerForcedCorrectiveKernelCatalog(
  domain: CorrectiveReferenceDomain,
  running: {
    sourceRelease: string;
    policyDigest: string | null;
    baselineSelectionsDigest: string;
    holdoutDigest: string;
  }
): Readonly<CorrectiveKernelCatalog> | null {
  if (
    !correctiveDomainIsValid(domain) ||
    domain.format !== 'cash' ||
    domain.mode !== 'cash' ||
    !/^[a-f0-9]{40}$/.test(running.sourceRelease) ||
    !sha256(running.policyDigest) ||
    !sha256(running.baselineSelectionsDigest) ||
    !sha256(running.holdoutDigest)
  )
    return null;
  const catalog: CorrectiveKernelCatalog = {
    version: CORRECTIVE_KERNEL_CATALOG_VERSION,
    kind: 'original_state_function',
    domain: { variant: domain.variant, format: domain.format, mode: domain.mode },
    sourceRelease: running.sourceRelease,
    kernelVersion: RIVER_CORRECTION_KERNEL.version,
    modelVersion: RIVER_DECISION_MODEL.version,
    policyDigest: running.policyDigest as string,
    baselineSelectionsDigest: running.baselineSelectionsDigest,
    holdoutDigest: running.holdoutDigest,
    maximumConditionalProbability: RIVER_CORRECTION_KERNEL.conditionalProbability,
    minimumModelGainBb: RIVER_CORRECTION_KERNEL.minimumModelGainBb,
  };
  Object.freeze(catalog.domain);
  Object.freeze(catalog);
  validated.add(catalog);
  return catalog;
}
