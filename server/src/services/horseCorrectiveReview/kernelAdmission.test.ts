import { describe, it, expect } from 'vitest';
import { catalog, now, running, signedApproval } from './kernelApproval.test-support.js';
import { TRUSTED_KEY_DIGEST } from './fixture.test-support.js';
import { correctiveKernelCatalogDigest } from './kernelCatalog.js';
import { sha256 } from '../../engine/HorseQualifiedAuthority.js';
import { admitCorrectiveKernelAttachment } from './kernelAdmission.js';
import { kernelAdmissionFixture as fixture } from './kernelAdmission.test-support.js';
describe('functional attachment uses protected Phase 14 S4 identity', () => {
  it('admits exact signed source and catalog atomically', () => {
    const f = fixture(),
      r = admitCorrectiveKernelAttachment('nlh-cash', f.selection, f.reader, now, f.context);
    expect(r.admission.status).toBe('admitted');
    expect(r.catalog).not.toBeNull();
    if (r.admission.status === 'admitted') {
      expect(r.admission.authority.phase).toBe('phase14');
      expect(r.admission.authority.domain).toBe('nlh-cash');
      expect(r.admission.authority.continuationVersion).toBe(f.c.version + '/nlh-cash');
      expect(r.admission.authority.catalogDigest).toBe(correctiveKernelCatalogDigest(f.c));
    }
  });
  it.each([
    'key',
    'generation',
    'issued',
    'expiry',
    'hash',
    'policy',
    'baseline',
    'domain',
    'withdrawn',
    'fixture',
    'missing',
  ])('refuses %s without returning a functional catalog', (fault) => {
    const f = fixture();
    if (fault === 'key') f.selection.trustedSignerKeySha256 = '0'.repeat(64);
    if (fault === 'generation') f.selection.approvalGeneration++;
    if (fault === 'issued') f.selection.issuedAt = '2026-10-25T00:30:00.000Z';
    if (fault === 'expiry') f.selection.expiresAt = '2026-10-25T02:00:00.000Z';
    if (fault === 'hash') f.selection.qualificationSha256 = '0'.repeat(64);
    if (fault === 'policy') f.context.policyDigest = '0'.repeat(64);
    if (fault === 'baseline') f.context.baselineSelectionsDigest = '0'.repeat(64);
    if (fault === 'domain') f.selection.domain = 'plo5-cash';
    if (fault === 'withdrawn')
      f.selection.withdrawn = { at: '2026-10-25T00:30:00.000Z', reason: 'test' } as never;
    if (fault === 'fixture') {
      f.file.approval = signedApproval(f.c);
      const b = Buffer.from(JSON.stringify(f.file));
      f.reader.read = () => b;
      f.selection.qualificationSha256 = sha256(b);
    }
    if (fault === 'missing')
      f.reader.read = () => {
        throw Object.assign(Error('missing'), { code: 'ENOENT' });
      };
    const r = admitCorrectiveKernelAttachment('nlh-cash', f.selection, f.reader, now, f.context);
    expect(r.admission.status).not.toBe('admitted');
    expect(r.catalog).toBeNull();
  });
  it('does not read when unselected', () => {
    expect(
      admitCorrectiveKernelAttachment(
        'nlh-cash',
        null,
        {
          read: () => {
            throw Error('must not read');
          },
        },
        now,
        fixture().context
      ).admission
    ).toMatchObject({ status: 'refused', reason: 'unselected' });
  });
});
