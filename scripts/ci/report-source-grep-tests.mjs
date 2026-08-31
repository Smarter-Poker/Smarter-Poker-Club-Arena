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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TESTS = join(ROOT, 'tests');

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
 *   await import(                a dynamic one
 *   new Something(               a class under test
 */
const EXERCISES =
  /(\brender(Hook)?\s*\(|from\s+['"][./]*\.\.\/(\.\.\/)?src\/|await\s+import\s*\(|\bnew\s+[A-Z]\w*\s*\()/;
const READS_SOURCE = /readFileSync\s*\(/;

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

const files = testFiles(TESTS);
const textOnly = [];
for (const f of files) {
  const body = readFileSync(f, 'utf8');
  if (!READS_SOURCE.test(body)) continue;
  if (EXERCISES.test(body)) continue;
  textOnly.push({ file: relative(ROOT, f), pins: pinnedPaths(body) });
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

const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');
const ratchet = process.argv.includes('--ratchet');

if (json) {
  console.log(
    JSON.stringify(
      { total: files.length, textOnly: textOnly.length, utilViolations, files: textOnly },
      null,
      2
    )
  );
} else {
  const pct = ((textOnly.length / files.length) * 100).toFixed(0);
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
