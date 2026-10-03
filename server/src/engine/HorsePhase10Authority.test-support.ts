/**
 * Test-only Phase 10 qualification. The bytes live in memory and reach
 * admission through an injected reader. Nothing here is committed evidence:
 * the protected release selection stays null, no qualified:true file exists in
 * the repository, and the running contract digest stays null until #5969.
 *
 * The qualification object has exactly the keys the P10.2 assembler
 * (`server/scripts/phase10-strength-assemble.mjs`, #5969) writes for a
 * `horse-phase10-qualification-v1` file.
 */
import { createHash } from 'node:crypto';
import { PLO4_POLICY_PACK } from './plo4/Plo4PolicyPack.js';
import {
  admitHorsePhase10QualifiedAuthority,
  HORSE_PHASE10_CONTRACT_VERSION,
  HORSE_PHASE10_DOMAIN,
  HORSE_PHASE10_QUALIFICATION_SCHEMA,
  type HorsePhase10AuthoritySelection,
} from './HorsePhase10Authority.js';
import type { HorseAuthorityAdmission } from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';

/** The digest the P10.2 record states for plo4-strength-contract-v1. */
export const P10_TEST_CONTRACT_DIGEST =
  'ebdbdbb48336c0425df735fa073a4a28ef4884c199a69006e27909a6bc2b6384';
export const P10_TEST_SOURCE_SHA = 'b'.repeat(40);
export const P10_TEST_QUALIFICATION_PATH = 'docs/evidence/phase10/phase10-qualification-test.json';
export const P10_TEST_STRENGTH_PATH = 'docs/evidence/phase10/strength-test/strength.json';
export const P10_TEST_NOW = Date.parse('2026-10-10T01:00:00.000Z');

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export const p10TestStrength = Buffer.from(
  JSON.stringify({ schema: 'horse-phase10-strength-v1', note: 'test-only bytes' }) + '\n'
);

/** A `horse-phase10-qualification-v1` object as the assembler writes it. */
export function p10QualificationObject(overrides: Record<string, unknown> = {}) {
  const qualified = overrides.qualified ?? true;
  return {
    schema: HORSE_PHASE10_QUALIFICATION_SCHEMA,
    qualified,
    mode: 'contract',
    sourceSha: P10_TEST_SOURCE_SHA,
    packVersion: PLO4_POLICY_PACK.version,
    contractVersion: HORSE_PHASE10_CONTRACT_VERSION,
    contractDigest: P10_TEST_CONTRACT_DIGEST,
    domain: HORSE_PHASE10_DOMAIN,
    policyDigest: 'd'.repeat(64),
    objectives: {
      cash: { qualified, status: 'measured' },
      tournament: {
        status: 'unavailable dependency',
        qualified: false,
        reasons: [
          'tournament:plo4_whole_tournament_outcome_model_unavailable',
          'tournament:qualified_plo4_tournament_reference_population_unavailable',
          'tournament:plo4_tournament_thresholds_not_specified',
        ],
      },
    },
    evidencePath: P10_TEST_STRENGTH_PATH,
    evidenceSha256: sha256(p10TestStrength),
    reasons: [],
    ...overrides,
  };
}

export function p10QualificationBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify(p10QualificationObject(overrides), null, 2) + '\n');
}

export function p10Selection(
  qualification: Buffer = p10QualificationBytes(),
  overrides: Partial<HorsePhase10AuthoritySelection> = {}
): HorsePhase10AuthoritySelection {
  return {
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase10',
    sourceSha: P10_TEST_SOURCE_SHA,
    packVersion: PLO4_POLICY_PACK.version,
    contractVersion: HORSE_PHASE10_CONTRACT_VERSION,
    contractDigest: P10_TEST_CONTRACT_DIGEST,
    domain: HORSE_PHASE10_DOMAIN,
    qualificationPath: P10_TEST_QUALIFICATION_PATH,
    qualificationSha256: sha256(qualification),
    approvalGeneration: 1,
    issuedAt: '2026-10-10T00:00:00.000Z',
    expiresAt: null,
    withdrawn: null,
    ...overrides,
  };
}

export function p10Reader(qualification: Buffer = p10QualificationBytes()) {
  return memoryReader({
    [P10_TEST_QUALIFICATION_PATH]: qualification,
    [P10_TEST_STRENGTH_PATH]: p10TestStrength,
  });
}

/** A usable Phase 10 admission (test fixture only) for an approval generation. */
export function qualifiedPhase10TestAdmission(approvalGeneration = 1): HorseAuthorityAdmission {
  const qualification = p10QualificationBytes();
  return admitHorsePhase10QualifiedAuthority(
    p10Selection(qualification, { approvalGeneration }),
    p10Reader(qualification),
    P10_TEST_NOW,
    P10_TEST_CONTRACT_DIGEST
  );
}
