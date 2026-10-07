/**
 * Test-only Phase 14 qualification evidence. The bytes live in memory and
 * reach admission through an injected reader. Nothing here is committed
 * evidence: every protected release selection stays null and no
 * `docs/evidence/phase14/` file exists. The digests below are labels, not the
 * digest of any real catalog or holdout.
 */
import { createHash } from 'node:crypto';
import {
  admitHorsePhase14QualifiedAuthority,
  HORSE_PHASE14_CATALOG_VERSION,
  HORSE_PHASE14_QUALIFICATION_SCHEMA,
  type HorsePhase14AuthoritySelection,
} from './HorsePhase14Authority.js';
import type { HorseAuthorityAdmission } from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';

export const P14_TEST_SOURCE_SHA = 'd'.repeat(40);
export const P14_TEST_CATALOG_DIGEST = createHash('sha256')
  .update('p14-test-catalog')
  .digest('hex');
export const P14_TEST_HOLDOUT_DIGEST = createHash('sha256')
  .update('p14-test-holdout')
  .digest('hex');
export const P14_TEST_NOW = Date.parse('2026-10-20T01:00:00.000Z');
export const P14_TEST_ISSUED_AT = '2026-10-20T00:00:00.000Z';
export const p14QualificationPath = (domain: string) =>
  `docs/evidence/phase14/phase14-qualification-test-${domain}.json`;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function p14QualificationBytes(
  domain: string,
  overrides: Record<string, unknown> = {}
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: HORSE_PHASE14_QUALIFICATION_SCHEMA,
      qualified: true,
      domain,
      sourceSha: P14_TEST_SOURCE_SHA,
      catalogVersion: HORSE_PHASE14_CATALOG_VERSION,
      catalogDigest: P14_TEST_CATALOG_DIGEST,
      holdoutDigest: P14_TEST_HOLDOUT_DIGEST,
      reasons: [],
      ...overrides,
    })
  );
}

export function p14Selection(
  domain: string,
  bytes: Buffer = p14QualificationBytes(domain),
  overrides: Partial<HorsePhase14AuthoritySelection> = {}
): HorsePhase14AuthoritySelection {
  return {
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase14',
    domain,
    sourceSha: P14_TEST_SOURCE_SHA,
    catalogVersion: HORSE_PHASE14_CATALOG_VERSION,
    catalogDigest: P14_TEST_CATALOG_DIGEST,
    holdoutDigest: P14_TEST_HOLDOUT_DIGEST,
    qualificationPath: p14QualificationPath(domain),
    qualificationSha256: sha(bytes),
    approvalGeneration: 1,
    issuedAt: P14_TEST_ISSUED_AT,
    expiresAt: null,
    withdrawn: null,
    ...overrides,
  };
}

export const p14Reader = (domain: string, bytes: Buffer = p14QualificationBytes(domain)) =>
  memoryReader({ [p14QualificationPath(domain)]: bytes });

/** A usable test admission for `domain` at an approval generation, optionally
 * naming another catalog (a rollback names an earlier one). */
export function qualifiedPhase14TestAdmission(
  domain: string,
  approvalGeneration = 1,
  catalogDigest = P14_TEST_CATALOG_DIGEST
): HorseAuthorityAdmission {
  const bytes = p14QualificationBytes(domain, { catalogDigest });
  return admitHorsePhase14QualifiedAuthority(
    domain,
    p14Selection(domain, bytes, { approvalGeneration, catalogDigest }),
    p14Reader(domain, bytes),
    P14_TEST_NOW
  );
}
