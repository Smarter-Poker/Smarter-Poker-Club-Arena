#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH TESTS CANNOT FAIL FOR THE RIGHT REASON — an inventory, not a gate
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-31, after two bugs in one file were missed by the tests that were
 * supposedly guarding them.
 *
 * A test that reads a source file as TEXT and asserts a regex over it can only
 * tell you a line still exists. It cannot tell you the line is reached, that
 * the objects arriving there satisfy it, or that it does anything at all. Both
 * bugs found this week lived under exactly that kind of pin:
 *
 *   - the stale-seat prune asked for `kind === 'table'` while the rebuild's own
 *     tabs were built without a `kind`. The pin matched the predicate's TEXT
 *     and passed for as long as the prune did nothing;
 *   - `isTournament` was derived and thrown away in the same factory, and four
 *     readers silently treated those tables as cash games.
 *
 * A behavioural test - `tests/unit/tabSlots.test.ts` is the template - runs the
 * predicate against the real shapes and fails in one second.
 *
 * WHY THIS ONLY REPORTS. Roughly 200 of 555 test files are in this category.
 * Failing CI on them would stop every agent in the repo over work none of them
 * started, and a source-grep pin is not worthless: for CSS beats, workflow YAML
 * and house copy rules the text IS the artefact under test. The honest tool is
 * an inventory that makes the number visible and shrinkable, plus the one hard
 * rule below that can be enforced without stopping anybody.
 *
 * THE ONE HARD RULE: a test may not pin a `src/utils` module by text alone.
 * Those modules are pure and importable by construction, so a text-only pin on
 * one is always a choice to test the weaker thing.
 *
 * ...ENFORCED AS A RATCHET, not a cliff. Five files already break that rule.
 * Failing CI on them would stop every agent in the repo over work none of them
 * started - so `--ratchet` fails only when the count goes UP, which blocks the
 * next one without blocking anybody on the last five. Same shape as CHECK 6's
 * cron governance: compare to current state, never to zero. When the five are
 * migrated, drop BASELINE_UTIL_VIOLATIONS with them and the rule becomes
 * absolute on its own.
 *
 * Usage:
 *   node scripts/ci/report-source-grep-tests.mjs            # inventory, exit 0
 *   node scripts/ci/report-source-grep-tests.mjs --ratchet  # exit 1 if it grew
 *   node scripts/ci/report-source-grep-tests.mjs --strict   # exit 1 on any
 *   node scripts/ci/report-source-grep-tests.mjs --json
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this script lives on disk, or null when that question has no answer.
 *
 * Under Vitest, `import.meta.url` is NOT a file: URL - the transform rewrites
 * it - so `fileURLToPath` throws ERR_INVALID_URL_SCHEME at module load. That
 * killed the whole spec file before a single test ran: the tool could not be
 * imported by the test written to prove it works. Resolving defensively means
 * importing is always safe, and the CLI (a real node entry point, where the
 * URL is a genuine file:) is unaffected.
 */
const SELF = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
})();

const ROOT = SELF ? join(dirname(SELF), '..', '..') : '';
const TESTS = ROOT ? join(ROOT, 'tests') : '';

