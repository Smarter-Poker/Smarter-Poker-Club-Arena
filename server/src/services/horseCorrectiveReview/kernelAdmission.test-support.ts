import { catalog, now, running, signedApproval } from './kernelApproval.test-support.js';
import { TRUSTED_KEY_DIGEST } from './fixture.test-support.js';
import { correctiveKernelCatalogDigest } from './kernelCatalog.js';
import { sha256 } from '../../engine/HorseQualifiedAuthority.js';
import { admitCorrectiveKernelAttachment } from './kernelAdmission.js';
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
  return { c, file, bytes, selection, reader: { read: () => bytes }, context: running(c) };
};
