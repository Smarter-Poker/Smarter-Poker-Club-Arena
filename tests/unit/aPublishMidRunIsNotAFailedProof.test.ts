/**
 * A PUBLISH THAT LANDS MID-RUN IS NOT A FAILED PROOF (2026-10-26).
 *
 * Post-deploy run 40242809027 failed tests/e2e/production-notifications.spec.ts
 * with "Expected 09ea5c49... Received 96818b8b...": every product assertion had
 * passed, a newer publish landed while the proof ran, and the run reported the
 * notifications surface broken. A changed release now stands the proof down as
 * a named non-verdict after cleanup. These cases pin that shape in the spec,
 * which itself only runs against production.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const spec = readFileSync(resolve(__dirname, '../e2e/production-notifications.spec.ts'), 'utf8');
const proofs = spec.split(/\ntest\(/).slice(1);

describe('a release replaced mid-run stands a notification proof down', () => {
  it('has the two production proofs', () => {
    expect(proofs).toHaveLength(2);
  });

  it('never asserts the ending release equals the starting one', () => {
    expect(spec).not.toMatch(/ca_sha\)\.toBe\((selected|clientSha)\)/);
  });

  it.each([0, 1])('proof %i reads the release at both ends and certifies only one', (i) => {
    const body = proofs[i];
    expect(body).toMatch(/= await servedRelease\(page\);/);
    expect(body).toContain('served = await servedRelease(page);');
    expect(body).toMatch(/if \(served === (selected|clientSha)\)\s+await testInfo\.attach\(/);
  });

  it.each([0, 1])('proof %i stands down only after its cleanup has run', (i) => {
    const body = proofs[i];
    const standDown = body.lastIndexOf('await standDownIfReplaced(');
    expect(standDown).toBeGreaterThan(body.lastIndexOf('finally'));
    // Cleanup failures are real failures and are reported first.
    if (body.includes('AggregateError')) {
      expect(standDown).toBeGreaterThan(body.indexOf('AggregateError'));
    }
  });

  it('records the stand-down as a named non-verdict, never a silent skip', () => {
    expect(spec).toContain("import { recordNonVerdict } from './support/nonVerdict';");
    const helper = spec.slice(spec.indexOf('async function standDownIfReplaced'));
    expect(helper).toContain('if (ended === undefined || ended === began) return;');
    expect(helper.indexOf('recordNonVerdict(')).toBeLessThan(helper.indexOf('test.skip(true'));
  });
});
