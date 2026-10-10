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
import { partitionMigrations, reportRecorded } from './recording-only.mjs';
import { join } from 'node:path';

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

/**
 * Comments go. Single-quoted string literals are KEPT, because the declaration
 * lives inside them - `VALUES ('chip_ledger','my_guard', ...)`.
 *
 * DOLLAR-QUOTED BLOCKS ARE DATA UNLESS THEY ARE CODE (2026-09-23).
 *
 * This used to be two `.replace` calls and nothing else, so every character of
 * every `$tag$ ... $tag$` block was read as SQL this migration executes. Two of
 * the migrations recovered in issue #5008 pin their expected catalogue in one:
 *
 *     FOR v_trigger IN SELECT value FROM jsonb_array_elements($trigger_pins$
 *       [{"relation":"table_seats","tgname":"aa_tournament_live_seat_proof_lock",
 *         "definition":"CREATE TRIGGER aa_tournament_live_seat_proof_lock ...
 *                       ON public.table_seats ..."}]$trigger_pins$)
 *
 * That is a migration ASSERTING that a trigger is present and unchanged - the
 * opposite of creating an unreviewed one - and this gate reported all eight of
 * them as new undeclared triggers on money tables. Measured 2026-09-23 across
 * the two files: 33 findings, 32 of them text inside a `$tag$` literal and ONE
 * a real `CREATE TRIGGER` statement. A gate that is wrong 32 times out of 33 is
 * a gate people learn to push past.
 *
 * A block is treated as CODE, and scanned exactly as the surrounding SQL is,
 * when it follows `AS`, `DO` or `EXECUTE` - a function body, an anonymous
 * block, or plpgsql dynamic SQL. Those are the three places a real
 * CREATE TRIGGER can hide, and all three stay visible. Everything else is a
 * value being passed to something, and a value is not a statement.
 */
