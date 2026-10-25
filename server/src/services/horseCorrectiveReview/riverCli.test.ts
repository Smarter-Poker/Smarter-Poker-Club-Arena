import { afterEach, describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHorseRiverReference } from '../../scripts/horseRiverReference.js';
import { riverReferenceFixture } from './riverReference.test-support.js';
import { evidenceDigest } from './authority.js';
import { produceRiverCallFoldReference } from './riverReference.js';
import { RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { RIVER_CORRECTION_KERNEL } from './riverKernel.js';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setup = (value: unknown) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'river-reference-'));
  dirs.push(dir);
  const input = join(dir, 'input.json'),
    output = join(dir, 'output.json');
  writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
  return { dir, input, output };
};
describe('explicit private river qualification ingress', () => {
  it('builds the fixed original-state model without requiring future hand records', () => {
    const s = setup({ version: 1, original: riverReferenceFixture().original });
    expect(runHorseRiverReference(['model', s.input, s.output]).code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
      status: 'built',
      prices: { status: 'priced' },
      qualified: false,
      activationAllowed: false,
    });
  });
  it('routes numerical verification through the independent reference', () => {
    const input = riverReferenceFixture(),
      r = produceRiverCallFoldReference(input);
    if (r.status !== 'produced') throw Error(r.reason);
    const s = setup({ version: 1, input, reference: r.reference });
    expect(runHorseRiverReference(['verify', s.input, s.output]).code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
      status: 'numerically_consistent',
      qualified: false,
      activationAllowed: false,
    });
  });
  it.each(['holdout', 'model-holdout'])(
    'invokes %s while preserving its unqualified verdict',
    (mode) => {
      const rows = [0, 1].map((n) => {
        const input = riverReferenceFixture();
        input.binding.decisionDigest = evidenceDigest(['decision', n]);
        input.binding.acceptedHandDigest = evidenceDigest(['accepted', n]);
        return {
          handKey: evidenceDigest(['hand', n]),
          playedAt: '2026-10-25T01:00:00.000Z',
          input,
          baseline: { action: 'fold', amount: 0 },
          baselineDecision: { action: 'fold', thinkTime: 0 },
          oracle: { foldBb: 0, callBb: 48 },
        };
      });
      const s = setup({
        version: 1,
        rows,
        plan: {
          modelVersion: RIVER_DECISION_MODEL.version,
          policyVersion: RIVER_CORRECTION_KERNEL.version,
          sourceRelease: '1'.repeat(40),
          producerDigest: 'a'.repeat(64),
          qualificationId: 'qualification-required',
          evidenceClass: 'synthetic_fixture',
          declaredAt: '2026-10-23T00:00:00.000Z',
          holdoutStartsAt: '2026-10-25T00:00:00.000Z',
          holdoutEndsAt: '2026-10-26T00:00:00.000Z',
          selectionHandKeys: [evidenceDigest('selection')],
          minimumSamples: 2,
          maximumAbsoluteDeltaBb: 5,
          familyWiseAlpha: 0.05,
          familySize: 45,
        },
      });
      expect(runHorseRiverReference([mode, s.input, s.output]).code).toBe(0);
      expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
        status: 'measured',
        samples: 2,
        changed: mode === 'model-holdout' ? 0 : 2,
        qualified: false,
        activationAllowed: false,
      });
    }
  );
  it('writes an unsigned reference privately without leaking source to stdout', () => {
    const s = setup({ version: 1, input: riverReferenceFixture() });
    const result = runHorseRiverReference(['produce', s.input, s.output]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
      status: 'produced',
      qualified: false,
      activationAllowed: false,
    });
    expect(statSync(s.output).mode & 0o777).toBe(0o600);
    for (const secret of ['spades', 'hero', 'original-decision', 'readFrame'])
      expect(result.output).not.toContain(secret);
  });
  it('retains an explicit refusal artifact and a nonzero result', () => {
    const value = riverReferenceFixture();
    value.stage = 'turn';
    const s = setup({ version: 1, input: value });
    expect(runHorseRiverReference(['produce', s.input, s.output]).code).toBe(2);
    expect(JSON.parse(readFileSync(s.output, 'utf8')).status).toBe('unavailable');
  });
  it('never overwrites a previous artifact', () => {
    const s = setup({ version: 1, input: riverReferenceFixture() });
    expect(runHorseRiverReference(['produce', s.input, s.output]).code).toBe(0);
    const bytes = readFileSync(s.output);
    expect(runHorseRiverReference(['produce', s.input, s.output]).code).toBe(3);
    expect(readFileSync(s.output)).toEqual(bytes);
  });
  it('rejects shared private inputs and unspecified paths', () => {
    const s = setup({ version: 1, input: riverReferenceFixture() });
    chmodSync(s.input, 0o644);
    expect(runHorseRiverReference(['produce', s.input, s.output]).code).toBe(3);
    expect(runHorseRiverReference([]).code).toBe(64);
    expect(runHorseRiverReference(['produce', 'relative', 'output']).code).toBe(64);
  });
});
