import { describe, expect, it } from 'vitest';

import {
  PHASE1_MTT_CASE_TITLE,
  phase1MttCertificateVerdict,
} from '../../scripts/ci/phase1-mtt-certificate-verdict.mjs';

function report(status: string, description?: string) {
  return {
    suites: [
      {
        suites: [
          {
            specs: [
              {
                file: 'production-live-table-realtime.spec.ts',
                title: PHASE1_MTT_CASE_TITLE,
                tests: [
                  {
                    annotations: description ? [{ description }] : [],
                    results: [{ status }],
                  },
                ],
              },
              {
                file: 'production-live-table-realtime.spec.ts',
                title: 'an already-running SNG table stays realtime and recovers one owner',
                tests: [{ results: [{ status: 'passed' }] }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('Phase 1 MTT certificate verdict', () => {
  it('certifies only when the exact MTT case executed and passed', () => {
    expect(phase1MttCertificateVerdict(report('passed'))).toMatchObject({
      certified: true,
      kind: 'certified',
    });
  });

  it('keeps a skipped MTT as a non-verdict even when another case passed', () => {
    const verdict = phase1MttCertificateVerdict(report('skipped', 'no eligible natural subject'));
    expect(verdict).toEqual({
      certified: false,
      kind: 'non-verdict',
      detail: 'no eligible natural subject',
    });
  });

  it('refuses a failed or missing exact MTT result', () => {
    expect(phase1MttCertificateVerdict(report('failed'))).toMatchObject({
      certified: false,
      kind: 'failed',
    });
    expect(() => phase1MttCertificateVerdict({ suites: [] })).toThrow(
      'Expected one Phase 1 MTT case'
    );
  });
});
