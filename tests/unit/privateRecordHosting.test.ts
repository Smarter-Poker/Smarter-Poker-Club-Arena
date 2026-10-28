import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  sealGatewayArtifact,
  verifyGatewayArtifact,
  assessClientCoverage,
} from '../../scripts/ci/private-record-gateway-artifact.mjs';
const roots: string[] = [];
function makeWritable(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else chmodSync(path, 0o600);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? '/Volumes/SmarterWork/agent-work', 'private-record-hosting-')
  );
  roots.push(root);
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'dist/privateRecordGateway.js'), 'export const entry = true;');
  return root;
}
const revision = 'a'.repeat(40);
describe('private record artifact and client coverage admission', () => {
  it('seals exact bytes and rejects tampering, extra files and wrong revisions', () => {
    const root = fixture();
    sealGatewayArtifact(root, revision);
    expect(verifyGatewayArtifact(root, revision).revision).toBe(revision);
    expect(() => verifyGatewayArtifact(root, 'b'.repeat(40))).toThrow();
    writeFileSync(join(root, 'dist/privateRecordGateway.js'), 'tampered');
    expect(() => verifyGatewayArtifact(root, revision)).toThrow();
  });
  it('refuses credentials and symlinks before creating a release seal', () => {
    const root = fixture();
    writeFileSync(join(root, '.env'), 'not-a-real-secret');
    expect(() => sealGatewayArtifact(root, revision)).toThrow();
    rmSync(join(root, '.env'));
    symlinkSync('/etc/passwd', join(root, 'node_modules/escape'));
    expect(() => sealGatewayArtifact(root, revision)).toThrow();
  });
  it('does not mistake an empty or sampled inventory for complete legacy coverage', () => {
    expect(assessClientCoverage({ observations: [], errorReporterSample: true }).eligible).toBe(
      false
    );
    expect(assessClientCoverage({}).eligible).toBe(false);
  });
  it('refuses even a complete current census when returning old clients are not protected', () => {
    const result = assessClientCoverage({
      census: { complete: true, unqualified: 0 },
      returningLegacy: { verified: false },
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/returning|resume/i);
  });
});

describe('gateway immutable activation', () => {
  it('keeps the old route when startup fails and refuses stale compare-and-swap', async () => {
    const { activateGateway } =
      await import('../../scripts/ci/private-record-gateway-activate.mjs');
    const root = fixture();
    const runtime = join(root, 'runtime');
    mkdirSync(runtime);
    const old = 'b'.repeat(40);
    symlinkSync(`${old}/listener.sock`, join(runtime, 'active.sock'));
    const artifact = join(root, 'candidate');
    mkdirSync(artifact);
    mkdirSync(join(artifact, 'dist'));
    writeFileSync(join(artifact, 'dist/privateRecordGateway.js'), 'entry');
    writeFileSync(join(artifact, 'package.json'), '{"type":"module"}');
    sealGatewayArtifact(artifact, revision, {
      validationOnly: false,
      builtBy: 'github-actions',
      runId: '17',
      workflowRef:
        'Smarter-Poker/Smarter-Poker-Club-Arena/.github/workflows/publish-club-arena.yml@refs/heads/main',
      workflowSha: 'c'.repeat(40),
    });
    const controller = {
      start: async () => {},
      stop: async () => {},
      probe: async () => {
        throw new Error('candidate unavailable');
      },
    };
    await expect(
      activateGateway({ root, runtime, artifact, revision, expected: old, runId: '17', controller })
    ).rejects.toThrow('candidate unavailable');
    const { readlinkSync } = await import('node:fs');
    expect(readlinkSync(join(runtime, 'active.sock'))).toBe(`${old}/listener.sock`);
    await expect(
      activateGateway({
        root,
        runtime,
        artifact,
        revision,
        expected: 'd'.repeat(40),
        runId: '18',
        controller,
      })
    ).rejects.toThrow();
  });
});

describe('gateway activation commit and recovery', () => {
  async function setup() {
    const { activateGateway } =
      await import('../../scripts/ci/private-record-gateway-activate.mjs');
    const { readlinkSync, existsSync } = await import('node:fs');
    const root = fixture(),
      runtime = join(root, 'runtime'),
      artifact = join(root, 'candidate');
    mkdirSync(runtime);
    mkdirSync(artifact);
    mkdirSync(join(artifact, 'dist'));
    const old = 'b'.repeat(40);
    symlinkSync(`${old}/listener.sock`, join(runtime, 'active.sock'));
    writeFileSync(join(artifact, 'dist/privateRecordGateway.js'), 'entry');
    writeFileSync(join(artifact, 'package.json'), '{"type":"module"}');
    sealGatewayArtifact(artifact, revision, {
      validationOnly: false,
      builtBy: 'github-actions',
      runId: '27',
      workflowRef:
        'Smarter-Poker/Smarter-Poker-Club-Arena/.github/workflows/publish-club-arena.yml@refs/heads/main',
      workflowSha: 'c'.repeat(40),
    });
    const calls: string[] = [];
    const controller = {
      start: async () => {
        calls.push('start');
      },
      stop: async () => {
        calls.push('stop');
      },
      probe: async () => {},
      publicProbe: async () => {},
      retire: async () => {
        calls.push('retire');
      },
    };
    return {
      root,
      runtime,
      artifact,
      old,
      controller,
      calls,
      readlinkSync,
      existsSync,
      run: () =>
        activateGateway({
          root,
          runtime,
          artifact,
          revision,
          expected: old,
          runId: '27',
          controller,
        }),
    };
  }
  it('commits only after public proof and retires the predecessor', async () => {
    const f = await setup();
    await expect(f.run()).resolves.toMatchObject({
      phase: 'verified',
      retirement: 'draining-existing-peers',
    });
    expect(JSON.parse(readFileSync(join(f.root, 'active-release.json'), 'utf8')).revision).toBe(
      revision
    );
    expect(f.readlinkSync(join(f.runtime, 'active.sock'))).toBe(`${revision}/listener.sock`);
    expect(f.calls).toEqual(['start', 'retire']);
    expect(f.existsSync(join(f.root, 'activation.lock'))).toBe(false);
  });
  it('restores the predecessor when public verification fails', async () => {
    const f = await setup();
    f.controller.publicProbe = async () => {
      throw new Error('public unavailable');
    };
    await expect(f.run()).rejects.toThrow('public unavailable');
    expect(f.readlinkSync(join(f.runtime, 'active.sock'))).toBe(`${f.old}/listener.sock`);
    expect(f.existsSync(join(f.root, 'active-release.json'))).toBe(false);
    expect(f.calls).toEqual(['start', 'stop']);
  });
  it('reports failed predecessor retirement without rolling back the committed route', async () => {
    const f = await setup();
    f.controller.retire = async () => {
      throw new Error('signal refused');
    };
    await expect(f.run()).rejects.toThrow('gateway is committed');
    expect(f.readlinkSync(join(f.runtime, 'active.sock'))).toBe(`${revision}/listener.sock`);
    expect(JSON.parse(readFileSync(join(f.root, 'active-release.json'), 'utf8')).revision).toBe(
      revision
    );
    expect(JSON.parse(readFileSync(join(f.root, 'activation-27.json'), 'utf8')).retirement).toBe(
      'requires-explicit-recovery'
    );
    expect(f.calls).toEqual(['start']);
  });
});

describe('hosting qualification remains enforced', () => {
  it('requires real hosting inputs to execute native accounting qualification', async () => {
    const { classifyChangedPaths } = await import('../../scripts/ci/classify-ci-changes.mjs');
    for (const path of [
      'infra/ca-origin/Caddyfile',
      'infra/ca-origin/ca-private-record-gateway@.service',
      'infra/ca-origin/ca-private-record-gateway-activate',
      'scripts/ci/build-private-record-gateway.sh',
      'scripts/ci/private-record-gateway-artifact.mjs',
      'server/scripts/privateRecordGatewayCaddy.mts',
      'server/tsconfig.private-record-gateway.json',
    ])
      expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
    const { parse } = await import('yaml');
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const owners = workflow.jobs.accounting_postgres.steps.filter(
      (step: any) => step.run === 'bash scripts/ci/test-private-record-hosting.sh'
    );
    expect(owners).toHaveLength(1);
    expect(owners[0].if).toBe('matrix.shard == 2');
    expect(owners[0]['continue-on-error']).toBeUndefined();
  });
  it('does not accept a different repository identity in a verified signing result', async () => {
    const { verifyAttestationIdentity } =
      await import('../../scripts/ci/private-record-gateway-activate.mjs');
    expect(() =>
      verifyAttestationIdentity([
        { verificationResult: { signature: { certificate: { sourceRepositoryIdentifier: '1' } } } },
      ])
    ).toThrow();
    expect(() => verifyAttestationIdentity([])).toThrow();
    expect(() =>
      verifyAttestationIdentity([
        {
          verificationResult: {
            signature: { certificate: { sourceRepositoryIdentifier: '1132369872' } },
          },
        },
      ])
    ).not.toThrow();
  });
});
