import type { HorseDecision } from '../types.js';
import { PLO4_POLICY_PACK } from './plo4/Plo4PolicyPack.js';
import { OMAHA_VARIANT_PACKS } from './omaha/OmahaVariantPolicyPack.js';
import { REMAINING_VARIANT_PACKS } from './remainingVariants/RemainingVariantPolicyPack.js';

/** These entries select the actual variant-policy caller. A registered pack
 * is not a claim that every configuration is supported or strength-certified.
 * The pack's real evaluation receipt owns its dimensional refusal reasons. */
export const HORSE_POLICY_REGISTRY = Object.freeze({
  nlh: Object.freeze({ owner: 'reference', packVersion: null }),
  plo4: Object.freeze({ owner: 'phase10', packVersion: PLO4_POLICY_PACK.version }),
  plo5: Object.freeze({ owner: 'phase11', packVersion: OMAHA_VARIANT_PACKS.plo5.version }),
  plo6: Object.freeze({ owner: 'phase11', packVersion: OMAHA_VARIANT_PACKS.plo6.version }),
  plo8: Object.freeze({ owner: 'phase11', packVersion: OMAHA_VARIANT_PACKS.plo8.version }),
  short_deck: Object.freeze({
    owner: 'phase12',
    packVersion: REMAINING_VARIANT_PACKS.short_deck.version,
  }),
  pineapple: Object.freeze({
    owner: 'phase12',
    packVersion: REMAINING_VARIANT_PACKS.pineapple.version,
  }),
  flh: Object.freeze({ owner: 'phase12', packVersion: REMAINING_VARIANT_PACKS.flh.version }),
  flo8: Object.freeze({ owner: 'phase12', packVersion: REMAINING_VARIANT_PACKS.flo8.version }),
} as const);
export type HorsePolicyVariant = keyof typeof HORSE_POLICY_REGISTRY;
export type HorsePolicyOwner = (typeof HORSE_POLICY_REGISTRY)[HorsePolicyVariant]['owner'];

/** Exact canonical identifiers only. Prototype keys and aliases cannot select
 * a policy, even when the general card-rule resolver accepts their spelling. */
export function horsePolicyRegistration(variant: unknown) {
  if (typeof variant !== 'string' || !Object.hasOwn(HORSE_POLICY_REGISTRY, variant)) return null;
  const key = variant as HorsePolicyVariant;
  return { variant: key, ...HORSE_POLICY_REGISTRY[key] };
}

export interface HorsePolicyOwnership {
  version: 'horse-policy-ownership-v1';
  variant: HorsePolicyVariant;
  owner: HorsePolicyOwner;
  /** The legacy reference is source-bound by the release, not an invented pack version. */
  packVersion: string | null;
  mode: 'reference' | 'off' | 'shadow' | 'candidate';
  outcome: 'reference' | 'disabled' | 'computed' | 'outside_domain' | 'unavailable';
  reason: string | null;
}

const OUTSIDE_DOMAIN = new Set([
  'variant_outside_pack',
  'depth_or_ante_outside_pack',
  'pineapple_tournament_unapproved',
  'variant_spin_unavailable',
  'multiboard_owned_by_phase13',
  'discard_owned_by_worker',
]);

/** Reconcile routing against the receipt actually produced. A missing or
 * mismatched owner is a failure, never evidence of a supported fallback.
 * Joint/tournament ownership remains separately recorded by those layers. */
export function horsePolicyOwnership(
  variant: HorsePolicyVariant,
  decision: HorseDecision,
  enabled: boolean
): HorsePolicyOwnership {
  const registration = horsePolicyRegistration(variant);
  if (!registration) throw new Error('Horse policy is not registered');
  const receipts = [
    decision.plo4Policy,
    decision.omahaVariantPolicy,
    decision.remainingVariantPolicy,
  ];
  const receipt =
    registration.owner === 'phase10'
      ? receipts[0]
      : registration.owner === 'phase11'
        ? receipts[1]
        : registration.owner === 'phase12'
          ? receipts[2]
          : undefined;
  const base = { version: 'horse-policy-ownership-v1' as const, ...registration };
  if (registration.owner === 'reference' || !enabled) {
    if (receipts.some(Boolean)) throw new Error('Horse policy receipt has an unexpected owner');
    return {
      ...base,
      mode: registration.owner === 'reference' ? 'reference' : 'off',
      outcome: registration.owner === 'reference' ? 'reference' : 'disabled',
      reason: null,
    };
  }
  if (
    !receipt ||
    receipts.filter(Boolean).length !== 1 ||
    receipt.version !== registration.packVersion ||
    (registration.owner !== 'phase10' &&
      (!('variant' in receipt) || receipt.variant !== variant)) ||
    !['shadow', 'candidate'].includes(receipt.mode) ||
    typeof receipt.eligible !== 'boolean' ||
    typeof receipt.fired !== 'boolean' ||
    (receipt.fired && !receipt.eligible) ||
    typeof receipt.reason !== 'string' ||
    !/^[a-z][a-z0-9_]{0,127}$/.test(receipt.reason)
  )
    throw new Error('Horse policy receipt does not match its registered owner');
  if (receipt.fired && OUTSIDE_DOMAIN.has(receipt.reason))
    throw new Error('Horse policy cannot fire outside its domain');
  return {
    ...base,
    mode: receipt.mode as 'shadow' | 'candidate',
    reason: receipt.reason,
    outcome: receipt.fired
      ? 'computed'
      : OUTSIDE_DOMAIN.has(receipt.reason)
        ? 'outside_domain'
        : 'unavailable',
  };
}

/** Validate the compact ownership receipt against the corresponding policy
 * result before the response crosses into execution-witness construction. */
export function horsePolicyOwnershipMatches(decision: HorseDecision): boolean {
  const value = decision.policyOwnership;
  if (!value) return value === undefined;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'mode,outcome,owner,packVersion,reason,variant,version'
  )
    return false;
  try {
    const expected = horsePolicyOwnership(value.variant, decision, value.mode !== 'off');
    return Object.keys(expected).every(
      (key) =>
        expected[key as keyof HorsePolicyOwnership] === value[key as keyof HorsePolicyOwnership]
    );
  } catch {
    return false;
  }
}
