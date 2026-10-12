/**
 * Test-only qualified Phase 8 authority. The evidence bytes live in memory and
 * reach admission through an injected reader; nothing here is the committed
 * protected-release selection, which stays null until P8.2 qualification.
 */
import { createHash } from 'node:crypto';
import { PHASE8_POLICY } from './HorseTournamentPostflop.js';
import {
  admitHorseQualifiedAuthority,
  horsePhase8PolicyDigest,
  HORSE_PHASE8_DOMAIN,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
  type HorseQualifiedAuthoritySelection,
} from './HorseQualifiedAuthority.js';

export const TEST_SOURCE_SHA = 'a'.repeat(40);
export const TEST_EVIDENCE_PATH = 'docs/evidence/phase8/test-qualification.json';

export function testQualificationEvidence(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 'horse-phase8-qualification-v1',
      qualified: true,
      sourceSha: TEST_SOURCE_SHA,
      continuationVersion: PHASE8_POLICY.version,
      packId: 'horse-tournament-postflop',
      domain: HORSE_PHASE8_DOMAIN,
      policyDigest: horsePhase8PolicyDigest(),
      ...overrides,
    })
  );
}

export function testSelection(
  evidence: Buffer = testQualificationEvidence(),
  overrides: Partial<HorseQualifiedAuthoritySelection> = {}
): HorseQualifiedAuthoritySelection {
  return {
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase8',
    sourceSha: TEST_SOURCE_SHA,
    continuationVersion: PHASE8_POLICY.version,
    packId: 'horse-tournament-postflop',
    domain: HORSE_PHASE8_DOMAIN,
    evidencePath: TEST_EVIDENCE_PATH,
    evidenceSha256: createHash('sha256').update(evidence).digest('hex'),
    approvalGeneration: 1,
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    withdrawn: null,
    ...overrides,
  };
}

export function memoryReader(files: Record<string, Buffer | Error>): HorseAuthorityEvidenceReader {
  return {
    read(path) {
      const file = files[path];
      if (file instanceof Error) throw file;
      if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return file;
    },
  };
}

/** A usable admission for an approval generation. */
export function qualifiedTestAdmission(approvalGeneration = 1): HorseAuthorityAdmission {
  const evidence = testQualificationEvidence();
  return admitHorseQualifiedAuthority(
    testSelection(evidence, { approvalGeneration }),
    memoryReader({ [TEST_EVIDENCE_PATH]: evidence }),
    Date.parse('2026-10-01T01:00:00.000Z')
  );
}
