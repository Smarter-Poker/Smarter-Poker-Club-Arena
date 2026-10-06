#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MIGRATION THAT MERGED MUST BE LIVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-19)
 *
 * Two checks already watch migrations and neither asks this question.
 *
 *   check-migrations-applied.mjs asks it only of the migrations a PULL REQUEST
 *   ADDS, only about the OBJECTS they declare, and only against a nightly
 *   snapshot. Once a branch merges, nothing ever asks again.
 *
 *   check-applied-migrations-are-recorded.mjs asks the OPPOSITE direction -
 *   what production applied that the repo has no file for.
 *
 * So a migration can merge to main, never be applied, and nothing anywhere
 * says so. It looks shipped: merged, green, closed.
 *
 * MEASURED 2026-09-19 across the 202 migrations merged in the preceding seven
 * days. THREE had never reached the database:
 *
 *   20260913172658_a_player_can_see_their_own_responsible_gaming_state
 *     The policy was absent, fn_rg_require_not_excluded is not SECURITY
 *     DEFINER, so it read the table with the caller's privileges, the
 *     player's own row was invisible to the player, and the "no row means no
 *     limits" branch turned that invisibility into permission: a self-excluded
 *     player asking about themselves was told ok: true. Six days.
 *
 *   20260918121836_anon_executes_only_what_it_needs
 *     Thirteen anon grants the repository described as gone were still live,
 *     and docs/security/anon-executable-definers.json described a state the
 *     database could not reach.
 *
 *   20260919025445_early_bird_original_fee_custody_after_player_finality
 *     27 fees still held in escrow.
 *
 * Two of the three are player protection or money.
 *
 * WHY IT IS NOT ENOUGH TO MATCH ON NAMES. Supabase's apply transport stamps
 * its own version and agents submit a condensed blob, so a migration is
 * routinely recorded under a different version and sometimes a different NAME:
 * the cash-lease lock fix of 20260912012000 was applied as
 * `cash_lease_canonical_ownership_and_heartbeat`. On that same sweep, name
 * matching produced TEN candidates of which SEVEN were false. A check that
 * accuses at a 70% false rate gets switched off, which is how this estate
 * already lost `Applied Migrations Are Recorded`.
 *
 * WHY IT IS NOT ENOUGH TO LOOK, EITHER - the reason step 3 exists. The author
 * of this file classified that cash-lease migration as unapplied by reading
 * its function for the wrong lock mode: the edit produces FOR KEY SHARE, and
 * counting FOR SHARE and FOR NO KEY UPDATE by hand said the opposite of the
 * truth. What corrected it was the migration's OWN assertion, which refused on
 * apply with "has 0 cash-lease lock sites, expected exactly 1" - the end state
 * it wanted, stated precisely enough to be machine-checked. Human
 * pattern-matching over a money path is exactly the thing that should not be
 * load-bearing here.
 *
 * HOW THIS DECIDES, cheapest first, and it only accuses when it can prove:
 *
 *   1. NAME. A schema_migrations row whose name matches the file's slug (or
 *      its 55-character truncation, which is how long names are stored).
 *   2. OBJECTS. Otherwise, every object the file CREATEs - function, table,
 *      view, index, trigger, policy - must exist in the live catalogue. This
 *      is what clears the six false positives.
 *   3. PROOF. A file that creates no object cannot be checked that way: it
 *      patches a function body, changes a lock mode, revokes a grant. Those
 *      declare their own proof, one or more lines of:
 *
 *          -- @live-proof: <a boolean SQL expression>
 *
 *      run read-only against production. Every one must come back true. The
 *      four real misses above were all in this class, which is exactly why
 *      the convention exists.
 *
 * VERDICTS. `not-applied` (objects missing, or a declared proof is false) is
 * a failure. `unverifiable` (creates nothing and declares no proof) is
 * reported and, with --require-proof, is also a failure - which is how the
 * convention becomes load-bearing for new migrations without failing on the
 * 3,000 files that predate it.
 *
 * IT NEVER PASSES SILENTLY WHEN IT CANNOT ASK (CLAUDE.md 10.86). No database
 * URL, an unreadable catalogue, an empty answer: exit 2, not 0.
 *
 * Usage:
 *   SUPABASE_DB_URL=postgres://... node scripts/ci/check-migrations-are-live.mjs
 *   ... --days 30            how far back to look (default 21)
 *   ... --since 20260901     absolute floor, wins over --days
 *   ... --require-proof      an unverifiable migration also fails
 * Exit: 0 every migration in the window is live · 1 one is not · 2 could not ask
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadAliases } from './migration-aliases.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'supabase', 'migrations');

