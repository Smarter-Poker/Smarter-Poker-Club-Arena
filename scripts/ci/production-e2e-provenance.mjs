#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The publisher selects current main after its trigger; its artifact records that choice. */
export function readPublisherArtifactSha(raw, runId, triggerSha, repositoryId) {
  if (
    !/^[1-9][0-9]*$/.test(runId) ||
    !FULL_SHA.test(triggerSha) ||
    !/^[1-9][0-9]*$/.test(repositoryId)
  ) {
    throw new Error(
      'Publisher provenance requires an exact run id, full trigger SHA and repository id.'
    );
  }
  let payload;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    throw new Error('Publisher artifacts response is not valid JSON.');
  }
  if (
    !payload ||
    !Array.isArray(payload.artifacts) ||
    !Number.isSafeInteger(payload.total_count) ||
    payload.total_count !== payload.artifacts.length
  ) {
    throw new Error('Publisher artifacts response is missing or incomplete.');
  }
  const bundles = payload.artifacts.filter(
    (artifact) => typeof artifact?.name === 'string' && artifact.name.startsWith('club-arena-dist-')
  );
  if (bundles.length !== 1) {
    throw new Error(`Expected one publisher client artifact, received ${bundles.length}.`);
  }
  const artifact = bundles[0];
  const selected = artifact.name.slice('club-arena-dist-'.length);
  const source = artifact.workflow_run;
  const exactId = (actual, expected) =>
    Number.isSafeInteger(actual) && actual > 0 && String(actual) === expected;
  if (
    !FULL_SHA.test(selected) ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    !source ||
    !exactId(source.id, runId) ||
    source.head_sha !== triggerSha ||
    source.head_branch !== 'main' ||
    !exactId(source.repository_id, repositoryId) ||
    !exactId(source.head_repository_id, repositoryId)
  ) {
    throw new Error('The client artifact does not prove this exact main-branch publisher run.');
  }
  return selected;
}

export function readReadyEngineSha(raw) {
  let value;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new Error('Production engine health is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Production engine health must be one JSON object.');
  }
  if (!Object.hasOwn(value, 'releaseSha') || !FULL_SHA.test(value.releaseSha)) {
    throw new Error('Production engine health must contain one full lowercase releaseSha.');
  }
  if (value.running !== true || value.liveness !== 'ok') {
    throw new Error('The exact production engine is not running with healthy liveness.');
  }
  return value.releaseSha;
}

export function requireReadyEngineSha(raw, expected) {
  if (!FULL_SHA.test(expected)) {
    throw new Error('The expected engine provenance must be one full lowercase SHA.');
  }
  const actual = readReadyEngineSha(raw);
  if (actual !== expected) {
    throw new Error(
      `Production engine ${actual} has not reached required ${expected}; this run cannot begin certification.`
    );
  }
  return actual;
}

export function readBuildInfoSha(raw) {
  let value;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new Error('Production build-info.json is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Production build-info.json must be one JSON object.');
  }
  if (!Object.hasOwn(value, 'ca_sha') || !FULL_SHA.test(value.ca_sha)) {
    throw new Error('Production build-info.json must contain one full lowercase ca_sha.');
  }
  return value.ca_sha;
}

export function requireUnchangedBuildInfoSha(raw, expected) {
  if (!FULL_SHA.test(expected)) {
    throw new Error('The expected production provenance must be one full lowercase SHA.');
  }
  const actual = readBuildInfoSha(raw);
  if (actual !== expected) {
    throw new Error(
      `Production changed from ${expected} to ${actual} during certification; this run cannot certify one exact release.`
    );
  }
  return actual;
}

export function classifyTrustedLineage(live, here, evidence) {
  if (!FULL_SHA.test(live) || !FULL_SHA.test(here)) {
    throw new Error('Production and checkout provenance must both be full lowercase SHAs.');
  }
  if (live === here) return 'same';
  if (!evidence.commitExists(live)) {
    throw new Error(`Production SHA ${live} does not resolve to a trusted repository commit.`);
  }
  if (!evidence.isAncestor(live, here)) {
    throw new Error(`Production SHA ${live} is not an ancestor of checkout ${here}.`);
  }
  return 'ancestor';
}

function gitSucceeds(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function classifyRepositoryLineage(live, here) {
  return classifyTrustedLineage(live, here, {
    commitExists: (sha) => gitSucceeds(['cat-file', '-e', `${sha}^{commit}`]),
    isAncestor: (ancestor, descendant) =>
      gitSucceeds(['merge-base', '--is-ancestor', ancestor, descendant]),
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'publisher-artifact' && args.length === 3) {
    process.stdout.write(`${readPublisherArtifactSha(await readStdin(), ...args)}\n`);
    return;
  }
  if (command === 'engine-live' && args.length === 0) {
    process.stdout.write(`${readReadyEngineSha(await readStdin())}\n`);
    return;
  }
  if (command === 'engine-ready' && args.length === 1) {
    process.stdout.write(`${requireReadyEngineSha(await readStdin(), args[0])}\n`);
    return;
  }
  if (command === 'build-info' && args.length === 0) {
    process.stdout.write(`${readBuildInfoSha(await readStdin())}\n`);
    return;
  }
  if (command === 'unchanged' && args.length === 1) {
    process.stdout.write(`${requireUnchangedBuildInfoSha(await readStdin(), args[0])}\n`);
    return;
  }
  if (command === 'lineage' && args.length === 2) {
    process.stdout.write(`${classifyRepositoryLineage(args[0], args[1])}\n`);
    return;
  }
  throw new Error(
    'Usage: production-e2e-provenance.mjs publisher-artifact <run-id> <trigger-sha> <repository-id> | build-info | unchanged <expected-sha> | engine-live | engine-ready <expected-sha> | lineage <live-sha> <checkout-sha>'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[production-e2e-provenance] ${error.message}`);
    process.exit(1);
  });
}
