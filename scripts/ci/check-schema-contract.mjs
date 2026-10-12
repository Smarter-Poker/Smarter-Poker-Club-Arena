#!/usr/bin/env node
/**
 * THE CONTRACT MAY LAG PRODUCTION. IT MAY NEVER BLESS WHAT PRODUCTION LACKS.
 *
 * Run by .github/workflows/schema-manifest-refresh.yml directly after
 * gen-schema-manifest.mjs has written a fresh snapshot of the live schema into
 * the disposable checkout. It compares TWO things and reports THREE outcomes.
 *
 * WHAT IT REPLACED, AND WHY
 *
 * The step before this one was `git diff --quiet -- scripts/ci/` after the
 * regeneration: any difference at all between the committed manifests and live
 * production failed the job, with "regenerate it in a reviewed change".
 *
 * That command cannot pass in this repository, and the measurement says so:
 * the `refresh` job RAN sixteen times between 2026-09-13 and 2026-10-02 and
 * FAILED all sixteen. On the last of those runs production carried 1,541
 * tables and 4,306 functions against the committed base's 1,321 and 3,572 -
 * about 960 names ahead - and `prune-schema-fragments.mjs` in the same run
 * reported `445 absorbed, 10 trimmed, 10 still landing, 0 stale`. Nothing was
 * wrong. The fragment mechanism was working exactly as designed.
 *
 * It cannot pass because of a rule written down in this repo AFTER that step:
 * scripts/ci/schema-manifest.mjs (2026-09-22) made the base snapshot READ-ONLY
 * to agents, because it was the single most-changed file on main - 25 commits
 * in 24 hours - and every two branches touching it conflicted by construction.
 * Agents declare a new name in their own fragment instead. So the only action
 * that could have satisfied `git diff --quiet` is the one the fragment system
 * exists to forbid, and the same file states what the nightly refresh is for:
 * it "goes red when a promised addition is absent or a promised removal is
 * still live". That is prune's job, plus the one direction nothing checked.
 *
 * A check with one outcome is not a check (CLAUDE.md 10.86 rule 1). This one
 * separates the harms:
 *
 *   PHANTOM  (exit 1) - the committed contract names a table, view, function,
 *       column or REQUIRED column that live production does not have, and no
 *       fragment tombstone retires it. The gates read that contract, so they
 *       are blessing a reference that cannot resolve at runtime: the exact
 *       thing check-phantom-tables.mjs exists to refuse, in the one direction
 *       it could never see. Nothing in this repository checked the BASE file
 *       for its own phantoms before today - prune only ever judged fragments.
 *
 *   BEHIND   (exit 0, reported) - production has names the contract does not.
 *       This is the documented steady state: schema is applied straight to
 *       production here, and a branch that needs a name declares it in its own
 *       fragment. It is reported with its count so the drift stays visible and
 *       so a base regeneration can be judged as due, but it is not a failure:
 *       it was a failure for sixteen consecutive runs and all it did was bury
 *       the signal above it.
 *
 *   COULD NOT TELL (exit 2) - the live snapshot is missing, unparseable or
 *       implausibly empty, or a committed fragment will not parse. Never
 *       reported as clean, and never as a thousand phantoms (10.86 rule 2).
 *
 * The committed side is read from `git show HEAD:` rather than from disk, so
 * neither the regeneration nor prune's deletions can move the verdict, and
 * this step and the stale-fragment step cannot mask one another.
 *
 * This script writes nothing and pushes nothing. The audit stays read-only.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE_SCHEMA = 'scripts/ci/supabase-schema-manifest.json';
const BASE_COLUMNS = 'scripts/ci/supabase-columns-manifest.json';
const BASE_REQUIRED = 'scripts/ci/supabase-required-columns-manifest.json';
const FRAGMENT_DIR = 'scripts/ci/schema-manifest.d';

/** Plausibility floors. The live schema has thousands of each; a snapshot
 *  under these is a failed read dressed as an answer, not a demolished
 *  database. Chosen an order of magnitude below the measured 1,541 / 4,306. */
const MIN_LIVE_TABLES = 200;
const MIN_LIVE_FUNCTIONS = 500;
/** Every base table and view has at least one column, so the live column
 *  snapshot covers essentially every relation the table list carries. A
 *  fraction of that is a failed read; a quarter leaves an order of magnitude
 *  of slack and still cannot be satisfied by an empty answer. */
