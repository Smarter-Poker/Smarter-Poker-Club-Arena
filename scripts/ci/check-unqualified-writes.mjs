#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN UNQUALIFIED UPDATE OR DELETE IS REFUSED ON THE ONE PATH THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-06)
 *
 * `20260906150328` replaced a TRUNCATE inside `fn_aggregate_gto_v31_next` with
 *
 *     delete from tmp_agg31;
 *
 * to stop the function churning temp-table DDL on every cron tick. That is
 * legal SQL, legal plpgsql, and it worked perfectly every time it was run from
 * a migration. It broke the function completely on the only path anyone uses:
 *
 *     [GtoAggregationDriverV31.tick] Error: DELETE requires a WHERE clause
 *
 * PostgREST connects as `authenticator`, and on this database that role carries
 *
 *     session_preload_libraries = safeupdate
 *
 * `safeupdate` is loaded per SESSION at connect time and raises on any UPDATE
 * or DELETE with no WHERE clause. A `SET ROLE service_role` afterwards does not
 * unload it, so this catches the ENGINE's service-role RPCs exactly as it
 * catches a browser's - which is how it caught the GTO driver rather than a
 * player.
 *
 * The asymmetry is the whole problem, and it is why nobody had noticed:
 *
 *   as `postgres`, from a migration or pg_cron .......... works
 *   through PostgREST, from the engine or a browser ..... refused
 *
 * So the statement passes every test that runs it the way the author ran it,
 * and fails in production. Sweeping the schema on 2026-09-06 found TEN
 * functions in this shape, one of them a bomb-pot backfill the engine calls and
 * one a settlement RPC the operator dashboard calls.
 *
 * WHAT IT CHECKS. For every migration this branch adds or modifies, any
 * statement of the form
 *
 *     DELETE FROM <table> ;                (no WHERE)
 *     UPDATE <table> SET <...> ;           (no WHERE)
 *
 * is reported. The check is deliberately about the STATEMENT, not about where
 * the statement lives: an unqualified write in a function body, in a DO block,
 * or at migration top level all read the same, and the one in a function body
 * is the dangerous one precisely because it does not fail until something
 * calls it.
 *
 * WHAT IT DOES NOT DO. It does not judge the live database - migrations are
 * applied here by many agents and by hand, so a file check cannot be the whole
 * answer. `fn_ca_unqualified_write_audit()` is the live half. This is the half
 * that stops a NEW one from landing.
 *
 * THE REMEDY IS ALMOST ALWAYS `where true`. It is a no-op predicate over
 * exactly the same rows and it changes nothing but the parser's opinion. If
 * `where true` feels wrong on the statement you just wrote, that is worth
 * listening to: an unqualified DELETE against a REAL table wipes it, and the
 * refusal you are trying to get past may be the only thing standing between an
 * API caller and that table. Scope it properly, or leave it refused.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO = process.cwd();
