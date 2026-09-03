#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  pr-push — land the current branch on main through a pull request
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THE PUSH PATH CHANGED
 *
 * main is protected by a ruleset (scripts/ci/apply-main-ruleset.mjs). Stage 2 of
 * that ruleset makes main reachable ONLY through a pull request whose checks
 * passed, which is what finally makes it impossible to land a red test - the
 * failure mode that stopped every deploy four times on 2026-08-21.
 *
 * Agents keep calling scripts/git-safe-push.sh exactly as before. It now routes
 * through here instead of pushing straight at main.
 *
 * WHAT THIS ALSO FIXES, QUIETLY
 *
 * git-safe-push.sh pushed with --no-verify, so the pre-push hook - nine house
 * rules and, since #149, the test suite - never ran from the one command every
 * agent is told to use. And its failure path was --force-with-lease, which is
 * how four commits already serving in production were rewound off main. Both
 * are gone: a PR cannot force-push, and the hook runs on the branch push.
 *
 * WAITING FOR CHECKS
 *
 * We merge on mergeable_state `clean` (required checks green) or `unstable`
 * (required checks green, some NON-required check red - e2e is slow and flaky
 * and is not a required check). `blocked` means a required check has not passed
 * yet, so we keep waiting. `dirty` means a real conflict with main, and no
 * amount of waiting fixes that.
 *
 * Usage:  GITHUB_TOKEN=... node scripts/ci/pr-push.mjs "commit subject"
 */

import { execSync } from 'node:child_process';

const OWNER = 'Smarter-Poker';
const REPO = 'Smarter-Poker-Club-Arena';
const BASE = 'main';
const TIMEOUT_MS = 12 * 60 * 1000;

const token = process.env.GITHUB_TOKEN || process.env.GH_PAT;
const title = process.argv.slice(2).join(' ').trim() || 'chore: automated push';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const log = (m) => console.log(`   ${m}`);

if (!token) {
  console.error('pr-push: no GITHUB_TOKEN. Set it (it is in the club-arena .env) and retry.');
  process.exit(2);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* some responses have no body */ }
  return { status: res.status, body };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  const head = sh('git rev-parse HEAD');
  const short = head.slice(0, 8);
  const branch = `auto/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${short}`;

  console.log(`\npr-push: landing ${short} on ${BASE} through a pull request\n`);

  // The branch push runs the pre-push hook on purpose. That is where the test
  // gate lives, and it is the whole point of routing through here.
  log(`pushing branch ${branch}`);
  try {
    sh(`git push origin HEAD:refs/heads/${branch}`);
  } catch (e) {
    console.error('\npr-push: the branch push was refused. The pre-push hook blocks');
    console.error('pushes that would break main - read its output above and fix the cause.');
    console.error('CA_SKIP_TESTS=1 bypasses only the test gate, for genuine emergencies.\n');
    process.exit(1);
  }

  log('opening the pull request');
  const pr = await api(`/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, head: branch, base: BASE, body: `Opened by scripts/ci/pr-push.mjs for ${short}.` }),
  });
  if (pr.status >= 300) {
    console.error(`\npr-push: could not open the PR (HTTP ${pr.status}): ${pr.body?.message}\n`);
    process.exit(1);
  }
  const number = pr.body.number;
  log(`PR #${number}  ${pr.body.html_url}`);

  log('waiting for the required checks');
  const started = Date.now();
  let state = '';
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(10000);
    const cur = await api(`/repos/${OWNER}/${REPO}/pulls/${number}`);
    state = cur.body?.mergeable_state || 'unknown';
    if (state === 'clean' || state === 'unstable' || state === 'has_hooks') break;
    if (state === 'dirty') {
      console.error(`\npr-push: PR #${number} conflicts with ${BASE}. Rebase and retry.\n`);
      process.exit(1);
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (!['clean', 'unstable', 'has_hooks'].includes(state)) {
    console.error(`\npr-push: gave up waiting (state: ${state}). PR #${number} is open and safe;`);
    console.error('nothing was merged. Check it and merge by hand once the checks pass.\n');
    process.exit(1);
  }

  log(`merging (${state})`);
  const merged = await api(`/repos/${OWNER}/${REPO}/pulls/${number}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'squash', commit_title: `${title} (#${number})` }),
  });
  if (!merged.body?.merged) {
    console.error(`\npr-push: merge refused (HTTP ${merged.status}): ${merged.body?.message}`);
    console.error(`PR #${number} is still open - nothing was lost.\n`);
    process.exit(1);
  }

  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`, { method: 'DELETE' });
  console.log(`\n   MERGED to ${BASE} as ${merged.body.sha.slice(0, 8)} (PR #${number})\n`);
};

run().catch((e) => {
  console.error(`pr-push: ${e?.message || e}`);
  process.exit(1);
});
