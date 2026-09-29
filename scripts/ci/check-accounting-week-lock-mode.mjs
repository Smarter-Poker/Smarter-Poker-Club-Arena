#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN ACCRUAL SHARES THE WEEKLY ACCOUNTING LANE. ONLY THE CLOSE OWNS IT.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-29)
 *
 * Four functions guard the weekly accounting period with an advisory lock keyed
 * on (club-or-union, week_start, week_end):
 *
 *   fn_accrue_cash_hand_commissions                 once per CASH HAND
 *   fn_settle_tournament_rake                       once per TOURNAMENT RAKE SETTLE
 *   fn_lock_cash_bank_accounting_week               once per HAND, via atomic_distribute_rake
 *   fn_lock_accounting_tournament_recognition_week  once per tournament recognition
 *
 * All four took it EXCLUSIVELY. The lock exists for one reason, and
 * fn_resolve_accounting_routing_scope says so in a comment:
 *
 *     "Acquire before reading source-club membership: a waiting close must see
 *      all earning sources committed by the previous lock holder. Accrual
 *      shares this key."
 *
 * Many accruals against one close is a reader/writer contract. It was built as
 * writer/writer, and the key spans SEVEN DAYS, so for a whole week every cash
 * hand and every tournament rake settle in a club queued behind one lock in
 * FIFO order. Measured on production 2026-09-29 02:52 UTC over 20 s: a mean of
 * 24.25 backends waiting on advisory locks, of which 18.05 - 74.4% of all
 * advisory waiting on the platform - were on these week keys, against 0.80 on
 * the per-table hand locks that fan out correctly. Queues ran seven deep, and
 * every waiter held its other locks while it waited, including the FOR KEY
 * SHARE that the rake_records -> clubs foreign key takes on the club row. The
 * clubs tuple queue was downstream of this one.
 *
 * ── WHAT THIS REFUSES ───────────────────────────────────────────────────────
 *
 * A migration that redefines one of the four and takes the WEEK key
 * exclusively again, or that drops the shared acquisition altogether.
 *
 * It does NOT refuse, because each is the rule being obeyed:
 *
 *   pg_advisory_xact_lock_shared(<week key>)   an accrual. This is the point.
 *   pg_advisory_xact_lock('accounting_cash_hand:'||p_hand_id)
 *                                              the per-hand exactly-once guard
 *                                              inside fn_accrue_cash_hand_commissions.
 *                                              It is per hand, it never contends
 *                                              with a sibling, and it is not this
 *                                              bug. It stays exclusive.
 *   anything in the CLOSE functions            fn_resolve_accounting_routing_scope,
 *                                              fn_prepare_accounting_week and
 *                                              fn_process_weekly_accounting_scope
 *                                              are the exclusive side and are not
 *                                              inspected here at all.
 *
 * ── WHY ALL FOUR, AND NOT WHICHEVER ONE YOU ARE EDITING ─────────────────────
 *
 * fn_settle_tournament_rake calls fn_lock_accounting_tournament_recognition_week
 * on the SAME key. If one of that pair goes back to exclusive, the chain asks
 * for an exclusive lock over its own shared hold. This repository already paid
 * for that lesson: "2026-09-10: no upgrades, they deadlock"
 * (fn_ca_lock_settlement_lane_global). That is why the gate covers the set.
 *
 * THREE OUTCOMES (10.86 rule 1):
 *   0  every redefinition shares the week lane
 *   1  one of them takes it exclusively again
 *   2  COULD NOT TELL - the diff was unreadable, usually a shallow checkout
 *
 * Usage:
 *   node scripts/ci/check-accounting-week-lock-mode.mjs [baseRef]
 *   node scripts/ci/check-accounting-week-lock-mode.mjs --all
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'supabase/migrations/';
const ALL = process.argv.includes('--all');

/** The accrual side. Every one of these must take the week key SHARED. */
export const ACCRUAL_GUARDS = [
  'fn_accrue_cash_hand_commissions',
  'fn_settle_tournament_rake',
  'fn_lock_cash_bank_accounting_week',
  'fn_lock_accounting_tournament_recognition_week',
];

/** The one exclusive acquisition that is legitimate inside an accrual guard. */
const PER_HAND_KEY = 'accounting_cash_hand:';

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
      // A gate that silently skips reports success for a check it never ran.
      console.error(
        `[check-accounting-week-lock-mode] cannot diff against "${base}" - the checkout is ` +
          'probably shallow. Give the job fetch-depth: 0, or pass an explicit base ref.'
      );
      process.exit(2);
    }
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(DIR) && l.endsWith('.sql'));
}

/**
 * An explicit, reasoned exemption, in the shape this directory already uses.
 * The reason has to be a real one: 40+ characters, over as many lines as it takes.
 */
