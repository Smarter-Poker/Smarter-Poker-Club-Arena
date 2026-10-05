/**
 * Test-only Phase 11 qualification and completion evidence. The bytes live in
 * memory and reach admission through an injected reader. Nothing here is
 * committed evidence: every protected release selection stays null and no
 * qualified:true file or completion record exists in the repository.
 *
 * The qualification object has exactly the keys the P11.2 assembler
 * (`server/scripts/phase11-strength-assemble.mjs`) writes for a
 * `horse-phase11-qualification-v1` file; the completion record has exactly
 * the keys `horse-phase11-completion-v1` requires.
 */
import { createHash } from 'node:crypto';
import {
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  omahaVariantStrengthContractDigest,
  omahaVariantStrengthPack,
} from '../benchmark/OmahaVariantStrengthContract.js';
import {
  admitHorsePhase11QualifiedAuthority,
  HORSE_PHASE11_COMPLETION_DEFINITION,
  HORSE_PHASE11_COMPLETION_SCHEMA,
  HORSE_PHASE11_CONTRACT_VERSION,
  HORSE_PHASE11_QUALIFICATION_SCHEMA,
  type HorsePhase11AuthoritySelection,
  type HorsePhase11StreetCompletion,
} from './HorsePhase11Authority.js';
import {
  HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
  horsePhase11PolicyDigest,
} from './HorsePhase11PolicyDigest.js';
import type { HorseAuthorityAdmission } from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import { OMAHA_VARIANT_PACKS, type OmahaPolicyVariant } from './omaha/OmahaVariantPolicyPack.js';

/** The running P11.2 contract digest. */
export const P11_TEST_CONTRACT_DIGEST = omahaVariantStrengthContractDigest();
export const P11_TEST_SOURCE_SHA = 'b'.repeat(40);
export const P11_TEST_RELEASE_SHA = 'c'.repeat(40);
export const P11_TEST_NOW = Date.parse('2026-10-20T01:00:00.000Z');
export const P11_TEST_ISSUED_AT = '2026-10-20T00:00:00.000Z';

export const p11QualificationPath = (variant: OmahaPolicyVariant) =>
  `docs/evidence/phase11/phase11-qualification-test-${variant}.json`;
export const p11StrengthPath = (variant: OmahaPolicyVariant) =>
  `docs/evidence/phase11/strength-test-${variant}/strength.json`;
export const p11CompletionPath = (variant: OmahaPolicyVariant) =>
  `docs/evidence/phase11/phase11-completion-test-${variant}.json`;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export const p11TestStrength = (variant: OmahaPolicyVariant) =>
  json({ schema: 'horse-phase11-strength-v1', variant, note: 'test-only bytes' });

/** A `horse-phase11-qualification-v1` object as the assembler writes it. */
export function p11QualificationObject(
  variant: OmahaPolicyVariant,
  overrides: Record<string, unknown> = {}
) {
  const pack = omahaVariantStrengthPack(variant);
  const qualified = overrides.qualified ?? true;
  return {
    schema: HORSE_PHASE11_QUALIFICATION_SCHEMA,
    qualified,
    mode: 'contract',
    variant,
    sourceSha: P11_TEST_SOURCE_SHA,
    packVersion: OMAHA_VARIANT_PACKS[variant].version,
    contractVersion: HORSE_PHASE11_CONTRACT_VERSION,
    contractDigest: P11_TEST_CONTRACT_DIGEST,
    domain: pack.domain,
    policyDigest: horsePhase11PolicyDigest(variant),
    policyDigestDefinition: HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
    objectives: {
      cash: { qualified, status: 'measured' },
      tournament: {
        status: 'unavailable dependency',
        qualified: false,
        reasons: [...pack.tournament.refusals],
      },
    },
    admissionAlsoRequires: [
      ...OMAHA_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires,
    ],
    evidencePath: p11StrengthPath(variant),
    evidenceSha256: sha256(p11TestStrength(variant)),
    reasons: [],
    ...overrides,
  };
}

