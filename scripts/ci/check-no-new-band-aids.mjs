#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NO NEW BAND-AIDS. THE FIX GOES AT THE SOURCE (CLAUDE.md 10.12)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-07: "I DO NOT WANT CRONS AND 'BACK PAY JOBS'! ... MAKE IT A HARD
 * RULE THAT IT IS NO LONGER ALLOWED TO CREATE ANYTHING THAT MONITORS AND BACK
 * FILLS OR ADJUSTS A PAYOUT OR ANY OTHER ISSUE, IT MUST WORK FLAWLESSLY! I WANT
 * HARD CODED FIXES AT THE ROOT SOURCE WHEN AN ISSUE IS DISCOVERED! NOT A
 * FUCKING BAND AID!"
 *
 * WHY A CHECK AND NOT JUST A PARAGRAPH. 10.11 already said a detector is not a
 * fix, in writing, on 2026-09-06. On 2026-09-07 the platform still paid **558
 * payouts / 48,146.94 chips in seven days** through repair machinery instead of
 * through the engine - median six hours late, worst 84 days - and 29 of the 127
 * active cron jobs were repair-shaped. A rule with no reader is a rule that
 * gets re-derived one incident at a time (10.86 rule 3). This is the reader.
 *
 * WHAT IT CHECKS. For every migration this branch adds or modifies:
 *
 *   1. a function DECLARED with a repair-shaped name
 *      (_repair_, _backpay_, _redrive_, _catchup_, _backfill_, _heal_,
 *       _resweep_, _reprocess_, _fixup_, _reconcile_ ...);
 *   2. a `cron.schedule(...)` that schedules one.
 *
 * WHAT IT DELIBERATELY ALLOWS, because each is the rule being obeyed:
 *
 *   - a file that DROPs the function or `cron.unschedule`s the job. Deleting a
 *     band-aid is the point;
 *   - anything named in `scripts/ci/band-aid.allowlist.json`. That file is the
 *     EXISTING debt, and every entry has a row in docs/BAND-AIDS-REGISTER.md
 *     with the root fix that lets it be deleted. It is a list that may only
 *     ever get shorter, which `tests/no-band-aids.law.test.ts` asserts;
 *   - a name that merely CONTAINS a word - `fn_reconcile_view` is judged on the
 *     whole identifier, not on a substring of an English sentence, because the
 *     header of every one of these migrations quotes the words it is about.
 *
 * THREE OUTCOMES (10.86 rule 1):
 *   0  no new band-aid
 *   1  a new band-aid is being declared
 *   2  COULD NOT TELL - the diff was unreadable, usually a shallow checkout
 *
 * Usage:
 *   node scripts/ci/check-no-new-band-aids.mjs [baseRef]
 *   node scripts/ci/check-no-new-band-aids.mjs --all    # sweep every migration
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'supabase/migrations/';
const ALLOWLIST = 'scripts/ci/band-aid.allowlist.json';

/**
 * The shapes. Each is a word that only appears in an identifier when the thing
 * being built repairs something that should not have needed repairing.
 *
 * `sweep` is NOT here and that is deliberate: the engine's legitimate periodic
 * work is full of sweeps that move the game forward (the elimination sweep, the
 * blind sweep) and a name-based check cannot tell those from a repair sweep.
 * Sweeps are caught by review against the register, not by this.
 */
export const BAND_AID_WORDS = [
  'repair',
  'backpay',
  'back_pay',
  'redrive',
  'catchup',
  'catch_up',
  'backfill',
  'heal',
  'reprocess',
  'resweep',
  'fixup',
  'reconcile',
  // `fn_pay_backed_payout_shortfalls` carries none of the words above: it is
  // spelled as a payment, which is exactly how a back-pay job hides. A
  // read-only report that has to be called this is allowlistable; a thing that
  // PAYS a shortfall on a schedule is the rule's whole subject.
  'shortfall',
  'shortfalls',
];