const DIR = 'supabase/migrations/';
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
      // A gate that silently skips reports success for a check it never ran.
      console.error(
        `[check-unqualified-writes] cannot diff against "${base}" — the checkout is ` +
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
 * Strip what must not be read as code: line comments, block comments, and
 * quoted text.
 *
 * The literals matter more than they look. This very file's remedy text, and
 * every migration header that QUOTES the broken statement to explain it, would
 * otherwise be reported as the defect they are documenting - the exact trap
 * that made an earlier guard in this directory unusable until it was found.
 * Dollar-quoted bodies are deliberately KEPT: a function body is where the
 * dangerous statement lives, so a body is scanned in turn rather than skipped,
 * and an unqualified write inside one is judged on its merits like any other.
 *
 * ONE LEFT-TO-RIGHT PASS, NOT THREE INDEPENDENT REGEXES (2026-09-25)
 *
 * This used to strip block comments, then line comments, then literals, each
 * with its own regex over the whole file. None of them knew about the others,
 * and the project's standard idiom for stripping comments FROM SQL
 *
 *     regexp_replace(pg_get_functiondef(...), '--[^' || chr(10) || ']*', '', 'g')
 *
 * is a string literal that CONTAINS `--`. The comment pass ate from that `--`
 * to end of line, taking the literal's closing quote with it and orphaning the
 * opening one. Five such lines in `20260921151618` flipped quote parity for
 * the rest of the file, so a genuine literal further down
 *
 *     IF v_begin ~ 'UPDATE public\.table_seats|DELETE FROM public\.table_seats'
 *
 * stopped being recognised as a literal, survived into the "clean" SQL, and
 * was reported as an unqualified DELETE on a table the migration never writes.
 * Blocking the branch that quotes a statement, over a statement that is not
 * there, is the precise failure this file exists to avoid - so the passes are
 * now one pass, and a `--` inside a literal can never be a comment nor a quote
 * inside a comment ever be a quote.
 *
 * Recognised, in the order a lexer meets them: identifiers and keywords as
 * whole words (so a `$` inside one cannot open a dollar-quoted body), `--`
 * line comments, block comments (NESTED, as Postgres nests them),
 * single-quoted literals with `''` escapes - and backslash escapes after an
 * `E` prefix - double-quoted identifiers, and dollar-quoted bodies of any tag.
 */
const IDENT_START = /[A-Za-z_\u0080-\uFFFF]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const NOISE_START = /['"$\-/A-Za-z_\u0080-\uFFFF]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/y;

/** The dollar-quote tag opening at `i`, or null if one does not open there. */
function dollarTagAt(src, i) {
  DOLLAR_TAG.lastIndex = i;
  const m = DOLLAR_TAG.exec(src);
  return m ? m[0] : null;
}

export function stripNoise(sql) {
  const src = String(sql);
  const n = src.length;
  let out = '';
  let i = 0;

  // The index just past a single-quoted literal that opens at `start`. `''` is
  // an escaped quote; a backslash escapes the next character only in an E''
  // string, because standard_conforming_strings is on everywhere here.
  const literalEnd = (start, backslashEscapes) => {
    let j = start + 1;
    while (j < n) {
      if (backslashEscapes && src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === "'") {
        if (src[j + 1] === "'") {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j += 1;
    }
    return n; // unterminated: the rest of the file is inside it
  };

  while (i < n) {
    const c = src[i];

    // An identifier or keyword is taken whole, so the `$` in `a$b` is part of
    // the name and opens nothing. `AS $$` must still open, so the run stops at
    // a `$` that begins a dollar-quote tag.
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(src[j])) {
        if (src[j] === '$' && dollarTagAt(src, j)) break;
        j += 1;
      }
      const word = src.slice(i, j);
      out += word;
      i = j;
      if ((word === 'E' || word === 'e') && src[i] === "'") {
        i = literalEnd(i, true);
        out += "''";
      }
      continue;
    }

    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += ' ';
      continue;
    }

    if (c === "'") {
      i = literalEnd(i, false);
      out += "''";
      continue;
    }

    // A quoted identifier is not noise: `delete from "public"."x"` names a
    // real table and has to go on naming it. It is recognised here only so a
    // quote or a `--` inside one cannot be mistaken for anything else.
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }

    if (c === '$') {
      const tag = dollarTagAt(src, i);
      if (tag) {
        const bodyStart = i + tag.length;
        const close = src.indexOf(tag, bodyStart);
        const bodyEnd = close === -1 ? n : close;
        out += tag + stripNoise(src.slice(bodyStart, bodyEnd));
        if (close !== -1) out += tag;
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }

    // Nothing that can start noise: copy the whole run in one go.
    let j = i + 1;
    while (j < n && !NOISE_START.test(src[j])) j += 1;
    out += src.slice(i, j);
    i = j;
  }

  return out;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;

/**
 * Every unqualified DELETE in this SQL, as written.
 *
 * The statement is read up to its terminator and then asked whether a WHERE is
 * anywhere in it, rather than requiring the semicolon to follow the table name
 * directly. That is not tidiness: `DELETE FROM x USING y;` and
 * `DELETE FROM x RETURNING *;` are both just as unqualified, and a rule that
 * only knew the bare form would be a rule anyone could step around by writing
 * one more word.
 *
 * A `;` inside a string literal cannot end a statement early - the literals are
 * gone by the time this runs.
 */
export function unqualifiedDeletes(sql) {
  const clean = stripNoise(sql);
  const re = new RegExp(
    String.raw`\bdelete\s+from\s+(${QUALIFIED})(?![A-Za-z0-9_$])([^;]*)(?:;|$)`,
    'gi'
  );
  const out = [];
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (!/\bwhere\b/i.test(m[2])) out.push(m[1].replace(/\s+/g, ''));
  }
  return out;
}

/**
 * Every unqualified UPDATE in this SQL.
 *
 * An UPDATE has a SET clause between the table and the semicolon, so the
 * statement is read up to its terminator and then asked whether a WHERE is in
 * it. A `;` inside a string literal cannot end it early - the literals are gone
 * by the time this runs.
 */
export function unqualifiedUpdates(sql) {
  const clean = stripNoise(sql);
  const re = new RegExp(
    String.raw`\bupdate\s+(?:only\s+)?(${QUALIFIED})\s+set\b([^;]*)(?:;|$)`,
    'gi'
  );
  const out = [];
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (!/\bwhere\b/i.test(m[2])) out.push(m[1].replace(/\s+/g, ''));
  }
  return out;
}

