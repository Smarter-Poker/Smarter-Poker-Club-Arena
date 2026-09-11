#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
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
const need = (value, reason) => {
  if (!value) throw new Error(`Frontend retention refused: ${reason}`);
};
export {
  hash,
  publicDocuments,
  nativeIdentity,
  bindDocuments,
  requirePriorPublication,
  proveExistingArtifact,
} from '../../operations/release/frontend-artifact-proof.mjs';
import {
  hash,
  publicDocuments,
  sourceOf,
  requirePriorPublication,
  proveExistingArtifact,
} from '../../operations/release/frontend-artifact-proof.mjs';
export function nativeRead(source) {
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
        input: readFileSync(
          path.join(controlRoot, 'operations/release/native/read-native-frontend.py')
        ),
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