/** How long schema_migrations stores a name before it truncates. */
const NAME_PREFIX = 55;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const REQUIRE_PROOF = argv.includes('--require-proof');
const DAYS = Number(flag('days', '21'));

/**
 * THE PULL-REQUEST FORM OF THIS QUESTION (2026-09-27).
 *
 * The scheduled audit accuses a merged migration the moment it is not live.
 * On a pull request that is too early for somebody else's migration merged a
 * minute ago, so .github/workflows/migration-ledger-reconciled.yml runs this
 * with --min-age-hours: a file younger than that (by the version stamp, UTC)
 * that is not live yet is listed as in flight; an older one fails the branch.
 * The scheduled audit passes no flag and is exactly as strict as before.
 */
const MIN_AGE_HOURS = Number(flag('min-age-hours', '0'));

/**
 * RECORDED UNDER ITS OWN FILE NAME (2026-10-03). An apply can record the
 * migration's name as the whole file stem - its own version included - while
 * the transport stamps a new version: production carries
 * `20260927041957 20260927035803_certification_cleanup_removes_archived_public_user_residue`
 * for the file 20260927035803_certification_cleanup_removes_archived_public_user_residue.sql.
 * A name that carries the file's own version AND slug can only be that file,
 * so it matches by name exactly as the bare slug does.
 *
 * Before this, three such 2026-09-27 files fell through to step 3, whose
 * proofs begin `NOT public.fn_platform_frozen()`: every run inside a
 * maintenance freeze (the :55 cutover) read an installed migration as
 * MERGED BUT NOT LIVE, and `Installed and merged migrations agree` went red on
 * main and on every pull request for as long as the freeze lasted.
 */
export function matchedByName(file, recorded, recordedPrefixes) {
  const stem = String(file).replace(/\.sql$/, '');
  const slug = stem.slice(stem.indexOf('_') + 1);
  return [slug, stem].some(
    (n) => recorded.has(n) || recordedPrefixes.has(n.slice(0, NAME_PREFIX))
  );
}

export function stampedAt(file) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(String(file));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * EXPLICITLY MARKED (2026-09-27). The repository's own marker for a file that
 * must never run because a later file replaced it - honoured by
 * check-migrations-applied.mjs since 2026-09-07 - is honoured here too, on the
 * same terms: it must NAME the superseding version, and a file with that
 * version must exist in this directory. "Superseded" is the easiest lie to tell
 * about a migration that simply never ran, so an unverifiable claim is ignored
 * and the file is judged like any other.
 */
export function supersededBy(sql, dirFiles) {
  const m = String(sql).slice(0, 400).match(/^--\s*SUPERSEDED BY\s+(\d{14})\b/m);
  if (!m) return null;
  return dirFiles.some((f) => f.startsWith(`${m[1]}_`)) ? m[1] : null;
}

