/**
 * Test-only Phase 12 qualification and completion evidence. The bytes live in
 * memory and reach admission through an injected reader. Nothing here is
 * committed evidence: every protected release selection stays null and no
 * qualified:true file or completion record exists in the repository.
 *
 * The qualification object has exactly the keys the P12.2 assembler
 * (`server/scripts/phase12-strength-assemble.mjs`) writes for a
 * `horse-phase12-qualification-v1` file; the completion record has exactly
 * the keys `horse-phase12-completion-v1` requires.
 */
import { createHash } from 'node:crypto';
import {
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  remainingVariantStrengthContractDigest,
  remainingVariantStrengthPack,
} from '../benchmark/RemainingVariantStrengthContract.js';
import {
  admitHorsePhase12QualifiedAuthority,
  HORSE_PHASE12_COMPLETION_DEFINITION,
  HORSE_PHASE12_COMPLETION_SCHEMA,
  HORSE_PHASE12_CONTRACT_VERSION,
  HORSE_PHASE12_QUALIFICATION_SCHEMA,
  type HorsePhase12AuthoritySelection,
  type HorsePhase12StreetCompletion,
} from './HorsePhase12Authority.js';
import {
  HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
  horsePhase12PolicyDigest,
} from './HorsePhase12PolicyDigest.js';
import type { HorseAuthorityAdmission } from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import {
  REMAINING_VARIANT_PACKS,
  type RemainingPolicyVariant,
} from './remainingVariants/RemainingVariantPolicyPack.js';

/** The running P12.2 contract digest. */
export const P12_TEST_CONTRACT_DIGEST = remainingVariantStrengthContractDigest();
export const P12_TEST_SOURCE_SHA = 'b'.repeat(40);
export const P12_TEST_RELEASE_SHA = 'c'.repeat(40);
export const P12_TEST_NOW = Date.parse('2026-10-20T01:00:00.000Z');
export const P12_TEST_ISSUED_AT = '2026-10-20T00:00:00.000Z';

export const p12QualificationPath = (variant: RemainingPolicyVariant) =>
  `docs/evidence/phase12/phase12-qualification-test-${variant}.json`;
export const p12StrengthPath = (variant: RemainingPolicyVariant) =>
  `docs/evidence/phase12/strength-test-${variant}/strength.json`;
export const p12CompletionPath = (variant: RemainingPolicyVariant) =>
  `docs/evidence/phase12/phase12-completion-test-${variant}.json`;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export const p12TestStrength = (variant: RemainingPolicyVariant) =>
  json({ schema: 'horse-phase12-strength-v1', variant, note: 'test-only bytes' });

/** A `horse-phase12-qualification-v1` object exactly as the assembler writes it. */
export function p12QualificationObject(
  variant: RemainingPolicyVariant,
  overrides: Record<string, unknown> = {}
) {
  const pack = remainingVariantStrengthPack(variant);
  const qualified = overrides.qualified ?? true;
  return {
    schema: HORSE_PHASE12_QUALIFICATION_SCHEMA,
    qualified,
    mode: 'contract',
    variant,
    sourceSha: P12_TEST_SOURCE_SHA,
    packVersion: REMAINING_VARIANT_PACKS[variant].version,
    contractVersion: HORSE_PHASE12_CONTRACT_VERSION,
    contractDigest: P12_TEST_CONTRACT_DIGEST,
    domain: pack.domain,
    policyDigest: horsePhase12PolicyDigest(variant),
    policyDigestDefinition: HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
    objectives: {
      cash: {
        qualified,
        status: 'measured',
        regressionMarginBbPer100: pack.regressionMargin.lowerBoundAtLeastBbPer100,
      },
      tournament: {
        status: pack.tournament.status,
        qualified: false,
        reasons: [...pack.tournament.refusals],
      },
    },
    admissionAlsoRequires: [
      ...REMAINING_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires,
    ],
    evidencePath: p12StrengthPath(variant),
    evidenceSha256: sha256(p12TestStrength(variant)),
    reasons: [],
    ...overrides,
  };
}

