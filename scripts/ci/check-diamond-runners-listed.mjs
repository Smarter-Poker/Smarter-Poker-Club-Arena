#!/usr/bin/env node
/**
 * Every Diamond SQL acceptance runner under tests/sql/ must be run by CI.
 *
 * The runners (`tests/sql/run-*diamond*.py`) certify the Diamond Arena's
 * money doors on an isolated PostgreSQL 17, and until 2026-09-19 they ran only
 * when somebody remembered to run them on the owner's Mac. They now run in the
 * `Accounting transactions (PostgreSQL 17)` job through
 * scripts/ci/run-diamond-sql-acceptance.py, which carries an EXPLICIT list of
 * runners. A glob would have run a new runner silently; an explicit list means a
 * new runner is a decision, and this check is what makes forgetting that
 * decision a red build rather than a runner nobody executes.
 *
 * Five things are checked, and each one has failed for real elsewhere in this
 * estate (see hero-card-row.spec.ts in tests/shipped-invariants.test.ts):
 *   1. every runner on disk is named in the wrapper's RUNNERS list, and every
 *      name in the list is on disk;
 *   2. every listed runner carries a proof line, so a runner that exits 0
 *      without asserting anything cannot stand as a green step;
 *   3. ci.yml's accounting job actually invokes the wrapper, once, unguarded
 *      by `if:` and without `continue-on-error`;
 *   4. the wrapper's SQL_SCRIPTS still name tests/sql/poker-arena-access.sql;
 *   5. every name in PRIVATE_CLUSTER_RUNNERS is a runner the wrapper runs, so
 *      the declaration of which cluster a runner uses cannot name a ghost.
 *
 * THE LIST ROTTED WITHIN A DAY of it being written, which is why the failure
 * text below names all three places a new runner has to be added rather than
 * only the one this check happens to read. Three runners landed on main from
 * three other pull requests - the tournament doors, the tournament lifecycle
 * and the stats asset dimension - and each moved one place instead of three.
 *
 * Exit 0 when all hold, 1 with the exact drift otherwise. Read-only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WRAPPER = 'scripts/ci/run-diamond-sql-acceptance.py';
export const RUNNER_PATTERN = /^run-.*diamond.*\.py$/;
export const ACCOUNTING_JOB_KEY = '\n  accounting_postgres:\n';

export function runnersOnDisk(root) {
  return readdirSync(resolve(root, 'tests/sql'))
    .filter((name) => RUNNER_PATTERN.test(name))
    .sort();
}

/**
 * The wrapper's RUNNERS block holds (file, proof) pairs: the proof is the
 * runner's own terminal print, which the wrapper requires in the output so that
 * a runner which exits 0 without asserting anything cannot pass. This returns
 * the file names; `runnerProofsInWrapper` returns the pairs.
 */
export function runnersListedInWrapper(wrapperSource) {
  const entries = runnerProofsInWrapper(wrapperSource);
  return entries && entries.map(([name]) => name);
}

