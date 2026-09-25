#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUNDLE SIZE — measure what users download, then what the app weighs
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS REPLACED THE INLINE SHELL STEP (2026-08-21)
 *
 * The old gate summed every file in `dist/assets` and failed the build on the
 * total. Its own comment said it was gating on "what users actually download".
 * It was not. Measured on the commit that had frozen CI for the whole team:
 *
 *     initial load   888kB raw /  244kB gzipped   (4 files)
 *     whole app     6573kB raw / 1862kB gzipped   (288 files)
 *
 * The gate was charging every push for 1,618kB of gzipped code that no user
 * ever downloads, because 284 of those files are lazily-split route chunks
 * fetched only if you visit that route.
 *
 * That is not merely inaccurate, it is BACKWARDS. Splitting a heavy feature
 * into its own chunk — the correct thing to do — scored identically to
 * shipping it in the entry bundle. The Rive avatar runtime is the clean
 * example: it is dynamically imported behind a check that no player passes
 * today, its author documented that "no player downloads a byte of it", and
 * the gate counted all 182kB anyway. The only way to score well was to delete
 * features, and the only way the number could go down over time was for the
 * product to stop growing.
 *
 * So this measures BOTH numbers and treats them differently:
 *
 *   INITIAL LOAD is gated hard. It is the entry script, the stylesheets and
 *   every chunk the browser is told to preload for the first paint — the real
 *   cost of opening smarter.poker. This is a NEW gate; nothing checked it
 *   before, which is why a static `import * as THREE` into a shared module
 *   could have quietly tripled first load without failing anything.
 *
 *   TOTAL is a ceiling, not a budget. It exists to catch genuine bloat — a
 *   duplicated vendor copy, a library pulled in twice under two versions — and
 *   is set with room for the product to keep growing, because a codebase
 *   adding routes is not a codebase getting worse.
 *
 * Both are reported in the job summary either way, so a regression is visible
 * long before it is fatal.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const DIST = process.argv[2] || 'dist';
const ASSETS = path.join(DIST, 'assets');

/**
 * What the browser fetches before it can paint.
 *
 * Vite writes the entry <script>, the entry <link rel=stylesheet> and a
 * <link rel=modulepreload> for every chunk the entry statically imports. That
 * list IS the initial download; anything reached by `import()` is deliberately
 * absent from it, which is the whole point of splitting.
 */
