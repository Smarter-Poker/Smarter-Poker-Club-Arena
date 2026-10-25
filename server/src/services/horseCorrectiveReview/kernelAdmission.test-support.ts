import { catalog, now, running, signedApproval } from './kernelApproval.test-support.js';
import { TRUSTED_KEY_DIGEST } from './fixture.test-support.js';
import { correctiveKernelCatalogDigest } from './kernelCatalog.js';
import { sha256 } from '../../engine/HorseQualifiedAuthority.js';
import { admitCorrectiveKernelAttachment } from './kernelAdmission.js';
import {
  PHASE14_GENERATION_LEDGER_PATH,
  phase14SelectionIdentityDigest,
} from './kernelGenerationLedger.js';
import {
  PHASE14_GENERATION_DOMAINS,
  PHASE14_GENERATION_LEDGER_SCHEMA,
} from './kernelGenerationLedgerRules.mjs';
export const kernelAdmissionFixture = () => {
  const c = catalog(),
    envelope = signedApproval(c, 'reviewed_reference');
  const file = { schema: 'horse-phase14-kernel-qualification-v1', catalog: c, approval: envelope };
  const bytes = Buffer.from(JSON.stringify(file));
  const selection = {
    schema: 'horse-qualified-authority-selection-v1' as const,
    phase: 'phase14' as const,
    domain: 'nlh-cash',
    sourceSha: c.sourceRelease,
    catalogVersion: c.version,
    catalogDigest: correctiveKernelCatalogDigest(c),
    holdoutDigest: c.holdoutDigest,
    qualificationPath: 'docs/evidence/phase14/test-only.json',
    qualificationSha256: sha256(bytes),
    approvalGeneration: 1,
    issuedAt: envelope.approval.issuedAt,
    expiresAt: envelope.approval.expiresAt,
    withdrawn: null,
    trustedSignerKeySha256: TRUSTED_KEY_DIGEST,
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
  return {
    c,
    file,
    bytes,
    selection,
    ledger,
    reader: {
      read: (path: string) =>
        path === PHASE14_GENERATION_LEDGER_PATH ? Buffer.from(JSON.stringify(ledger)) : bytes,
    },
    context: running(c),
  };
};
