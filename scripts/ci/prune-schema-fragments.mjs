#!/usr/bin/env node
/**
 * Absorb and retire the manifest fragments.
 *
 * scripts/ci/schema-manifest.d/*.json let an agent declare a table, function or
 * column it just created without editing the shared snapshot every other agent
 * is editing. That only stays honest if the fragments are temporary and if a
 * fragment that names something production does not have gets found.
 *
 * Run this straight after gen-schema-manifest.mjs, when the base file is a
 * fresh copy of the live schema:
 *
 *   - every name the base now carries is ABSORBED; a fragment with nothing
 *     left to declare is deleted, so the directory empties itself;
 *   - a name the live schema does not have is REPORTED. Under a day old that
 *     is a warning, because an agent may legitimately have committed the
 *     fragment minutes before applying the migration. Older than a day it
 *     fails this job, because by then it is a declaration that will never come
 *     true and it is quietly widening the phantom-reference gate.
 *
 * Exit 0 = nothing outstanding. Exit 1 = a stale fragment needs a human.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadColumnsManifest, readFragments, FRAGMENT_DIR, BASE_SCHEMA } from './schema-manifest.mjs';

const REPO = process.cwd();
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function committedAt(relPath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', relPath], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim();
    return out ? Number(out) * 1000 : Date.now();
  } catch {
    return Date.now();
  }
}

const basePath = join(REPO, BASE_SCHEMA);
if (!existsSync(basePath)) {
  console.error(`[prune-schema-fragments] no base manifest at ${BASE_SCHEMA} - refusing to judge.`);
  process.exit(2);
}
const base = JSON.parse(readFileSync(basePath, 'utf8'));
const baseTables = new Set(base.tables || []);
const baseFns = new Set(base.functions || []);
// The columns loader unions fragments too, so read the base file directly.
const baseColumnsPath = join(REPO, 'scripts/ci/supabase-columns-manifest.json');
const baseColumns = existsSync(baseColumnsPath)
  ? JSON.parse(readFileSync(baseColumnsPath, 'utf8')).columns || {}
  : {};

let deleted = 0;
let trimmed = 0;
const stale = [];
const pending = [];

for (const { file, data } of readFragments(REPO)) {
  const rel = `${FRAGMENT_DIR}/${file}`;
  const keepTables = (data.tables || []).filter((t) => !baseTables.has(t));
  const keepFns = (data.functions || []).filter((f) => !baseFns.has(f));
  const keepCols = {};
  for (const [table, cols] of Object.entries(data.columns || {})) {
    const known = new Set(baseColumns[table] || []);
    const left = cols.filter((c) => !known.has(c));
    if (left.length) keepCols[table] = left;
  }

  const outstanding = [
    ...keepTables.map((t) => `table ${t}`),
    ...keepFns.map((f) => `function ${f}`),
    ...Object.entries(keepCols).flatMap(([t, cs]) => cs.map((c) => `column ${t}.${c}`)),
  ];

  if (outstanding.length === 0) {
    rmSync(join(REPO, rel));
    deleted++;
    console.log(`[prune-schema-fragments] absorbed and removed ${rel}`);
    continue;
  }

  const age = Date.now() - committedAt(rel);
  const bucket = age > STALE_AFTER_MS ? stale : pending;
  bucket.push({ rel, outstanding });

  // Keep only what is still outstanding, so a half-absorbed fragment shrinks
  // instead of re-reporting names the base already carries.
  const next = { ...data };
  if (data.tables) next.tables = keepTables;
  if (data.functions) next.functions = keepFns;
  if (data.columns) next.columns = keepCols;
  const before = JSON.stringify(data);
  if (JSON.stringify(next) !== before) {
    writeFileSync(join(REPO, rel), `${JSON.stringify(next, null, 2)}\n`);
    trimmed++;
  }
}

console.log(
  `[prune-schema-fragments] ${deleted} absorbed, ${trimmed} trimmed, ` +
    `${pending.length} still landing, ${stale.length} stale`
);

for (const { rel, outstanding } of pending) {
  console.log(`::warning title=Fragment not yet in production::${rel} still declares ${outstanding.join(', ')}`);
}
for (const { rel, outstanding } of stale) {
  console.log(
    `::error title=Stale manifest fragment::${rel} has declared ${outstanding.join(', ')} for over a day, ` +
      `and production does not have it. Either ship the migration or delete the fragment - ` +
      `until then it is widening the phantom-reference gate for a name that does not exist.`
  );
}

process.exit(stale.length ? 1 : 0);
