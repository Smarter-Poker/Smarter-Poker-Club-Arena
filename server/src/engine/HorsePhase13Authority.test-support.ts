/**
 * Test-only Phase 13 qualification and completion evidence. The bytes live in
 * memory and reach admission through an injected reader. Nothing here is
 * committed evidence: every protected release selection stays null and no
 * qualified:true file or completion record exists in the repository.
 *
 * The qualification object has exactly the sixteen keys the agreed P13.2
 * assembler writes for a `horse-phase13-qualification-v1` file (the Phase 12
 * qualification's keys); the completion record has exactly the keys
 * `horse-phase13-completion-v1` requires.
 */
import { createHash } from 'node:crypto';
import {
  jointStrengthContractDigest,
  jointStrengthDomain,
} from '../benchmark/JointStrengthContract.js';
import {
  admitHorsePhase13QualifiedAuthority,
  HORSE_PHASE13_COMPLETION_DEFINITION,
  HORSE_PHASE13_COMPLETION_SCHEMA,
  HORSE_PHASE13_CONTRACT_VERSION,
  HORSE_PHASE13_PACK_VERSION,
  HORSE_PHASE13_QUALIFICATION_SCHEMA,
  horsePhase13ContractAdmissionRequires,
  horsePhase13ContractMargin,
  type HorsePhase13AuthoritySelection,
  type HorsePhase13StreetCompletion,
} from './HorsePhase13Authority.js';
import {
  HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
  horsePhase13PolicyDigest,
} from './HorsePhase13PolicyDigest.js';
import type { HorseAuthorityAdmission } from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import type { JointVariant } from './multiway/JointInputBinding.js';

/** The running P13.2 contract digest. */
export const P13_TEST_CONTRACT_DIGEST = jointStrengthContractDigest();
export const P13_TEST_SOURCE_SHA = 'b'.repeat(40);
export const P13_TEST_RELEASE_SHA = 'c'.repeat(40);
export const P13_TEST_NOW = Date.parse('2026-10-20T01:00:00.000Z');
export const P13_TEST_ISSUED_AT = '2026-10-20T00:00:00.000Z';

export const p13QualificationPath = (variant: JointVariant) =>
  `docs/evidence/phase13/phase13-qualification-test-${variant}.json`;
export const p13StrengthPath = (variant: JointVariant) =>
  `docs/evidence/phase13/strength-test-${variant}/strength.json`;
export const p13CompletionPath = (variant: JointVariant) =>
  `docs/evidence/phase13/phase13-completion-test-${variant}.json`;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export const p13TestStrength = (variant: JointVariant) =>
  json({ schema: 'horse-phase13-strength-v1', variant, note: 'test-only bytes' });

/** A `horse-phase13-qualification-v1` object with the sixteen agreed keys. */
export function p13QualificationObject(
  variant: JointVariant,
  overrides: Record<string, unknown> = {}
) {
  const qualified = overrides.qualified ?? true;
  return {
    schema: HORSE_PHASE13_QUALIFICATION_SCHEMA,
    qualified,
    mode: 'contract',
    variant,
    sourceSha: P13_TEST_SOURCE_SHA,
    packVersion: HORSE_PHASE13_PACK_VERSION,
    contractVersion: HORSE_PHASE13_CONTRACT_VERSION,
    contractDigest: P13_TEST_CONTRACT_DIGEST,
    domain: jointStrengthDomain(variant),
    policyDigest: horsePhase13PolicyDigest(variant),
    policyDigestDefinition: HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
    objectives: {
      cash: {
        qualified,
        status: 'measured',
        regressionMarginBbPer100: horsePhase13ContractMargin(variant),
      },
      tournament: {
        status: 'not_applicable',
        qualified: false,
        reasons: ['tournament_objective_owned_by_phase7'],
      },
    },
    admissionAlsoRequires: [...(horsePhase13ContractAdmissionRequires() ?? [])],
    evidencePath: p13StrengthPath(variant),
    evidenceSha256: sha256(p13TestStrength(variant)),
    reasons: [],
    ...overrides,
  };
}

export const p13QualificationBytes = (
  variant: JointVariant,
  overrides: Record<string, unknown> = {}
) => json(p13QualificationObject(variant, overrides));

/** One cell: 200 eligible decisions, all complete (lower bound 0.968). */
export const p13Street = (
  eligible = 200,
  workBudget = 0,
  samplerBudgetExhausted = 0,
  sampleUnavailable = 0,
  governorReduced = 0,
  responseBranchUnavailable = 0
): HorsePhase13StreetCompletion => ({
  eligible,
  completed:
    eligible -
    workBudget -
    samplerBudgetExhausted -
    sampleUnavailable -
    governorReduced -
    responseBranchUnavailable,
  workBudget,
  samplerBudgetExhausted,
  sampleUnavailable,
  governorReduced,
  responseBranchUnavailable,
});

