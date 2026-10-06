#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** "I could not tell" is a third outcome with its own code (CLAUDE.md 10.86 rule 1). */
export const UNKNOWN_EXIT_CODE = 3;

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

/**
 * THREE LINEAGES, NOT TWO, BECAUSE PRODUCTION MOVES FORWARD WHILE WE WATCH.
 *
 * `ancestor` is deploy LAG: production is behind this checkout, and the
 * assertions must be taken from the deployed commit or a new spec asks an old
 * page a question it cannot answer. That is the case this guard was written
 * for and it is unchanged.
 *
 * `descendant` is the opposite and was, until 2026-09-30, a hard refusal
 * reading `Production SHA X is not an ancestor of checkout Y`. It is not a
 * divergence: it means another publisher merged and published while this
 * certificate was being assembled, so production is a LATER commit on the same
 * protected main. At the merge rate this repo actually runs at - twenty runs
 * in the sample, every one of them started within minutes of the next merge -
 * that is the ordinary case, not an anomaly, and calling it a failure told
 * nobody anything about the live site. The caller re-targets onto the live
 * commit instead; the lineage is still proved, in the other direction.
 *
 * Anything that shares no lineage with the checkout, or does not resolve at
 * all, is still refused: a mismatched assertion set cannot produce a verdict.
 */
export function classifyTrustedLineage(live, here, evidence) {
  if (!FULL_SHA.test(live) || !FULL_SHA.test(here)) {
    throw new Error('Production and checkout provenance must both be full lowercase SHAs.');
  }
  if (live === here) return 'same';
  if (!evidence.commitExists(live)) {
    throw new Error(`Production SHA ${live} does not resolve to a trusted repository commit.`);
  }
  if (evidence.isAncestor(live, here)) return 'ancestor';
  if (evidence.isAncestor(here, live)) return 'descendant';
  throw new Error(`Production SHA ${live} shares no lineage with checkout ${here}.`);
}

/**
 * WAS THE RELEASE STILL THE ONE WE TESTED, AND IF NOT, IS THAT A DEFECT?
 *
 * `requireUnchangedBuildInfoSha` above answers a different question and keeps
 * answering it: the PUBLISHER calls it immediately after swapping its own
 * symlink, where any change at all really is wrong. Do not merge the two.
 *
 * Here the window is forty minutes of browsers. Demanding one frozen SHA
 * across it made a normal forward publish indistinguishable from a rollback,
 * a divergence or an unreadable origin - and since the publisher fires on
 * every merge, the frozen-SHA demand could essentially never hold. Twelve of
 * the last twenty runs died on it.
 *
 * So classify instead of refusing:
 *   certified  - production never left the SHA this run recorded.
 *   superseded - production advanced to a LATER trusted commit on this
 *                lineage. The run could not tell for any assertion that
 *                straddled the switch; it is a non-verdict, not a red.
 * Anything else - a rollback, an off-lineage SHA, an unreadable document -
 * still throws, because those are the states worth waking somebody for.
 */
export function classifyReleaseWindow(raw, expected, evidence) {
  if (!FULL_SHA.test(expected)) {
    throw new Error('The expected production provenance must be one full lowercase SHA.');
  }
  const actual = readBuildInfoSha(raw);
  if (actual === expected) return { verdict: 'certified', sha: actual };
  if (!evidence.commitExists(actual)) {
    throw new Error(`Production SHA ${actual} does not resolve to a trusted repository commit.`);
  }
  if (!evidence.isAncestor(expected, actual)) {
    throw new Error(
      `Production moved from ${expected} to ${actual}, which is not a forward release on this lineage.`
    );
  }
  return { verdict: 'superseded', sha: actual };
}

function gitSucceeds(args) {
  try {
    execFileSync('git', args, {
      stdio: 'ignore',
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    });
    return true;
  } catch {
    return false;
  }
}

const REPOSITORY_EVIDENCE = {
  commitExists: (sha) => gitSucceeds(['cat-file', '-e', `${sha}^{commit}`]),
  isAncestor: (ancestor, descendant) =>
    gitSucceeds(['merge-base', '--is-ancestor', ancestor, descendant]),
};

export function classifyRepositoryLineage(live, here) {
  return classifyTrustedLineage(live, here, REPOSITORY_EVIDENCE);
}

export function classifyRepositoryReleaseWindow(raw, expected) {
  return classifyReleaseWindow(raw, expected, REPOSITORY_EVIDENCE);
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
  // Exit 3 is UNKNOWN and is deliberately not shared with 0 (certified) or 1
  // (a real anomaly). CLAUDE.md 10.86 rule 1: a run whose release moved under
  // it could not tell, and "could not tell" needs its own name and its own
  // code, or it gets folded into a red nobody reads.
  if (command === 'release-window' && args.length === 1) {
    const window = classifyRepositoryReleaseWindow(await readStdin(), args[0]);
    process.stdout.write(`${window.verdict} ${window.sha}\n`);
    if (window.verdict !== 'certified') process.exitCode = UNKNOWN_EXIT_CODE;
    return;
  }
  throw new Error(
    'Usage: production-e2e-provenance.mjs publisher-artifact <run-id> <trigger-sha> <repository-id> | build-info | unchanged <expected-sha> | release-window <expected-sha> | engine-live | engine-ready <expected-sha> | lineage <live-sha> <checkout-sha>'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[production-e2e-provenance] ${error.message}`);
    process.exit(1);
  });
}
