import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import { catalog, now, signedApproval, running } from './kernelApproval.test-support.js';
import { TRUSTED_KEY_DIGEST } from './fixture.test-support.js';
import { kernelApprovalSigningBytes } from './kernelApproval.js';
import {
  tournamentKernelApprovalSigningBytes,
  type TournamentCorrectiveKernelApproval,
} from './kernelTournamentApproval.js';
import {
  TOURNAMENT_KERNEL_CATALOG_VERSION,
  tournamentKernelCatalogDigest,
  type TournamentCorrectiveKernelCatalog,
} from './kernelTournamentCatalog.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
  TOURNAMENT_RIVER_DECISION_MODEL,
} from './kernelTournamentDefinition.js';
import {
  functionalKernelCatalogVersionIsKnown,
  verifyFunctionalKernelApproval,
  validateFunctionalKernelCatalog,
  isValidatedFunctionalKernelCatalog,
  functionalKernelCatalogDigest,
} from './kernelObjective.js';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pin = journalHash(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
function tournament() {
  const c: TournamentCorrectiveKernelCatalog = {
    version: TOURNAMENT_KERNEL_CATALOG_VERSION,
    kind: 'original_state_function',
    objective: TOURNAMENT_KERNEL_OBJECTIVE,
    utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
    domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
    sourceRelease: '1'.repeat(40),
    kernelVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
    modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
    policyDigest: '2'.repeat(64),
    baselineSelectionsDigest: '3'.repeat(64),
    holdoutDigest: '4'.repeat(64),
    maximumConditionalProbability: 0.05,
    minimumModelGainPrizeShare: 0.0001,
  };
  const a: TournamentCorrectiveKernelApproval = {
    ...signedApproval(catalog(), 'reviewed_reference').approval,
    version: 2,
    objective: c.objective,
    utilityUnit: c.utilityUnit,
    domain: c.domain,
    kernelVersion: c.kernelVersion,
    modelVersion: c.modelVersion,
    policyDigest: c.policyDigest,
    baselineSelectionsDigest: c.baselineSelectionsDigest,
    catalogDigest: tournamentKernelCatalogDigest(c),
    holdoutDigest: c.holdoutDigest,
    measurement: {
      samples: 10000,
      changed: 10000,
      meanGain: 0.02,
      lowerGain: 0.018,
      familyWiseConfidence: 0.95,
      familySize: 45,
      maximumAbsoluteDelta: 0.05,
    },
  };
  const envelope = {
    approval: a,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signature: sign(null, tournamentKernelApprovalSigningBytes(a), privateKey).toString('base64'),
  };
  return {
    catalog: c,
    envelope,
    running: {
      policyDigest: c.policyDigest,
      baselineSelectionsDigest: c.baselineSelectionsDigest,
      nowMs: now,
    },
  };
}
describe('single functional kernel objective dispatch', () => {
  it('routes genuine v1/v2 approval brands to their exact catalog validators', () => {
    const c = catalog(),
      cash = verifyFunctionalKernelApproval(
        signedApproval(c, 'reviewed_reference'),
        TRUSTED_KEY_DIGEST,
        now
      );
    const t = tournament(),
      prize = verifyFunctionalKernelApproval(t.envelope, pin, now);
    expect(cash?.version).toBe(1);
    expect(prize?.version).toBe(2);
    for (const result of [
      validateFunctionalKernelCatalog(c, cash, running(c)),
      validateFunctionalKernelCatalog(t.catalog, prize, t.running),
    ]) {
      expect(result.status).toBe('validated');
      if (result.status !== 'validated') throw Error('unverified catalog');
      expect(result.activationAllowed).toBe(false);
      expect(isValidatedFunctionalKernelCatalog(result.catalog)).toBe(true);
      expect(isValidatedFunctionalKernelCatalog(structuredClone(result.catalog))).toBe(false);
      expect(functionalKernelCatalogDigest(result.catalog)).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('refuses cross-objective catalogs and copied approval brands', () => {
    const c = catalog(),
      cash = verifyFunctionalKernelApproval(
        signedApproval(c, 'reviewed_reference'),
        TRUSTED_KEY_DIGEST,
        now
      ),
      t = tournament(),
      prize = verifyFunctionalKernelApproval(t.envelope, pin, now);
    expect(validateFunctionalKernelCatalog(c, prize, running(c)).status).toBe('refused');
    expect(validateFunctionalKernelCatalog(t.catalog, cash, t.running).status).toBe('refused');
    expect(
      validateFunctionalKernelCatalog(t.catalog, structuredClone(prize), t.running).status
    ).toBe('refused');
  });
  it('refuses unknown or changed version without shape-based fallback', () => {
    const t = tournament();
    for (const version of [undefined, null, 0, 3, '2', 1])
      expect(
        verifyFunctionalKernelApproval(
          { ...t.envelope, approval: { ...t.envelope.approval, version } },
          pin,
          now
        )
      ).toBeNull();
    for (const value of [undefined, null, {}, { approval: null }])
      expect(verifyFunctionalKernelApproval(value, pin, now)).toBeNull();
    const throwingEnvelope = Object.defineProperty({}, 'approval', {
      get() {
        throw Error('untrusted getter');
      },
    });
    expect(verifyFunctionalKernelApproval(throwingEnvelope, pin, now)).toBeNull();
    const hostileCatalog = new Proxy(
      {},
      {
        ownKeys() {
          throw Error('untrusted catalog');
        },
      }
    );
    expect(
      validateFunctionalKernelCatalog(
        hostileCatalog,
        verifyFunctionalKernelApproval(t.envelope, pin, now),
        t.running
      ).status
    ).toBe('refused');
    expect(functionalKernelCatalogVersionIsKnown('horse-corrective-kernel-catalog-v1')).toBe(true);
    expect(functionalKernelCatalogVersionIsKnown(TOURNAMENT_KERNEL_CATALOG_VERSION)).toBe(true);
    expect(functionalKernelCatalogVersionIsKnown('horse-corrective-kernel-catalog-v3')).toBe(false);
  });
  it('keeps production synthetic evidence refused for both versions', () => {
    expect(
      verifyFunctionalKernelApproval(signedApproval(catalog()), TRUSTED_KEY_DIGEST, now)
    ).toBeNull();
    const t = tournament();
    t.envelope.approval.evidenceClass = 'synthetic_fixture';
    t.envelope.signature = sign(
      null,
      tournamentKernelApprovalSigningBytes(t.envelope.approval),
      privateKey
    ).toString('base64');
    expect(verifyFunctionalKernelApproval(t.envelope, pin, now)).toBeNull();
  });
  it('preserves v1 cash signing bytes and rejects unsupported objective despite a valid v2 signature', () => {
    const a = signedApproval(catalog(), 'reviewed_reference').approval;
    expect(kernelApprovalSigningBytes(a)).toEqual(
      Buffer.from(horseJournalJson(['horse-corrective-kernel-approval-v1', a]))
    );
    const t = tournament();
    (t.envelope.approval as unknown as Record<string, unknown>).objective = 'cash_big_blinds';
    t.envelope.signature = sign(
      null,
      tournamentKernelApprovalSigningBytes(t.envelope.approval),
      privateKey
    ).toString('base64');
    expect(verifyFunctionalKernelApproval(t.envelope, pin, now)).toBeNull();
  });
});
