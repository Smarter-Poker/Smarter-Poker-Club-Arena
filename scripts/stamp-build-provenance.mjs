#!/usr/bin/env node
/**
 * stamp-build-provenance.mjs — LAYER 1 of the anti-regression system
 * ═══════════════════════════════════════════════════════════════════════════
 * Writes dist/ca-provenance.json describing WHERE this build came from, so the
 * Club Arena publisher can refuse a bundle that would move production
 * BACKWARDS.
 *
 * WHY THIS EXISTS (2026-08-21)
 * Production silently lost the 49-item dynamic throwables. Nothing was
 * reverted in source: a deploy loop rebuilt Club Arena from a local checkout
 * that was 96 commits BEHIND origin/main and 16 ahead, and committed that
 * bundle over the current one. Every gate passed — the bundle was valid, in
 * budget, lint-clean. It was simply OLD, and nothing in the pipeline could
 * tell how old, because a built bundle carried no memory of its source.
 *
 * A per-feature marker check (the first fix) protects one feature. This
 * protects EVERY feature, forever, including ones not written yet: if the
 * incoming build's source commit is older than the deployed one, the deploy
 * is a time-machine and gets blocked. No manifest entry, no new test.
 *
 * WHAT IS RECORDED
 *   commit        full source SHA the bundle was built from
 *   commitTime    author/commit timestamp of that SHA (ISO, UTC) — the field
 *                 the monotonic gate actually compares, because it is a
 *                 property of the SOURCE, not of when someone ran a build
 *   buildTime     when this build ran (diagnostics only; a stale checkout can
 *                 produce a NEW buildTime from OLD source, which is exactly
 *                 the failure this catches)
 *   branch        branch name at build time
 *   behindMain    how many commits the checkout was behind origin/main
 *   aheadMain     how many commits it was ahead
 *   dirty         uncommitted changes present
 *   ciRun         GitHub Actions run URL when built in CI
 *
 * Degrades gracefully: outside a git checkout (or with git unavailable) it
 * writes `unknown` values rather than failing the build. The gate treats
 * unknown provenance as "cannot prove it is newer" and says so.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// CA_DIST: the native build (npm run build:native) writes dist-native/ so the
// two bundles can never be confused. Unset means 'dist', exactly as before.
const DIST = path.join(process.cwd(), process.env.CA_DIST || 'dist');

function git(cmd, fallback = 'unknown') {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

function gitCount(range) {
  const out = git(`rev-list --count ${range}`, '');
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

const commit = git('rev-parse HEAD');
// %cI = committer date, strict ISO 8601. Committer date (not author date) is
// what actually orders history after a rebase, which is how these repos land
// most commits.
const commitTime = git('show -s --format=%cI HEAD');
const branch = git('rev-parse --abbrev-ref HEAD');
const dirty = git('status --porcelain', '') !== '';

// Behind/ahead only mean something if a remote-tracking ref exists locally.
// In CI the checkout is detached with a fetched origin/main, so this is
// usually available on both sides.
const hasOriginMain = git('rev-parse --verify --quiet origin/main', '') !== '';
// rev-list treats shallow boundaries as roots. Even a merge of current main
// can then appear to be thousands of commits behind it on a reused runner.
const shallowRepository = git('rev-parse --is-shallow-repository', 'unknown');
const historyComplete =
  shallowRepository === 'false' ? true : shallowRepository === 'true' ? false : null;
const behindMain = hasOriginMain && historyComplete ? gitCount('HEAD..origin/main') : null;
const aheadMain = hasOriginMain && historyComplete ? gitCount('origin/main..HEAD') : null;

// A pull_request job tests the immutable merge selected by its event. Main can
// advance before a queued job fetches it. Bind that test to BOTH event parents;
// never change the actual main-distance fields consumed by the publisher.
// Explicit strict release builds retain the current-main refusal in every event.
const pullRequestTest =
  process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'pull_request';
let validationSnapshot = null;
let snapshotError = null;
if (pullRequestTest) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const pr = event.pull_request;
    const repository = process.env.GITHUB_REPOSITORY;
    const base = pr?.base?.sha;
    const head = pr?.head?.sha;
    const fullSha = /^[0-9a-f]{40}$/;
    const parents = git('show -s --format=%P HEAD', '').split(' ');
    if (
      !repository ||
      event.repository?.full_name !== repository ||
      pr?.base?.repo?.full_name !== repository ||
      !Number.isSafeInteger(event.number) ||
      event.number < 1 ||
      pr?.number !== event.number ||
      process.env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
      process.env.GITHUB_BASE_REF !== 'main' ||
      pr?.base?.ref !== 'main' ||
      !fullSha.test(base || '') ||
      !fullSha.test(head || '') ||
      !fullSha.test(commit) ||
      process.env.GITHUB_SHA !== commit ||
      (pr.merge_commit_sha != null && pr.merge_commit_sha !== commit) ||
      branch !== 'HEAD' ||
      historyComplete !== true ||
      !Number.isSafeInteger(behindMain) ||
      behindMain < 0 ||
      !Number.isSafeInteger(aheadMain) ||
      aheadMain < 0 ||
      !hasOriginMain ||
      parents.length !== 2 ||
      parents[0] !== base ||
      parents[1] !== head ||
      git(`merge-base --is-ancestor ${base} origin/main`, null) !== ''
    ) {
      throw new Error('event, checkout and complete merge ancestry do not agree');
    }
    validationSnapshot = {
      purpose: 'pull-request-test-only',
      pullRequest: event.number,
      base,
      head,
      merge: commit,
    };
  } catch {
    snapshotError =
      'Pull-request build snapshot cannot be verified from its event and exact Git parents.';
  }
}

const info = {
  schema: 1,
  commit,
  commitTime,
  buildTime: new Date().toISOString(),
  branch,
  dirty,
  historyComplete,
  behindMain,
  aheadMain,
  ...(validationSnapshot ? { validationSnapshot } : {}),
  ciRun:
    process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  builtBy: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
};

if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });
// NOTE the filename. publish-club-arena.yml writes its own dist/build-info.json
// AFTER `npm run build` returns (ca_sha / built_at / built_by / run_id), so
// writing there would be silently clobbered in CI. ca-provenance.json is ours
// alone and survives; the two files coexist and the deploy gate reads both.
writeFileSync(path.join(DIST, 'ca-provenance.json'), JSON.stringify(info, null, 2) + '\n');

const age = behindMain === null ? '?' : behindMain;
console.log(
  `build provenance: ${commit.slice(0, 8)} (${commitTime}) branch=${branch} ` +
    `behind-main=${age}${dirty ? ' DIRTY' : ''} by=${info.builtBy}`
);

// A build from a checkout that is behind canonical main is exactly the
// regression that happened. Release builds refuse it. A verified temporary PR
// test may use its event snapshot, but retains its real non-publishable distance.
// Local diagnostic builds warn; the publisher independently enforces provenance.
const strictProvenance = process.env.GITHUB_ACTIONS || process.env.STRICT_PROVENANCE === '1';
if (snapshotError) {
  console.error(snapshotError);
  process.exit(1);
}
if (commit !== 'unknown' && historyComplete !== true) {
  const msg =
    '\n✗ Build ancestry cannot be verified: incomplete Git history.\n' +
    '  FIX: fetch full history (actions/checkout fetch-depth: 0), then rebuild.\n';
  if (strictProvenance) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}
const BEHIND_LIMIT = 0;
if (typeof behindMain === 'number' && behindMain > BEHIND_LIMIT) {
  const msg =
    `\n✗ This build is ${behindMain} commit(s) BEHIND origin/main.\n` +
    `  Shipping it would erase whatever landed in those commits — that is\n` +
    `  precisely the 2026-08-21 throwables regression.\n\n` +
    `  FIX: merge current origin/main into this feature branch, then rebuild.\n`;
  if (validationSnapshot && process.env.STRICT_PROVENANCE !== '1') {
    console.log(
      'Validated the exact pull-request test snapshot; this artifact is not a production release.'
    );
  } else if (strictProvenance) {
    console.error(msg);
    process.exit(1);
  } else {
    console.warn(msg);
  }
}
