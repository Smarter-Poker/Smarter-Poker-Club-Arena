#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TRIAGE OPEN PULL REQUESTS - turn the stuck-PR wallpaper into a task list.
//
// WHY THIS EXISTS (measured 2026-08-31).
//
// This repo took 254 squash merges into main in one 24-hour window - one every
// 5.7 minutes. At that velocity a branch that does not merge within the hour
// conflicts, and 96 open pull requests had accumulated: 95 DIRTY, 81 of them
// from the 2026-08-26 swarm, median 1,215 commits behind main and median ONE
// commit ahead.
//
// This is a manual read-only report. Scheduled pull-request reconcilers and
// automatic closure were retired; this script ranks work but changes nothing.
//
// THE POINT IS RANKING, NOT CLOSING. This script closes nothing and changes
// nothing. It reads what each pull request CONTAINS and sorts by it, because
// the pile is not uniform. Sampled on the day this was written:
//
//   #1105  a claim-back double-charge fix: 366-line migration + 78-line test,
//          green, five days old, never shipped. A MONEY fix sitting in the pile.
//   #962   a bash/awk codemod script committed into the repo beside its output.
//   #971   a 189-line deletion of TournamentPage.tsx, five days stale.
//
// A sweep that treats those three alike is worse than no sweep. Mass-closing
// the pile would have thrown away #1105.
//
// USAGE
//   GITHUB_TOKEN=... node scripts/ci/triage-open-prs.mjs [--repo owner/name]
//                                                        [--json out.json]
//                                                        [--limit N]
//
// The token needs `repo` read only. It deliberately does NOT need `checks:read`
// - that scope is missing from the estate token and returns 403 on
// /commits/:sha/check-runs, which is why nobody could see why a PR was stuck.
// The Actions API (/actions/runs?head_sha=) answers the same question and IS
// readable, so this reports check outcomes without any token change.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

const REPO = argOf('--repo', process.env.REPO || 'Smarter-Poker/Smarter-Poker-Club-Arena');
const JSON_OUT = argOf('--json', null);
const LIMIT = Number(argOf('--limit', '0')) || 0;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('triage-open-prs: no GH_TOKEN / GITHUB_TOKEN in the environment.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// SUPERSESSION BY ADDED-FILE IDENTITY
//
// The question that actually discriminates here is coarser and far more
// reliable: DOES EVERY FILE THIS BRANCH ADDS ALREADY EXIST ON MAIN. Each branch
// in this estate brings its own new test files, its own migration, its own
// changelog entry. If all of those are already there, the work reached main
// through a sibling branch under a different SHA - the exact pattern CLAUDE.md
// section 12 describes - and this branch is a leftover, not lost work.
//
// MEASURED 2026-08-31: 64 of 97 open pull requests satisfied it, and ZERO were
// byte-identical to main, which is precisely why the line test finds nothing.
// Ten were then verified BY HAND against main and against production before
// this signal was trusted:
//
//   #1105 #1108 #1021 #1742 #1439 #1450 #1118 #1091 #1110  superseded (closed)
//   #1971                                                  GENUINELY STRANDED
//
// #1971 is the reason this stays a REPORT and never an auto-close. Its content
// was absent from main and one of its two commits was real, unshipped work
// guarding the boot-time rescue against paying out live tournaments. A sweep
// that closed on this signal alone would still have been right nine times out
// of ten - and wrong in the one case that mattered.
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';

function gitOut(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// A workflow checkout has origin/main; a local worktree may only have main.
const BASE_REF = ['origin/main', 'main'].find((r) => gitOut(['rev-parse', '--verify', r])) || null;

/** The blob sha of `path` on the base branch, or null when it is not there. */
function baseBlob(path) {
  return BASE_REF ? gitOut(['rev-parse', `${BASE_REF}:${path}`]) : null;
}

async function api(path, { retries = 3 } = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${REPO}/${path}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'triage-open-prs',
        },
      });
      if (res.status === 403 || res.status === 429) {
        // Secondary rate limit. Back off rather than hammering - the estate
        // token has been exhausted by polling before.
        await sleep(2000 * attempt);
        continue;
      }
      if (!res.ok) return { __status: res.status };
      return await res.json();
    } catch (err) {
      if (attempt === retries) return { __error: String(err) };
      await sleep(1000 * attempt);
    }
  }
  return { __error: 'exhausted retries' };
}

