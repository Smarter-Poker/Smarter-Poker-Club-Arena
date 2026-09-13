#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyClubArenaComponents,
  controlRoot,
  requireControlSource,
} from './classify-club-arena-components.mjs';

const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const fullSha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const need = (value, reason) => {
  if (!value) throw new Error(`Frontend retention refused: ${reason}`);
};
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function publicDocuments(fetchImpl = fetch) {
  const result = {};
  for (const [name, base] of Object.entries({
    origin: 'https://ca-static.smarter.poker',
    public: 'https://smarter.poker/hub/club-arena',
  })) {
    result[name] = {};
    for (const file of ['build-info.json', 'ca-provenance.json']) {
      const response = await fetchImpl(`${base}/${file}?retention=${randomUUID()}`, {
        headers: { 'Cache-Control': 'no-cache' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      need(response.status === 200, 'public provenance unreadable');
      const text = await response.text();
      need(Buffer.byteLength(text) <= 1024 * 1024, 'oversized public provenance');
      result[name][file] = { value: JSON.parse(text), sha256: hash(text) };
    }
  }
  return result;
}
function sourceOf(documents) {
  const source = documents?.origin?.['build-info.json']?.value?.ca_sha;
  need(
    fullSha.test(source ?? '') &&
      !/^0+$/.test(source) &&
      documents?.public?.['build-info.json']?.value?.ca_sha === source,
    'origin and public source disagree'
  );
  return source;
}
export function nativeIdentity(proof) {
  need(
    proof?.schema === 1 &&
      fullSha.test(proof.source_sha ?? '') &&
      digest.test(proof.manifest_sha256 ?? '') &&
      digest.test(proof.build_info_sha256 ?? '') &&
      digest.test(proof.provenance_sha256 ?? '') &&
      Number.isSafeInteger(proof.file_count) &&
      proof.file_count > 2 &&
      [proof.lock?.device, proof.lock?.inode, proof.release?.device, proof.release?.inode].every(
        Number.isSafeInteger
      ),
    'malformed native artifact proof'
  );
  const { observed_at, ...identity } = proof;
  need(
    typeof observed_at === 'string' && Number.isFinite(Date.parse(observed_at)),
    'missing native observation time'
  );
  return identity;
}
export function bindDocuments(documents, proof) {
  const identity = nativeIdentity(proof);
  need(sourceOf(documents) === proof.source_sha, 'native and public sources disagree');
  for (const side of ['origin', 'public']) {
    need(
      documents[side]['build-info.json'].sha256 === identity.build_info_sha256 &&
        documents[side]['ca-provenance.json'].sha256 === identity.provenance_sha256,
      'served documents differ from the existing immutable artifact'
    );
  }
  return identity;
}
export function requirePriorPublication(run, jobs, proof) {
  const id = proof.build_info?.run_id;
  need(
    typeof id === 'string' &&
      /^[1-9][0-9]*$/.test(id) &&
      String(run?.id) === id &&
      run.path === '.github/workflows/publish-club-arena.yml' &&
      run.head_branch === 'main' &&
      ['push', 'repository_dispatch'].includes(run.event) &&
      run.status === 'completed' &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      proof.provenance?.ciRun === `https://github.com/${repository}/actions/runs/${id}`,
    'original trusted publisher run not proven'
  );
  need(
    Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.total_count <= 100,
    'original publisher jobs incomplete'
  );
  const origin = jobs.jobs.filter((job) => job.name === 'publish-to-origin');
  need(
    origin.length === 1 && origin[0].status === 'completed' && origin[0].conclusion === 'success',
    'original origin job not successful'
  );
  const steps = (origin[0].steps ?? []).filter(
    (step) => step.name === 'Verify the origin serves this bundle'
  );
  need(
    steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success',
    'original artifact publication not verified'
  );
  return { run_id: id, run_attempt: run.run_attempt, origin_job_id: origin[0].id };
}
export async function proveExistingArtifact({
  expected,
  readPublic = publicDocuments,
  readNative,
  priorPublication,
}) {
  const before = await readPublic();
  const source = sourceOf(before);
  if (expected) need(expected.source_sha === source, 'retained source changed');
  const first = await readNative(source);
  const identity = bindDocuments(before, first);
  if (expected)
    need(
      JSON.stringify(identity) === JSON.stringify(nativeIdentity(expected)),
      'retained artifact changed'
    );
  const publication = await priorPublication(first);
  const after = await readPublic();
  const second = await readNative(source);
  need(
    JSON.stringify(bindDocuments(after, second)) === JSON.stringify(identity),
    'native artifact changed during proof'
  );
  return { native: second, publication, observed_at: new Date().toISOString() };
}
function nativeRead(source) {
  const host = process.env.ORIGIN_HOST;
  need(
    /^[A-Za-z0-9.-]+$/.test(host ?? '') && fullSha.test(source),
    'invalid fixed native destination'
  );
  const ssh = path.join(process.env.HOME, '.ssh');
  return JSON.parse(
    execFileSync(
      'ssh',
      [
        '-i',
        path.join(ssh, 'ca_origin'),
        '-o',
        `UserKnownHostsFile=${path.join(ssh, 'ca_origin_known_hosts')}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=25',
        '-o',
        'ServerAliveInterval=10',
        '-o',
        'ServerAliveCountMax=2',
        `ci@${host}`,
        'python3',
        '-',
        source,
      ],
      {
        input: readFileSync(path.join(controlRoot, 'scripts/ci/read-native-frontend.py')),
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
  );
}
function github(route) {
  return JSON.parse(
    execFileSync(
      'gh',
      ['api', '--header', 'Cache-Control: no-cache', `repos/${repository}/${route}`],
      {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
  );
}
function priorPublication(proof) {
  const id = proof.build_info?.run_id;
  need(/^[1-9][0-9]*$/.test(id ?? ''), 'invalid prior run');
  return requirePriorPublication(
    github(`actions/runs/${id}`),
    github(`actions/runs/${id}/jobs?filter=latest&per_page=100`),
    proof
  );
}
async function main() {
  const [phase, sourceRoot, targetSha, directory] = process.argv.slice(2);
  need(['classify', 'preview', 'recheck'].includes(phase) && directory, 'invalid command');
  need(process.env.GITHUB_REPOSITORY === repository, 'wrong repository');
  const controlSha = process.env.GITHUB_SHA;
  requireControlSource(controlSha);
  mkdirSync(directory, { recursive: true });
  if (phase === 'classify') {
    const documents = await publicDocuments();
    const beforeSha = sourceOf(documents);
    const decision = classifyClubArenaComponents({ sourceRoot, beforeSha, targetSha, controlSha });
    writeFileSync(
      path.join(directory, 'decision.json'),
      JSON.stringify({
        ...decision,
        source_sha: beforeSha,
        target_sha: targetSha,
        control_sha: controlSha,
      })
    );
    appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${decision.retained}\n`);
    return;
  }
  const decision = JSON.parse(readFileSync(path.join(directory, 'decision.json'), 'utf8'));
  need(
    decision.control_sha === controlSha &&
      decision.target_sha === targetSha &&
      decision.retained === true,
    'missing exact control-only classification'
  );
  const current = classifyClubArenaComponents({
    sourceRoot,
    beforeSha: decision.source_sha,
    targetSha,
    controlSha,
  });
  need(
    current.retained && JSON.stringify(current.changed) === JSON.stringify(decision.changed),
    'source classification changed'
  );
  const preview =
    phase === 'recheck'
      ? JSON.parse(readFileSync(path.join(directory, 'preview.json'), 'utf8'))
      : null;
  if (preview)
    need(
      preview.control_sha === controlSha &&
        preview.target_sha === targetSha &&
        preview.source_sha === decision.source_sha &&
        preview.decision_sha256 === hash(JSON.stringify(decision)),
      'preview identity mismatch'
    );
  const proof = await proveExistingArtifact({
    expected: preview?.native,
    readNative: nativeRead,
    readPublic: publicDocuments,
    priorPublication,
  });
  need(
    proof.native.source_sha === decision.source_sha,
    'serving source changed after classification'
  );
  const receipt = {
    schema: 1,
    retained: true,
    control_sha: controlSha,
    target_sha: targetSha,
    source_sha: decision.source_sha,
    decision_sha256: hash(JSON.stringify(decision)),
    ...proof,
  };
  writeFileSync(
    path.join(directory, `${phase === 'preview' ? 'preview' : 'final'}.json`),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' }
  );
  appendFileSync(process.env.GITHUB_OUTPUT, `retained=true\nsha=${decision.source_sha}\n`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `Retained the existing frontend artifact from \`${decision.source_sha}\` for target \`${targetSha}\`; immutable manifest \`${proof.native.manifest_sha256}\`. All production browser coverage remains required.\n`
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
