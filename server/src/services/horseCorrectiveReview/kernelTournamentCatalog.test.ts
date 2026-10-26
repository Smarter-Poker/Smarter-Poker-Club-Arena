import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { journalHash } from '../horseDecisionJournal/record.js';
import { evidenceDigest } from './authority.js';
import {
  TOURNAMENT_RIVER_CORRECTION_KERNEL as kernel,
  TOURNAMENT_RIVER_DECISION_MODEL as model,
  TOURNAMENT_KERNEL_OBJECTIVE as objective,
  TOURNAMENT_KERNEL_UTILITY_UNIT as utilityUnit,
} from './kernelTournamentDefinition.js';
import {
  tournamentKernelApprovalSigningBytes,
  verifyTournamentCorrectiveKernelApproval,
  type TournamentCorrectiveKernelApproval,
} from './kernelTournamentApproval.js';
import {
  TOURNAMENT_KERNEL_CATALOG_VERSION,
  tournamentKernelCatalogDigest,
  validateTournamentCorrectiveKernelCatalog,
  isValidatedTournamentCorrectiveKernelCatalog,
  type TournamentCorrectiveKernelCatalog,
} from './kernelTournamentCatalog.js';
const now = Date.parse('2026-10-25T01:00:00.000Z');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trusted = journalHash(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
function fixture() {
  const catalog: TournamentCorrectiveKernelCatalog = {
    version: TOURNAMENT_KERNEL_CATALOG_VERSION,
    kind: 'original_state_function',
    objective,
    utilityUnit,
    domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
    sourceRelease: '1'.repeat(40),
    kernelVersion: kernel.version,
    modelVersion: model.version,
    policyDigest: evidenceDigest('policy'),
    baselineSelectionsDigest: evidenceDigest('baseline'),
    holdoutDigest: evidenceDigest('holdout'),
    maximumConditionalProbability: 0.05,
    minimumModelGainPrizeShare: kernel.minimumModelGainPrizeShare,
  };
  const approval: TournamentCorrectiveKernelApproval = {
    version: 2,
    role: 'original_state_kernel_holdout',
    objective,
    utilityUnit,
    evidenceClass: 'synthetic_fixture',
    qualificationId: 'catalog-synthetic-only',
    domain: { ...catalog.domain },
    sourceRelease: catalog.sourceRelease,
    kernelVersion: kernel.version,
    modelVersion: model.version,
    policyDigest: catalog.policyDigest,
    baselineSelectionsDigest: catalog.baselineSelectionsDigest,
    catalogDigest: tournamentKernelCatalogDigest(catalog),
    holdoutDigest: catalog.holdoutDigest,
    selectionWindowDigest: evidenceDigest('selection'),
    holdoutWindowDigest: evidenceDigest('window'),
    sourceCustodyDigest: evidenceDigest('custody'),
    numericReviewDigest: evidenceDigest('numeric'),
    rollbackDigest: evidenceDigest('rollback'),
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
  };
  const verified = verifyTournamentCorrectiveKernelApproval(
    {
      approval,
      publicKeyPem,
      signature: sign(null, tournamentKernelApprovalSigningBytes(approval), privateKey).toString(
        'base64'
      ),
    },
    trusted,
    now,
    { allowSynthetic: true }
  );
  expect(verified).not.toBeNull();
  return {
    catalog,
    approval: verified!,
    running: {
      policyDigest: catalog.policyDigest,
      baselineSelectionsDigest: catalog.baselineSelectionsDigest,
      nowMs: now,
    },
  };
}
describe('tournament objective-bound functional catalog', () => {
  it('binds genuine signed objective/unit/source/baseline and freezes detached catalog without activation', () => {
    const f = fixture(),
      result = validateTournamentCorrectiveKernelCatalog(f.catalog, f.approval, f.running);
    expect(result.status).toBe('validated');
    if (result.status !== 'validated') throw Error('catalog refused');
    expect(result.activationAllowed).toBe(false);
    expect(isValidatedTournamentCorrectiveKernelCatalog(result.catalog)).toBe(true);
    expect(isValidatedTournamentCorrectiveKernelCatalog(structuredClone(result.catalog))).toBe(
      false
    );
    expect(Object.isFrozen(result.catalog.domain)).toBe(true);
    f.catalog.domain.variant = 'plo5';
    expect(result.catalog.domain.variant).toBe('nlh');
  });
  it.each([
    'copy',
    'objective',
    'unit',
    'cash',
    'mtt',
    'model',
    'source',
    'policy',
    'baseline',
    'holdout',
    'probability',
    'gain',
    'expired',
    'extra-bb',
  ])('refuses %s without broadening v1 or tournament coverage', (fault) => {
    const f = fixture();
    const c = f.catalog as unknown as Record<string, unknown>;
    if (fault === 'objective') c.objective = 'realized_prize';
    if (fault === 'unit') c.utilityUnit = 'bb';
    if (fault === 'cash') f.catalog.domain = { variant: 'nlh', format: 'cash', mode: 'cash' };
    if (fault === 'mtt') f.catalog.domain.format = 'mtt';
    if (fault === 'model') c.modelVersion = 'river-public-finite-prior-v1';
    if (fault === 'source') c.sourceRelease = '2'.repeat(40);
    if (fault === 'policy') f.running.policyDigest = evidenceDigest('changed');
    if (fault === 'baseline') f.running.baselineSelectionsDigest = evidenceDigest('changed');
    if (fault === 'holdout') c.holdoutDigest = evidenceDigest('changed');
    if (fault === 'probability') c.maximumConditionalProbability = 0.06;
    if (fault === 'gain') c.minimumModelGainPrizeShare = 0;
    if (fault === 'expired') f.running.nowMs = Date.parse(f.approval.expiresAt);
    if (fault === 'extra-bb') c.minimumModelGainBb = 0.01;
    expect(
      validateTournamentCorrectiveKernelCatalog(
        f.catalog,
        fault === 'copy' ? structuredClone(f.approval) : f.approval,
        f.running
      ).status
    ).toBe('refused');
  });
});

import {
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL,
  CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
it('binds a genuine second-family ladder approval to its exact catalog and rejects WTA/catalog substitutions', () => {
  const f = fixture();
  Object.assign(f.catalog, {
    objective: CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
    domain: { variant: 'nlh', format: 'mtt', mode: 'tournament' },
    modelVersion: CLOSED_HU_TOURNAMENT_RIVER_DECISION_MODEL.version,
    kernelVersion: CLOSED_HU_TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
  });
  const a: TournamentCorrectiveKernelApproval = {
    ...f.approval,
    objective: f.catalog.objective,
    domain: f.catalog.domain,
    modelVersion: f.catalog.modelVersion,
    kernelVersion: f.catalog.kernelVersion,
    catalogDigest: tournamentKernelCatalogDigest(f.catalog),
  };
  const verified = verifyTournamentCorrectiveKernelApproval(
    {
      approval: a,
      publicKeyPem,
      signature: sign(null, tournamentKernelApprovalSigningBytes(a), privateKey).toString('base64'),
    },
    trusted,
    now,
    { allowSynthetic: true }
  );
  expect(verified).not.toBeNull();
  expect(validateTournamentCorrectiveKernelCatalog(f.catalog, verified, f.running).status).toBe(
    'validated'
  );
  for (const patch of [
    { objective },
    { domain: { variant: 'nlh', format: 'spin', mode: 'tournament' } },
    { modelVersion: model.version },
  ])
    expect(
      validateTournamentCorrectiveKernelCatalog({ ...f.catalog, ...patch }, verified, f.running)
        .status
    ).toBe('refused');
});
