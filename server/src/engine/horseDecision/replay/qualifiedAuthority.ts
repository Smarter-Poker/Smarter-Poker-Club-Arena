import { admitHorseFeatureReleaseAuthority } from '../../HorseFeatureAuthority.js';
import { admitHorsePhase8GuardAuthority } from '../../HorseTournamentCatastropheGuardAuthority.js';
/** Offline replay admission uses the same protected selections and exact
 * qualification files as production. A record cannot turn a pack on. */
import { admitHorsePhase14LiveAttachment } from '../../HorsePhase14Authority.js';
import type { HorseDecision } from '../../../types.js';
import {
  admitHorsePhase8LiveAuthority,
  HorseQualifiedAuthorityHolder,
  canonical,
  horseAuthorityReceiptIsWellFormed,
  type HorseAuthorityAdmission,
  type HorseAuthorityReceipt,
} from '../../HorseQualifiedAuthority.js';
import { admitHorsePhase10LiveAuthority } from '../../HorsePhase10Authority.js';
import { admitHorsePhase11LiveAuthority } from '../../HorsePhase11Authority.js';
import { admitHorsePhase12LiveAuthority } from '../../HorsePhase12Authority.js';
import { admitHorsePhase13LiveAuthority } from '../../HorsePhase13Authority.js';
import type { OmahaPolicyVariant } from '../../omaha/OmahaVariantPolicyPack.js';
import type { RemainingPolicyVariant } from '../../remainingVariants/RemainingVariantPolicyPack.js';
import type { JointVariant } from '../../multiway/JointInputBinding.js';
import type {
  HorseDecisionWorkerAuthorityHolderFactory,
  HorseDecisionWorkerDependencies,
} from '../workerRuntime.js';

export class HorseReplayAuthorityRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** No mode override: the production runtime still derives each mode from
 * its own holder, original request/domain and ordinary qualified verdict. */
export const qualifiedReplayAdmissions = {
  admitFeatureAuthority: () => admitHorseFeatureReleaseAuthority(),
  admitPhase8GuardAuthority: () => admitHorsePhase8GuardAuthority(),
  admitPhase8Authority: () => admitHorsePhase8LiveAuthority(),
  admitPhase10Authority: () => admitHorsePhase10LiveAuthority(),
  admitPhase11Authority: (variant: OmahaPolicyVariant) => admitHorsePhase11LiveAuthority(variant),
  admitPhase12Authority: (variant: RemainingPolicyVariant) =>
    admitHorsePhase12LiveAuthority(variant),
  admitPhase13Authority: (variant: JointVariant) => admitHorsePhase13LiveAuthority(variant),
  admitPhase14Attachment: (domain: string) => admitHorsePhase14LiveAttachment(domain),
} satisfies Pick<
  HorseDecisionWorkerDependencies,
  | 'admitFeatureAuthority'
  | 'admitPhase8GuardAuthority'
  | 'admitPhase8Authority'
  | 'admitPhase10Authority'
  | 'admitPhase11Authority'
  | 'admitPhase12Authority'
  | 'admitPhase13Authority'
  | 'admitPhase14Attachment'
>;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Only an applied owner emits identity into the stable decision/effects.
 * Its existing journaled receipt already carries the full holder identity.
 * Unused/shadow owner epochs are not decision inputs and are not fabricated. */
export function qualifiedReplayAuthorityHolders(
  original: HorseDecision,
  variant: string,
  admissions: typeof qualifiedReplayAdmissions = qualifiedReplayAdmissions
): HorseDecisionWorkerAuthorityHolderFactory {
  const receipts = new Map<string, HorseAuthorityReceipt>();
  const policies = [
    [
      'features',
      null,
      original.featureAuthority ? { ...original.featureAuthority, applied: true } : undefined,
    ],
    ['phase8', null, original.tournamentPostflop],
    ['phase8_guard', null, original.tournamentCatastropheGuard],
    ['phase10', null, original.plo4Policy],
    ['phase11', variant, original.omahaVariantPolicy],
    ['phase12', variant, original.remainingVariantPolicy],
    ['phase13', variant, original.jointPolicy],
    ['phase14', original.correctivePolicy?.domain ?? '', original.correctivePolicy],
  ] as const;
  for (const [owner, pack, policy] of policies) {
    if (!object(policy) || (owner !== 'phase14' && policy.applied !== true)) continue;
    const receipt = policy.authority;
    if (!horseAuthorityReceiptIsWellFormed(receipt))
      throw new HorseReplayAuthorityRefusal(`${owner}:missing_receipt`);
    if (receipt.state !== 'usable')
      throw new HorseReplayAuthorityRefusal(`${owner}:${receipt.state}`);
    receipts.set(`${owner}:${pack ?? ''}`, receipt);
  }
  // An admitted corrective composition can depend on selected baseline owners
  // even though none of their proposals applied on this decision. Their exact
  // recorded generations remain replay inputs and require independent admission.
  for (const [owner, receipt] of Object.entries(
    original.correctivePolicy?.baselineAuthorities ?? {}
  )) {
    if (
      !['phase8', 'phase8_guard', 'phase10', 'phase11', 'phase12', 'phase13'].includes(owner) ||
      !horseAuthorityReceiptIsWellFormed(receipt) ||
      receipt.state !== 'usable'
    )
      throw new HorseReplayAuthorityRefusal(`${owner}:missing_baseline_receipt`);
    const key = `${owner}:${owner === 'phase8' || owner === 'phase8_guard' || owner === 'phase10' ? '' : variant}`;
    const prior = receipts.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(receipt))
      throw new HorseReplayAuthorityRefusal(`${owner}:conflicting_baseline_receipt`);
    receipts.set(key, receipt);
  }
  return (owner, pack, runningVersion, epoch) => {
    const receipt = receipts.get(`${owner}:${pack ?? ''}`);
    if (!receipt) return new HorseQualifiedAuthorityHolder(epoch, runningVersion);
    let admission: HorseAuthorityAdmission;
    try {
      admission =
        owner === 'features'
          ? admissions.admitFeatureAuthority()
          : owner === 'phase8_guard'
            ? admissions.admitPhase8GuardAuthority()
            : owner === 'phase8'
              ? admissions.admitPhase8Authority()
              : owner === 'phase10'
                ? admissions.admitPhase10Authority()
                : owner === 'phase11'
                  ? admissions.admitPhase11Authority(pack as OmahaPolicyVariant)
                  : owner === 'phase12'
                    ? admissions.admitPhase12Authority(pack as RemainingPolicyVariant)
                    : owner === 'phase13'
                      ? admissions.admitPhase13Authority(pack as JointVariant)
                      : admissions.admitPhase14Attachment(pack ?? '').admission;
      if (owner === 'features' && admission.status === 'admitted') {
        const feature = original.featureAuthority,
          authority = admission.authority;
        if (
          !feature ||
          feature.compositionDigest !== authority.featureCompositionDigest ||
          JSON.stringify(canonical(feature.flags)) !==
            JSON.stringify(canonical(authority.featureFlags)) ||
          JSON.stringify(canonical(feature.domain)) !==
            JSON.stringify(canonical(authority.featureDomain))
        )
          throw new Error('feature_composition_mismatch');
      }
      return HorseQualifiedAuthorityHolder.fromReplayReceipt(receipt, admission, runningVersion);
    } catch (error) {
      throw new HorseReplayAuthorityRefusal(
        `${owner}:${error instanceof Error ? error.message : 'unavailable'}`
      );
    }
  };
}
