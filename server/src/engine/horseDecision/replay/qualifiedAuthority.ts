/** Offline replay admission uses the same protected selections and exact
 * qualification files as production. A record cannot turn a pack on. */
import { admitHorsePhase14ReleaseAttachment } from '../../HorsePhase14Authority.js';
import type { HorseDecision } from '../../../types.js';
import {
  admitHorsePhase8ReleaseAuthority,
  HorseQualifiedAuthorityHolder,
  horseAuthorityReceiptIsWellFormed,
  type HorseAuthorityAdmission,
  type HorseAuthorityReceipt,
} from '../../HorseQualifiedAuthority.js';
import { admitHorsePhase10ReleaseAuthority } from '../../HorsePhase10Authority.js';
import { admitHorsePhase11ReleaseAuthority } from '../../HorsePhase11Authority.js';
import { admitHorsePhase12ReleaseAuthority } from '../../HorsePhase12Authority.js';
import { admitHorsePhase13ReleaseAuthority } from '../../HorsePhase13Authority.js';
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
  admitPhase8Authority: () => admitHorsePhase8ReleaseAuthority(),
  admitPhase10Authority: () => admitHorsePhase10ReleaseAuthority(),
  admitPhase11Authority: (variant: OmahaPolicyVariant) =>
    admitHorsePhase11ReleaseAuthority(variant),
  admitPhase12Authority: (variant: RemainingPolicyVariant) =>
    admitHorsePhase12ReleaseAuthority(variant),
  admitPhase13Authority: (variant: JointVariant) => admitHorsePhase13ReleaseAuthority(variant),
  admitPhase14Attachment: (domain: string) => admitHorsePhase14ReleaseAttachment(domain),
} satisfies Pick<
  HorseDecisionWorkerDependencies,
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
    ['phase8', null, original.tournamentPostflop],
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
  return (owner, pack, runningVersion, epoch) => {
    const receipt = receipts.get(`${owner}:${pack ?? ''}`);
    if (!receipt) return new HorseQualifiedAuthorityHolder(epoch, runningVersion);
    let admission: HorseAuthorityAdmission;
    try {
      admission =
        owner === 'phase8'
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
      return HorseQualifiedAuthorityHolder.fromReplayReceipt(receipt, admission, runningVersion);
    } catch (error) {
      throw new HorseReplayAuthorityRefusal(
        `${owner}:${error instanceof Error ? error.message : 'unavailable'}`
      );
    }
  };
}
