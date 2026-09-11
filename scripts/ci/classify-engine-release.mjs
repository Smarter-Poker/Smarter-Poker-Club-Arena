#!/usr/bin/env node
/** Separate the engine component identity from the controls that must release it. */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Keep the accepted runtime boundary identical to the engine intake/transaction.
// Controls outside server/ may require a new release without becoming runtime.
export const runtimePathspecs = Object.freeze([
  'server/**',
  ':(exclude)server/**/*.test.ts',
  ':(exclude)server/sim/**',
]);
export const engineControlFiles = Object.freeze([
  '.github/workflows/stage-engine-release.yml',
  '.github/workflows/auto-deploy-hetzner.yml',
  'scripts/ci/check-engine-doors-exist.mjs',
  'scripts/ci/engine-doors.allowlist.json',
  'scripts/ci/record-engine-deploy-attempt.mjs',
  'scripts/ci/classify-engine-release.mjs',
]);
const fullSha = /^[0-9a-f]{40}$/;
const zeroSha = '0'.repeat(40);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export function latestRequiredRuntime(cwd, afterSha) {
  if (!fullSha.test(afterSha) || afterSha === zeroSha) {
    throw new Error('Protected-main push must provide one full lowercase commit SHA.');
  }
  git(cwd, ['cat-file', '-e', `${afterSha}^{commit}`]);
  const latest = git(cwd, ['log', afterSha, '-1', '--format=%H', '--', ...runtimePathspecs]);
  if (!fullSha.test(latest)) throw new Error('Could not resolve one engine-runtime commit.');
  return latest;
}

/** Read the complete Git range, never GitHub's truncated push file list. */
export function classifyEngineRelease({ cwd = process.cwd(), beforeSha, afterSha }) {
  const targetSha = latestRequiredRuntime(cwd, afterSha);
  let beforeKnown = fullSha.test(beforeSha ?? '') && beforeSha !== zeroSha;
  if (beforeKnown) {
    try {
      git(cwd, ['cat-file', '-e', `${beforeSha}^{commit}`]);
      git(cwd, ['merge-base', '--is-ancestor', beforeSha, afterSha]);
    } catch {
      beforeKnown = false;
    }
  }
  if (!beforeKnown) {
    return {
      releaseRequired: true,
      targetSha,
      runtimeChanged: null,
      controlChanged: null,
      beforeKnown,
    };
  }
  // A runtime change followed by its revert still changes the component SHA
  // required by the receiver. Comparing only net tree bytes would strand it.
  const beforeRuntime = git(cwd, [
    'log',
    beforeSha,
    '-1',
    '--format=%H',
    '--',
    ...runtimePathspecs,
  ]);
  const runtimeChanged = beforeRuntime !== targetSha;
  const controlChanged =
    git(cwd, [
      'diff',
      '--no-ext-diff',
      '--name-only',
      beforeSha,
      afterSha,
      '--',
      ...engineControlFiles,
    ]) !== '';
  return {
    releaseRequired: runtimeChanged || controlChanged,
    targetSha,
    runtimeChanged,
    controlChanged,
    beforeKnown,
  };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    const result = classifyEngineRelease({
      beforeSha: process.env.BEFORE_SHA,
      afterSha: process.env.AFTER_SHA,
    });
    console.log(`release_required=${result.releaseRequired}`);
    console.log(`target_sha=${result.targetSha}`);
    console.log(`runtime_changed=${result.runtimeChanged ?? 'unknown'}`);
    console.log(`control_changed=${result.controlChanged ?? 'unknown'}`);
    console.log(`before_known=${result.beforeKnown}`);
    if (!result.beforeKnown) {
      console.error(
        'Previous commit is missing or unreadable; failing closed by staging the exact engine component.'
      );
    }
  } catch (error) {
    console.error(`Engine release classification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