export function declaredExceptions(sql) {
  const out = new Map();
  const lines = String(sql).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*--\s*week-lane-ok:\s*([A-Za-z0-9_."]+)\s+because\s+(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let reason = m[2].trim();
    for (let j = i + 1; j < lines.length; j += 1) {
      const c = /^\s*--\s?(.*)$/.exec(lines[j]);
      if (!c) break;
      if (/week-lane-ok:/i.test(c[1])) break;
      reason += ` ${c[1].trim()}`;
    }
    if (reason.trim().length >= 40) {
      out.set(m[1].replace(/\s+/g, '').replace(/^public\./i, '').replace(/"/g, ''), reason.trim());
    }
  }
  return out;
}

/**
 * Every dollar-quoted body this migration gives to `name`. The opening tag is
 * matched to its own closing tag, so a body containing another function's text
 * is still read as one body.
 */
export function bodiesFor(sql, name) {
  const out = [];
  const re = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\s*\.\s*)?` + name + String.raw`\s*\(`,
    'gi'
  );
  let m;
  while ((m = re.exec(sql)) !== null) {
    const rest = sql.slice(m.index);
    const tag = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(rest);
    if (!tag) continue;
    const start = tag.index + tag[0].length;
    const end = rest.indexOf(tag[1], start);
    if (end < 0) continue;
    out.push(rest.slice(start, end));
  }
  return out;
}

/**
 * The exclusive acquisitions in a body that are NOT the per-hand guard, plus
 * whether the body took the week key shared at all. `pg_advisory_xact_lock_shared`
 * is not an exclusive call and never matches.
 */
export function offences(body, name) {
  const found = [];
  const re = /pg_advisory_xact_lock(?!_shared)\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const argument = body.slice(m.index, m.index + 200);
    if (name === 'fn_accrue_cash_hand_commissions' && argument.includes(PER_HAND_KEY)) continue;
    found.push(body.slice(Math.max(0, m.index - 40), m.index + 90).replace(/\s+/g, ' ').trim());
  }
  const shared = /pg_advisory_xact_lock_shared\s*\(/.test(body);
  return { exclusive: found, shared };
}

export function inspect(sql) {
  const exempt = declaredExceptions(sql);
  const hits = [];
  for (const name of ACCRUAL_GUARDS) {
    if (exempt.has(name)) continue;
    for (const body of bodiesFor(sql, name)) {
      const { exclusive, shared } = offences(body, name);
      for (const snippet of exclusive) hits.push({ name, kind: 'exclusive', snippet });
      if (!shared) hits.push({ name, kind: 'missing-shared', snippet: '(no shared acquisition)' });
    }
  }
  return hits;
}

function main() {
  const files = ALL
    ? git(['ls-files', DIR])
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.endsWith('.sql'))
    : changedMigrations(baseRef());

  const hits = [];
  let inspected = 0;
  for (const file of files) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    inspected += 1;
    for (const h of inspect(readFileSync(path, 'utf8'))) hits.push({ ...h, file });
  }

  if (hits.length > 0) {
    console.error('');
    console.error('[check-accounting-week-lock-mode] BLOCKED - the weekly accounting lane is');
    console.error('                                 being taken exclusively by an accrual.');
    console.error('');
    for (const h of hits) {
      console.error(`  ${h.name}: ${h.kind}`);
      console.error(`    ${h.snippet}`);
      console.error(`    in ${h.file}`);
    }
    console.error('');
    console.error('  The week key is held for SEVEN DAYS of traffic. Taken exclusively, every');
    console.error('  cash hand and every tournament rake settle in a club queues behind one');
    console.error('  lock in FIFO order - measured at 74.4% of all advisory waiting on the');
    console.error('  platform, queues seven deep, on 2026-09-29.');
    console.error('');
    console.error('  The lock is there to exclude the weekly CLOSE, which is a reader/writer');
    console.error('  contract, not a writer/writer one:');
    console.error('');
    console.error('  1. YOU ARE AN ACCRUAL (a hand, a rake settle, a bank, a recognition):');
    console.error('       PERFORM pg_advisory_xact_lock_shared(hashtextextended(<week key>,0));');
    console.error('     The close still excludes you. Your siblings no longer do.');
    console.error('');
    console.error('  2. YOU ARE THE WEEKLY CLOSE and are entitled to exclude every accrual:');
    console.error('     put it in fn_resolve_accounting_routing_scope, fn_prepare_accounting_week');
    console.error('     or fn_process_weekly_accounting_scope, which this gate does not inspect.');
    console.error('');
    console.error('  3. IT REALLY IS EXCLUSIVE AND YOU CAN SAY WHY. Name it and give a real');
    console.error('     reason (40+ characters):');
    console.error('       -- week-lane-ok: <function> because <why serialising a week of this');
    console.error('       --   club’s hands behind one lock is acceptable here>');
    console.error('');
    console.error('  Proof either way: scripts/ci/test-accounting-week-lane-shared.py');
    console.error('');
    process.exit(1);
  }

  console.log(
    `[check-accounting-week-lock-mode] OK - ${inspected} migration(s) checked; no accrual ` +
      'takes the weekly accounting lane exclusively, so none of them can convoy its siblings.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
