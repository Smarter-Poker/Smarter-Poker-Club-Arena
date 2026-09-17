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
 * That is precise. It does not guess and it does not diff line ranges. Two
 * escape classes exist: a revert the author actually meant (the commit
 * message + label hatch below), and — found live on PR #2537, 2026-09-01 — a
 * branch commit on a CONCURRENT lineage that matches a main commit's
 * pre-state because both lineages carried byte-identical content under
 * different shas (CLAUDE.md section 12). The second is handled structurally:
 * a finding only stands if the undone change is also ABSENT from HEAD,
 * because squash-only merges mean HEAD's tree is the only thing that ships.
 *
 * ESCAPE HATCHES
 *   - paths in IGNORED_PATHS (build output, lockfiles, generated bundles)
 *   - an ANNOUNCED revert: the commit message contains "revert" or
 *     [allow-revert], or the pull request title/body does (the workflow
 *     passes that in as REVERT_ANNOUNCED=true). The `revert-approved` label
 *     still counts too (REVERT_APPROVED=true), but nobody has to apply it.
 *
 * THE ANNOUNCEMENT IS THE APPROVAL (2026-09-17, Dan)
 *   From 2026-09-01 to 2026-09-17 an announced revert also needed the
 *   `revert-approved` label, applied by a human, after an agent had amended
 *   [allow-revert] into its own message to get past this guard. Dan retired
 *   that on 2026-09-17: "I don't approve anything, when you are cleared to
 *   push and publish you do it automatically." Agents own their releases end
 *   to end, so a revert that SAYS it is a revert is approved by saying so.
 *
 *   What this guard still catches is the thing it was written for: a commit
 *   that restores a file to an older state WITHOUT saying so, which is what
 *   a stale checkout does to somebody else's fix. That is a defect, not a
 *   decision, and the fix is to rebase and re-apply, or to say in the commit
 *   or the pull request that the revert is intended.
 *
 * USAGE
 *   node scripts/ci/detect-silent-revert.mjs [--base <ref>] [--days N]
 *   Defaults: base = HEAD~1, days = 45. Exit 1 on a finding.
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

const git = (...args) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

const commitsInRange = () => {
  const out = git('rev-list', `${BASE}..HEAD`);
  return out ? out.split('\n').filter(Boolean) : [];
};

const subjectOf = (sha) => git('log', '-1', '--format=%s', sha) || '(no subject)';
const bodyOf = (sha) => git('log', '-1', '--format=%B', sha) || '';

const blobAt = (sha, file) => git('rev-parse', `${sha}:${file}`);

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
  try {
    const patch = execFileSync('git', ['diff', `${prior}~1`, prior, '--', file], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!patch.trim()) return false;
    execFileSync('git', ['apply', '--reverse', '--check', '-'], {
      input: patch,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
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

const range = commitsInRange(); // newest first
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

// REVERT_APPROVED: the `revert-approved` label is on the pull request.
// REVERT_ANNOUNCED: the pull request title or body says "revert" or carries
// [allow-revert]. Either one is the author saying, outside any single commit
// message, that this pull request undoes earlier work on purpose. Since
// 2026-09-17 no human is in this loop (Dan: agents push and publish
// themselves), so both are honoured the same way: say what is being waved
// through and stop.
const APPROVED = process.env.REVERT_APPROVED === 'true';
const ANNOUNCED_IN_PR = process.env.REVERT_ANNOUNCED === 'true';

if (APPROVED || ANNOUNCED_IN_PR) {
  console.log(
    `${APPROVED ? 'revert-approved label present' : 'revert announced in the pull request'}: ` +
      `${range.length} commit(s) in this pull request are an intended revert and are not ` +
      'scanned for restored files.'
  );
  process.exit(0);
}

const findings = [];

for (const commit of range) {
  const message = bodyOf(commit);
  const announced = /revert/i.test(message) || message.includes('[allow-revert]');
  // A commit that says it reverts is an intended revert (2026-09-17: the
  // announcement is the approval). Only the SILENT restore of an older state
  // is a finding, because that is the stale-checkout clobber this exists for.
  if (announced) continue;

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
    const history = (touchMap.get(file) || [])
      .filter((sha) => {
        if (sha === commit) return false;
        const idx = rangeIndex.get(sha);
        return idx === undefined ? true : idx > myIndex;
      })
      .slice(0, MAX_PRIORS_PER_FILE);

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
        // lineage it was never part of, while HEAD carried the fix intact —
        // and because the flagged commit's message did not say "revert", no
        // human label could clear it.
        // The discriminating question is: does prior's change survive at
        // HEAD? If yes, nothing is lost by merging; if no, this is exactly
        // the stale-checkout clobber this guard exists for (902d8b2b shipped
        // its stale content, so it still fails this test).
        if (priorChangeSurvivesAtHead(prior, file)) continue;
        findings.push({
          commit: commit.slice(0, 9),
          commitSubject: subjectOf(commit),
          file,
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
  console.log('detect-silent-revert: no silent reverts in ' + `${BASE}..HEAD`);
  process.exit(0);
}

console.error('');
console.error('SILENT REVERT DETECTED');
console.error('======================');
console.error('');
console.error('A commit below restores a file to exactly the state it had before an');
console.error('earlier commit, without saying so. This is what happens when work is');
console.error('committed from a checkout that predates someone else’s change: the');
console.error('older content wins and the newer fix disappears with no diff anyone');
console.error('would think to read.');
console.error('');

for (const f of findings) {
  console.error(`  ${f.file}`);
  console.error(`    this commit : ${f.commit}  ${f.commitSubject}`);
  console.error(`    undoes      : ${f.reverted}  ${f.revertedSubject}  (${f.revertedDate})`);
  console.error('');
}

console.error('If this revert is NOT intentional (it usually is not): merge current');
console.error('origin/main into your branch and re-apply your change on top of theirs.');
console.error('');
console.error('If the revert IS intentional: say so. Put "revert" or [allow-revert] in');
console.error('the commit message, or in the pull request title or body, naming which');
console.error('commit you are undoing and why. That announcement is the approval; no');
console.error('label and no human sign-off is needed (Dan, 2026-09-17). The check');
console.error('re-runs when the pull request is edited.');
console.error('If main is broken right now, prefer a forward fix.');
console.error('');
process.exit(1);