function windowFloor() {
  const since = flag('since', null);
  if (since) return String(since);
  const d = new Date(Date.now() - DAYS * 86_400_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}000000`;
}

function die(message) {
  console.error(`[migrations-are-live] COULD NOT ASK: ${message}`);
  console.error('   This is not a pass.');
  process.exit(2);
}

function psql(sql) {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  if (!url) die('no SUPABASE_DB_URL / DATABASE_URL in the environment.');
  try {
    return execFileSync(process.env.PSQL_BIN || 'psql', [url, '-Atc', sql], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // execFileSync puts the whole command line in the message, and the first
    // argument IS the connection string, password and all.
    die(String(err.message).split(url).join('<database url>'));
    return '';
  }
}

/**
 * A query the database is allowed to REJECT. `{ out }` when it answered,
 * `{ error }` when it rejected this SQL (psql exit 1 with an ERROR line - a
 * proof casting to regprocedure a function production does not carry yet,
 * say). Anything else - no connection, a timeout - is still COULD NOT ASK,
 * never a verdict.
 */
function ask(sql) {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  if (!url) die('no SUPABASE_DB_URL / DATABASE_URL in the environment.');
  try {
    // VERBOSITY=verbose makes psql prefix the SQLSTATE on an ERROR line, which
    // is the only thing that separates "production does not have that object"
    // from "what you sent me is not SQL". It changes nothing about a query
    // that succeeds.
    const out = execFileSync(
      process.env.PSQL_BIN || 'psql',
      [url, '-v', 'VERBOSITY=verbose', '-Atc', sql],
      {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    return { out };
  } catch (err) {
    const refused = String(err.stderr || '')
      .split('\n')
      .find((l) => l.trim().startsWith('ERROR:'));
    if (err.status === 1 && refused) return { error: refused.trim() };
    die(String(err.message).split(url).join('<database url>'));
    return { error: '' };
  }
}

const rows = (out) =>
  out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/** Blank `--` comments and dollar-quoted bodies so prose is not read as DDL. */
export function code(sql) {
  let out = sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
  const tag = /\$[A-Za-z_]*\$/g;
  let m;
  while ((m = tag.exec(out)) !== null) {
    const close = out.indexOf(m[0], m.index + m[0].length);
    if (close < 0) break;
    const span = close + m[0].length - m.index;
    out = out.slice(0, m.index) + ' '.repeat(span) + out.slice(m.index + span);
    tag.lastIndex = m.index + span;
  }
  return out;
}

/**
 * Every persistent object a migration creates, as {kind, name, on}. pg_temp
 * objects are skipped: they are apply-time scaffolding and are gone by design.
 */
export function declaredObjects(sql) {
  const src = code(sql);
  const out = [];
  const push = (kind, name, on) => {
    if (!name || /^pg_temp\./i.test(name)) return;
    out.push({ kind, name: name.replace(/"/g, ''), on: (on || '').replace(/"/g, '') });
  };
  for (const m of src.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_"][\w."]*)\s*\(/gi
  ))
    push('function', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/gi
  ))
    push('table', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/gi
  ))
    push('view', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/gi
  ))
    push('index', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([A-Za-z_"][\w."]*)/gi
  ))
    push('trigger', m[1]);
  for (const m of src.matchAll(
    /\bCREATE\s+POLICY\s+([A-Za-z_"][\w."]*)\s+ON\s+([A-Za-z_"][\w."]*)/gi
  ))
    push('policy', m[1], m[2]);
  const seen = new Set();
  return out.filter((o) => {
    const k = `${o.kind}:${o.name}:${o.on}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The `-- @live-proof:` lines a migration declares, in file order.
 *
 * ANCHORED, and anchored exactly the way every Lightning harness extracts them
 * (`grep -n -- '^-- @live-proof: '`): the marker must BEGIN the line, with no
 * indentation, one space after the dashes and one after the colon. Unanchored,
 * this harvested prose. 20260925204249 and 20260925215731 each explain the
 * convention in their headers with a sentence that quotes "-- @live-proof:"
 * mid-line, and the tail of that sentence ("` is a claim that an expression is
 * true of the database") was returned as a proof. Every proof is run as ONE
 * UNION ALL query below, so a single harvested sentence is a syntax error that
 * takes EVERY proof in the window down with it, and the check reports it could
 * not ask rather than what it was asked. The harness and this check now read
 * the same lines, which tests/a-merged-migration-must-be-live.law.test.ts pins
 * per Lightning file against the raw line count.
 */
export function declaredProofs(sql) {
  return [...sql.matchAll(/^-- @live-proof: (.*)$/gm)].map((m) => m[1].trim());
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PROOF THIS CHECK CANNOT RUN IS NOT A PROOF THAT CAME BACK FALSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * (2026-09-30.) Step 3 runs each declared proof and treats anything that is
 * not `true` - including a rejection - as evidence the migration is not live.
 * For a rejection that reads "function ... does not exist" that is exactly
 * right, and it is why the rule was written that way: a proof about an
 * unapplied migration names what is not there yet.
 *
 * It is wrong for a rejection that means "what you sent me is not SQL".
 *
 * `declaredProofs` reads ONE LINE, because the marker is line-anchored and
 * every Lightning harness greps for it that way. Three migrations on main
 * declare a proof that does not survive that:
 *
 *   20260929130144  "(SELECT count(*) FROM pg_index i"      truncated -> 42601
 *   20260928200404  "(SELECT count(*) FROM pg_class c ..."  truncated -> 42601
 *   20260928001128  two proofs that are English prose, not SQL at all
 *
 * The first was reported on 2026-09-30 as
 *
 *   proof false: (SELECT count(*) FROM pg_index i  ->  rejected: ERROR: syntax error
 *
 * and counted toward MERGED BUT NOT LIVE. The verdict happened to be right -
 * that migration really is unapplied, decided at step 2 from its missing
 * indexes - but the proof line was this check reading back its own truncation
 * and presenting it as an answer from production. Had the objects been there,
 * a correct migration would have been accused on nothing at all, and this
 * file's own header says why that matters: "a check that accuses at a 70%
 * false rate gets switched off, which is how this estate already lost Applied
 * Migrations Are Recorded."
 *
 * So an unrunnable proof is a THIRD outcome. It is never run, never counted
 * false, always named in the report, and on its own it makes the run exit 2 -
 * COULD NOT TELL - which is neither 0 nor 1 (CLAUDE.md 10.86 rules 1 and 2).
 * A migration that also fails on real evidence still exits 1: FAIL beats
 * COULD-NOT-TELL beats PASS, because there we do know.
 *
 * Two layers catch it, because neither alone is enough:
 *
 *   BEFORE ASKING  `proofIsRunnable` refuses text that cannot be an
 *                  expression - unbalanced parentheses, an unterminated
 *                  literal. That covers every truncation, and it keeps a
 *                  malformed proof out of the shared UNION ALL batch, which is
 *                  the collapse this file already feared.
 *   AFTER ASKING   a rejection carrying SQLSTATE 42601 (syntax_error) is about
 *                  the text we sent and can never be about what production
 *                  holds. A missing object raises 42883 / 42P01 / 42703 and
 *                  stays a failure, exactly as before. Prose that parses as
 *                  SQL but names nothing real is caught here, not above.
 */
export function proofIsRunnable(expr) {
  const s = String(expr ?? '');
  if (!s.trim()) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
      if (tag) {
        const close = s.indexOf(tag[0], i + tag[0].length);
        if (close < 0) return false; // an unterminated dollar quote
        i = close + tag[0].length - 1;
      }
      continue;
    }
    if (c === "'") {
      let from = i + 1;
      for (;;) {
        const q = s.indexOf("'", from);
        if (q < 0) return false; // an unterminated string literal
        if (s[q + 1] === "'") {
          from = q + 2;
          continue;
        }
        i = q;
        break;
      }
      continue;
    }
    if (c === '"') {
      const q = s.indexOf('"', i + 1);
      if (q < 0) return false; // an unterminated quoted identifier
      i = q;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Postgres raises this, and only this, when the TEXT we sent is not SQL. */
const SYNTAX_ERROR = '42601';

/**
 * The SQLSTATE of a psql `ERROR:` line, when psql was asked to print one.
 * `VERBOSITY=verbose` prefixes the code: `ERROR:  42601: syntax error ...`.
 *
 * Null when the line carries no code, and null is deliberately judged the OLD
 * way - as a failure. A surprise in psql's output format must not quietly turn
 * a real miss into a shrug.
 */
export function errorSqlState(line) {
  const m = /^ERROR:\s+([0-9A-Z]{5}):/.exec(String(line || '').trim());
  return m ? m[1] : null;
}

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The executable half. Importing this file runs nothing; the helpers above
 *  are exported so tests/a-merged-migration-must-be-live.law.test.ts parses a
 *  migration exactly the way the check does, instead of a lookalike regex. */
function main() {
// ── read the window ────────────────────────────────────────────────────────
  if (!existsSync(DIR)) die(`${DIR} does not exist`);
  const floor = windowFloor();
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => f.slice(0, f.indexOf('_')) >= floor)
    .sort();

  if (files.length === 0) {
    console.log(`[migrations-are-live] no migrations at or after ${floor}; nothing to check.`);
    process.exit(0);
  }

  // ── 1. names ───────────────────────────────────────────────────────────────
  const recorded = new Set(
    rows(psql(`select name from supabase_migrations.schema_migrations where name is not null`))
  );
  if (recorded.size === 0) die('schema_migrations returned no names at all');
  const recordedPrefixes = new Set([...recorded].map((n) => n.slice(0, NAME_PREFIX)));

  // Apply-time aliases (scripts/ci/migration-aliases.mjs): the same migration
  // recorded under the version and name the Supabase MCP gave it.
  const dirFiles = readdirSync(DIR);
  const aliases = loadAliases(ROOT, { files: dirFiles });
  if (aliases.error) die(`the alias table is unreadable: ${aliases.error}`);
  for (const r of aliases.rejected) console.error(`[migrations-are-live] alias refused: ${r}`);
  const aliasedLive = (file) =>
    (aliases.byFile.get(file) || []).some(
      (row) =>
        recorded.has(String(row.appliedName)) ||
        recordedPrefixes.has(String(row.appliedName).slice(0, NAME_PREFIX))
    );

  const unmatched = [];
  const superseded = [];
  for (const file of files) {
    const slug = file.slice(file.indexOf('_') + 1, -4);
    if (matchedByName(file, recorded, recordedPrefixes)) continue;
    if (aliasedLive(file)) continue;
    const sql = readFileSync(join(DIR, file), 'utf8');
    const by = supersededBy(sql, dirFiles) || aliases.superseded.get(file)?.by || null;
    if (by) {
      superseded.push({ file, by });
      continue;
    }
    unmatched.push({ file, slug, sql });
  }
  for (const s of superseded) {
    console.log(`[migrations-are-live] explicitly marked: ${s.file} is SUPERSEDED BY ${s.by} and must never run.`);
  }

  console.log(
    `[migrations-are-live] ${files.length} migration(s) at or after ${floor}; ` +
      `${files.length - unmatched.length} matched by name, ${unmatched.length} to prove another way.`
  );
  if (unmatched.length === 0) process.exit(0);

  // ── 2. objects ─────────────────────────────────────────────────────────────
  const checks = [];
  for (const m of unmatched) {
    m.objects = declaredObjects(m.sql);
    m.proofs = declaredProofs(m.sql);
    for (const o of m.objects) checks.push({ m, o });
  }

  const missing = new Set();
  if (checks.length > 0) {
    const values = checks
      .map(({ o }) => `(${sqlLiteral(o.kind)},${sqlLiteral(o.name)},${sqlLiteral(o.on)})`)
      .join(',');
    const probe = `
  with want(kind, name, on_rel) as (values ${values}),
       norm as (
         select kind,
                name,
                on_rel,
                position('.' in name) > 0 as qualified,
                case when position('.' in name) > 0 then split_part(name,'.',1) else 'public' end as nsp,
                case when position('.' in name) > 0 then split_part(name,'.',2) else name end as obj
           from want)
  select distinct kind || E'\\t' || name || E'\\t' || on_rel
    from norm w
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where w.kind = 'function' and n.nspname = w.nsp and p.proname = w.obj)
     and not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where w.kind in ('table','view') and n.nspname = w.nsp and c.relname = w.obj)
     -- An index named without a schema takes its TABLE's schema, which the DDL
     -- does not state, so an unqualified one is looked up by name anywhere.
     -- Measured 2026-09-19 against production: f06_one_source, f06_one_active
     -- and f06_one_winner all live in smarter_private, and assuming public
     -- accused all three of not being live.
     and not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where w.kind = 'index' and c.relname = w.obj and c.relkind = 'i'
        and (not w.qualified or n.nspname = w.nsp))
     and not exists (
     select 1 from pg_trigger t where w.kind = 'trigger' and not t.tgisinternal and t.tgname = w.obj)
     and not exists (
     select 1 from pg_policy pol where w.kind = 'policy' and pol.polname = w.obj);`;
    for (const line of rows(psql(probe))) missing.add(line.split('\t').slice(0, 2).join('\t'));
  }

  // ── 3. declared proofs ─────────────────────────────────────────────────────
  const falseProofs = new Map();
  /** Proofs this check could not put a question to. Never a false proof. */
  const unrunnable = new Map();
  const cannotRun = ({ m, p }, why) => {
    if (!unrunnable.has(m.file)) unrunnable.set(m.file, []);
    unrunnable.get(m.file).push(`${p}  ->  ${why}`);
  };

  // Refused BEFORE the database is asked, so a fragment can neither be
  // mistaken for an answer nor collapse the shared UNION ALL below.
  for (const m of unmatched) {
    m.runnableProofs = [];
    for (const p of m.proofs) {
      if (proofIsRunnable(p)) m.runnableProofs.push(p);
      else
        cannotRun(
          { m, p },
          'not a runnable expression (unbalanced parentheses or an unterminated ' +
            'literal - a "-- @live-proof:" is ONE line, so a proof written across ' +
            'several comment lines arrives here truncated)'
        );
    }
  }

  const proofChecks = unmatched.flatMap((m) => m.runnableProofs.map((p) => ({ m, p })));
  if (proofChecks.length > 0) {
    const record = ({ m, p }, answer) => {
      if (!falseProofs.has(m.file)) falseProofs.set(m.file, []);
      falseProofs.get(m.file).push(`${p}  ->  ${answer}`);
    };
    const union = (checks) =>
      checks
        .map(({ p }, i) => `select ${i} as i, coalesce((select (${p}))::text, 'null') as answer`)
        .join(' union all ');
    const judge = (checks, out) => {
      for (const line of rows(out)) {
        const [i, answer] = line.split('|');
        if (answer !== 'true') record(checks[Number(i)], answer);
      }
    };
    // ONE query is cheap and is the normal case. But one proof the database
    // REJECTS fails the whole UNION ALL, and a proof about a migration that is
    // not live is exactly the proof most likely to be rejected, because it
    // names what is not there yet. So a refused batch is asked again file by
    // file, and a refused file proof by proof: a rejected expression becomes a
    // false proof of ITS file instead of silencing every other file's answer.
    const all = ask(union(proofChecks));
    if (all.out !== undefined) {
      judge(proofChecks, all.out);
    } else {
      for (const m of unmatched.filter((u) => u.runnableProofs.length > 0)) {
        const mine = proofChecks.filter((c) => c.m === m);
        const file = ask(union(mine));
        if (file.out !== undefined) {
          judge(mine, file.out);
          continue;
        }
        for (const check of mine) {
          const one = ask(union([check]));
          if (one.out !== undefined) {
            judge([check], one.out);
            continue;
          }
          // A rejection naming a missing object IS evidence this migration is
          // not live, and stays a failure. A syntax error is about the text we
          // sent and can never be about what production holds.
          if (errorSqlState(one.error) === SYNTAX_ERROR) {
            cannotRun(check, `the database refused it as malformed: ${one.error}`);
          } else {
            record(check, `rejected: ${one.error}`);
          }
        }
      }
    }
  }

  // ── the verdict ────────────────────────────────────────────────────────────
  const notApplied = [];
  const inFlight = [];
  const unverifiable = [];
  for (const m of unmatched) {
    const gone = m.objects.filter((o) => missing.has(`${o.kind}\t${o.name}`));
    const bad = falseProofs.get(m.file) || [];
    if (gone.length > 0 || bad.length > 0) {
      const at = stampedAt(m.file);
      if (MIN_AGE_HOURS > 0 && at !== null && Date.now() - at < MIN_AGE_HOURS * 3600000) {
        inFlight.push({ ...m, gone, bad });
        continue;
      }
      notApplied.push({ ...m, gone, bad });
    } else if (m.objects.length === 0 && m.proofs.length === 0) {
      unverifiable.push(m);
    }
  }

  if (unverifiable.length > 0) {
    console.log(
      `\n[migrations-are-live] ${unverifiable.length} migration(s) create no object and declare no proof,\n` +
        '  so whether production carries them cannot be decided from here. Add a line\n' +
        '  "-- @live-proof: <boolean SQL>" to each - the expression a reader would run\n' +
        '  to see the change is there:\n'
    );
    for (const m of unverifiable) console.log(`    ${m.file}`);
  }

  if (unrunnable.size > 0) {
    console.error(
      `\n[migrations-are-live] ${unrunnable.size} migration(s) declare a proof this check\n` +
        '  COULD NOT RUN. These are NOT reported as false: a proof the database never\n' +
        '  answered says nothing whatever about production. Rewrite each one as a\n' +
        '  single-line boolean expression after "-- @live-proof: ":\n'
    );
    for (const [file, why] of unrunnable) {
      console.error(`    ${file}`);
      for (const w of why) console.error(`        ${w}`);
    }
  }

  for (const m of inFlight) {
    console.log(
      `[migrations-are-live] in flight (younger than ${MIN_AGE_HOURS}h, not failed yet): ${m.file}`
    );
  }

  if (notApplied.length > 0) {
    console.error('\n[migrations-are-live] MERGED BUT NOT LIVE:\n');
    for (const m of notApplied) {
      console.error(`  ${m.file}`);
      for (const o of m.gone) console.error(`      missing ${o.kind} ${o.name}`);
      for (const b of m.bad) console.error(`      proof false: ${b}`);
    }
    console.error(
      '\n  These are in the repository and not in the database. Apply each one with the\n' +
        '  Supabase MCP apply_migration, or - if it was superseded - put\n' +
        '  "-- SUPERSEDED BY <version>" on its first line, naming the file that replaced it,\n' +
        '  in a pull request that says why. History is never deleted.\n'
    );
    process.exit(1);
  }

  if (REQUIRE_PROOF && unverifiable.length > 0) {
    console.error('[migrations-are-live] --require-proof: every migration must be checkable.');
    process.exit(1);
  }

  // FAIL beats COULD-NOT-TELL beats PASS. Nothing above is failing, so an
  // unrunnable proof is now the only thing between this run and a clean bill -
  // and a clean bill is not something it is entitled to give.
  if (unrunnable.size > 0) {
    console.error(
      `[migrations-are-live] COULD NOT TELL: ${unrunnable.size} migration(s) above could not be\n` +
        '   proved either way. This is not a pass.'
    );
    process.exit(2);
  }

  console.log('[migrations-are-live] OK - every migration in the window is live in production.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
