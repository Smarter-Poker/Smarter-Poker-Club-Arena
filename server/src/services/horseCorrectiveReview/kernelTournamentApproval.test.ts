import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import {
  isVerifiedTournamentCorrectiveKernelApproval,
  tournamentKernelApprovalSigningBytes,
  verifyTournamentCorrectiveKernelApproval,
  type TournamentCorrectiveKernelApproval,
} from './kernelTournamentApproval.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
  TOURNAMENT_RIVER_DECISION_MODEL,
} from './kernelTournamentDefinition.js';
import { kernelApprovalSigningBytes, verifyCorrectiveKernelApproval } from './kernelApproval.js';
import { catalog, now, signedApproval } from './kernelApproval.test-support.js';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trustedDigest = journalHash(
  publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
);
const approval = (): TournamentCorrectiveKernelApproval => ({
  version: 2,
  objective: TOURNAMENT_KERNEL_OBJECTIVE,
  utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
  role: 'original_state_kernel_holdout',
  evidenceClass: 'reviewed_reference',
  qualificationId: 'tournament-schema-only',
  domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
  sourceRelease: '1'.repeat(40),
  modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
  kernelVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
  baselineSelectionsDigest: '2'.repeat(64),
  policyDigest: '3'.repeat(64),
  catalogDigest: '4'.repeat(64),
  holdoutDigest: '5'.repeat(64),
  selectionWindowDigest: '6'.repeat(64),
  holdoutWindowDigest: '7'.repeat(64),
  sourceCustodyDigest: '8'.repeat(64),
  numericReviewDigest: '9'.repeat(64),
  rollbackDigest: 'a'.repeat(64),
  approvalGeneration: 1,
  issuedAt: '2026-10-25T00:00:00.000Z',
  expiresAt: '2026-10-26T00:00:00.000Z',
  measurement: {
    samples: 10000,
    changed: 10000,
    meanGain: 0.02,
    lowerGain: 0.018,
    familyWiseConfidence: 0.95,
    familySize: 45,
    maximumAbsoluteDelta: 0.05,
  },
});
const envelope = (a: TournamentCorrectiveKernelApproval) => ({
  approval: a,
  publicKeyPem,
  signature: sign(null, tournamentKernelApprovalSigningBytes(a), privateKey).toString('base64'),
});
const verify = (a: TournamentCorrectiveKernelApproval) =>
  verifyTournamentCorrectiveKernelApproval(envelope(a), trustedDigest, now);

