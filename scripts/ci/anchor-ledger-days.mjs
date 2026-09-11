#!/usr/bin/env node
/**
 * ANCHOR THE LEDGER DAY MANIFESTS OUTSIDE THE DATABASE.
 *
 * `ca_ledger_day_manifests` holds one row per day: row_count, first_seq,
 * last_seq, net_amount and a sha256 over that day's journal. It is a good
 * attestation and it is stored in the same database as the journal it hashes,
 * so it proves nothing to anybody who does not already trust that database
 * (roadmap 9.2).
 *
 * This generates each day's expected line in the current checkout and compares
 * it with `docs/attestation/chip-ledger-days.tsv`, which lives in git - a
 * different owner, content-addressed history, and a record Supabase cannot
 * rewrite. In CI the checkout is disposable: source never changes remotely.
 *
 * THE POINT IS THE COMPARISON, NOT THE COPY. A day already anchored is never
 * rewritten. If the database now reports a different sha for a day this file
 * already carries, one of two things is true:
 *
 *   - a restatement row explains it (sanctioned maintenance changed that day
 *     and said so): a NEW line is appended carrying the new value, and the old
 *     line stays exactly where it is;
 *   - nothing explains it: the script FAILS. That is the alarm, and it is the
 *     only reason this file exists.
 *
 * Run by .github/workflows/schema-manifest-refresh.yml on its existing audit
 * schedules. A new or restated line makes the read-only audit fail until a
 * reviewed source change records it; the workflow never commits or pushes.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const FILE = 'docs/attestation/chip-ledger-days.tsv';
const HEADER = '# day\trow_count\tfirst_seq\tlast_seq\tnet_amount\tsha256\tnote';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('[anchor] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(2);
}

async function rest(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: supabaseServerHeaders(key, {
      Accept: 'application/json',
      // Ask for the exact total so a truncated page cannot pass as the whole.
      Prefer: 'count=exact',
    }),
  });
  // Never coerce an unreadable answer into an empty one (CLAUDE.md 10.86).
  if (!res.ok) {
    console.error(`[anchor] ${path} returned HTTP ${res.status} - refusing to treat that as "no rows".`);
    process.exit(2);
  }
  const rows = await res.json();
  // PostgREST caps one response at max-rows (1,000 here). One line a day,
  // that is under three years - after which every later day would silently
  // never be anchored while this script kept reporting "up to date". Found by
  // the deep dive over phase 6 (2026-09-07). Content-Range is "0-N/total";
  // if total is more than we were given, we did not read the whole table.
  const range = res.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (!Number.isFinite(total)) {
    console.error(`[anchor] ${path}: no exact count in Content-Range ("${range}") - refusing to guess whether the answer is complete.`);
    process.exit(2);
  }
  if (Array.isArray(rows) && rows.length < total) {
    console.error(`[anchor] ${path}: ${rows.length} of ${total} rows returned - the response was truncated. Page it before trusting it.`);
    process.exit(2);
  }
  return rows;
}

const days = await rest('ca_ledger_day_manifests?select=day,row_count,first_seq,last_seq,net_amount,sha256&order=day.asc');
const restatements = await rest('ca_ledger_day_manifest_restatements?select=day,new_sha256,reason&order=restated_at.asc');

if (!Array.isArray(days) || days.length === 0) {
  console.error('[anchor] the database reported no manifest days at all. That is not a normal empty; refusing.');
  process.exit(2);
}

const restatedShas = new Map();
for (const r of restatements) {
  if (!restatedShas.has(r.day)) restatedShas.set(r.day, new Set());
  restatedShas.get(r.day).add(r.new_sha256);
}

let lines = [];
if (existsSync(FILE)) {
  lines = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
} else {
  lines = [HEADER];
}

/** Every sha this file already carries, per day. */
const anchored = new Map();
for (const line of lines) {
  if (line.startsWith('#')) continue;
  const [day, , , , , sha] = line.split('\t');
  if (!anchored.has(day)) anchored.set(day, new Set());
  anchored.get(day).add(sha);
}

const money = (n) => Number(n).toFixed(2);
const added = [];
const unexplained = [];

for (const d of days) {
  const have = anchored.get(d.day);
  if (have && have.has(d.sha256)) continue; // already anchored, unchanged

  if (have && have.size > 0) {
    // The day is anchored with a DIFFERENT sha. Only a restatement explains it.
    if (!(restatedShas.get(d.day) || new Set()).has(d.sha256)) {
      unexplained.push({ day: d.day, anchored: [...have], now: d.sha256 });
      continue;
    }
  }

  const note = have && have.size > 0 ? 'restated' : 'original';
  added.push(
    [d.day, d.row_count, d.first_seq ?? '', d.last_seq ?? '', money(d.net_amount), d.sha256, note].join('\t'),
  );
}

if (unexplained.length > 0) {
  console.error('');
  console.error('[anchor] A DAY THAT IS ALREADY ANCHORED NOW HASHES DIFFERENTLY, AND NOTHING EXPLAINS IT.');
  console.error('');
  for (const u of unexplained) {
    console.error(`  ${u.day}`);
    console.error(`    anchored: ${u.anchored.join(', ')}`);
    console.error(`    database: ${u.now}`);
  }
  console.error('');
  console.error('  The journal for a day already attested has changed with no restatement row saying so.');
  console.error('  Either it was changed outside the sanctioned maintenance path, or the change was made');
  console.error('  and never recorded. Both are incidents.');
  console.error('');
  console.error('  What to do, in this order:');
  console.error('    1. read ca_ledger_mutation_log for that day - every sanctioned change keeps the old row;');
  console.error('    2. if the change was legitimate, restate the manifest (a row in');
  console.error('       ca_ledger_day_manifest_restatements saying what changed and why), and this passes;');
  console.error('    3. if nothing accounts for it, the journal was altered. Do not "fix" this file.');
  console.error('');
  process.exit(1);
}

if (added.length === 0) {
  console.log(`[anchor] up to date: ${days.length} day(s) anchored, nothing new.`);
  process.exit(0);
}

mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(FILE, [...lines, ...added].join('\n') + '\n');
console.log(`[anchor] anchored ${added.length} new line(s):`);
for (const a of added) console.log('  ' + a.split('\t').slice(0, 2).join('  ') + ' rows');