export function stripComments(sql) {
  const source = String(sql);
  const out = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    if (source.startsWith('--', i)) {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end;
      out.push(' ');
      continue;
    }
    if (source.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (source.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out.push(' ');
      continue;
    }
    if (source[i] === "'") {
      i += 1;
      while (i < source.length) {
        if (source[i++] === "'") {
          if (source[i] !== "'") break;
          i += 1;
        }
      }
      out.push(source.slice(start, i)); // kept: the declaration is in here
      continue;
    }
    if (source[i] === '$' && !/[\w$]/.test(source[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(source.slice(i))?.[0];
      const end = tag ? source.indexOf(tag, i + tag.length) : -1;
      if (end < 0) {
        out.push(source[i++]);
        continue;
      }
      const body = source.slice(i + tag.length, end);
      const before = out.join('');
      const executable = /\b(?:AS|EXECUTE|DO(?:\s+LANGUAGE\s+\w+)?)\s*$/i.test(before);
      out.push(executable ? tag + stripComments(body) + tag : ' ');
      i = end + tag.length;
      continue;
    }
    out.push(source[i++]);
  }
  return out.join('');
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

/** Money tables named as quoted literals in a stretch of SQL. */
function moneyLiterals(text) {
  return MONEY_TABLES.filter((t) => new RegExp(`'(?:public\\.)?${t}'`, 'i').test(text));
}

/**
 * The same text with every single-quoted literal's contents blanked, length
 * kept, so positions still line up. Statement structure - `;`, LOOP, END LOOP,
 * BEGIN - is read from this, never from the original: `RAISE NOTICE 'retry
 * loop; giving up'` holds a LOOP and a `;` that are words, not syntax.
 */
function maskLiterals(code) {
  return code.replace(/'(?:[^']|'')*'/g, (lit) => `'${' '.repeat(lit.length - 2)}'`);
}

/** Index just past the last statement boundary in `shape`: `;`, BEGIN, LOOP, THEN or ELSE. */
function statementStart(shape) {
  let at = shape.lastIndexOf(';') + 1;
  const kw = /\b(?:BEGIN|LOOP|THEN|ELSE)\b/gi;
  let k;
  while ((k = kw.exec(shape)) !== null) at = Math.max(at, k.index + k[0].length);
  return at;
}

/**
 * A CREATE TRIGGER inside a literal that is COMPARED, not run - the shape a
 * proof block uses to pin a trigger's definition:
 *
 *     AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER x BEFORE INSERT ON public.' || r.name || ...
 *
 * creates nothing. PL/pgSQL also assigns with `=` (`v_sql = 'CREATE ...'`),
 * and `:=` always assigns; both of those are SQL about to be run.
 */
function comparedNotRun(code, shape, at) {
  const op = /(:=|<>|!=|=)\s*'$/.exec(code.slice(0, at));
  if (!op || op[1] === ':=') return false;
  if (op[1] === '=') {
    const lhs = code.slice(statementStart(shape.slice(0, op.index)), op.index).trim();
    if (/^[A-Za-z_]\w*$/.test(lhs)) return false;
  }
  return true;
}

/**
 * The tables a run-time target can be. The loop the statement sits in names
 * them - `FOREACH t IN ARRAY ARRAY['a','b'] LOOP`, `FOR r IN SELECT
 * unnest(ARRAY[...]) LOOP`, or `FOREACH t IN ARRAY v_tables LOOP` with
 * v_tables given an ARRAY literal. Outside any loop, the statement's own
 * arguments do: `format('... ON public.%I ...', 'wallets')`.
 *
 * Reading the enclosing loop rather than every literal in the file matters:
 * measured 2026-10-10 against production's catalogue, "any money table the
 * file mentions" was wrong for 15 of the 25 table/trigger pairs it produced
 * across this directory's history, and right for all 10 the loop produced.
 */
function runTimeTargets(code, shape, at) {
  const open = [];
  const kw = /\bEND\s+LOOP\b|\bLOOP\b/gi;
  let k;
  while ((k = kw.exec(shape)) !== null && k.index < at) {
    if (/^END/i.test(k[0])) open.pop();
    else open.push(k.index);
  }
  if (open.length === 0) {
    const end = shape.indexOf(';', at);
    return moneyLiterals(code.slice(at, end < 0 ? code.length : end));
  }
  const loopAt = open[open.length - 1];
  const head = code.slice(statementStart(shape.slice(0, loopAt)), loopAt);
  const named = moneyLiterals(head);
  if (named.length > 0) return named;
  const variable = /\bIN\s+ARRAY\s+([A-Za-z_]\w*)\s*$/i.exec(head)?.[1];
  if (!variable) return [];
  const assigned = new RegExp(
    `\\b${variable}\\b[^;]*?(?::=|=|\\bDEFAULT\\b)\\s*ARRAY\\s*\\[([^\\]]*)\\]`,
    'i'
  ).exec(code);
  return assigned ? moneyLiterals(assigned[1]) : [];
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

  // The target is a written-out table, or a table supplied at run time: a
  // format() placeholder (`ON public.%I`) or a string built with `||`.
  const create =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("?[A-Za-z0-9_]+"?)\b([\s\S]*?)\bON\s+(?:public\.)?("?[A-Za-z0-9_]+"?|%(?:\d+\$)?[IsL]|'\s*\|\|)/gi;

  /**
   * A TABLE SUPPLIED AT RUN TIME IS STILL A TABLE (2026-10-10).
   *
   * Migration 20261005183028 put poker_arena_no_chip_rake on four tables in
   * one loop:
   *
   *     FOREACH t IN ARRAY ARRAY['rake_records','rake_attributions',
   *                              'rake_distribution_legs','club_wallets'] LOOP
   *       EXECUTE format('CREATE TRIGGER poker_arena_no_chip_rake '
   *                      'BEFORE INSERT OR UPDATE ON public.%I ...', t);
   *
   * This gate read `ON public.%I`, could not match `%I` as a table, fell back
   * to reading `public` as the table name, and said OK. club_wallets is a
   * money table, so UndeclaredTriggerOnAMoneyTable fired in production from
   * 2026-10-05 22:18 UTC until the declaration landed on 2026-10-10 (26
   * deliveries) - a critical page for a reviewed guard, which is how the
   * alarm teaches people to ignore it.
   *
   * When the statement cannot name its table, the loop it runs in does: see
   * runTimeTargets(). Each money table that loop walks needs its declaration,
   * exactly as if the statement had been written out once per table.
   */
  const shape = maskLiterals(code);
  let m;
  while ((m = create.exec(code)) !== null) {
    if (comparedNotRun(code, shape, m.index)) continue;
    const trigger = m[1].replace(/"/g, '');
    const dynamic = /^(?:%|')/.test(m[3]);
    const tables = dynamic
      ? runTimeTargets(code, shape, m.index)
      : [m[3].replace(/"/g, '').toLowerCase()];

    for (const table of tables) {
      if (!MONEY_TABLES.includes(table)) continue;

      const key = `${table}.${trigger}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (exempt.has(key)) continue;

      // The declaration names the trigger as a literal next to the register.
      const named = new RegExp(`'${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i').test(
        code
      );
      if (declaresRegister && named) continue;

      hits.push({ table, trigger, sawRegister: declaresRegister, sawName: named, dynamic });
    }
  }
  return hits;
}

function main() {
  const base = baseRef();
  const files = ALL
    ? git(['ls-files', `${DIR}*.sql`])
        .split('\n')
        .filter(Boolean)
    : changedMigrations(base);

  if (files.length === 0) {
    console.log(`[check-money-trigger-declared] no new migrations against ${base} - nothing to check.`);
    return;
  }

  const { judge, recorded, unknown } = partitionMigrations(files, { repo: REPO });
  reportRecorded('check-money-trigger-declared', recorded, unknown);
  if (judge.length === 0) {
    console.log(
      `[check-money-trigger-declared] OK - ${files.length} migration(s); every one is a ` +
        'verified recording of SQL production has already applied. Whether each trigger it ' +
        'names is in public.ca_declared_money_triggers TODAY is asked of production by ' +
        'scripts/ci/check-recorded-migrations-evidence.mjs.'
    );
    return;
  }

  const hits = [];
  let inspected = 0;
  for (const file of judge) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    inspected += 1;
    for (const o of offenders(readFileSync(path, 'utf8'))) hits.push({ ...o, file });
  }

  if (hits.length > 0) {
    console.error('');
    console.error('[check-money-trigger-declared] BLOCKED - an undeclared trigger on a money table.');
    console.error('');
    for (const h of hits) {
      console.error(`  ${h.trigger} on public.${h.table}`);
      console.error(`    in ${h.file}`);
      if (h.sawRegister && !h.sawName) {
        console.error(`    (the migration writes to ${REGISTER}, but never names this trigger)`);
      }
      if (h.dynamic) {
        console.error(
          `    (its table is supplied at run time, and this migration names '${h.table}' as a literal)`
        );
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