export function runnerProofsInWrapper(wrapperSource) {
  const block = /^RUNNERS = \[([\s\S]*?)^\]/m.exec(wrapperSource);
  if (!block) return null;
  return [...block[1].matchAll(/\(\s*'([^']+\.py)',\s*\n?\s*'([^']*)'/g)].map((m) => [m[1], m[2]]);
}

/**
 * The runners the wrapper declares build a cluster of their own rather than
 * using the shared one. It is a declaration, not a guess, so that each runner
 * can be held to exactly one fully specified contract: see
 * tests/unit/diamondAcceptanceCi.test.ts.
 */
export function privateClusterRunnersInWrapper(wrapperSource) {
  const block = /^PRIVATE_CLUSTER_RUNNERS = \[([\s\S]*?)^\]/m.exec(wrapperSource);
  if (!block) return null;
  return [...block[1].matchAll(/'([^']+\.py)'/g)].map((m) => m[1]).sort();
}

export function sqlScriptsListedInWrapper(wrapperSource) {
  const block = /^SQL_SCRIPTS = \[([\s\S]*?)^\]/m.exec(wrapperSource);
  if (!block) return [];
  return [...block[1].matchAll(/\(\s*'([^']+\.sql)'/g)].map((m) => m[1]);
}

/** The accounting job's text: from its key to the next top-level job key. */
export function accountingJobText(ciSource) {
  const start = ciSource.indexOf(ACCOUNTING_JOB_KEY);
  if (start < 0) return '';
  const rest = ciSource.slice(start + ACCOUNTING_JOB_KEY.length);
  const next = rest.search(/\n  [a-z_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Split a job's text into its steps (each begins with `      - `). */
export function jobSteps(jobText) {
  return jobText.split(/\n(?=      - )/).filter((step) => step.trimStart().startsWith('- '));
}

export function findDiamondRunnerProblems(root) {
  const problems = [];
  const wrapperSource = readFileSync(resolve(root, WRAPPER), 'utf8');
  const listed = runnersListedInWrapper(wrapperSource);
  if (!listed) {
    problems.push(`${WRAPPER} has no RUNNERS list`);
    return problems;
  }
  const onDisk = runnersOnDisk(root);
  for (const name of onDisk)
    if (!listed.includes(name))
      problems.push(`tests/sql/${name} exists but ${WRAPPER} does not run it; add it to RUNNERS`);
  for (const name of listed)
    if (!onDisk.includes(name))
      problems.push(`${WRAPPER} lists ${name} but tests/sql/${name} does not exist`);
  const duplicates = listed.filter((name, index) => listed.indexOf(name) !== index);
  for (const name of new Set(duplicates)) problems.push(`${WRAPPER} lists ${name} twice`);
  for (const [name, proof] of runnerProofsInWrapper(wrapperSource))
    if (!proof.trim())
      problems.push(`${WRAPPER} gives ${name} no proof line, so exit 0 alone would pass it`);
  if (!sqlScriptsListedInWrapper(wrapperSource).includes('poker-arena-access.sql'))
    problems.push(`${WRAPPER} no longer runs tests/sql/poker-arena-access.sql`);
  const privateCluster = privateClusterRunnersInWrapper(wrapperSource);
  if (!privateCluster) {
    problems.push(`${WRAPPER} has no PRIVATE_CLUSTER_RUNNERS list`);
  } else {
    for (const name of privateCluster)
      if (!listed.includes(name))
        problems.push(
          `${WRAPPER} declares ${name} a private-cluster runner but RUNNERS does not run it`
        );
  }

  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const job = accountingJobText(ci);
  if (!job) {
    problems.push('.github/workflows/ci.yml has no accounting_postgres job');
    return problems;
  }
  const steps = jobSteps(job).filter((step) => step.includes(WRAPPER));
  if (steps.length !== 1) {
    problems.push(
      `the accounting_postgres job must run ${WRAPPER} in exactly one step (found ${steps.length})`
    );
  } else {
    const step = steps[0];
    if (/^\s+if:/m.test(step)) problems.push(`the ${WRAPPER} step must not be guarded by if:`);
    if (/continue-on-error/.test(step))
      problems.push(`the ${WRAPPER} step must not set continue-on-error`);
    if (!/PG_BIN:\s*\/usr\/lib\/postgresql\/17\/bin/.test(step))
      problems.push(`the ${WRAPPER} step must pass PG_BIN: /usr/lib/postgresql/17/bin`);
  }
  return problems;
}

/**
 * What a red check is actually asking for. Kept here as well as in the wrapper
 * because this is the step whose log a red build shows first.
 */
export const ADDING_A_RUNNER = [
  '',
  'A NEW tests/sql/run-*diamond*.py RUNNER MOVES THREE PLACES IN THE SAME COMMIT:',
  '',
  `  1. RUNNERS in ${WRAPPER} - the file name and the exact line the runner's`,
  '     own body prints when it reaches its end. Add it to',
  '     PRIVATE_CLUSTER_RUNNERS too if it builds its own cluster rather than',
  "     using that script's.",
  '  2. The EXPLICIT name list in tests/unit/diamondAcceptanceCi.test.ts.',
  '  3. The COUNTS in that same test file, which are deliberately literal so',
  '     that a list and a number cannot quietly disagree.',
  '',
  'Moving one of the three and not the others is exactly what left this list',
  'stale a day after it was written. Do not delete the explicit list, and do',
  'not make the count derived so that it can never disagree - CLAUDE.md',
  'sections 8 and 10.11. Add the runner.',
  '',
].join('\n');

function main() {
  const root = process.cwd();
  const problems = findDiamondRunnerProblems(root);
  if (problems.length === 0) {
    console.log(
      `check-diamond-runners-listed: ${runnersOnDisk(root).length} Diamond runners are all run by CI`
    );
    return 0;
  }
  for (const problem of problems) console.error(`check-diamond-runners-listed: ${problem}`);
  console.error(ADDING_A_RUNNER);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
