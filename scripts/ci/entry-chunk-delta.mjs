#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHO PAYS — the modules in the entry chunk are a reviewed list
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-01)
 *
 * bundle-size.mjs measures two numbers and gates both. Neither can see the
 * thing that actually went wrong on this date.
 *
 * Table Management shipped with two static imports from modules that are
 * mounted eagerly — TournamentStartingTicker, which mounts at the app root
 * outside <Routes>, and TableService, which App reaches through
 * TournamentRankingHost. One of them imported a single function out of the
 * 1,482-line lobby view-model. The other imported the whole operator command
 * gateway for four administrative methods. Between them they moved roughly
 * 190kB raw into the chunk that EVERY player downloads before first paint,
 * for features almost no player will ever open.
 *
 * The initial-load gate did not fire: 309kB against a 320kB limit is a pass.
 * The total gate did fire, but for the wrong reason — the whole-app number had
 * been creeping toward its ceiling for months, so it read as "the product got
 * bigger" rather than "operator code is now in first paint". The leak was
 * found by hand, by diffing two sourcemaps, and only because something else
 * was already red.
 *
 * A limit answers "is it too big yet". It cannot answer "who just started
 * paying, and for what". That is the question this file asks.
 *
 * HOW IT WORKS
 *
 * The entry chunk's sourcemap lists every module Rollup put inside it. That
 * list is committed as `entry-chunk-baseline.json`. A module arriving in the
 * entry chunk is then a line in a diff that a reviewer sees, with the same
 * shape as this estate's other baselines (definer exposure, bus wiring).
 *
 * Only `src/**` is tracked. Third-party modules land in the entry as a
 * CONSEQUENCE of a first-party import — every package that appeared on
 * 2026-09-01 (fast-json-patch, zustand middleware, web-vitals) arrived
 * because `lobbyEntries` did, and all of them left when it did. Tracking them
 * too would add machine-to-machine noise without adding signal.
 *
 * WHEN IT FIRES, THE ANSWER IS USUALLY "MAKE IT LAZY"
 *
 * Not always. Some modules genuinely belong in first paint. Then the right
 * move is to update the baseline IN THE SAME COMMIT and say why in the pull
 * request — which is the entire point: the cost becomes a decision somebody
 * made on purpose, rather than a side effect of an import line.
 *
 * Usage:  node scripts/ci/entry-chunk-delta.mjs [dist]
 *         node scripts/ci/entry-chunk-delta.mjs [dist] --update
 * Exit:   0 clean · 1 an unreviewed module in the entry · 2 script error
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const DIST = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) || 'dist';
const UPDATE = process.argv.includes('--update');
const ASSETS = path.join(DIST, 'assets');
const BASELINE = path.join('scripts', 'ci', 'entry-chunk-baseline.json');

/** Machine-independent module id. Sourcemap sources are relative to the chunk
 *  and differ by checkout depth, so anchor them on the parts that are stable. */
function normalise(source) {
  const nm = source.lastIndexOf('node_modules/');
  if (nm !== -1) return 'node_modules/' + source.slice(nm + 'node_modules/'.length);
  const src = source.lastIndexOf('/src/');
  if (src !== -1) return 'src/' + source.slice(src + '/src/'.length);
  return source.replace(/^(\.\.\/)+/, '');
}

function entryChunk() {
  if (!existsSync(ASSETS)) {
    console.error(`[entry-chunk] no ${ASSETS} — did the build run?`);
    process.exit(2);
  }
  const js = readdirSync(ASSETS).filter((f) => /^index-[^/]*\.js$/.test(f));
  if (js.length !== 1) {
    console.error(
      `[entry-chunk] expected exactly one index-*.js in ${ASSETS}, found ${js.length}. ` +
        'The entry chunk is no longer identifiable and this gate would be measuring the wrong file.'
    );
    process.exit(2);
  }
  const file = path.join(ASSETS, js[0]);
  const map = file + '.map';
  if (!existsSync(map)) {
    console.error(
      `[entry-chunk] ${js[0]} has no sourcemap. This gate reads the module list out of it; ` +
        'without it a leak into first paint is invisible. Do not silence this by skipping the check.'
    );
    process.exit(2);
  }
  const buf = readFileSync(file);
  const sources = JSON.parse(readFileSync(map, 'utf8')).sources || [];
  return {
    name: js[0],
    gz: gzipSync(buf, { level: 9 }).length,
    modules: sources.map(normalise).filter((s) => s.startsWith('src/')).sort(),
  };
}

const kb = (n) => Math.round(n / 1024);

const chunk = entryChunk();

if (UPDATE) {
  writeFileSync(
    BASELINE,
    JSON.stringify({ entry_gz_kb: kb(chunk.gz), modules: chunk.modules }, null, 2) + '\n'
  );
  console.log(
    `[entry-chunk] baseline written: ${chunk.modules.length} src modules, ${kb(chunk.gz)}kB gz.`
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`[entry-chunk] ${BASELINE} is missing. Create it with --update.`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const known = new Set(baseline.modules || []);
const added = chunk.modules.filter((m) => !known.has(m));
const removed = (baseline.modules || []).filter((m) => !chunk.modules.includes(m));
const drift = kb(chunk.gz) - (baseline.entry_gz_kb || 0);

console.log(
  `[entry-chunk] ${chunk.name}: ${chunk.modules.length} src modules, ${kb(chunk.gz)}kB gz ` +
    `(baseline ${(baseline.modules || []).length} modules, ${baseline.entry_gz_kb}kB gz, drift ${drift >= 0 ? '+' : ''}${drift}kB)`
);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary && (added.length || removed.length || drift !== 0)) {
  appendFileSync(
    summary,
    ['## Entry chunk (what every player downloads before first paint)', '',
      `Gzipped: **${kb(chunk.gz)}kB** (${drift >= 0 ? '+' : ''}${drift}kB vs baseline)`, '',
      ...(added.length ? ['**Newly in the entry chunk:**', '', ...added.map((m) => `- \`${m}\``), ''] : []),
      ...(removed.length ? ['**No longer in the entry chunk:**', '', ...removed.map((m) => `- \`${m}\``), ''] : []),
    ].join('\n') + '\n'
  );
}

if (removed.length && !added.length) {
  console.log(
    `[entry-chunk] ${removed.length} module(s) left the entry chunk. That is an improvement, ` +
      'but the baseline is now stale: refresh it with --update so the next change is measured against the truth.'
  );
}

if (added.length) {
  console.error(
    `::error::${added.length} module(s) entered the entry chunk, which every player downloads before first paint:\n` +
      added.map((m) => `  ${m}`).join('\n') +
      '\n\nUsually the fix is to make the import lazy — a dynamic import() in an async ' +
      'path, or a type-only import if you needed only the type. On 2026-09-01 one named ' +
      'import of a single function pulled a 1,482-line module and its whole dependency ' +
      'tree into first paint this way.\n\n' +
      'If a module genuinely belongs in the entry, that is a real decision and the ' +
      'answer is to run `node scripts/ci/entry-chunk-delta.mjs dist --update` in the same ' +
      'commit and say why in the pull request.'
  );
  process.exit(1);
}

console.log('OK — nothing new is being downloaded before first paint.');