export const p11QualificationBytes = (
  variant: OmahaPolicyVariant,
  overrides: Record<string, unknown> = {}
) => json(p11QualificationObject(variant, overrides));

/** Every street: 200 eligible decisions, all complete (lower bound 0.968). */
export const p11Street = (
  eligible = 200,
  workBudget = 0,
  samplerBudgetExhausted = 0,
  sampleUnavailable = 0
): HorsePhase11StreetCompletion => ({
  eligible,
  completed: eligible - workBudget - samplerBudgetExhausted - sampleUnavailable,
  workBudget,
  samplerBudgetExhausted,
  sampleUnavailable,
});

/** A `horse-phase11-completion-v1` record that clears the floor. */
export function p11CompletionObject(
  variant: OmahaPolicyVariant,
  overrides: Record<string, unknown> = {}
) {
  return {
    schema: HORSE_PHASE11_COMPLETION_SCHEMA,
    definition: HORSE_PHASE11_COMPLETION_DEFINITION,
    variant,
    packVersion: OMAHA_VARIANT_PACKS[variant].version,
    releaseSha: P11_TEST_RELEASE_SHA,
    policyDigestDefinition: HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
    policyDigest: horsePhase11PolicyDigest(variant),
    gameMode: 'cash',
    window: {
      from: '2026-10-12T00:00:00.000Z',
      to: '2026-10-19T00:00:00.000Z',
      releaseUnchanged: true,
      source: 'test-only: no journal was read',
    },
    streets: {
      preflop: p11Street(),
      flop: p11Street(),
      turn: p11Street(),
      river: p11Street(),
    },
    ...overrides,
  };
}

export const p11CompletionBytes = (
  variant: OmahaPolicyVariant,
  overrides: Record<string, unknown> = {}
) => json(p11CompletionObject(variant, overrides));

export function p11Selection(
  variant: OmahaPolicyVariant,
  qualification: Buffer = p11QualificationBytes(variant),
  completion: Buffer | null = p11CompletionBytes(variant),
  overrides: Partial<HorsePhase11AuthoritySelection> = {}
): HorsePhase11AuthoritySelection {
  return {
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant,
    sourceSha: P11_TEST_SOURCE_SHA,
    packVersion: OMAHA_VARIANT_PACKS[variant].version,
    contractVersion: HORSE_PHASE11_CONTRACT_VERSION,
    contractDigest: P11_TEST_CONTRACT_DIGEST,
    domain: omahaVariantStrengthPack(variant).domain,
    qualificationPath: p11QualificationPath(variant),
    qualificationSha256: sha256(qualification),
    completionPath: completion ? p11CompletionPath(variant) : null,
    completionSha256: completion ? sha256(completion) : null,
    approvalGeneration: 1,
    issuedAt: P11_TEST_ISSUED_AT,
    expiresAt: null,
    withdrawn: null,
    ...overrides,
  };
}

export function p11Reader(
  variant: OmahaPolicyVariant,
  qualification: Buffer = p11QualificationBytes(variant),
  completion: Buffer | null = p11CompletionBytes(variant)
) {
  return memoryReader({
    [p11QualificationPath(variant)]: qualification,
    [p11StrengthPath(variant)]: p11TestStrength(variant),
    ...(completion ? { [p11CompletionPath(variant)]: completion } : {}),
  });
}

/** A usable Phase 11 admission for one pack (test fixture only). */
export function qualifiedPhase11TestAdmission(
  variant: OmahaPolicyVariant,
  approvalGeneration = 1
): HorseAuthorityAdmission {
  return admitHorsePhase11QualifiedAuthority(
    variant,
    p11Selection(variant, undefined, undefined, { approvalGeneration }),
    p11Reader(variant),
    P11_TEST_NOW,
    P11_TEST_CONTRACT_DIGEST
  );
}
