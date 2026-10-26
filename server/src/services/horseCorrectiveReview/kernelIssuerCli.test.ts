import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const control = vi.hoisted(() => ({
  declared: true,
  transport: true,
  source: '1'.repeat(40),
  produceCalls: 0,
  issueCalls: 0,
  readCalls: 0,
  issue: false,
  identityCalls: 0,
}));
vi.mock('./kernelPredeclaration.js', () => ({
  readCorrectivePredeclaration: () => {
    control.readCalls++;
    return control.declared
      ? {
          status: 'authenticated_predeclaration',
          predeclaration: {
            plan: { sourceRelease: control.source },
            custodyDigest: 'a'.repeat(64),
          },
        }
      : { status: 'unavailable', reason: 'predeclaration_provider_unavailable' };
  },
}));
vi.mock('./journalTransport.js', () => ({
  createAuthenticatedHorseJournalReader: () => async (keys: string[]) => {
    expect(keys).toEqual([]);
    return {
      status: 'authenticated_journal_batch',
      sourceRelease: control.source,
      runtime: { node: 'v22.20.0', v8: '12.4.unit', arch: 'x64' },
      recordsByHand: [],
    };
  },
  isAuthenticatedHorseJournalBatch: () => control.transport,
}));
vi.mock('./kernelIssuer.js', () => ({
  produceCorrectiveKernelSource: async () => {
    control.produceCalls++;
    return {
      status: 'produced_unsigned_population',
      producerRequestsDigest: 'b'.repeat(64),
      qualified: false,
      activationAllowed: false,
    };
  },
  createCorrectiveKernelIssuer: () => async () => {
    control.issueCalls++;
    return control.issue
      ? {
          status: 'issued_qualification',
          qualification: {
            schema: 'horse-phase14-kernel-qualification-v1',
            catalog: { unit: 'no-production-evidence' },
            approval: { unit: 'no-production-evidence' },
          },
          activationAllowed: false,
        }
      : {
          status: 'unavailable',
          reason: 'issuer_independent_holdout_not_qualified',
          qualified: false,
          activationAllowed: false,
        };
  },
}));
vi.mock('./kernelSignerIdentity.js', () => ({
  probeCorrectiveKernelSignerIdentity: () => {
    control.identityCalls++;
    return {
      status: 'signer_identity_verified',
      identityVerified: true,
      publicKeySha256: 'd'.repeat(64),
      qualified: false,
      activationAllowed: false,
    };
  },
}));
import { runHorseCorrectiveKernelIssue } from '../../scripts/horseCorrectiveKernelIssue.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  Object.assign(control, {
    declared: true,
    transport: true,
    produceCalls: 0,
    issueCalls: 0,
    readCalls: 0,
    issue: false,
    identityCalls: 0,
  });
});
function setup(issue = false) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'kernel-issuer-cli-'));
  dirs.push(dir);
  const input = join(dir, 'input.json'),
    output = join(dir, 'output.json');
  const value = {
    version: 1,
    predeclaration: {
      commitSha: '2'.repeat(40),
      path: 'docs/evidence/phase14/plans/unit.json',
      contentSha256: 'c'.repeat(64),
    },
    ...(issue ? { scratchRoot: dir, producerRequestsDigest: 'b'.repeat(64) } : {}),
  };
  writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
  return { dir, input, output, value };
}
describe('explicit finite qualification operator routing', () => {
  it('runs credential identity only for the fixed empty protocol, without source or issuer gates', async () => {
    const s = setup();
    writeFileSync(s.input, JSON.stringify({ version: 1 }));
    const result = await runHorseCorrectiveKernelIssue(['identity', s.input, s.output], {});
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
      identityVerified: true,
      qualified: false,
      activationAllowed: false,
    });
    expect(control.readCalls).toBe(0);
    expect(control.produceCalls).toBe(0);
    expect(control.issueCalls).toBe(0);
    const forged = setup();
    writeFileSync(forged.input, JSON.stringify({ version: 1, challenge: 'kernel-approval' }));
    expect(
      (await runHorseCorrectiveKernelIssue(['identity', forged.input, forged.output], {})).code
    ).toBe(3);
    expect(existsSync(forged.output)).toBe(false);
  });

  it('uses only an empty-key authenticated runtime probe for context and writes private metadata', async () => {
    const s = setup(),
      result = await runHorseCorrectiveKernelIssue(['context', s.input, s.output], {});
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
      status: 'qualification_context',
      sourceRelease: control.source,
      runtime: { arch: 'x64' },
    });
    expect(statSync(s.output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(result.output)).toEqual({
      status: 'qualification_context',
      outputWritten: true,
      activationAllowed: false,
    });
    expect(control.issueCalls).toBe(0);
  });
  it('routes source production without issuing and preserves unknown provider/runtime outcomes', async () => {
    const p = setup();
    expect((await runHorseCorrectiveKernelIssue(['produce', p.input, p.output], {})).code).toBe(0);
    expect(control.produceCalls).toBe(1);
    expect(control.issueCalls).toBe(0);
    control.declared = false;
    const c = setup();
    expect((await runHorseCorrectiveKernelIssue(['context', c.input, c.output], {})).code).toBe(2);
    expect(JSON.parse(readFileSync(c.output, 'utf8'))).toMatchObject({
      status: 'unavailable',
      reason: 'predeclaration_provider_unavailable',
    });
    control.declared = true;
    control.transport = false;
    const r = setup();
    expect((await runHorseCorrectiveKernelIssue(['context', r.input, r.output], {})).code).toBe(2);
  });
  it('writes the actual bare qualification file only for an issued result, otherwise keeps the refusal', async () => {
    const unavailable = setup(true);
    expect(
      (await runHorseCorrectiveKernelIssue(['issue', unavailable.input, unavailable.output], {}))
        .code
    ).toBe(2);
    expect(JSON.parse(readFileSync(unavailable.output, 'utf8'))).toMatchObject({
      status: 'unavailable',
      qualified: false,
    });
    control.issue = true;
    const issued = setup(true);
    expect(
      (await runHorseCorrectiveKernelIssue(['issue', issued.input, issued.output], {})).code
    ).toBe(0);
    const saved = JSON.parse(readFileSync(issued.output, 'utf8'));
    expect(saved.schema).toBe('horse-phase14-kernel-qualification-v1');
    expect(saved.status).toBeUndefined();
  });
  it('refuses existing output or caller case/catalog/qualified inputs before acquisition or key service', async () => {
    const old = setup(true);
    writeFileSync(old.output, 'retained', { mode: 0o600 });
    expect((await runHorseCorrectiveKernelIssue(['issue', old.input, old.output], {})).code).toBe(
      3
    );
    expect(readFileSync(old.output, 'utf8')).toBe('retained');
    for (const extra of [{ qualified: true }, { cases: [] }, { catalog: {} }]) {
      const s = setup(true);
      writeFileSync(s.input, JSON.stringify({ ...s.value, ...extra }));
      expect((await runHorseCorrectiveKernelIssue(['issue', s.input, s.output], {})).code).toBe(3);
      expect(existsSync(s.output)).toBe(false);
    }
    expect(control.readCalls).toBe(0);
    expect(control.issueCalls).toBe(0);
  });
  it('requires one explicit mode and two absolute paths and never accepts a signer override', async () => {
    const s = setup();
    for (const args of [
      [],
      ['issue', 'relative', 'out'],
      ['sign', s.input, s.output],
      ['issue', s.input, s.output, '--allow-synthetic'],
    ])
      expect((await runHorseCorrectiveKernelIssue(args, {})).code).toBe(64);
    expect(control.issueCalls).toBe(0);
  });
});
