import type { HorseDecision } from '../../types.js';
import { horseAuthorityReceiptIsWellFormed } from '../../engine/HorseQualifiedAuthority.js';
import { CORRECTIVE_DOMAIN_KEYS } from './domain.js';
import { CORRECTIVE_KERNEL_CATALOG_VERSION } from './kernelCatalog.js';
import { TOURNAMENT_KERNEL_CATALOG_VERSION } from './kernelTournamentCatalog.js';
import {
  tournamentKernelDefinitionFor,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const choice = (v: unknown): v is { action: 'fold' | 'call'; amount: number } =>
  object(v) &&
  Object.keys(v).sort().join(',') === 'action,amount' &&
  ((v.action === 'fold' && v.amount === 0) ||
    (v.action === 'call' &&
      typeof v.amount === 'number' &&
      Number.isFinite(v.amount) &&
      v.amount > 0));
const same = (
  a: { action: string; amount: number | null },
  b: { action: string; amount: number | null }
) => a.action === b.action && (a.action === 'fold' || a.amount === b.amount);
/** Structural and action-order binding at the worker response boundary.
 * Main S4 admission is checked separately immediately before execution. */
export function correctiveKernelReceiptIsValid(decision: HorseDecision): boolean {
  const v = decision.correctivePolicy;
  if (v === undefined) return true;
  if (!object(v)) return false;
  const tournament = v.version === 'horse-corrective-live-kernel-v2';
  if (
    !object(v) ||
    ![
      'version',
      'domain',
      'catalogDigest',
      'sourceSha',
      'policyDigest',
      'baselineSelectionsDigest',
      'inputDigest',
      'readFrameDigest',
      'samplingContractDigest',
      'conditionalProbability',
      ...(tournament
        ? ['objective', 'utilityUnit', 'modelGainLowerPrizeShare', 'tournamentContextDigest']
        : ['modelGainLowerBb']),
      'baseline',
      'proposed',
      'selected',
      'applied',
      'reason',
      'authority',
      'baselineAuthorities',
    ].every((k) => Object.hasOwn(v, k)) ||
    Object.keys(v).length !== (tournament ? 21 : 18)
  )
    return false;
  if (
    !object(v.baselineAuthorities) ||
    Object.keys(v.baselineAuthorities).length > (tournament ? 5 : 4) ||
    Object.entries(v.baselineAuthorities).some(
      ([owner, r]) =>
        !(
          tournament
            ? ['phase8', 'phase10', 'phase11', 'phase12', 'phase13']
            : ['phase10', 'phase11', 'phase12', 'phase13']
        ).includes(owner) ||
        !horseAuthorityReceiptIsWellFormed(r) ||
        r.state !== 'usable'
    )
  )
    return false;
  if (
    (!tournament && v.version !== 'horse-corrective-live-kernel-v1') ||
    !CORRECTIVE_DOMAIN_KEYS.includes(v.domain) ||
    (tournament
      ? !['nlh-spin', 'nlh-mtt', 'nlh-sng', 'nlh-hu_sng'].includes(v.domain)
      : !v.domain.endsWith('-cash')) ||
    !sha(v.catalogDigest) ||
    !sha(v.policyDigest) ||
    !sha(v.baselineSelectionsDigest) ||
    !sha(v.inputDigest) ||
    !sha(v.readFrameDigest) ||
    !sha(v.samplingContractDigest) ||
    !/^[a-f0-9]{40}$/.test(v.sourceSha) ||
    v.conditionalProbability !== 0.05 ||
    (tournament
      ? !tournamentKernelDefinitionFor(v.objective, {
          variant: 'nlh',
          format: v.domain.slice(4),
          mode: 'tournament',
        }) ||
        v.utilityUnit !== TOURNAMENT_KERNEL_UTILITY_UNIT ||
        !sha(v.tournamentContextDigest) ||
        !Number.isFinite(v.modelGainLowerPrizeShare) ||
        v.modelGainLowerPrizeShare <=
          TOURNAMENT_RIVER_CORRECTION_KERNEL.minimumModelGainPrizeShare ||
        v.modelGainLowerPrizeShare > 1
      : !Number.isFinite(v.modelGainLowerBb) || v.modelGainLowerBb <= 0.01) ||
    !choice(v.baseline) ||
    !choice(v.proposed) ||
    !choice(v.selected) ||
    v.baseline.action === v.proposed.action ||
    typeof v.applied !== 'boolean' ||
    !['sampled', 'not_sampled', 'illegal_candidate'].includes(v.reason)
  )
    return false;
  if (
    !horseAuthorityReceiptIsWellFormed(v.authority) ||
    v.authority.state !== 'usable' ||
    v.authority.continuationVersion !==
      (tournament ? TOURNAMENT_KERNEL_CATALOG_VERSION : CORRECTIVE_KERNEL_CATALOG_VERSION) +
        '/' +
        v.domain ||
    v.authority.sourceSha !== v.sourceSha
  )
    return false;
  if (
    v.applied
      ? v.reason !== 'sampled' || !same(v.selected, v.proposed)
      : v.reason === 'sampled' || !same(v.selected, v.baseline)
  )
    return false;
  const graph = decision.policyGraph,
    node = graph?.transitions.find((t) => t.node === 'corrective_policy');
  if (
    graph?.version !== 'horse-policy-order-v3' ||
    !node?.before ||
    !same(node.before, v.baseline) ||
    !same(node.after, v.selected)
  )
    return false;
  if (
    v.applied &&
    [
      decision.tournamentPostflop,
      decision.plo4Policy,
      decision.omahaVariantPolicy,
      decision.remainingVariantPolicy,
      decision.jointPolicy,
    ].some((r) => r?.applied)
  )
    return false;
  return true;
}
