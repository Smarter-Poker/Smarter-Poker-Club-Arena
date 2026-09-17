#!/usr/bin/env node
/**
 * detect-silent-revert — catch a commit that undoes an earlier commit without saying so
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 * 2026-08-15, Smarter-Poker-World-Hub commit 902d8b2b, subject: "match icon
 * sizes to profile orb, show hamburger menu on all pages". It also reverted
 * every line of 3fec6aa3 across three source files and deleted a migration.
 * Nothing in the subject hinted at it. The club-identity fix stayed dead for
 * four days and nobody noticed, because the diff nobody reads is the one
 * attached to a commit whose message sounds unrelated.
 *
 * The cause is mechanical, not careless: an agent builds from a working tree
 * checked out BEFORE someone else's commit landed, commits the whole tree, and
 * the older content silently wins. It has now happened at least twice.
 *
 * HOW IT DETECTS
 *
 * A wholesale revert has an exact signature: the new commit's blob for a file
 * is byte-identical to the blob that file had BEFORE some earlier commit
 * touched it. Not "similar" — identical. So for every file a commit changes,
 * compare its new blob against `P^:file` for each earlier commit P that
 * touched that file inside the lookback window. A hit means this commit put
 * the file back to its pre-P state.
 *
 * Findings are advisory. The owner removed the manual approval dependency
 * on 2026-09-17: authorized tasks review the reported files and complete
 * protected delivery themselves. Labels and commit-message tokens never
 * suppress scanning. Required technical checks remain enforced separately.
 *
 * A branch commit on a concurrent lineage can match a main commit's prior
 * state without undoing its final content. A finding only stands if that
 * earlier change is also absent from HEAD, the tree that squash-merges.
 *
 * USAGE
 *   node scripts/ci/detect-silent-revert.mjs [--base <ref>] [--days N]
 *   Defaults: base = HEAD~1, days = 45. Findings exit 0; execution errors fail.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = getArg('--base', 'HEAD~1');
const DAYS = Number(getArg('--days', '45'));

const IGNORED_PATHS = [
  /^dist\//,
  /^public\/hub\/club-arena\//,
  /(^|\/)node_modules\//,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.tsbuildinfo$/,
  /^\.next\//,
  /^coverage\//,
  /__snapshots__\//,
  // The Supabase manifests are GENERATED snapshots of the production schema
  // (scripts/ci/gen-schema-manifest.mjs). Two agents regenerating at different
  // moments legitimately produce byte-identical earlier snapshots, which reads
  // to this check as a wholesale revert when it is just a stale regeneration
  // race (first hit: PR #2346, a manifest matching its pre-#2404 state).
  // Correctness of these files is enforced by the stronger live check --
  // check-migrations-applied asks the production database directly -- so a
  // "revert" here can never silently lose schema truth.
  /^scripts\/ci\/supabase-(schema|columns|required-columns)-manifest\.json$/,
];

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// An invalid range or Git failure must not look like an empty successful scan.
git('rev-parse', '--verify', `${BASE}^{commit}`);
git('rev-parse', '--verify', 'HEAD^{commit}');

const commitsInRange = () => {
  const out = git('rev-list', `${BASE}..HEAD`);
  return out ? out.split('\n').filter(Boolean) : [];
};

const subjectOf = (sha) => git('log', '-1', '--format=%s', sha) || '(no subject)';
const bodyOf = (sha) => git('log', '-1', '--format=%B', sha) || '';

const blobAt = (sha, file) => {
  try {
    return git('rev-parse', '--verify', '--quiet', `${sha}:${file}`);
  } catch (error) {
    // Missing historical files/parents are normal; infrastructure errors are not.
    if (error.status === 1) return null;
    throw error;
  }
};

/**
 * Does `prior`'s change to `file` still exist in the tree that will actually
 * merge (HEAD)? Three tiers, cheapest first:
 *   1. HEAD holds prior's pre-state byte-for-byte  -> the revert ships: NO.
 *   2. HEAD holds prior's result byte-for-byte     -> fully present: YES.
 *   3. Diverged since: prior's diff for the file reverse-applies cleanly to
 *      the checked-out tree iff its lines are still there               -> YES;
 *      anything else stays a finding (conservative: an unprovable survival
 *      is treated as a revert, never the other way around).
 */