// GitHub computes mergeability LAZILY and ASYNCHRONOUSLY. A list response
// returns null for every row, and the FIRST individual request only STARTS the
// computation. agent-autopilot.yml learned this the expensive way on
// 2026-08-27: asking once left 78 of 99 pull requests reading UNKNOWN, and they
// all fell through to a doomed update-branch. Ask, pause, ask again.
async function mergeStateOf(number) {
  let pr = await api(`pulls/${number}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (pr && pr.mergeable_state && pr.mergeable_state !== 'unknown') return pr;
    await sleep(1200);
    pr = await api(`pulls/${number}`);
  }
  return pr;
}

const MONEY = /chip|wallet|ledger|rake|payout|refund|treasur|buy[_-]?in|prize|bount|jackpot|diamond|commission|rakeback/i;
const JUNK = /(^|\/)(node_modules|dist|coverage)\/|\.(log|zip|tgz|map)$|^[^/]*\.(sh|awk)$/i;

function classify(files) {
  const paths = files.map((f) => f.filename);
  const patchText = files.map((f) => f.patch || '').join('\n');

  const additions = files.reduce((n, f) => n + (f.additions || 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions || 0), 0);

  // DOCS-ONLY IS ITS OWN SHAPE. Measured on the first live run: two handoff
  // pull requests scored 50 for "money" purely because their PROSE discusses
  // chips and treasuries. A ranking that puts a changelog above a migration is
  // the wallpaper problem again, one layer up. Judge documents as documents.
  const docsOnly =
    paths.length > 0 &&
    paths.every((p) => /\.(md|mdx|txt)$/i.test(p) || p.startsWith('docs/') || p.startsWith('.agent/'));

  // Added files only. A MODIFIED file exists on both sides by definition, so
  // including those would call every branch superseded.
  const addedFiles = files.filter((f) => f.status === 'added');
  const addedOnBase = addedFiles.filter((f) => baseBlob(f.filename) !== null).length;
  const addedIdentical = addedFiles.filter((f) => baseBlob(f.filename) === f.sha).length;

  const signals = {
    migration: paths.some((p) => p.startsWith('supabase/migrations/')),
    tests: paths.some((p) => p.startsWith('tests/') || /\.test\.(ts|tsx|js)$/.test(p)),
    server: paths.some((p) => p.startsWith('server/')),
    money: !docsOnly && (paths.some((p) => MONEY.test(p)) || MONEY.test(patchText)),
    docs: docsOnly,
    junk: paths.some((p) => JUNK.test(p)),
    // A branch that deletes far more than it adds, opened days ago against a
    // main that has moved on, is the shape that silently reverts other agents'
    // work when it is merged late. Silent Revert Guard catches the worst of it;
    // this flags it for a human before it gets that far.
    destructive: deletions > additions * 2 && deletions > 50,
    // Only meaningful when the branch adds something. A modify-only branch
    // says nothing either way and must not be scored as superseded.
    superseded: addedFiles.length > 0 && addedOnBase === addedFiles.length,
  };

  let score = 0;
  if (signals.money) score += 50;
  if (signals.migration) score += 30;
  if (signals.tests) score += 15;
  if (signals.server) score += 10;
  if (signals.destructive) score -= 25;
  if (signals.junk) score -= 40;

  let verdict;
  // Ranked above every other verdict on purpose: an operator should not spend a
  // conflict resolution on work that is already in production.
  if (signals.superseded) verdict = 'LIKELY-SUPERSEDED';
  else if (signals.docs) verdict = 'DOCS';
  else if (signals.junk) verdict = 'INSPECT-JUNK';
  else if (signals.destructive) verdict = 'STALE-DESTRUCTIVE';
  else if (score >= 30) verdict = 'RESCUE';
  else verdict = 'REVIEW';

  if (signals.superseded) score -= 60;

  return {
    signals,
    score,
    verdict,
    additions,
    deletions,
    addedFiles: addedFiles.length,
    addedOnBase,
    addedIdentical,
  };
}

function flagString(s) {
  const on = [];
  if (s.money) on.push('money');
  if (s.migration) on.push('migration');
  if (s.tests) on.push('tests');
  if (s.server) on.push('server');
  if (s.destructive) on.push('destructive');
  if (s.junk) on.push('junk');
  if (s.docs) on.push('docs');
  if (s.superseded) on.push('superseded?');
  return on.join(' ') || '-';
}

async function main() {
  const open = [];
  for (let page = 1; ; page++) {
    const batch = await api(`pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    open.push(...batch);
    if (batch.length < 100) break;
  }
  const candidates = LIMIT ? open.slice(0, LIMIT) : open;
  console.error(`triage-open-prs: ${open.length} open, examining ${candidates.length}`);
  if (!BASE_REF) {
    console.error(
      'triage-open-prs: WARNING - no origin/main or main in this checkout, so the ' +
        'supersession signal is OFF and every branch will read as novel. Run this ' +
        'inside a full clone (actions/checkout with fetch-depth: 0).'
    );
  }

  const now = Date.now();
  const rows = [];

  for (const p of candidates) {
    const detail = await mergeStateOf(p.number);
    const files = await api(`pulls/${p.number}/files?per_page=100`);
    const fileList = Array.isArray(files) ? files : [];
    const cmp = await api(`compare/${p.base.ref}...${p.head.ref}`);

    const c = classify(fileList);
    rows.push({
      pr: p.number,
      title: p.title,
      branch: p.head.ref,
      draft: Boolean(p.draft),
      state: detail?.mergeable_state ?? 'unknown',
      ageDays: Number(((now - Date.parse(p.created_at)) / 86400000).toFixed(1)),
      behind: typeof cmp?.behind_by === 'number' ? cmp.behind_by : null,
      ahead: typeof cmp?.ahead_by === 'number' ? cmp.ahead_by : null,
      files: fileList.length,
      ...c,
    });
    console.error(`  #${p.number} ${c.verdict} score=${c.score}`);
  }

  // Highest-value first, then biggest, then oldest. An operator reads the top
  // of this list and stops when the value runs out - that is the entire point.
  rows.sort((a, b) => b.score - a.score || b.additions - a.additions || b.ageDays - a.ageDays);

  const counts = rows.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});

  console.log(`# Open pull request triage - ${REPO}`);
  console.log('');
  console.log(`${rows.length} open. ` + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' | '));
  console.log('');
  console.log('| PR | verdict | score | age | ahead/behind | +/- | added on base | signals | title |');
  console.log('|----|---------|-------|-----|--------------|-----|---------------|---------|-------|');
  for (const r of rows) {
    console.log(
      `| #${r.pr} | ${r.verdict} | ${r.score} | ${r.ageDays}d | ${r.ahead ?? '?'}/${r.behind ?? '?'} | ` +
        `+${r.additions}/-${r.deletions} | ${r.addedOnBase}/${r.addedFiles} | ` +
        `${flagString(r.signals)} | ${r.title.replace(/\|/g, '/').slice(0, 60)} |`
    );
  }

  if (JSON_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
    console.error(`triage-open-prs: wrote ${JSON_OUT}`);
  }
}

main().catch((err) => {
  console.error('triage-open-prs failed:', err);
  process.exit(1);
});