function initialLoadFiles(html) {
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) refs.add(m[1]);
  const out = [];
  for (const ref of refs) {
    // The built HTML uses the deployed base path (/hub/club-arena/...), so
    // resolve by basename against dist/assets rather than trusting the prefix.
    const candidate = path.join(ASSETS, path.basename(ref));
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

const sizeOf = (file) => {
  const buf = readFileSync(file);
  return { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length };
};
const kb = (n) => Math.round(n / 1024);

async function main() {
  if (!existsSync(ASSETS)) {
    console.error(`[bundle-size] no ${ASSETS} — did the build run?`);
    process.exit(1);
  }

  // `diamond-test.*` is the standalone Diamond bonus test entry, built by a
  // second Vite pass (vite.config.ts, TEST_ENTRY). It shares the directory so
  // the origin pools it and the service worker caches it like every other
  // chunk, but no player downloads it, so it is not charged to the budget that
  // guards what players download.
  const all = (await readdir(ASSETS))
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .filter((f) => !f.startsWith('diamond-test.'))
    .map((f) => path.join(ASSETS, f));

  if (all.length === 0) {
    console.error('[bundle-size] dist/assets holds no js or css — refusing to pass a build that produced nothing');
    process.exit(1);
  }

  const htmlPath = path.join(DIST, 'index.html');
  if (!existsSync(htmlPath)) {
    console.error('[bundle-size] no dist/index.html — cannot tell initial load from lazy chunks');
    process.exit(1);
  }
  const entry = initialLoadFiles(readFileSync(htmlPath, 'utf8'));
  if (entry.length === 0) {
    // Guard against a silent pass: if the parse breaks, "0kB initial" would
    // look like a spectacular win rather than a broken measurement.
    console.error('[bundle-size] parsed ZERO entry files out of index.html — the measurement is broken, not the bundle');
    process.exit(1);
  }

  const sum = (files) =>
    files.reduce(
      (acc, f) => {
        const { raw, gz } = sizeOf(f);
        acc.raw += raw;
        acc.gz += gz;
        return acc;
      },
      { raw: 0, gz: 0 }
    );

  const initial = sum(entry);
  const total = sum(all);

  // ── Limits ────────────────────────────────────────────────────────────────
  // Set against the real numbers on 2026-08-21 (initial 244kB gz, total
  // 1862kB gz) with deliberate, stated headroom rather than round guesses.

  /** Hard gate. ~31% over today: catches a heavy library landing in the entry
   *  (three.js alone would add ~146kB gz and blow straight through it) while
   *  leaving room for ordinary growth. */
  const INITIAL_GZ_LIMIT = 320;
  const INITIAL_RAW_LIMIT = 1400;

  /** Ceiling, not a budget. Trips on duplicated vendors or a library arriving
   *  twice, not on the product gaining routes.
   *
   *  RAISED 2026-09-01 (Dan's call): 2400 -> 2600 gz, 8400 -> 9200 raw.
   *
   *  Not a waiver. The ceiling was set on 2026-08-21 against a 1862kB gz app
   *  with ~29% of deliberate headroom for growth. That headroom is now gone:
   *  on 2026-09-01 EVERY open pull request in the repository measured within
   *  25kB of the ceiling, and main itself never measures at all because
   *  Production Build only runs on pull_request. The first feature to arrive
   *  after the room ran out was failing for the product's whole accumulated
   *  history rather than for anything it did, which is precisely the failure
   *  mode the block above says this gate must not have: "a codebase adding
   *  routes is not a codebase getting worse".
   *
   *  Measured before raising it, so the growth is known to be growth:
   *    main                          2328kB gz / 388 files  (local build)
   *    same tree + table management  2355kB gz / 393 files  (local build)
   *    ten heaviest chunks inspected: one copy each of react, error reporting,
   *      supabase, motion and the chart runtime. No duplicated vendor, no
   *      library arriving twice.
   *
   *  The two REAL regressions that measurement exposed were fixed rather than
   *  absorbed, and both were on the initial load, the gate that actually
   *  protects users. A root-mounted ticker was importing one function out of
   *  the 1,482-line lobby view-model, and the eager app shell was statically
   *  importing the operator command gateway. Entry cost of the feature fell
   *  from +11kB gz to +3kB gz. INITIAL_GZ_LIMIT is deliberately untouched.
   *
   *  ~8% of headroom is a quarter of what the original author allowed. That is
   *  intentional: enough that ordinary work is not blocked, little enough that
   *  this comment gets read again soon rather than never.
   */
  // 2026-09-14: four requested Three.js games add one shared, lazy renderer.
  // Paired builds with the same dependencies/config: main a00f5c5c measured
  // 2527kB gz / 8963kB raw; Diamond Spins measured 2723kB gz / 9674kB raw.
  // Source-map inspection found one copy of Three.js (129kB gz shared chunk)
  // and unchanged single React, Supabase, Motion and chart vendors.
  // Restored hosted build35184528688: 2651kB gz / 9444kB raw, initial297kB gz;
  // reuse the original game-feature envelope below, with telemetry still removed.
  // The remaining growth is the four game routes and their controls. The
  // eager game-door imports were fixed first: initial load fell 311 -> 298kB
  // gz, versus main's 296kB. No new source module enters first paint.
  // This accounts for the new product surface with 77kB total headroom;
  // initial-load limits and the entry-module gate remain unchanged.
  // 2026-09-24: raised to 2840 with the owner's explicit approval (Dan, in the
  // #5193 delivery session) for the club and union diamond commerce UI.
  // Paired builds with the same dependencies: main 91837c041 2794kB gz; #5193
  // 2816kB gz. A source-map audit of every chunk found no module in two
  // chunks; the one duplicated vendor (immer 10 beside immer 11) was removed
  // in #5196. The growth is new product surface: the staff Commerce Desk
  // route (+14.6kB gz with its stylesheet) and the owner Diamond Costs page
  // (+6.4kB gz). Initial load is unchanged at 307kB gz; the initial-load
  // limits and the entry-module gate are untouched.
  const TOTAL_GZ_CEILING = 2840;
  const TOTAL_RAW_CEILING = 10000;

  const biggest = all
    .map((f) => ({ name: path.basename(f), ...sizeOf(f) }))
    .sort((a, b) => b.gz - a.gz)
    .slice(0, 10);

  const lines = [
    '## Bundle Size',
    '',
    '| Measure | Raw | Gzipped | Limit (gz) | Files |',
    '|---|---|---|---|---|',
    `| **Initial load** (what users download) | ${kb(initial.raw)}kB | **${kb(initial.gz)}kB** | ${INITIAL_GZ_LIMIT}kB | ${entry.length} |`,
    `| Whole app (incl. lazy routes) | ${kb(total.raw)}kB | ${kb(total.gz)}kB | ${TOTAL_GZ_CEILING}kB ceiling | ${all.length} |`,
    '',
    `Lazy chunks account for **${kb(total.gz - initial.gz)}kB gzipped** that no single session fetches.`,
    '',
    '<details><summary>10 heaviest chunks</summary>',
    '',
    '| Chunk | Raw | Gzipped |',
    '|---|---|---|',
    ...biggest.map((b) => `| \`${b.name}\` | ${kb(b.raw)}kB | ${kb(b.gz)}kB |`),
    '',
    '</details>',
  ];
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, lines.join('\n') + '\n');
  console.log(
    `[bundle-size] initial ${kb(initial.raw)}kB raw / ${kb(initial.gz)}kB gz (${entry.length} files) | ` +
      `total ${kb(total.raw)}kB raw / ${kb(total.gz)}kB gz (${all.length} files)`
  );

  const fail = (msg) => {
    console.error(`::error::${msg}`);
    return true;
  };
  let failed = false;

  if (kb(initial.gz) > INITIAL_GZ_LIMIT) {
    failed = fail(
      `Initial load ${kb(initial.gz)}kB gzipped exceeds ${INITIAL_GZ_LIMIT}kB. Something heavy is being imported STATICALLY by the entry — make it a dynamic import() so it splits into its own chunk.`
    );
  }
  if (kb(initial.raw) > INITIAL_RAW_LIMIT) {
    failed = fail(
      `Initial load ${kb(initial.raw)}kB raw exceeds ${INITIAL_RAW_LIMIT}kB.`
    );
  }
  if (kb(total.gz) > TOTAL_GZ_CEILING) {
    failed = fail(
      `Whole app ${kb(total.gz)}kB gzipped exceeds the ${TOTAL_GZ_CEILING}kB ceiling. This is a bloat ceiling, not a growth budget: look for a duplicated vendor library before deleting features.`
    );
  }
  if (kb(total.raw) > TOTAL_RAW_CEILING) {
    failed = fail(`Whole app ${kb(total.raw)}kB raw exceeds the ${TOTAL_RAW_CEILING}kB ceiling.`);
  }

  if (failed) process.exit(1);
  console.log(
    `[bundle-size] OK — initial ${kb(initial.gz)}kB/${INITIAL_GZ_LIMIT}kB gz, total ${kb(total.gz)}kB/${TOTAL_GZ_CEILING}kB gz`
  );
}

main().catch((err) => {
  console.error('[bundle-size] failed:', err);
  process.exit(1);
});
