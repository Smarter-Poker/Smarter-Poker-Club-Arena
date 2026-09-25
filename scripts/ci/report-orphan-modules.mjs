#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ORPHAN MODULES — source nothing imports, and tests that guard it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS. On 2026-09-02 an audit found ~200KB of `src/` that no other
 * file in `src/` imports and that `App.tsx` does not route — including
 * `ClubDetailPage.tsx` at 76KB and `PlayerSessionsPage.tsx` at 57KB.
 *
 * That alone is only waste. What makes it a trap is the second column: six of
 * those orphans are asserted against by LAW TESTS. So
 *
 *   - an agent sent to fix a bug "in ClubDetailPage" edits it, runs the tests,
 *     sees green, ships, and changes nothing a player can see;
 *   - and a law failing on dead code blocks `publish-club-arena.yml` for
 *     everyone, over behaviour that is not in the product.
 *
 * Both were live risks the day this was written.
 *
 * WHAT THIS IS NOT. It is not a dead-code deleter, and it does not fail on the
 * orphans that exist today — deleting a page a law test guards means first
 * proving the law still holds against the LIVE equivalent, which is a
 * judgement call per file, not a sweep. This reports, and ratchets, so the set
 * cannot quietly grow while somebody decides.
 *
 * USAGE
 *   node scripts/ci/report-orphan-modules.mjs            # report
 *   node scripts/ci/report-orphan-modules.mjs --ratchet  # fail if the count grew
 *   node scripts/ci/report-orphan-modules.mjs --json     # machine readable
 *
 * The baseline below is deliberately the measured count, not zero. Lower it in
 * the same commit that removes an orphan — the same discipline as
 * `discardedErrorReadRatchet` and `report-source-grep-tests`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'src');
const TESTS = join(ROOT, 'tests');

/**
 * Measured 2026-09-02 at 64. Lowered to 32 on 2026-09-10 when the transitively
 * unreachable tree under src/ (387 files, 30k lines: 73 dead barrels and the
 * design-system layer behind them) was deleted; what remains is every orphan a
 * law test, a ratchet, a CI script or a docs/laws.d entry still reads by path.
 * Lower this when an orphan is routed or deleted. Raising it requires saying
 * why in the PR body.
 */
const BASELINE_ORPHANS = 32;

/** Entry points: reachable by definition, whatever imports them.
 * src/diamond-test.tsx is the module diamond-test.html loads: the standalone
 * Diamond bonus test entry, built by scripts/build-diamond-test.mjs as its own
 * Vite pass (2026-09-19). An HTML entry is reached by the build, not by an
 * import, exactly as main.tsx is reached by index.html. */
const ENTRY_POINTS = new Set([
  'src/main.tsx',
  'src/App.tsx',
  'src/vite-env.d.ts',
  'src/diamond-test.tsx',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isCode = (f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f);

const sourceFiles = walk(SRC).filter(isCode);
const testFiles = walk(TESTS).filter((f) => /\.(ts|tsx)$/.test(f));

/**
 * Every module specifier imported anywhere in src/, resolved to a repo path.
 *
 * Deliberately generous: a file counts as imported if ANY import specifier
 * resolves to it, including via `import type`, `export ... from`, and dynamic
 * `import()`. A false "reachable" costs nothing; a false "orphan" would send
 * somebody to delete live code.
 */
const importedPaths = new Set();

const SPECIFIER = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(SPECIFIER)) {
    const spec = match[1];
    if (!spec.startsWith('.') && !spec.startsWith('@/')) continue; // package import
    const base = spec.startsWith('@/')
      ? join(SRC, spec.slice(2))
      : resolve(dirname(file), spec);

    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
    ]) {
      importedPaths.add(candidate);
    }
  }
}

const allUnimported = sourceFiles
  .filter((f) => !importedPaths.has(f))
  .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  .filter((rel) => !ENTRY_POINTS.has(rel))
  .sort();

/* Barrel files (`index.ts` that only re-exports) are a different animal: they
   exist to be imported and frequently are not, but they carry no behaviour, no
   test ever guards one, and nobody is sent to "fix a bug" in one. Counting
   them buries the ~15 real pages and components under ~90 empty hubs, and a
   report nobody reads is a report that does not work. They are listed
   separately and excluded from the ratchet. */
const isBarrel = (rel) => /\/index\.tsx?$/.test(rel);
const barrels = allUnimported.filter(isBarrel);
const orphans = allUnimported.filter((rel) => !isBarrel(rel));

/** Which orphans are asserted against by a test — the dangerous ones. */
const testText = new Map(testFiles.map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]));
const guardedOrphans = orphans
  .map((orphan) => {
    const guards = [...testText.entries()]
      .filter(([, text]) => text.includes(orphan))
      .map(([name]) => name);
    return { orphan, guards };
  })
  .filter((row) => row.guards.length > 0);

const json = process.argv.includes('--json');
const ratchet = process.argv.includes('--ratchet');

if (json) {
  console.log(JSON.stringify({ orphans, guardedOrphans, baseline: BASELINE_ORPHANS }, null, 2));
} else {
  console.log(`[orphan-modules] ${orphans.length} behavioural file(s) in src/ that nothing in src/ imports.`);
  console.log(`[orphan-modules] (plus ${barrels.length} unimported re-export barrels, not ratcheted.)`);
  console.log('[orphan-modules] These ship to no one. Route them or delete them.');
  for (const o of orphans) console.log(`  ${o}`);

  if (guardedOrphans.length > 0) {
    console.log('');
    console.log(
      `[orphan-modules] ${guardedOrphans.length} of them are ASSERTED AGAINST BY TESTS, which is the trap:`
    );
    console.log('[orphan-modules] a fix there ships nothing, and a failure there blocks the publisher.');
    for (const { orphan, guards } of guardedOrphans) {
      console.log(`  ${orphan}`);
      for (const g of guards) console.log(`      guarded by ${g}`);
    }
  }
}

if (ratchet && orphans.length > BASELINE_ORPHANS) {
  console.error('');
  console.error(
    `[orphan-modules] FAILED (--ratchet): unreachable src/ modules went from ${BASELINE_ORPHANS} to ${orphans.length}.`
  );
  console.error('                  A file nothing imports ships to nobody. Either route it from');
  console.error('                  App.tsx, import it where it belongs, or delete it - and if a');
  console.error('                  test guards it, retarget that test at the LIVE equivalent first.');
  process.exit(1);
}