export const p12QualificationBytes = (
  variant: RemainingPolicyVariant,
  overrides: Record<string, unknown> = {}
) => json(p12QualificationObject(variant, overrides));

/** Every street: 200 eligible decisions, all complete (lower bound 0.968). */
export const p12Street = (
  eligible = 200,
  workBudget = 0,
  samplerBudgetExhausted = 0,
  sampleUnavailable = 0,
  governorReduced = 0
): HorsePhase12StreetCompletion => ({
  eligible,
  completed: eligible - workBudget - samplerBudgetExhausted - sampleUnavailable - governorReduced,
  workBudget,
  samplerBudgetExhausted,
  sampleUnavailable,
  governorReduced,
});

/** A `horse-phase12-completion-v1` record that clears the floor. */
export function p12CompletionObject(
  variant: RemainingPolicyVariant,
  overrides: Record<string, unknown> = {}
) {
  return {
    schema: HORSE_PHASE12_COMPLETION_SCHEMA,
    definition: HORSE_PHASE12_COMPLETION_DEFINITION,
    variant,
    packVersion: REMAINING_VARIANT_PACKS[variant].version,
    releaseSha: P12_TEST_RELEASE_SHA,
    policyDigestDefinition: HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
    policyDigest: horsePhase12PolicyDigest(variant),
    gameMode: 'cash',
    window: {
      from: '2026-10-12T00:00:00.000Z',
      to: '2026-10-19T00:00:00.000Z',
      releaseUnchanged: true,
      source: 'test-only: no journal was read',
    },
    streets: {
      preflop: p12Street(),
      flop: p12Street(),
      turn: p12Street(),
      river: p12Street(),
    },
    ...overrides,
  };
}

export const p12CompletionBytes = (
  variant: RemainingPolicyVariant,
  overrides: Record<string, unknown> = {}
) => json(p12CompletionObject(variant, overrides));

export function p12Selection(
  variant: RemainingPolicyVariant,
  qualification: Buffer = p12QualificationBytes(variant),
  completion: Buffer | null = p12CompletionBytes(variant),
  overrides: Partial<HorsePhase12AuthoritySelection> = {}
): HorsePhase12AuthoritySelection {
  return {
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant,
    sourceSha: P12_TEST_SOURCE_SHA,
    packVersion: REMAINING_VARIANT_PACKS[variant].version,
    contractVersion: HORSE_PHASE12_CONTRACT_VERSION,
    contractDigest: P12_TEST_CONTRACT_DIGEST,
    domain: remainingVariantStrengthPack(variant).domain,
    qualificationPath: p12QualificationPath(variant),
    qualificationSha256: sha256(qualification),
    completionPath: completion ? p12CompletionPath(variant) : null,
    completionSha256: completion ? sha256(completion) : null,
    approvalGeneration: 1,
    issuedAt: P12_TEST_ISSUED_AT,
    expiresAt: null,
    withdrawn: null,
    ...overrides,
  };
}

export function p12Reader(
  variant: RemainingPolicyVariant,
  qualification: Buffer = p12QualificationBytes(variant),
  completion: Buffer | null = p12CompletionBytes(variant)
) {
  return memoryReader({
    [p12QualificationPath(variant)]: qualification,
    [p12StrengthPath(variant)]: p12TestStrength(variant),
    ...(completion ? { [p12CompletionPath(variant)]: completion } : {}),
  });
}

/** A usable Phase 12 admission for one pack (test fixture only). */
export function qualifiedPhase12TestAdmission(
  variant: RemainingPolicyVariant,
  approvalGeneration = 1
): HorseAuthorityAdmission {
  return admitHorsePhase12QualifiedAuthority(
    variant,
    p12Selection(variant, undefined, undefined, { approvalGeneration }),
    p12Reader(variant),
    P12_TEST_NOW,
    P12_TEST_CONTRACT_DIGEST
  );
}
