#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TRIGGER ON A MONEY TABLE DECLARES ITSELF IN THE MIGRATION THAT CREATES IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * `UndeclaredTriggerOnAMoneyTable` is critical severity and pages by SMS. Its
 * own description says why it matters:
 *
 *     "Either it is a legitimate change missing its declaration, or it is an
 *      unreviewed one - and the last unreviewed one broke a third of all hand
 *      settlements."
 *
 * On 2026-09-12 it was reading 76. It read 74 ninety minutes earlier in the
 * same session. The register holds 115 declarations, so it is genuinely in use
 * and genuinely drifting: triggers reach money tables faster than anyone
 * declares them, and the alarm that should have caught the first one has been
 * saturated for so long that the seventy-seventh will look exactly like the
 * seventy-sixth.
 *
 * A counter that only ever goes up cannot be acted on. The declaration has to
 * be enforced where the trigger is WRITTEN, not counted after it is live.
 *
 * ── WHAT THIS REFUSES ───────────────────────────────────────────────────────
 *
 * A migration that creates a trigger on one of the nine tables
 * `fn_undeclared_money_triggers` watches, without declaring it in the same
 * migration. The declaration is one row:
 *
 *     INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
 *     VALUES ('table_seats', 'my_new_guard', 'what it guards and why');
 *
 * Same migration, deliberately: a declaration in a later one is a promise, and
 * the register is already 76 broken promises long.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does not review the trigger. It cannot. It enforces that a human wrote
 * down what the trigger is for at the moment they added it, which is the thing
 * the register was built to hold and the thing nobody can reconstruct later.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { partition } from './recorded-migration.mjs';

const REPO = process.cwd();
const DIR = 'supabase/migrations/';
const ALL = process.argv.includes('--all');

/** Exactly the list `fn_undeclared_money_triggers` watches. */
export const MONEY_TABLES = [
  'table_seats',
  'club_members',
  'club_wallets',
  'union_wallets',
  'wallets',
  'chip_ledger',
  'tournaments',
  'tournament_players',
  'ca_settlements',
];

const REGISTER = 'ca_declared_money_triggers';

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
        `[check-money-trigger-declared] cannot diff against "${base}" - the checkout is ` +
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

/** Comments only. String literals are KEPT: the declaration lives inside them. */
export function stripComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * An explicit, reasoned exemption, in the shape this directory already uses.
 * The reason has to be a real one: 40+ characters.
 */