/** Every *.test.ts / *.test.tsx under tests/, recursively. */
function testFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'fixtures') continue;
      testFiles(full, out);
    } else if (/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Does this file exercise the unit, or only read it?
 *
 *   render( / renderHook(        React behaviour
 *   from '../../src/...'         a real import of the thing under test
 *   from '@/utils/...'           the SAME import through the path alias
 *   await import( / import('@/   a dynamic one
 *   new Something(               a class under test
 *
 * THE ALIAS ARM IS A BUG FIX, not thoroughness (found 2026-08-31, before it
 * ever fired). This repo aliases `@/` to `src/` in vitest.config.ts, and tests
 * genuinely use it - `from '@/utils/mapEngineSnapshot'` appears three times
 * today. Without that arm, a test that imports its unit PROPERLY through the
 * alias and also happens to readFileSync something would be filed as
 * text-only. If it read a `src/utils/*` path it would count as a violation,
 * push the ratchet past its baseline, and fail CI on a test that is doing
 * exactly the right thing - a false accusation from the tool whose whole
 * purpose is telling real coverage from fake. None of today's five use the
 * alias, so nothing was miscounted; this closes it before one does.
 */
const EXERCISES =
  /(\brender(Hook)?\s*\(|from\s+['"](?:[./]*\.\.\/(?:\.\.\/)?src\/|[@~]\/)|await\s+import\s*\(|\bimport\s*\(\s*['"][@~]\/|\bnew\s+[A-Z]\w*\s*\()/;
const READS_SOURCE = /readFileSync\s*\(/;

/**
 * Is this file body a text-only pin, and what does it pin?
 *
 * EXPORTED so it can be tested by running it, which is the entire thesis of
 * this script. A tool that enforces "assert what it DOES" and is itself pinned
 * by a regex over its own source would be a joke with a straight face.
 * tests/unit/sourceGrepReporter.test.ts feeds it real file bodies.
 */
export function classify(body) {
  const textOnly = READS_SOURCE.test(body) && !EXERCISES.test(body);
  return { textOnly, pins: textOnly ? pinnedPaths(body) : [] };
}

/** Which source file(s) a text-only test is pinning, for the report. */
function pinnedPaths(body) {
  const hits = new Set();
  for (const m of body.matchAll(
    /['"`]((?:src|server\/src|scripts)\/[^'"`]+\.(?:ts|tsx|js|mjs|css))['"`]/g
  )) {
    hits.add(m[1]);
  }
  return [...hits];
}

/**
 * IMPORTED, NOT RUN, when something else loads this module.
 *
 * Everything below used to execute at import time, which meant a test that
 * imported `classify` would also scan the whole suite, print a report, and -
 * on a repo that happened to be over the ratchet - call process.exit(1) in the
 * middle of somebody's test run. Guarded so the CLI only runs when this file
 * IS the entry point.
 */
/**
 * Resolve symlinks before comparing, or the gate disables ITSELF in silence.
 *
 * `import.meta.url` is always the REAL path; `process.argv[1]` is whatever the
 * caller typed. Invoke this through a symlinked absolute path - which is how
 * every scratch worktree on this machine is reached, /tmp being a symlink to
 * /private/tmp on macOS - and the two strings differ, RUN_AS_CLI is false, and
 * the script prints nothing and exits 0. A required check that passes by doing
 * nothing is the precise failure this whole file exists to catch, so it must
 * not be the way this file fails.
 *
 * Verified before the fix: `node /tmp/ca-symlink/scripts/ci/...mjs --ratchet`
 * produced no output and exit 0. GitHub runners use real paths, and the CI log
 * for #2082 shows the inventory printing, so it was never inert in practice -
 * it was one workflow edit away from being so.
 */
const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const RUN_AS_CLI = !!(
  SELF &&
  process.argv[1] &&
  realOrSelf(SELF) === realOrSelf(process.argv[1])
);

const files = RUN_AS_CLI ? testFiles(TESTS) : [];
const textOnly = [];
for (const f of files) {
  const { textOnly: isTextOnly, pins } = classify(readFileSync(f, 'utf8'));
  if (isTextOnly) textOnly.push({ file: relative(ROOT, f), pins });
}

/** The strict rule: a text-only pin on a pure src/utils module. */
const utilViolations = textOnly.filter((t) => t.pins.some((p) => p.startsWith('src/utils/')));

/**
 * How many text-only `src/utils` pins exist today. The ratchet allows this many
 * and no more. LOWER IT when you migrate one; never raise it.
 *
 * 2026-08-31, the five: member-count-truth (memberCount), deadLobbyIsGone
 * (ChunkPreloader), discardedErrorReadRatchet (settlementLock, unionScope),
 * postBBAskedOnce and timeBankSeatFeedbackAndCards (both mapEngineSnapshot).
 */
const BASELINE_UTIL_VIOLATIONS = 5;

const json = RUN_AS_CLI && process.argv.includes('--json');
const strict = RUN_AS_CLI && process.argv.includes('--strict');
const ratchet = RUN_AS_CLI && process.argv.includes('--ratchet');

/**
 * AN EMPTY SCAN IS A BROKEN SCAN, NOT A CLEAN ONE.
 *
 * If `testFiles` ever returns nothing - a moved directory, a renamed suffix, a
 * ROOT that resolved somewhere unexpected - then `utilViolations` is 0, 0 is
 * under the baseline, and the gate reports "ratchet OK" while having inspected
 * not one file. Zero findings from zero inputs is the oldest silent pass there
 * is. A missing `tests/` already throws ENOENT out of readdirSync; this covers
 * the case where the directory exists and yields nothing.
 */
if ((ratchet || strict) && files.length === 0) {
  console.error(
    '[source-grep-tests] FAILED: scanned 0 test files. That is a broken scan, not a clean repo.'
  );
  console.error(`                    Looked in: ${TESTS || '(unresolved)'}`);
  process.exit(1);
}

if (!RUN_AS_CLI) {
  // Imported for `classify`. Say nothing, exit nothing.
} else if (json) {
  console.log(
    JSON.stringify(
      { total: files.length, textOnly: textOnly.length, utilViolations, files: textOnly },
      null,
      2
    )
  );
} else {
  // `files.length` is 0 only on the inventory run (the gating modes bail out
  // above), and 0/0 prints "NaN%" rather than saying what happened.
  const pct = files.length > 0 ? ((textOnly.length / files.length) * 100).toFixed(0) : '0';
  console.log(
    `[source-grep-tests] ${textOnly.length} of ${files.length} test files (${pct}%) assert on source TEXT and never import or render the unit.`
  );
  console.log(
    '[source-grep-tests] Those cannot catch a line that is present and wrong. See tests/unit/tabSlots.test.ts for the behavioural shape.'
  );
  if (utilViolations.length > 0) {
    console.log('');
    console.log(
      `[source-grep-tests] ${utilViolations.length} of them pin a src/utils module, which is pure and importable:`
    );
    for (const v of utilViolations) {
      console.log(`  ${v.file}`);
      for (const p of v.pins.filter((p) => p.startsWith('src/utils/'))) console.log(`      pins ${p}`);
    }
  } else {
    console.log('[source-grep-tests] OK - no text-only pin on a src/utils module.');
  }
}

if (strict && utilViolations.length > 0) {
  console.error('');
  console.error('[source-grep-tests] FAILED (--strict): a pure src/utils module is pinned by text alone.');
  console.error('                    Import it and assert what it DOES.');
  process.exit(1);
}

if (ratchet) {
  if (utilViolations.length > BASELINE_UTIL_VIOLATIONS) {
    console.error('');
    console.error(
      `[source-grep-tests] FAILED (--ratchet): text-only src/utils pins went from ` +
        `${BASELINE_UTIL_VIOLATIONS} to ${utilViolations.length}.`
    );
    console.error('                    A src/utils module is pure and importable. Import it and');
    console.error('                    assert what it DOES - tests/unit/tabSlots.test.ts is the shape.');
    console.error('                    A regex over source passes on a line that is present and wrong;');
    console.error('                    that is how the stale-seat prune sat broken while "covered".');
    process.exit(1);
  }
  if (utilViolations.length < BASELINE_UTIL_VIOLATIONS) {
    console.log('');
    console.log(
      `[source-grep-tests] The count fell to ${utilViolations.length}. Lower ` +
        `BASELINE_UTIL_VIOLATIONS in this script to ${utilViolations.length} so it cannot climb back.`
    );
  }
  console.log(`[source-grep-tests] ratchet OK (${utilViolations.length}/${BASELINE_UTIL_VIOLATIONS}).`);
}
