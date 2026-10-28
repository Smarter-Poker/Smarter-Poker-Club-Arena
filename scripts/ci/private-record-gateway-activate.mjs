import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  rmSync,
  cpSync,
  existsSync,
  lstatSync,
  chmodSync,
  openSync,
  fstatSync,
  constants,
  mkdtempSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { get } from 'node:http';
import { pathToFileURL } from 'node:url';
import { verifyGatewayArtifact } from './private-record-gateway-artifact.mjs';
import { gatewayMachineIdSha256 } from './private-record-gateway-host-identity.mjs';
const workflow =
  'Smarter-Poker/Smarter-Poker-Club-Arena/.github/workflows/publish-club-arena.yml@refs/heads/main';
const fullSha = (value) => /^[0-9a-f]{40}$/.test(value ?? '');
function durableJson(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const file = openSync(temporary, 'r');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function makeReadOnly(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) makeReadOnly(path);
    else chmodSync(path, 0o444);
  }
  chmodSync(directory, 0o555);
}
function served(runtime) {
  const path = join(runtime, 'active.sock');
  if (!existsSync(path) && !lstatMaybe(path)) return null;
  const target = readlinkSync(path);
  if (!/^[0-9a-f]{40}\/listener\.sock$/.test(target))
    throw new Error('unrecognized existing gateway socket owner');
  return target.slice(0, 40);
}
function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function switchSocket(runtime, revision) {
  const temporary = join(runtime, `.active.${randomUUID()}`);
  symlinkSync(`${revision}/listener.sock`, temporary);
  renameSync(temporary, join(runtime, 'active.sock'));
  const directory = openSync(runtime, 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
/** Caller owns one operation. No automatic replay, watcher, engine action or source toggle. */
export async function activateGateway({
  root,
  runtime,
  artifact,
  revision,
  expected,
  runId,
  controller,
}) {
  if (!fullSha(revision) || (expected !== null && !fullSha(expected)) || !/^\d+$/.test(runId ?? ''))
    throw new Error('invalid activation identity');
  if (served(runtime) !== expected) throw new Error('gateway compare-and-swap predecessor changed');
  const receipt = verifyGatewayArtifact(artifact, revision);
  if (
    receipt.provenance?.validationOnly !== false ||
    receipt.provenance.builtBy !== 'github-actions' ||
    receipt.provenance.workflowRef !== workflow ||
    receipt.provenance.runId !== runId ||
    !fullSha(receipt.provenance.workflowSha)
  )
    throw new Error('hosted protected-main artifact provenance required');
  if (revision === expected) {
    await controller.probe(join(runtime, 'active.sock'), revision);
    return { revision, expected, runId, phase: 'already-active' };
  }
  const lock = join(root, 'activation.lock');
  mkdirSync(lock, { mode: 0o700 });
  const operation = join(root, `activation-${runId}.json`);
  if (existsSync(operation)) {
    rmSync(lock, { recursive: true });
    throw new Error('existing operation must be recovered, never replayed');
  }
  let switched = false;
  let completed = false;
  const state = { revision, expected, runId, phase: 'prepared' };
  try {
    durableJson(operation, state);
    const releases = join(root, 'releases');
    mkdirSync(releases, { recursive: true, mode: 0o755 });
    const release = join(releases, revision);
    if (!existsSync(release)) {
      const stage = join(releases, `.candidate.${randomUUID()}`);
      try {
        cpSync(artifact, stage, { recursive: true, dereference: false });
        verifyGatewayArtifact(stage, revision);
        makeReadOnly(stage);
        renameSync(stage, release);
      } finally {
        if (existsSync(stage)) rmSync(stage, { recursive: true });
      }
    } else verifyGatewayArtifact(release, revision);
    mkdirSync(join(runtime, revision), { recursive: true, mode: 0o750 });
    if (!lstatSync(join(runtime, revision)).isDirectory())
      throw new Error('gateway runtime revision must be a real directory');
    await controller.start(revision);
    state.phase = 'started';
    durableJson(operation, state);
    await controller.probe(join(runtime, revision, 'listener.sock'), revision);
    if (served(runtime) !== expected)
      throw new Error('gateway predecessor changed before activation');
    switchSocket(runtime, revision);
    switched = true;
    state.phase = 'switched';
    durableJson(operation, state);
    await controller.probe(join(runtime, 'active.sock'), revision);
    if (controller.publicProbe) await controller.publicProbe(revision);
    state.phase = 'verified';
    durableJson(operation, state);
    durableJson(join(root, 'active-release.json'), { revision, runId, state: 'verified' });
    completed = true;
    if (expected && controller.retire) {
      try {
        await controller.retire(expected);
        state.retirement = 'draining-existing-peers';
      } catch (error) {
        state.retirement = 'requires-explicit-recovery';
        state.retirementError = error.message;
      }
      durableJson(operation, state);
      if (state.retirement === 'requires-explicit-recovery')
        throw new Error(
          'verified route retained; predecessor retirement requires explicit recovery'
        );
    }
    return state;
  } catch (error) {
    if (completed)
      throw new Error(
        'gateway is committed; retirement/receipt recovery is required without rolling back the verified route'
      );
    // Restore only our own pointer. A different writer's route is never overwritten.
    if (switched) {
      if (served(runtime) !== revision)
        throw new Error('gateway route changed during failure; requires explicit recovery');
      if (expected === null) rmSync(join(runtime, 'active.sock'));
      else switchSocket(runtime, expected);
    }
    try {
      await controller.stop(revision);
    } catch (stopError) {
      state.phase = 'recovery-required';
      state.failure = error.message;
      state.stopFailure = stopError.message;
      durableJson(operation, state);
      throw new Error('gateway route restored but candidate retirement requires explicit recovery');
    }
    state.phase = 'rolled-back';
    state.failure = error.message;
    durableJson(operation, state);
    completed = true;
    throw error;
  } finally {
    if (completed) rmSync(lock, { recursive: true });
  }
}
function probe(socketPath, revision) {
  return new Promise((resolve, reject) => {
    const req = get({ socketPath, path: '/health' }, (res) => {
      let body = '';
      res.on('data', (data) => {
        body += data;
        if (body.length > 4096) req.destroy(new Error('gateway health oversized'));
      });
      res.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (
            res.statusCode !== 200 ||
            value.service !== 'private-record-gateway' ||
            value.revision !== revision ||
            value.sourceReady !== true
          )
            throw new Error('gateway source/revision not ready');
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('gateway health timeout')));
  });
}
async function boundedProbe(socketPath, revision) {
  const until = Date.now() + 45000;
  let failure;
  do {
    try {
      return await probe(socketPath, revision);
    } catch (error) {
      failure = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  } while (Date.now() < until);
  throw failure;
}
export function verifyAttestationIdentity(verified) {
  if (
    !Array.isArray(verified) ||
    !verified.length ||
    verified.some(
      (item) =>
        String(item?.verificationResult?.signature?.certificate?.sourceRepositoryIdentifier) !==
        '1132369872'
    )
  )
    throw new Error('wrong attested repository identity');
}
function pinnedCopy(source, destination, limit) {
  const file = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > limit) throw new Error('invalid transfer file');
    writeFileSync(destination, readFileSync(file), { flag: 'wx', mode: 0o600 });
  } finally {
    closeSync(file);
  }
}
function verifiedTransfer(root, stageName) {
  const stage = mkdtempSync(join(root, '.verified-transfer.'));
  try {
    for (const [name, limit] of [
      ['runtime.tar.gz', 128 * 1024 * 1024],
      ['attestation.jsonl', 4 * 1024 * 1024],
    ])
      pinnedCopy(join(root, 'incoming', stageName, name), join(stage, name), limit);
    const verified = JSON.parse(
      execFileSync(
        '/usr/bin/gh',
        [
          'attestation',
          'verify',
          join(stage, 'runtime.tar.gz'),
          '--bundle',
          join(stage, 'attestation.jsonl'),
          '--custom-trusted-root',
          '/etc/club-arena/github-actions-trusted-root.jsonl',
          '--repo',
          'Smarter-Poker/Smarter-Poker-Club-Arena',
          '--cert-identity',
          'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/.github/workflows/publish-club-arena.yml@refs/heads/main',
          '--source-ref',
          'refs/heads/main',
          '--deny-self-hosted-runners',
          '--format',
          'json',
        ],
        { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024 }
      )
    );
    verifyAttestationIdentity(verified);
    const artifact = join(stage, 'artifact');
    mkdirSync(artifact, { mode: 0o700 });
    execFileSync('/usr/bin/python3', ['-', join(stage, 'runtime.tar.gz'), artifact], {
      timeout: 30000,
      input: `import tarfile,pathlib,sys,shutil
root=pathlib.Path(sys.argv[2]); seen=set(); total=0
with tarfile.open(sys.argv[1],'r:gz') as archive:
 for member in archive:
  path=pathlib.PurePosixPath(member.name)
  if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()): raise RuntimeError('unsafe archive member')
  if str(path)=='.': continue
  if str(path) in seen or len(seen)>=50000: raise RuntimeError('duplicate/oversized inventory')
  seen.add(str(path)); total+=member.size
  if total>256*1024*1024: raise RuntimeError('archive exceeds expansion budget')
  target=root.joinpath(*path.parts)
  if member.isdir(): target.mkdir(parents=True,exist_ok=True); continue
  target.parent.mkdir(parents=True,exist_ok=True)
  with archive.extractfile(member) as source, target.open('xb') as destination: shutil.copyfileobj(source,destination)
`,
    });
    return { stage, artifact };
  } catch (error) {
    rmSync(stage, { recursive: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.getuid?.() !== 0)
    throw new Error('the preinstalled host-owned activation helper must run as root');
  const [stageName, revision, expectedText, runId] = process.argv.slice(2);
  if (
    !new RegExp(`^${revision}\\.${runId}\\.[0-9]+$`).test(stageName ?? '') ||
    !fullSha(revision) ||
    !/^\d+$/.test(runId ?? '')
  )
    throw new Error('invalid staged operation');
  const root = '/srv/ca-private-record-gateway',
    runtime = '/run/ca-private-record-gateway';
  for (const directory of [root, runtime, join(root, 'releases')]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      throw new Error('gateway service roots must be root-owned and not writable by the publisher');
  }
  const configPath = '/etc/club-arena/private-record-gateway-host.json';
  for (const path of [configPath, '/etc/club-arena/private-record-gateway.env']) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0)
      throw new Error('host configuration must be root-owned and private');
  }
  const trustedRoot = lstatSync('/etc/club-arena/github-actions-trusted-root.jsonl');
  if (!trustedRoot.isFile() || trustedRoot.uid !== 0 || (trustedRoot.mode & 0o022) !== 0)
    throw new Error('attestation trust roots must be root-owned and immutable to the publisher');
  const host = JSON.parse(readFileSync(configPath, 'utf8'));
  const actual = gatewayMachineIdSha256(readFileSync('/etc/machine-id'));
  if (
    !/^[0-9a-f]{64}$/.test(host.engineMachineIdSha256 ?? '') ||
    host.originMachineIdSha256 !== actual ||
    host.engineMachineIdSha256 === actual ||
    host.independentHostVerified !== true
  )
    throw new Error('independent host identity is unqualified');
  const run = (verb, id) =>
    execFileSync('/usr/bin/systemctl', [verb, `ca-private-record-gateway@${id}.service`], {
      stdio: 'inherit',
      timeout: 20000,
    });
  const transfer = verifiedTransfer(root, stageName);
  try {
    await activateGateway({
      root,
      runtime,
      artifact: transfer.artifact,
      revision,
      expected: expectedText === 'none' ? null : expectedText,
      runId,
      controller: {
        start: async (id) => {
          execFileSync('/usr/bin/chown', ['ca-record-gateway:caddy', join(runtime, id)], {
            timeout: 5000,
          });
          run('start', id);
        },
        stop: async (id) => run('stop', id),
        retire: async (id) =>
          execFileSync(
            '/usr/bin/systemctl',
            [
              'kill',
              '--kill-whom=main',
              '--signal=SIGUSR2',
              `ca-private-record-gateway@${id}.service`,
            ],
            { stdio: 'inherit', timeout: 5000 }
          ),
        probe: boundedProbe,
        publicProbe: async (revision) => {
          const response = await fetch('https://ca-static.smarter.poker/private-record/health', {
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
            headers: { 'Cache-Control': 'no-cache' },
          });
          if (!response.ok) throw new Error('public gateway route unavailable');
          const health = await response.json();
          if (
            health.service !== 'private-record-gateway' ||
            health.revision !== revision ||
            health.sourceReady !== true
          )
            throw new Error('public gateway identity/source mismatch');
        },
      },
    });
  } finally {
    rmSync(transfer.stage, { recursive: true });
  }
  console.log(
    JSON.stringify({
      component: 'private-record-gateway',
      revision,
      runId,
      state: 'activated-source-ready',
      cutoverQualified: false,
    })
  );
}