const STREET_FIELDS = [
  'eligible',
  'completed',
  'workBudget',
  'samplerBudgetExhausted',
  'sampleUnavailable',
  'governorReduced',
  'responseBranchUnavailable',
] as const;

/**
 * The board-count tally of the same decisions as `streets`: 200 all-complete
 * decisions on two boards and 200 on three (bomb hands), and every other
 * decision, field by field, on one board, so both tallies total the same.
 */
export function p13BoardCountsFor(streets: Record<string, HorsePhase13StreetCompletion>) {
  const two = p13Street();
  const three = p13Street();
  const one = Object.fromEntries(
    STREET_FIELDS.map((field) => [
      field,
      Object.values(streets).reduce((sum, cell) => sum + cell[field], 0) -
        two[field] -
        three[field],
    ])
  ) as unknown as HorsePhase13StreetCompletion;
  return { '1': one, '2': two, '3': three };
}

/** A `horse-phase13-completion-v1` record that clears the floor. When
 * `overrides.streets` is given without `overrides.boardCounts`, the board-count
 * tally is derived from it (`p13BoardCountsFor`), so the record stays
 * internally consistent and a street override tests the street. */
export function p13CompletionObject(
  variant: JointVariant,
  overrides: Record<string, unknown> = {}
) {
  const streets = (overrides.streets as Record<string, HorsePhase13StreetCompletion>) ?? {
    preflop: p13Street(),
    flop: p13Street(),
    turn: p13Street(),
    river: p13Street(),
  };
  return {
    schema: HORSE_PHASE13_COMPLETION_SCHEMA,
    definition: HORSE_PHASE13_COMPLETION_DEFINITION,
    variant,
    packVersion: HORSE_PHASE13_PACK_VERSION,
    releaseSha: P13_TEST_RELEASE_SHA,
    policyDigestDefinition: HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
    policyDigest: horsePhase13PolicyDigest(variant),
    gameMode: 'cash',
    window: {
      from: '2026-10-12T00:00:00.000Z',
      to: '2026-10-19T00:00:00.000Z',
      releaseUnchanged: true,
      source: 'test-only: no journal was read',
    },
    streets,
    boardCounts: p13BoardCountsFor(streets),
    ...overrides,
  };
}

export const p13CompletionBytes = (
  variant: JointVariant,
  overrides: Record<string, unknown> = {}
) => json(p13CompletionObject(variant, overrides));

export function p13Selection(
  variant: JointVariant,
  qualification: Buffer = p13QualificationBytes(variant),
  completion: Buffer | null = p13CompletionBytes(variant),
  overrides: Partial<HorsePhase13AuthoritySelection> = {}
): HorsePhase13AuthoritySelection {
  return {
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase13',
    variant,
    sourceSha: P13_TEST_SOURCE_SHA,
    packVersion: HORSE_PHASE13_PACK_VERSION,
    contractVersion: HORSE_PHASE13_CONTRACT_VERSION,
    contractDigest: P13_TEST_CONTRACT_DIGEST,
    domain: jointStrengthDomain(variant),
    qualificationPath: p13QualificationPath(variant),
    qualificationSha256: sha256(qualification),
    completionPath: completion ? p13CompletionPath(variant) : null,
    completionSha256: completion ? sha256(completion) : null,
    approvalGeneration: 1,
    issuedAt: P13_TEST_ISSUED_AT,
    expiresAt: null,
    withdrawn: null,
    ...overrides,
  };
}

export function p13Reader(
  variant: JointVariant,
  qualification: Buffer = p13QualificationBytes(variant),
  completion: Buffer | null = p13CompletionBytes(variant)
) {
  return memoryReader({
    [p13QualificationPath(variant)]: qualification,
    [p13StrengthPath(variant)]: p13TestStrength(variant),
    ...(completion ? { [p13CompletionPath(variant)]: completion } : {}),
  });
}

/** A usable Phase 13 admission for one variant (test fixture only). */
export function qualifiedPhase13TestAdmission(
  variant: JointVariant,
  approvalGeneration = 1
): HorseAuthorityAdmission {
  return admitHorsePhase13QualifiedAuthority(
    variant,
    p13Selection(variant, undefined, undefined, { approvalGeneration }),
    p13Reader(variant),
    P13_TEST_NOW,
    P13_TEST_CONTRACT_DIGEST
  );
}