/** Strip comments and single-quoted literals: every header here quotes these words. */
export function stripNoise(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** An identifier is band-aid shaped when one of the words is a whole _-separated part of it. */
export function isBandAidName(name) {
  if (typeof name !== 'string' || name === '') return false;
  const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return BAND_AID_WORDS.some((w) => {
    const wp = w.split('_');
    if (wp.length === 1) return parts.includes(w);
    // multi-word forms like back_pay: look for the run of parts
    for (let i = 0; i + wp.length <= parts.length; i++) {
      if (wp.every((p, k) => parts[i + k] === p)) return true;
    }
    return false;
  });
}

/** Function names this SQL declares. */
export function declaredFunctions(sql) {
  const clean = stripNoise(sql);
  const out = new Set();
  for (const m of clean.matchAll(
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi
  )) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** Function names this SQL drops - deleting a band-aid is the rule being obeyed. */
export function droppedFunctions(sql) {
  const clean = stripNoise(sql);
  const out = new Set();
  for (const m of clean.matchAll(
    /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
  )) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** Job names this SQL schedules with pg_cron, and the ones it unschedules. */
export function scheduledJobs(sql) {
  const clean = stripNoise(sql);
  const added = new Set();
  const removed = new Set();
  // cron.schedule('name', '* * * * *', $$...$$) - the literal was stripped, so
  // read the ORIGINAL text for the job name and the command it runs.
  for (const m of String(sql).matchAll(/cron\.schedule\s*\(\s*'([^']+)'/gi)) {
    added.add(m[1].toLowerCase());
  }
  for (const m of String(sql).matchAll(/cron\.unschedule\s*\(\s*'([^']+)'/gi)) {
    removed.add(m[1].toLowerCase());
  }
  for (const name of removed) added.delete(name);
  return { added: [...added], removed: [...removed] };
}

/** Everything in one file that 10.12 refuses. */
export function offenders(sql, allowed = new Set()) {
  const dropped = new Set(droppedFunctions(sql));
  const found = [];

  for (const fn of declaredFunctions(sql)) {
    if (!isBandAidName(fn)) continue;
    if (allowed.has(fn)) continue;
    if (dropped.has(fn)) continue; // declared then dropped, or replaced on the way out
    found.push({ kind: 'function', name: fn });
  }

  const { added } = scheduledJobs(sql);
  for (const job of added) {
    if (!isBandAidName(job)) continue;
    if (allowed.has(job)) continue;
    found.push({ kind: 'cron job', name: job });
  }

  return found;
}

// ── runner ───────────────────────────────────────────────────────────────────

const ALL = process.argv.includes('--all');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function baseRef() {
  const explicit = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (explicit) return explicit;
  const b = process.env.GITHUB_BASE_REF;
  if (b) {
    for (const ref of [`origin/${b}`, b]) {
      try {
        git(['rev-parse', '--verify', ref]);
        return ref;
      } catch {
        /* try the next form */
      }
    }
  }
  return 'HEAD~1';
}

function changedMigrations(base) {
  let out;
  try {
    out = git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`]);
  } catch {
    try {
      out = git(['diff', '--name-only', '--diff-filter=AM', base, 'HEAD']);
    } catch {
      console.error(
        `[check-no-new-band-aids] COULD NOT TELL: cannot diff against "${base}" - the ` +
          'checkout is probably shallow. Give the job fetch-depth: 0, or pass a base ref.'
      );
      process.exit(2);
    }
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(DIR) && l.endsWith('.sql'));
}

export function loadAllowlist() {
  const path = join(REPO, ALLOWLIST);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const names = Array.isArray(parsed) ? parsed : parsed.existing_debt || [];
    return new Set(names.map((e) => String(e.name || e).toLowerCase()));
  } catch (err) {
    console.error(`[check-no-new-band-aids] COULD NOT TELL: ${ALLOWLIST} is unreadable (${err.message}).`);
    process.exit(2);
  }
}

function main() {
  const base = baseRef();
  const allowed = loadAllowlist();
  const files = ALL
    ? git(['ls-files', `${DIR}*.sql`]).split('\n').filter(Boolean)
    : changedMigrations(base);

  if (files.length === 0) {
    console.log(`[check-no-new-band-aids] no new migrations against ${base} - nothing to check.`);
    return 0;
  }

  const hits = [];
  for (const file of files) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    for (const o of offenders(readFileSync(path, 'utf8'), allowed)) hits.push({ ...o, file });
  }

  if (hits.length === 0) {
    console.log(
      `[check-no-new-band-aids] OK - ${files.length} migration(s) checked; none declares a repair, ` +
        'back-pay, re-drive, catch-up, backfill or heal path.'
    );
    return 0;
  }

  console.error('');
  console.error('[check-no-new-band-aids] BLOCKED - this is a band-aid (CLAUDE.md 10.12).');
  console.error('');
  for (const h of hits) {
    console.error(`  ${h.kind}: ${h.name}`);
    console.error(`    in ${h.file}`);
  }
  console.error('');
  console.error('  Dan, 2026-09-07: "I WANT THE ERRORS FIXED AND PLUGGED AND HARD CODED');
  console.error('  SOLUTIONS TO THE ISSUES ... NOT A FUCKING BAND AID."');
  console.error('');
  console.error('  A real poker room pays the winner when the hand ends. It does not pay');
  console.error('  him six hours later out of a cron. Measured on 2026-09-07: 558 payouts');
  console.error('  and 48,146.94 chips in seven days went through repair machinery instead');
  console.error('  of through the engine - median six hours late, worst 84 days.');
  console.error('');
  console.error('  Do this instead:');
  console.error('');
  console.error('  1. FIND THE LINE that produced the wrong outcome and change it, so the');
  console.error('     outcome cannot occur. If the live path can die half-way, make it one');
  console.error('     transaction, or make it restartable from its OWN record.');
  console.error('  2. SETTLE THE DAMAGE already done through the platform’s own idempotent');
  console.error('     path (10.9). That is a one-off migration, not a schedule.');
  console.error('  3. PIN THE CAUSE with a test.');
  console.error('');
  console.error('  If the cause is genuinely out of reach today, say so plainly and stop.');
  console.error('  Do not ship the plaster and call the defect handled.');
  console.error('');
  console.error(`  Existing debt lives in ${ALLOWLIST} and docs/BAND-AIDS-REGISTER.md.`);
  console.error('  That list may only ever get shorter.');
  console.error('');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
