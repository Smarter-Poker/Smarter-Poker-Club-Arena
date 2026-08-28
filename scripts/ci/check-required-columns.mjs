#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN INSERT MUST SUPPLY THE COLUMNS THE TABLE REQUIRES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-28)
 *
 * check-phantom-columns catches a write that NAMES a column which does not
 * exist. It cannot catch a write that OMITS one that must be there. Postgres
 * refuses the statement just as completely, the error lands in a catch, and the
 * control silently does nothing - the same failure, from the opposite direction,
 * and invisible to every gate in this repo until now.
 *
 * Four instances, all found by hand in one day:
 *
 *   audit_trail.actor_role, .target_type   the agent audit trail wrote nothing,
 *                                          ever
 *   referrals.referral_code_used           referral bonuses were paid and the
 *                                          referral was never recorded
 *   club_announcements.author_id           creating an announcement has never
 *                                          worked: Save cleared the form, closed
 *                                          the editor, and reloaded a list that
 *                                          had not changed
 *   credit_requests.club_id                every credit increase request threw a
 *                                          raw Postgres error at the caller
 *
 * The first two are the reason this is not merely a nice-to-have. They were
 * ALSO phantom-column bugs, and repointing the wrong names - the obvious fix,
 * the one that passes review - would have left both inserts failing exactly as
 * before, with the fix commit as evidence that somebody had looked.
 *
 * WHAT "REQUIRED" MEANS: NOT NULL, no DEFAULT, not identity, not generated,
 * straight from the live schema via scripts/ci/supabase-required-columns-manifest.json.
 * A column with a default, or one a trigger fills, is not the caller's problem;
 * flagging those would produce noise, and noise teaches people to ignore a gate.
 *
 * WHAT IT DELIBERATELY DOES NOT JUDGE:
 *
 *   * a payload containing a SPREAD (`...buyInColumns(x)`) or a COMPUTED key.
 *     The keys are decided at runtime and this cannot know them. Six such sites
 *     exist and all six are correct - HorseOrchestrator's `...buyInColumns()`
 *     supplies exactly buy_in_amount and buy_in_fee. Guessing would have made
 *     those six the first thing anyone allowlisted, and an allowlist that opens
 *     with six false alarms is one nobody reads.
 *   * a payload built in a variable and passed by name. Following that needs a
 *     type checker, not a regex, and pretending otherwise is how a gate starts
 *     lying in the reassuring direction.
 *   * a table not in the manifest. The phantom-table gate already answers
 *     "does this table exist"; answering it twice, differently, is worse.
 *
 * SHORTHAND PROPERTIES ARE THE WHOLE GAME. `{ club_id: uuid, title, content }`
 * supplies three columns, not one. A first pass at this scan read only `name:`
 * pairs and reported FOURTEEN violations, of which twelve were shorthand or
 * spreads. Two were real. A gate that cries wolf twelve times out of fourteen
 * would have been switched off within a week, so the parser below tracks quote
 * state and nesting depth rather than pattern-matching lines.
 *
 * Usage:  node scripts/ci/check-required-columns.mjs
 * Exit:   0 clean · 1 a write that cannot land · 2 script error
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const MANIFEST = join(REPO, 'scripts/ci/supabase-required-columns-manifest.json');
const ALLOWLIST = join(REPO, 'scripts/ci/required-columns.allowlist.json');
const ROOTS = ['src', 'server/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);
const EXTS = new Set(['.ts', '.tsx']);

if (!existsSync(MANIFEST)) {
  console.error(
    `[check-required-columns] ${MANIFEST} is missing. Regenerate it with ` +
      'scripts/ci/gen-schema-manifest.mjs (the daily Schema Manifest Refresh does this).'
  );
  process.exit(2);
}
const required = JSON.parse(readFileSync(MANIFEST, 'utf8')).required ?? {};
const allow = existsSync(ALLOWLIST)
  ? JSON.parse(readFileSync(ALLOWLIST, 'utf8')).reviewedExceptions ?? {}
  : {};

/** Comments carry no behaviour, and one that quotes a table name is not a write. */
const stripComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (EXTS.has(entry.slice(entry.lastIndexOf('.')))) acc.push(full);
  }
  return acc;
}

/**
 * The top-level keys of an object literal.
 *
 * Tracks quote state and nesting depth so a brace, a comma or a colon inside a
 * string or a nested object cannot be mistaken for structure. Returns
 * `unknowable` when the payload spreads another object or computes a key, which
 * is a "cannot judge", never a "looks fine".
 */
