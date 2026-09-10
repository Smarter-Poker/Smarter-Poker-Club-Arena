#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const FULL_SHA = /^[0-9a-f]{40}$/;

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
    'Usage: production-e2e-provenance.mjs build-info | unchanged <expected-sha> | lineage <live-sha> <checkout-sha>'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[production-e2e-provenance] ${error.message}`);
    process.exit(1);
  });
}
