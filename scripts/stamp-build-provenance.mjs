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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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

// PR browser/build checks exercise GitHub's immutable merge candidate. A later
// unrelated merge on main must not prevent those tests from running. This is
// accepted only for the exact two-parent candidate named by the actual PR event;
// the artifact is marked validation-only and cannot enter the publisher.
function pullRequestValidation() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
    process.env.STRICT_PROVENANCE === '1' ||
    historyComplete !== true
  )
    return null;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const pr = event.pull_request;
    if (
      !Number.isSafeInteger(event.number) ||
      event.number < 1 ||
      pr?.number !== event.number ||
      pr?.base?.ref !== 'main' ||
      process.env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
      process.env.GITHUB_SHA !== commit ||
      !/^[a-f0-9]{40}$/.test(pr?.base?.sha ?? '') ||
      !/^[a-f0-9]{40}$/.test(pr?.head?.sha ?? '')
    )
      return null;
    const parents = git('show -s --format=%P HEAD').split(' ');
    if (parents.length !== 2 || parents[0] !== pr.base.sha || parents[1] !== pr.head.sha)
      return null;
    return { base: pr.base.sha, head: pr.head.sha };
  } catch {
    // Unreadable or mismatched event evidence retains the strict release rule.
    return null;
  }
}
const validation = pullRequestValidation();

const info = {
  schema: 1,
  buildPurpose: validation ? 'pull-request-validation' : 'release',
  ...(validation ? { pullRequestBase: validation.base, pullRequestHead: validation.head } : {}),
  commit,
  commitTime,
  buildTime: new Date().toISOString(),
  branch,
  dirty,
  historyComplete,
  behindMain,
  aheadMain,
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
// regression that happened. Refuse it outright in CI, and warn loudly
// locally (where a developer may legitimately be testing an older tree but
// must never ship it — the Club Arena publisher is the backstop either way).
const strictProvenance = process.env.GITHUB_ACTIONS || process.env.STRICT_PROVENANCE === '1';
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
  if (strictProvenance && !validation) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(
    validation
      ? `PR validation candidate retained; main advanced by ${behindMain} commit(s). This artifact is not publishable.`
      : msg
  );
}
