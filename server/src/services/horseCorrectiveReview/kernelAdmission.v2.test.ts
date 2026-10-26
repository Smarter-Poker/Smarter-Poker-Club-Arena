import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { journalHash } from '../horseDecisionJournal/record.js';
import { catalog, now, signedApproval } from './kernelApproval.test-support.js';
import { kernelAdmissionFixture } from './kernelAdmission.test-support.js';
import {
  admitCorrectiveKernelAttachment,
  CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA,
  TOURNAMENT_KERNEL_QUALIFICATION_SCHEMA,
} from './kernelAdmission.js';
import { isValidatedFunctionalKernelCatalog } from './kernelObjective.js';
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
  TOURNAMENT_RIVER_DECISION_MODEL,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
import {
  PHASE14_GENERATION_LEDGER_PATH,
  phase14SelectionIdentityDigest,
} from './kernelGenerationLedger.js';
import {
  PHASE14_GENERATION_DOMAINS,
  PHASE14_GENERATION_LEDGER_SCHEMA,
} from './kernelGenerationLedgerRules.mjs';
import { sha256 } from '../../engine/HorseQualifiedAuthority.js';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pin = journalHash(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
function fixture() {
  const { minimumModelGainBb: _bb, ...cash } = catalog();
  const c: TournamentCorrectiveKernelCatalog = {
    ...cash,
    version: TOURNAMENT_KERNEL_CATALOG_VERSION,
    objective: TOURNAMENT_KERNEL_OBJECTIVE,
    utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
    domain: { variant: 'nlh', format: 'spin', mode: 'tournament' },
    modelVersion: TOURNAMENT_RIVER_DECISION_MODEL.version,
    kernelVersion: TOURNAMENT_RIVER_CORRECTION_KERNEL.version,
    minimumModelGainPrizeShare: 0.0001,
  };
  const a: TournamentCorrectiveKernelApproval = {
    ...signedApproval(catalog(), 'reviewed_reference').approval,
    version: 2,
    objective: c.objective,
    utilityUnit: c.utilityUnit,
    domain: c.domain,
    modelVersion: c.modelVersion,
    kernelVersion: c.kernelVersion,
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
  const file = {
    schema: TOURNAMENT_KERNEL_QUALIFICATION_SCHEMA as string,
    catalog: c,
    approval: envelope as unknown,
  };
  const selection = {
    schema: 'horse-qualified-authority-selection-v1' as const,
    phase: 'phase14' as const,
    domain: 'nlh-spin',
    sourceSha: c.sourceRelease,
    catalogVersion: c.version as string,
    catalogDigest: tournamentKernelCatalogDigest(c),
    holdoutDigest: c.holdoutDigest,
    qualificationPath: 'docs/evidence/phase14/v2-test-only.json',
    qualificationSha256: '',
    approvalGeneration: 1,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    withdrawn: null,
    trustedSignerKeySha256: pin,
  };
  const ledger = {
    schema: PHASE14_GENERATION_LEDGER_SCHEMA,
    domains: Object.fromEntries(
      PHASE14_GENERATION_DOMAINS.map((domain) => [
        domain,
        {
          highestPublishedGeneration: domain === selection.domain ? 1 : 0,
          authorityDigest:
            domain === selection.domain ? phase14SelectionIdentityDigest(selection) : null,
          retiredGenerations: [] as number[],
        },
      ])
    ),
  };
  let bytes: Buffer;
  const reseal = () => {
    bytes = Buffer.from(JSON.stringify(file));
    selection.qualificationSha256 = sha256(bytes);
    ledger.domains[selection.domain].authorityDigest = phase14SelectionIdentityDigest(selection);
  };
  reseal();
  const reader = {
    read: (path: string) =>
      path === PHASE14_GENERATION_LEDGER_PATH ? Buffer.from(JSON.stringify(ledger)) : bytes,
  };
  const context = {
    policyDigest: c.policyDigest,
    baselineSelectionsDigest: c.baselineSelectionsDigest,
  };
  const admit = () =>
    admitCorrectiveKernelAttachment(selection.domain, selection as never, reader, now, context);
  return { c, a, envelope, file, selection, ledger, reseal, admit };
}
describe('same S4 attachment path with strict tournament version identity', () => {
  it('admits genuine v2 signed bytes with exact source/domain/generation and objective catalog', () => {
    const f = fixture(),
      result = f.admit();
    expect(result.admission.status).toBe('admitted');
    expect(isValidatedFunctionalKernelCatalog(result.catalog)).toBe(true);
    expect(isValidatedFunctionalKernelCatalog(structuredClone(result.catalog))).toBe(false);
    if (result.admission.status !== 'admitted') throw Error('isolated v2 admission refused');
    expect(result.admission.authority).toMatchObject({
      domain: 'nlh-spin',
      sourceSha: f.c.sourceRelease,
      approvalGeneration: 1,
      packId: TOURNAMENT_KERNEL_CATALOG_VERSION,
      continuationVersion: TOURNAMENT_KERNEL_CATALOG_VERSION + '/nlh-spin',
    });
  });
  it('refuses a v2 signed catalog hidden inside selection/schema claiming v1, despite exact file and ledger hashes', () => {
    const f = fixture();
    f.selection.catalogVersion = 'horse-corrective-kernel-catalog-v1';
    f.file.schema = CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA;
    f.reseal();
    expect(f.admit().admission.status).toBe('refused');
  });
  it('refuses wrong units, unknown signed fields, unsigned JSON and caller brands', () => {
    for (const fault of ['unit', 'field', 'unsigned', 'brand']) {
      const f = fixture();
      if (fault === 'unit')
        (f.envelope.approval as unknown as Record<string, unknown>).utilityUnit = 'bb';
      if (fault === 'field')
        (f.file.catalog as unknown as Record<string, unknown>).qualified = true;
      if (fault === 'unsigned') f.envelope.signature = '';
      if (fault === 'brand') f.file.approval = { ...f.a, qualified: true };
      f.reseal();
      expect(f.admit().admission.status).toBe('refused');
    }
  });
  it('refuses changed source, generation, stale ledger or explicit retired generation', () => {
    for (const fault of ['source', 'generation', 'floor', 'retired']) {
      const f = fixture();
      if (fault === 'source') f.selection.sourceSha = '2'.repeat(40);
      if (fault === 'generation') f.selection.approvalGeneration = 2;
      if (fault === 'floor') f.ledger.domains[f.selection.domain].highestPublishedGeneration = 2;
      if (fault === 'retired') f.ledger.domains[f.selection.domain].retiredGenerations = [1];
      f.reseal();
      expect(f.admit().admission.status).toBe('refused');
    }
  });
  it('refuses wrong qualification schema or unsupported catalog version before producing S4 authority', () => {
    for (const fault of ['schema', 'version']) {
      const f = fixture();
      if (fault === 'schema') f.file.schema = CORRECTIVE_KERNEL_QUALIFICATION_SCHEMA;
      if (fault === 'version') f.selection.catalogVersion = 'horse-corrective-kernel-catalog-v3';
      f.reseal();
      expect(f.admit().admission.status).toBe('refused');
    }
  });
  it('retains existing cash v1 admission and identity unchanged', () => {
    const f = kernelAdmissionFixture(),
      r = admitCorrectiveKernelAttachment('nlh-cash', f.selection, f.reader, now, f.context);
    expect(r.admission.status).toBe('admitted');
    if (r.admission.status !== 'admitted') throw Error('cash refused');
    expect(r.admission.authority.packId).toBe('horse-corrective-kernel-catalog-v1');
  });
});