export function declaredExceptions(sql) {
  const out = new Set();
  const lines = String(sql).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*--\s*money-trigger-ok:\s*([A-Za-z0-9_."]+)\s+because\s+(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let reason = m[2].trim();
    for (let j = i + 1; j < lines.length; j += 1) {
      const c = /^\s*--\s?(.*)$/.exec(lines[j]);
      if (!c) break;
      if (/money-trigger-ok:/i.test(c[1])) break;
      reason += ` ${c[1].trim()}`;
    }
    if (reason.trim().length >= 40) out.add(m[1].replace(/\s+/g, '').toLowerCase());
  }
  return out;
}

/**
 * Every trigger this migration creates on a money table that it does not also
 * declare.
 *
 * A migration that declares straight from the live catalogue - the baseline
 * form, `INSERT ... SELECT ... FROM fn_undeclared_money_triggers()` - declares
 * whatever it creates by construction, so it satisfies this outright.
 */
export function offenders(sql) {
  const code = stripComments(String(sql));
  if (/fn_undeclared_money_triggers\s*\(/i.test(code)) return [];

  const exempt = declaredExceptions(sql);
  const declaresRegister = new RegExp(`\\b(?:public\\.)?${REGISTER}\\b`, 'i').test(code);
  const hits = [];
  const seen = new Set();

  const create =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("?[A-Za-z0-9_]+"?)\b([\s\S]*?)\bON\s+(?:public\.)?("?[A-Za-z0-9_]+"?)/gi;

  let m;
  while ((m = create.exec(code)) !== null) {
    const trigger = m[1].replace(/"/g, '');
    const table = m[3].replace(/"/g, '').toLowerCase();
    if (!MONEY_TABLES.includes(table)) continue;

    const key = `${table}.${trigger}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (exempt.has(key)) continue;

    // The declaration names the trigger as a literal next to the register.
    const named = new RegExp(`'${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i').test(code);
    if (declaresRegister && named) continue;

    hits.push({ table, trigger, sawRegister: declaresRegister, sawName: named });
  }
  return hits;
}

/* RECORD OR PROPOSAL (2026-09-21, issue #5008).
 *
 * A file whose bytes are exactly what production already applied for its
 * version is a RECORD of history. Every question this check asks is about a
 * PREDICTION - what the schema will become if this lands - and none of them
 * means anything about a migration that ran days ago. Refusing the record does
 * not undo the change; it only keeps the change out of source control, which
 * is the gap `Applied Migrations Are Recorded` exists to shout about.
 *
 * The proof is a sha256 against production, read from origin/main so a pull
 * request cannot add its own pardon, and "could not tell" judges the file as a
 * proposal. One byte different and it is a proposal again. See
 * scripts/ci/recorded-migration.mjs.
 */
function splitOutRecords(files, label, read) {
  const { records, proposals, note } = partition(files, read);
  if (note) console.error(note);
  if (records.length > 0) {
    console.log(
      `[${label}] ${records.length} file(s) record a migration production has already applied, ` +
        'byte for byte; judged as history rather than as a proposal:'
    );
    for (const f of records) console.log(`   ${f}`);
  }
  return proposals;
}

function main() {
  const base = baseRef();
  const allChangedFiles = ALL
    ? git(['ls-files', `${DIR}*.sql`])
        .split('\n')
        .filter(Boolean)
    : changedMigrations(base);
  const files = splitOutRecords(allChangedFiles, 'check-money-trigger-declared', (f) => {
    try {
      return readFileSync(join(REPO, f), 'utf8');
    } catch {
      return null;
    }
  });

  if (files.length === 0) {
    console.log(
      `[check-money-trigger-declared] no new migrations against ${base} - nothing to check.`
    );
    return;
  }

  const hits = [];
  let inspected = 0;
  for (const file of files) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    inspected += 1;
    for (const o of offenders(readFileSync(path, 'utf8'))) hits.push({ ...o, file });
  }

  if (hits.length > 0) {
    console.error('');
    console.error(
      '[check-money-trigger-declared] BLOCKED - an undeclared trigger on a money table.'
    );
    console.error('');
    for (const h of hits) {
      console.error(`  ${h.trigger} on public.${h.table}`);
      console.error(`    in ${h.file}`);
      if (h.sawRegister && !h.sawName) {
        console.error(`    (the migration writes to ${REGISTER}, but never names this trigger)`);
      }
    }
    console.error('');
    console.error(`  UndeclaredTriggerOnAMoneyTable is critical and pages by SMS. It read 76 on`);
    console.error('  2026-09-12 and had read 74 ninety minutes before, so it is saturated: one');
    console.error('  more makes no visible difference, and the alarm meant to catch the first');
    console.error('  unreviewed trigger can no longer catch any. The last unreviewed one broke a');
    console.error('  third of all hand settlements.');
    console.error('');
    console.error('  Declare it in THIS migration. A declaration in a later one is a promise,');
    console.error('  and the register is already 76 broken promises long:');
    console.error('');
    console.error(`    INSERT INTO public.${REGISTER} (table_name, trigger_name, note)`);
    console.error("    VALUES ('<table>', '<trigger>', '<what it guards, and why it is safe>');");
    console.error('');
    console.error('  If it genuinely must not be declared, say so and say why (40+ characters):');
    console.error('');
    console.error('    -- money-trigger-ok: <table>.<trigger> because <why this one is not');
    console.error('    --   part of the reviewed money surface>');
    console.error('');
    process.exit(1);
  }

  console.log(
    `[check-money-trigger-declared] OK - ${inspected} migration(s) checked; every trigger created ` +
      'on a money table declares itself in the same migration.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
