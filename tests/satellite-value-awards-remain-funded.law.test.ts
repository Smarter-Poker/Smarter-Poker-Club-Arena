import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Prospective satellite value-ticket financial qualification', () => {
  it('runs the actual isolated money proof in the required accounting aggregate', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const start = ci.indexOf(
      '      - name: Satellite awards retain reusable same-value ticket backing'
    );
    expect(start).toBeGreaterThan(0);
    const step = ci.slice(
      start,
      ci.indexOf('      - name: Retain reusable satellite ticket financial proof', start)
    );
    expect(step).toContain('if: matrix.shard == 4');
    expect(step).toContain('python3 -B scripts/ci/test-satellite-value-awards.py');
    expect(step).not.toContain('continue-on-error');
    expect(ci).toContain('name: Retain reusable satellite ticket financial proof');
    expect(ci).toContain('needs.accounting_postgres.result');
  });
});