export function topLevelKeys(body) {
  const inner = body.slice(1, -1);
  const parts = [];
  let depth = 0;
  let buf = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inString) {
      if (c === '\\') {
        buf += inner.slice(i, i + 2);
        i += 1;
        continue;
      }
      if (c === quote) inString = false;
      buf += c;
    } else if (c === "'" || c === '"' || c === '`') {
      inString = true;
      quote = c;
      buf += c;
    } else if (c === '{' || c === '[' || c === '(') {
      depth += 1;
      buf += c;
    } else if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      buf += c;
    } else if (c === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  parts.push(buf);

  const keys = new Set();
  let unknowable = false;
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith('...')) {
      unknowable = true;
      continue;
    }
    if (part.startsWith('[')) {
      unknowable = true; // computed key
      continue;
    }
    const m = /^([A-Za-z_]\w*)\s*(?::|$)/.exec(part);
    if (m) keys.add(m[1]); // `name: value` AND shorthand `name`
    else unknowable = true; // something this parser does not understand
  }
  return { keys, unknowable };
}

const WRITE = /\.from\(\s*['"`]([A-Za-z_]\w*)['"`]\s*\)\s*\.(insert|upsert)\(\s*\[?\s*\{/g;

/**
 * Every literal insert payload that omits a column its table requires.
 *
 * Separated from the CLI below so tests/required-columns-gate.test.ts can
 * exercise the PARSER directly. Importing a script that runs its scan at module
 * load would make a test import scan the tree, and - worse - a violation would
 * process.exit(1) out of the test runner. A gate whose own tests cannot run is
 * one nobody will change safely.
 */
export function scan() {
  const offenders = [];
  let inspected = 0;
  let unjudged = 0;

  for (const root of ROOTS) {
    if (!existsSync(join(REPO, root))) continue;
    for (const file of walk(join(REPO, root))) {
      const src = stripComments(readFileSync(file, 'utf8'));
      WRITE.lastIndex = 0;
      let m;
      while ((m = WRITE.exec(src))) {
        const table = m[1];
        const req = required[table];
        if (!req || req.length === 0) continue;

        // The literal starts at the last `{` inside the matched prefix.
        const open = src.lastIndexOf('{', m.index + m[0].length);
        let depth = 0;
        let close = -1;
        for (let i = open; i < src.length; i++) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              close = i;
              break;
            }
          }
        }
        if (close === -1) continue;

        inspected += 1;
        const { keys, unknowable } = topLevelKeys(src.slice(open, close + 1));
        if (unknowable) {
          unjudged += 1;
          continue;
        }

        const missing = req.filter((c) => !keys.has(c));
        if (missing.length === 0) continue;

        const rel = file.slice(REPO.length + 1);
        if (allow[`${rel}:${table}`] ?? allow[table]) continue;

        offenders.push({ file: rel, line: src.slice(0, open).split('\n').length, table, missing });
      }
    }
  }
  return { offenders, inspected, unjudged };
}

function main() {
  const { offenders, inspected, unjudged } = scan();

  if (offenders.length > 0) {
    console.error('');
    console.error('[check-required-columns] BLOCKED.');
    console.error('');
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}`);
      console.error(`    INSERT into ${o.table} omits ${o.missing.join(', ')}`);
      console.error(
        `    ${o.missing.length === 1 ? 'That column is' : 'Those columns are'} NOT NULL with no default, so Postgres refuses the whole`
      );
      console.error('    statement. The error lands in a catch and the control does nothing.');
      console.error('');
    }
    console.error('  Supply the value. If the caller genuinely cannot know it, refuse with a');
    console.error('  readable message instead of sending a write that cannot land - a thrown');
    console.error('  Postgres error and a silent no-op are both worse than saying so.');
    console.error('');
    console.error('  If the column is filled by something this gate cannot see, add an entry to');
    console.error('  scripts/ci/required-columns.allowlist.json keyed "<file>:<table>" with a');
    console.error('  reason naming what fills it. That list must only ever shrink.');
    console.error('');
    process.exit(1);
  }

  console.log(
    `[check-required-columns] OK — ${inspected} literal insert/upsert payload(s) checked against the ` +
      `live schema; ${unjudged} skipped as unjudgeable (spread or computed key).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