/**
 * A migration is allowed to say, in one machine-readable line, that it means
 * one of these. The line has to name the statement, so it cannot be pasted
 * once and left to cover everything a file ever grows.
 *
 *   -- unqualified-write-ok: <table> because <reason>
 *
 * The reason must be a sentence, not a word: 40 characters is short enough to
 * write honestly and long enough to stop "ok" being the reason.
 */
export function declaredExceptions(sql) {
  const out = new Map();
  const lines = String(sql).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*--\s*unqualified-write-ok:\s*([A-Za-z0-9_."]+)\s+because\s+(.*)$/i.exec(
      lines[i]
    );
    if (!m) continue;
    // A real reason does not fit on one line and should not have to. Following
    // comment lines continue it, up to the next directive or the next line of
    // actual SQL - so the author writes a paragraph rather than compressing it
    // to beat a length check.
    let reason = m[2].trim();
    for (let j = i + 1; j < lines.length; j += 1) {
      const c = /^\s*--\s?(.*)$/.exec(lines[j]);
      if (!c) break;
      if (/unqualified-write-ok:/i.test(c[1])) break;
      reason += ` ${c[1].trim()}`;
    }
    if (reason.trim().length >= 40) out.set(m[1].replace(/\s+/g, ''), reason.trim());
  }
  return out;
}

export function offenders(sql) {
  const allowed = declaredExceptions(sql);
  const found = [];
  for (const t of unqualifiedDeletes(sql)) {
    if (!allowed.has(t)) found.push({ verb: 'DELETE', table: t });
  }
  for (const t of unqualifiedUpdates(sql)) {
    if (!allowed.has(t)) found.push({ verb: 'UPDATE', table: t });
  }
  return found;
}

function main() {
  const base = baseRef();
  const files = ALL
    ? git(['ls-files', `${DIR}*.sql`])
        .split('\n')
        .filter(Boolean)
    : changedMigrations(base);

  if (files.length === 0) {
    console.log(`[check-unqualified-writes] no new migrations against ${base} — nothing to check.`);
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
    console.error('[check-unqualified-writes] BLOCKED — an UPDATE or DELETE with no WHERE clause.');
    console.error('');
    for (const h of hits) {
      console.error(`  ${h.verb} on ${h.table}`);
      console.error(`    in ${h.file}`);
    }
    console.error('');
    console.error('  This is legal SQL and it will work every time YOU run it, because a');
    console.error('  migration runs as `postgres`. PostgREST connects as `authenticator`,');
    console.error('  which carries session_preload_libraries=safeupdate, and safeupdate');
    console.error('  raises "DELETE requires a WHERE clause". SET ROLE service_role does not');
    console.error('  unload it, so the engine is refused exactly like a browser.');
    console.error('');
    console.error('  On 2026-09-06 one of these silently stopped the GTO aggregation driver');
    console.error('  for an hour. Nine more were already live, including a bomb-pot backfill');
    console.error('  the engine calls and a settlement RPC the operator dashboard calls.');
    console.error('');
    console.error('  Pick one:');
    console.error('');
    console.error('  1. IT REALLY IS EVERY ROW (a temp table you just built):');
    console.error('       delete from <table> where true;');
    console.error('');
    console.error('  2. IT IS NOT EVERY ROW. Write the predicate. If `where true` felt wrong');
    console.error('     just now, that instinct is the finding — an unqualified DELETE on a');
    console.error('     REAL table wipes it, and the refusal may be the only thing standing');
    console.error('     between an API caller and that table.');
    console.error('');
    console.error('  3. YOU MEAN IT AND IT IS NOT REACHABLE. Say so in the migration, naming');
    console.error('     the table and giving a real reason (40+ characters):');
    console.error('       -- unqualified-write-ok: <table> because <why this cannot be called');
    console.error('       --   through PostgREST, and why every row must go>');
    console.error('');
    process.exit(1);
  }

  console.log(
    `[check-unqualified-writes] OK — ${inspected} migration(s) checked; every UPDATE and ` +
      'DELETE carries a WHERE clause, so none of them is refused on the PostgREST path.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
