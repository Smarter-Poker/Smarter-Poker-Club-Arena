import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

describe('club promo journal native regression is enforced', () => {
  it.each([
    'scripts/ci/test-club-promo-journal-source.py',
    'scripts/ci/fixtures/club-promo-journal-check.sql',
    'scripts/ci/fixtures/club-promo-journal-payment.sql',
    'scripts/ci/fixtures/club-promo-journal-schema.sql',
    'scripts/ci/fixtures/club-promo-journal-seed.sql',
    'scripts/ci/fixtures/club-promo-journal-source.json',
    'scripts/ci/fixtures/club-promo-journal-writers.json',
    'scripts/ci/fixtures/club-promo-journal-declaration.json',
  ])('admits accounting when %s changes alone', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });
  it('runs the actual native proof in required accounting CI', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain(
      'run: python3 scripts/ci/test-club-promo-journal-source.py --pg-bin /usr/lib/postgresql/17/bin'
    );
  });
});