describe('strict signed tournament v2 prize-share approval', () => {
  it('verifies and freezes only a genuine signed aggregate, not a caller brand', () => {
    const raw = approval(),
      result = verify(raw);
    expect(result).not.toBeNull();
    expect(isVerifiedTournamentCorrectiveKernelApproval(raw)).toBe(false);
    expect(isVerifiedTournamentCorrectiveKernelApproval(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.domain)).toBe(true);
    expect(Object.isFrozen(result!.measurement)).toBe(true);
  });
  it('domain separates v2 and preserves exact existing cash v1 signing bytes', () => {
    const cash = signedApproval(catalog()).approval;
    expect(kernelApprovalSigningBytes(cash)).toEqual(
      Buffer.from(horseJournalJson(['horse-corrective-kernel-approval-v1', cash]))
    );
    expect(tournamentKernelApprovalSigningBytes(approval())).toEqual(
      Buffer.from(horseJournalJson(['horse-corrective-kernel-approval-v2', approval()]))
    );
    expect(
      verifyTournamentCorrectiveKernelApproval(envelope(approval()), trustedDigest, now)
    ).not.toBeNull();
    expect(verifyCorrectiveKernelApproval(envelope(approval()), trustedDigest, now)).toBeNull();
    const e = envelope(approval());
    e.signature = sign(
      null,
      Buffer.from(horseJournalJson(['horse-corrective-kernel-approval-v1', e.approval])),
      privateKey
    ).toString('base64');
    expect(verifyTournamentCorrectiveKernelApproval(e, trustedDigest, now)).toBeNull();
    expect(
      verifyTournamentCorrectiveKernelApproval({ ...e, approval: cash }, trustedDigest, now)
    ).toBeNull();
  });
  it('rejects cross-objective, cross-unit, cash and unsupported tournament families even when signed', () => {
    for (const patch of [
      { version: 1 },
      { objective: 'cash_chip_ev' },
      { utilityUnit: 'bb' },
      { domain: { variant: 'nlh', format: 'cash', mode: 'cash' } },
      { domain: { variant: 'nlh', format: 'mtt', mode: 'tournament' } },
      { domain: { variant: 'plo5', format: 'spin', mode: 'tournament' } },
      { modelVersion: 'river-public-finite-prior-v1' },
      { kernelVersion: 'river-call-fold-correction-v2' },
    ])
      expect(
        verify({
          ...approval(),
          ...patch,
        } as TournamentCorrectiveKernelApproval)
      ).toBeNull();
  });
  it('rejects mixed cash measurement fields and unknown signed/envelope keys', () => {
    expect(
      verify({
        ...approval(),
        measurement: { ...approval().measurement, meanGainBb: 1 },
      } as TournamentCorrectiveKernelApproval)
    ).toBeNull();
    expect(
      verify({
        ...approval(),
        qualified: true,
      } as TournamentCorrectiveKernelApproval)
    ).toBeNull();
    expect(
      verifyTournamentCorrectiveKernelApproval(
        { ...envelope(approval()), qualified: true },
        trustedDigest,
        now
      )
    ).toBeNull();
  });
  it('requires a predeclared finite share bound and independently recomputes confidence', () => {
    for (const patch of [
      { maximumAbsoluteDelta: 0 },
      { maximumAbsoluteDelta: 0.04 },
      { maximumAbsoluteDelta: 0.05000001 },
      { lowerGain: 0 },
      { lowerGain: 0.0199 },
      { familyWiseConfidence: 0.94 },
      { familySize: 44 },
      { changed: 0 },
      { samples: 10001 },
      { changed: 1 },
    ])
      expect(
        verify({
          ...approval(),
          measurement: { ...approval().measurement, ...patch },
        })
      ).toBeNull();
  });
  it('rejects nonfinite measurement before signature serialization', () => {
    const e = envelope(approval());
    e.approval.measurement.meanGain = Number.NaN;
    expect(verifyTournamentCorrectiveKernelApproval(e, trustedDigest, now)).toBeNull();
    e.approval.measurement.meanGain = Number.POSITIVE_INFINITY;
    expect(verifyTournamentCorrectiveKernelApproval(e, trustedDigest, now)).toBeNull();
  });
  it('binds baseline/source/generation/windows and rejects omissions or malformed commitments', () => {
    for (const patch of [
      { baselineSelectionsDigest: '' },
      { sourceRelease: '1'.repeat(39) },
      { approvalGeneration: 0 },
      { approvalGeneration: 1.1 },
      { selectionWindowDigest: approval().holdoutWindowDigest },
      { rollbackDigest: 'z'.repeat(64) },
    ])
      expect(verify({ ...approval(), ...patch })).toBeNull();
    const e = envelope(approval());
    e.approval.baselineSelectionsDigest = 'b'.repeat(64);
    expect(verifyTournamentCorrectiveKernelApproval(e, trustedDigest, now)).toBeNull();
  });
  it('refuses unknown signer, invalid signature, future/expired/noncanonical times and synthetic production evidence', () => {
    const e = envelope(approval());
    expect(verifyTournamentCorrectiveKernelApproval(e, 'f'.repeat(64), now)).toBeNull();
    expect(
      verifyTournamentCorrectiveKernelApproval(
        { ...e, signature: 'A'.repeat(88) },
        trustedDigest,
        now
      )
    ).toBeNull();
    for (const patch of [
      { issuedAt: '2026-10-25T02:00:00.000Z' },
      { expiresAt: '2026-10-25T01:00:00.000Z' },
      { issuedAt: '2026-10-25T00:00:00Z' },
      { evidenceClass: 'synthetic_fixture' as const },
    ])
      expect(verify({ ...approval(), ...patch })).toBeNull();
    const synthetic = envelope({
      ...approval(),
      evidenceClass: 'synthetic_fixture',
    });
    expect(
      verifyTournamentCorrectiveKernelApproval(synthetic, trustedDigest, now, {
        allowSynthetic: true,
      })
    ).not.toBeNull();
    expect(
      journalHash(
        createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).toString('base64')
      )
    ).toBe(trustedDigest);
  });
});

import {
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL,
  CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL,
  tournamentKernelDefinitionFor,
} from './kernelTournamentDefinition.js';
describe('closed HU ladder signed objective registry', () => {
  it('accepts only exact NLH mtt/sng/hu_sng ladder identities and refuses crossed families/code versions', () => {
    for (const format of ['mtt', 'sng', 'hu_sng'] as const) {
      const a: TournamentCorrectiveKernelApproval = {
        ...approval(),
        objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
        domain: { variant: 'nlh', format, mode: 'tournament' },
        modelVersion: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL.version,
        kernelVersion: CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
      };
      expect(verify(a)).not.toBeNull();
      for (const patch of [
        { objective: TOURNAMENT_KERNEL_OBJECTIVE },
        { domain: { variant: 'nlh', format: 'spin', mode: 'tournament' } },
        { modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version },
        { kernelVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version },
      ])
        expect(verify({ ...a, ...patch } as TournamentCorrectiveKernelApproval)).toBeNull();
    }
    expect(
      tournamentKernelDefinitionFor(CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE, {
        variant: 'plo5',
        format: 'mtt',
        mode: 'tournament',
      })
    ).toBeNull();
    expect(
      tournamentKernelDefinitionFor(CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE, {
        variant: 'nlh',
        format: 'cash',
        mode: 'cash',
      })
    ).toBeNull();
    expect(
      tournamentKernelDefinitionFor(
        CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
        new Proxy(
          {},
          {
            ownKeys() {
              throw Error('untrusted');
            },
          }
        )
      )
    ).toBeNull();
  });
});
