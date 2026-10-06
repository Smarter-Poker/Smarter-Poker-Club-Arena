/**
 * STUB (P13.3, October 6, 2026). The Phase 13 strength contract is owned by
 * package P13.2; this file exists only so P13.3's authority path compiles and
 * can be tested before P13.2's file is merged. It carries exactly the exports
 * the Stage 2 interface agreement names, plus the two sections P13.3 admission
 * reads (`packs.<variant>.regressionMargin` and `.tournament`, and
 * `liveConditions.admissionAlsoRequires`), in the shape the Phase 12 contract
 * uses. AT MERGE THE P13.2 FILE WINS. `HorsePhase13Authority.test.ts` pins that
 * every section admission reads resolves for all nine variants, so a contract
 * whose shape differs fails that test instead of silently refusing (or
 * admitting) anything.
 *
 * No value here is a measured threshold, a seed or a matrix. Nothing selects.
 */
import { createHash } from 'node:crypto';
import type { GameVariant } from '../types.js';
import { bettingStructureFor } from '../engine/BettingStructure.js';

export type JointStrengthVariant = GameVariant;

export const JOINT_STRENGTH_VARIANTS: readonly JointStrengthVariant[] = Object.freeze([
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flo8',
  'flh',
  'pineapple',
  'short_deck',
]);

/** Phi^-1(0.995), the Phase 12 contract's z. */
export const JOINT_STRENGTH_Z99 = 2.5758293035489004;

export function jointStrengthDomain(variant: JointStrengthVariant): string {
  return `${variant}-cash-joint-multiway-after-rake-horse-population`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export const JOINT_STRENGTH_CONTRACT = deepFreeze({
  schema: 'horse-phase13-strength-contract',
  version: 'joint-strength-contract-v1',
  phase: 'P13.2',
  stub: 'P13.3 compile stub; the P13.2 contract replaces this file at merge',
  interval: { z: JOINT_STRENGTH_Z99 },
  packs: Object.fromEntries(
    JOINT_STRENGTH_VARIANTS.map((variant) => [
      variant,
      {
        domain: jointStrengthDomain(variant),
        regressionMargin: {
          lowerBoundAtLeastBbPer100: bettingStructureFor(variant) === 'fixed_limit' ? -4 : -10,
        },
        tournament: {
          status: 'not_applicable',
          refusals: ['tournament_objective_owned_by_phase7'],
        },
      },
    ])
  ) as Record<
    JointStrengthVariant,
    {
      domain: string;
      regressionMargin: { lowerBoundAtLeastBbPer100: number };
      tournament: { status: string; refusals: string[] };
    }
  >,
  liveConditions: {
    admissionAlsoRequires: [
      'natural completion-share evidence for the variant: P13.3 must state and meet its own floor before admitting the joint candidate',
    ],
  },
  promotionEligible: false,
});

/** sha256 of the contract's JSON. */
export function jointStrengthContractDigest(): string {
  return createHash('sha256').update(JSON.stringify(JOINT_STRENGTH_CONTRACT)).digest('hex');
}