const priorChangeSurvivesAtHead = (prior, file) => {
  const headBlob = blobAt('HEAD', file);
  if (headBlob === null) return false; // deleted at HEAD: prior's change is gone
  if (headBlob === blobAt(`${prior}~1`, file)) return false;
  if (headBlob === blobAt(prior, file)) return true;
  const patch = execFileSync('git', ['diff', `${prior}~1`, prior, '--', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!patch.trim()) return false;
  try {
    execFileSync('git', ['apply', '--reverse', '--check', '-'], {
      input: patch,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false; // patch no longer applies
    throw error;
  }
};

/**
 * One history walk, not one per file. `git log --name-only` over the window
 * gives every (commit, file) pair in a single pass; doing a `git log -- <file>`
 * per changed file re-walks the whole history each time and turns a 5-second
 * check into minutes on a repo this size.
 */
const buildTouchMap = (tipRef) => {
  const raw = git('log', `--since=${DAYS}.days`, '--format=%x00%H', '--name-only', tipRef) || '';
  const map = new Map();
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('\u0000')) {
      current = line.slice(1);
      continue;
    }
    const file = line.trim();
    if (!file || !current) continue;
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(current);
  }
  return map;
};

const range = commitsInRange();           // newest first
const rangeIndex = new Map(range.map((sha, i) => [sha, i]));

const MAX_RANGE = 200;
// Per-commit work bounds. A wholesale-revert commit shows the signature on its
// first few files, so these cost nothing in detection and keep the check
// bounded on a bundle-sync commit that touches hundreds of paths. Anything
// dropped is printed -- a silent cap reads as "checked everything" when it did
// not.
const MAX_FILES_PER_COMMIT = 400;
const MAX_PRIORS_PER_FILE = 40;
if (range.length > MAX_RANGE) {
  console.log(
    `detect-silent-revert: ${range.length} commits in ${BASE}..HEAD exceeds the ` +
      `${MAX_RANGE}-commit cap (first push or a very large merge); skipping.`
  );
  process.exit(0);
}

// Built once from HEAD, reused for every commit in the range. Rebuilding it per
// commit re-walks the window each time, which is the difference between a
// six-second check and a CI timeout.
const touchMap = buildTouchMap('HEAD');

const findings = [];

for (const commit of range) {
  const message = bodyOf(commit);
  const announced = /revert/i.test(message) || message.includes('[allow-revert]');
  // Report announced and unannounced restorations alike; intent cannot hide findings.

  const allChanged = (git('diff-tree', '--no-commit-id', '--name-only', '-r', commit) || '')
    .split('\n')
    .filter(Boolean)
    .filter((f) => !IGNORED_PATHS.some((re) => re.test(f)));

  const changed = allChanged.slice(0, MAX_FILES_PER_COMMIT);
  if (allChanged.length > changed.length) {
    console.log(
      `detect-silent-revert: ${commit.slice(0, 9)} changes ${allChanged.length} files; ` +
        `checking the first ${MAX_FILES_PER_COMMIT}. ${allChanged.length - changed.length} not examined.`
    );
  }

  for (const file of changed) {
    const newBlob = blobAt(commit, file);
    if (!newBlob) continue; // deleted here; a deletion is visible in review

    // Only commits strictly OLDER than this one. Anything at or after it in
    // the pushed range is not something it could have reverted.
    const myIndex = rangeIndex.get(commit);
    const history = (touchMap.get(file) || []).filter((sha) => {
      if (sha === commit) return false;
      const idx = rangeIndex.get(sha);
      return idx === undefined ? true : idx > myIndex;
    }).slice(0, MAX_PRIORS_PER_FILE);

    for (const prior of history) {
      const priorParent = `${prior}~1`;
      const beforeBlob = blobAt(priorParent, file);
      if (!beforeBlob) continue; // file was created by `prior`
      const priorBlob = blobAt(prior, file);
      if (!priorBlob || priorBlob === beforeBlob) continue; // `prior` did not change it

      if (newBlob === beforeBlob) {
        // An intermediate state is not a revert unless it SHIPS. Pull
        // requests here merge by squash only (ruleset `main protection`), so
        // what lands on main is HEAD's tree, not this commit's. And
        // concurrent lineages in this repo routinely hold byte-identical
        // content under DIFFERENT shas (CLAUDE.md section 12: the GitHub-MCP
        // push path re-creates the same content under a new sha) — so a
        // branch commit authored BEFORE `prior` even existed can match
        // prior's pre-state without ever having seen, let alone undone,
        // prior's change. First live hit: PR #2537 was flagged for "undoing"
        // f48c48216, a fix committed an HOUR AFTER the flagged commit on a
        // lineage it was never part of, while HEAD carried the fix intact.
        // The discriminating question is: does prior's change survive at
        // HEAD? If yes, nothing is lost by merging; if no, this is exactly
        // the stale-checkout clobber this guard exists for (902d8b2b shipped
        // its stale content, so it still fails this test).
        if (priorChangeSurvivesAtHead(prior, file)) continue;
        findings.push({
          commit: commit.slice(0, 9),
          commitSubject: subjectOf(commit),
          file,
          announced,
          reverted: prior.slice(0, 9),
          revertedSubject: subjectOf(prior),
          revertedDate: git('log', '-1', '--format=%ad', '--date=short', prior),
        });
        break; // one finding per file is enough to make the point
      }
    }
  }
}

if (findings.length === 0) {
  console.log('detect-silent-revert: no restored-file findings in ' + `${BASE}..HEAD`);
  process.exit(0);
}

const silent = findings.filter((f) => !f.announced);

console.error('');
console.error('REVERT DETECTED');
console.error('===============');
console.error('');

if (silent.length > 0) {
  console.error('A commit below restores a file to exactly the state it had before an');
  console.error('earlier commit, without saying so. This is what happens when work is');
  console.error('committed from a checkout that predates someone else’s change: the');
  console.error('older content wins and the newer fix disappears with no diff anyone');
  console.error('would think to read.');
  console.error('');
}

for (const f of findings) {
  console.error(`  ${f.file}${f.announced ? '   (announced in the message)' : ''}`);
  console.error(`    this commit : ${f.commit}  ${f.commitSubject}`);
  console.error(`    undoes      : ${f.reverted}  ${f.revertedSubject}  (${f.revertedDate})`);
  console.error('');
}

if (silent.length > 0) {
  console.error('If this revert is NOT intentional (it usually is not): rebase onto');
  console.error('current origin/main and re-apply your change on top of theirs.');
  console.error('');
}
console.error('Advisory only: review the listed files and explain intentional restorations');
console.error('in the PR. Repair accidental loss of newer work before protected delivery.');
console.error('No approval label or additional human approval is required.');
console.error('Required technical checks remain enforced.');
console.error('');
if (process.env.GITHUB_ACTIONS === 'true') {
  console.log('::warning title=Restored file content detected::Review the exact-history findings in this job log. No approval label is required.');
}
process.exit(0);