const MIN_LIVE_COLUMN_COVERAGE = 0.25;

const cannotTell = (why) => {
  console.error(`[schema-contract] COULD NOT TELL: ${why}`);
  console.error('[schema-contract] refusing to report this as clean or as a phantom.');
  process.exit(2);
};

function fromGitHead(path) {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    cannotTell(`cannot read ${path} out of HEAD (${err.message.split('\n')[0]})`);
  }
}

function jsonFromGitHead(path) {
  const raw = fromGitHead(path);
  try {
    return JSON.parse(raw);
  } catch (err) {
    cannotTell(`HEAD:${path} will not parse (${err.message})`);
  }
}

function liveJson(path) {
  if (!existsSync(path)) {
    cannotTell(`${path} is not on disk - gen-schema-manifest.mjs has to run before this step`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    cannotTell(`${path} will not parse (${err.message})`);
  }
}

// ---------------------------------------------------------------- live side
const live = liveJson(BASE_SCHEMA);
const liveCols = liveJson(BASE_COLUMNS);
const liveReq = liveJson(BASE_REQUIRED);
const liveTables = new Set(live.tables || []);
const liveFns = new Set(live.functions || []);
const liveColumns = liveCols.columns || {};
if (liveTables.size < MIN_LIVE_TABLES) {
  cannotTell(`the live snapshot carries ${liveTables.size} tables, under the ${MIN_LIVE_TABLES} floor`);
}
if (liveFns.size < MIN_LIVE_FUNCTIONS) {
  cannotTell(`the live snapshot carries ${liveFns.size} functions, under the ${MIN_LIVE_FUNCTIONS} floor`);
}
const columnFloor = Math.floor(liveTables.size * MIN_LIVE_COLUMN_COVERAGE);
if (Object.keys(liveColumns).length < columnFloor) {
  cannotTell(
    `the live column snapshot covers ${Object.keys(liveColumns).length} of ${liveTables.size} relations, under the ${columnFloor} floor`
  );
}

// ----------------------------------------------------------- committed side
const baseSchema = jsonFromGitHead(BASE_SCHEMA);
const baseColumns = jsonFromGitHead(BASE_COLUMNS).columns || {};
const baseRequired = jsonFromGitHead(BASE_REQUIRED).required || {};
const baseTables = new Set(baseSchema.tables || []);
const baseFns = new Set(baseSchema.functions || []);

/** Every committed fragment, read out of HEAD for the reason in the header. */
let fragmentFiles = [];
try {
  fragmentFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', FRAGMENT_DIR], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.json'))
    .sort();
} catch (err) {
  cannotTell(`cannot list ${FRAGMENT_DIR} in HEAD (${err.message.split('\n')[0]})`);
}

const declaredTables = new Set();
const declaredFns = new Set();
const declaredColumns = new Map();
const tombstonedTables = new Set();
const tombstonedFns = new Set();
for (const file of fragmentFiles) {
  let data;
  try {
    data = JSON.parse(fromGitHead(file));
  } catch (err) {
    cannotTell(`manifest fragment HEAD:${file} will not parse (${err.message})`);
  }
  for (const t of data.tables || []) declaredTables.add(t);
  for (const f of data.functions || []) declaredFns.add(f);
  for (const t of data.removedTables || []) tombstonedTables.add(t);
  for (const f of data.removedFunctions || []) tombstonedFns.add(f);
  for (const [table, cols] of Object.entries(data.columns || {})) {
    if (!declaredColumns.has(table)) declaredColumns.set(table, new Set());
    for (const c of cols) declaredColumns.get(table).add(c);
  }
}

// -------------------------------------------------------------- the verdict
//
// PHANTOM is the BASE file's own dead names. A fragment's unproved promise is
// prune-schema-fragments.mjs's business - it owns the 24-hour window and the
// stale refusal - and judging it here too would double-report one finding and
// let either step mask the other.
const phantomTables = [...baseTables].filter((t) => !liveTables.has(t) && !tombstonedTables.has(t)).sort();
const phantomFns = [...baseFns].filter((f) => !liveFns.has(f) && !tombstonedFns.has(f)).sort();

