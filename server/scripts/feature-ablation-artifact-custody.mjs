/** Authenticate downloaded scientific files against the original provider ZIP.
 * Streaming limits are explicit; no archive path is ever extracted to disk. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const LIMIT = 2 * 1024 ** 3;
async function hashStream(stream) {
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of stream) {
    count += chunk.length;
    if (count > LIMIT) throw Error('artifact_member_size_bound');
    hash.update(chunk);
  }
  return hash.digest('hex');
}
export async function verifyOriginalFeatureArtifact(zip, directory) {
  const members = execFileSync('unzip', ['-Z1', zip], {
    encoding: 'utf8',
    maxBuffer: 65536,
    timeout: 20000,
  })
    .trim()
    .split('\n');
  const allowed = new Set([
    'attempt.json',
    'result.json',
    'raw-pairs.jsonl.gz',
    'evaluation.log',
    'jobs.json',
  ]);
  if (
    !members.length ||
    members.length > 5 ||
    new Set(members).size !== members.length ||
    members.some((m) => !allowed.has(m)) ||
    !members.includes('attempt.json') ||
    JSON.stringify([...readdirSync(directory)].sort()) !== JSON.stringify([...members].sort())
  )
    throw Error('artifact_members_changed');
  for (const member of members) {
    const local = join(directory, member);
    if (!lstatSync(local).isFile() || lstatSync(local).size > LIMIT)
      throw Error('artifact_member_not_regular');
    const child = spawn('unzip', ['-p', zip, member], { stdio: ['ignore', 'pipe', 'ignore'] });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    const timer = setTimeout(() => child.kill(), 120000);
    try {
      const [original, copied] = await Promise.all([
        hashStream(child.stdout),
        hashStream(createReadStream(local)),
      ]);
      if ((await exit) !== 0 || original !== copied) throw Error('artifact_original_bytes_changed');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  }
}
export async function authenticateFeatureArtifacts(runs, target, runId) {
  const repo = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN,
    scratch = process.env.RUNNER_TEMP;
  if (
    repo !== 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena' ||
    process.env.GITHUB_REPOSITORY_ID !== '1132369872' ||
    !token ||
    !scratch ||
    !/^\d+$/.test(String(runId))
  )
    throw Error('artifact_provider_unavailable');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const artifacts = [];
  for (let page = 1; page <= 30; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      { headers, signal: AbortSignal.timeout(20000) }
    );
    if (!response.ok) throw Error('artifact_inventory_unavailable');
    const body = await response.json();
    if (!Array.isArray(body.artifacts)) throw Error('artifact_inventory_shape');
    artifacts.push(...body.artifacts.filter((a) => a.name.startsWith(`fa-${target}-`)));
    if (body.artifacts.length < 100) break;
    if (page === 30) throw Error('artifact_inventory_bound');
  }
  const local = readdirSync(runs).sort();
  if (
    new Set(artifacts.map((a) => a.name)).size !== artifacts.length ||
    JSON.stringify(artifacts.map((a) => a.name).sort()) !== JSON.stringify(local)
  )
    throw Error('artifact_inventory_changed');
  for (const artifact of artifacts) {
    if (
      artifact.expired ||
      !Number.isSafeInteger(artifact.id) ||
      !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
      artifact.workflow_run?.id !== Number(runId)
    )
      throw Error('artifact_identity_refused');
    const directory = await mkdtemp(join(scratch, 'feature-artifact-'));
    try {
      const zip = join(directory, 'original.zip');
      const response = await fetch(
        `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
        { headers, signal: AbortSignal.timeout(120000) }
      );
      if (!response.ok || !response.body) throw Error('artifact_download_unavailable');
      const hash = createHash('sha256');
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _, done) {
            bytes += chunk.length;
            if (bytes > LIMIT) return done(Error('artifact_size_bound'));
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(zip, { flags: 'wx' })
      );
      if (`sha256:${hash.digest('hex')}` !== artifact.digest)
        throw Error('artifact_provider_digest_changed');
      const localDirectory = join(runs, artifact.name);
      if (!lstatSync(localDirectory).isDirectory() || lstatSync(localDirectory).isSymbolicLink())
        throw Error('artifact_directory_refused');
      await verifyOriginalFeatureArtifact(zip, localDirectory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