const phantomColumns = [];
for (const [table, cols] of Object.entries(baseColumns)) {
  // A table that is gone is already reported above; listing each of its
  // columns as well would turn one finding into forty.
  if (!liveTables.has(table) || tombstonedTables.has(table)) continue;
  const liveSet = new Set(liveColumns[table] || []);
  for (const c of cols) {
    if (!liveSet.has(c)) phantomColumns.push(`${table}.${c}`);
  }
}
phantomColumns.sort();

// A required column that production no longer has makes the required-column
// gate demand an INSERT supply something that is not there, which reds a
// correct pull request. Same class of harm, opposite direction.
const phantomRequired = [];
for (const [table, cols] of Object.entries(baseRequired)) {
  if (!liveTables.has(table) || tombstonedTables.has(table)) continue;
  const liveSet = new Set(liveColumns[table] || []);
  for (const c of cols) {
    if (!liveSet.has(c)) phantomRequired.push(`${table}.${c}`);
  }
}
phantomRequired.sort();

const behindTables = [...liveTables].filter((t) => !baseTables.has(t) && !declaredTables.has(t)).sort();
const behindFns = [...liveFns].filter((f) => !baseFns.has(f) && !declaredFns.has(f)).sort();

const show = (label, names, cap = 40) => {
  if (names.length === 0) return;
  console.log(`  ${label}: ${names.length}`);
  for (const n of names.slice(0, cap)) console.log(`    ${n}`);
  if (names.length > cap) console.log(`    (+${names.length - cap} more)`);
};

console.log('[schema-contract] live production:');
console.log(`  ${liveTables.size} tables/views, ${liveFns.size} functions`);
console.log('[schema-contract] the committed contract:');
console.log(
  `  base ${baseTables.size} tables/views, ${baseFns.size} functions; ` +
    `${fragmentFiles.length} fragment(s) declaring ${declaredTables.size} table(s) and ${declaredFns.size} function(s), ` +
    `retiring ${tombstonedTables.size} table(s) and ${tombstonedFns.size} function(s)`
);

const phantomCount =
  phantomTables.length + phantomFns.length + phantomColumns.length + phantomRequired.length;
const behindCount = behindTables.length + behindFns.length;

console.log('');
console.log(`[schema-contract] BEHIND: ${behindCount} live name(s) the contract does not carry.`);
show('tables/views production has and the contract does not', behindTables);
show('functions production has and the contract does not', behindFns);
console.log(
  '  That is the documented steady state: schema is applied straight to production here and a'
);
console.log(
  '  branch that needs a name declares it in its own fragment. Reported, not failed - sixteen'
);
console.log('  consecutive runs failed on it and all that did was bury the phantom check below.');

console.log('');
console.log(`[schema-contract] PHANTOM: ${phantomCount} name(s) the contract blesses that production lacks.`);
show('tables/views', phantomTables);
show('functions', phantomFns);
show('columns', phantomColumns);
show('required columns', phantomRequired);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  try {
    appendFileSync(
      summary,
      [
        '### The committed schema contract against production',
        '',
        `- live: **${liveTables.size}** tables/views, **${liveFns.size}** functions`,
        `- behind (production has, the contract does not): **${behindCount}** - reported, not a failure`,
        `- phantom (the contract blesses, production lacks): **${phantomCount}**`,
        `- fragments carried on HEAD: **${fragmentFiles.length}**`,
        '',
      ].join('\n')
    );
  } catch {
    // A summary that cannot be written is not a verdict. Keep going.
  }
}

if (phantomCount > 0) {
  console.error('');
  console.error('[schema-contract] The gates read this contract, so every name above is a reference');
  console.error('  they will bless and production will refuse at runtime. Fix it by REMOVING the dead');
  console.error('  name from the base manifest in a reviewed change, or by tombstoning it in a fragment');
  console.error(`  under ${FRAGMENT_DIR} ("removedTables" / "removedFunctions") if a migration retired it.`);
  console.error('  Do not regenerate the base to make this pass: that reopens the merge queue the');
  console.error('  fragment system was built to close (scripts/ci/schema-manifest.mjs).');
  process.exit(1);
}

console.log('');
console.log('[schema-contract] ok - the contract blesses nothing production lacks.');
