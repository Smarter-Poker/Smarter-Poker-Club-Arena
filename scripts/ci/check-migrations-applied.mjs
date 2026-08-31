#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A MIGRATION THIS BRANCH ADDS MUST ALREADY EXIST IN THE LIVE SCHEMA
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-22)
 *
 * `supabase/migrations/20260821_club_tournament_stats.sql` was committed on
 * 2026-08-21 and never applied. The service code that called the function it
 * declared was reverted by a bad merge the same day. The repo therefore claimed
 * a feature the database had never heard of, the leaderboard quietly kept
 * serving numbers computed from an arbitrary half of each club's history, and
 * nothing anywhere went red. It was found a day later by hand.
 *
 * Every gate in this repo checks the CODE against the live schema. Nothing
 * checked the MIGRATIONS against it. This does.
 *
 * SCOPE: only migrations this branch ADDS or MODIFIES. The files already in the
 * directory are intentionally stale — CLAUDE.md is explicit that schema is
 * applied straight to production via the Supabase MCP and the older files are
 * history, not truth; many of the functions and tables they declare no longer
 * exist. Auditing those is a separate archaeology project; letting a NEW one
 * slip is a bug that ships today.
 *
 * This comment used to say "the 432 files" and "68 functions and 80 tables".
 * On 2026-08-31 `ls supabase/migrations | wc -l` said 1129. A count written
 * into a comment is always stale by the time someone reads it, so it is gone:
 * run the count when you need it, and get the dead-object figures from
 * `scripts/ci/supabase-schema-manifest.json` against the live schema.
 *
 * HOW IT DECIDES: `scripts/ci/supabase-schema-manifest.json` is a snapshot of
 * the live public schema, regenerated with `gen-schema-manifest.mjs`. If a new
 * migration declares an object that is not in it, either the migration was
 * never applied (apply it with the Supabase MCP `apply_migration`) or the
 * manifest is stale (regenerate it in the same PR). Both are things the author
 * must do; neither is something to discover a day later.
 *
 * Usage:  node scripts/ci/check-migrations-applied.mjs [baseRef]
 * Exit:   0 clean · 1 an unapplied object · 2 script error
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const MANIFEST = join(REPO, 'scripts/ci/supabase-schema-manifest.json');
const DIR = 'supabase/migrations/';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The commit this branch grew from. PRs get it from GitHub; a push compares to
 *  its own parent, which is the smallest honest unit of "what this adds". */
function baseRef() {
  if (process.argv[2]) return process.argv[2];
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
      /* A gate that silently skips is worse than no gate: it reports success
         for a check it never ran. Fail loudly instead, so a shallow checkout
         is fixed rather than quietly disabling this. */
      console.error(
        `[check-migrations-applied] cannot diff against "${base}" — the checkout is ` +
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

/** Objects a migration CREATES or ADDS. Drops and alters of existing objects
 *  are out of scope: this asks "did the thing you added actually land", not
 *  "is the schema perfect".
 *
 *  ADD COLUMN was missing here until 2026-08-22, and the omission cost a
 *  feature. In World Hub, 20260821210000_user_avatars_cosmetics.sql and
 *  20260821210001_profiles_cosmetics.sql sat unapplied for a day while the
 *  avatar frames-and-auras feature was fully built around the columns they
 *  declare - every write failed 42703 into a catch block and nothing went red.
 *  A CREATE-only version of this gate watches that go straight past: the table
 *  already exists, so every other check stays green. A column is the most
 *  common thing a migration adds and the easiest thing to strand. */
function declaredObjects(sql) {
  /**
   * Comments FIRST, then string literals.
   *
   * A quoted string is not a declaration, and until 2026-08-23 this function
   * could not tell the difference. An event-trigger migration that legitimately
   * contains
   *
   *   WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
   *
   * was read as declaring a table named "as", and a COMMENT ON FUNCTION whose
   * prose said "CREATE TABLE here inherits ..." was read as declaring a table
   * named "here". Both are phantoms by construction: the gate then demands they
   * exist in the live schema, and no amount of applying the migration can ever
   * satisfy it.
   *
   * Stripping quoted strings cannot hide a real declaration, because a real
   * CREATE TABLE is never inside quotes. The order matters: comments are
   * removed first so that an apostrophe in prose ("someone else's change")
   * cannot unbalance the quote scan that follows.
   */
  const clean = sql
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
  const fns = [
    ...clean.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi
    ),
  ].map((m) => m[1]);
  const tables = [
    ...clean.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi),
  ].map((m) => m[1]);
  const views = [
    ...clean.matchAll(
      /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
    ),
  ].map((m) => m[1]);
  // ALTER TABLE [IF EXISTS] [ONLY] [public.]t ADD [COLUMN] [IF NOT EXISTS] c
  const columns = [
    ...clean.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi
    ),
  ]
    // ADD CONSTRAINT / PRIMARY / FOREIGN / UNIQUE / CHECK read identically to
    // ADD COLUMN under that regex and are not columns. Without this filter
    // every constraint is reported as a phantom column forever, and a gate
    // that cries wolf is a gate somebody disables.
    .filter((m) => !/^(constraint|primary|foreign|unique|check|exclude)$/i.test(m[2]))
    .map((m) => [m[1], m[2]]);

  return {
    fns: [...new Set(fns)],
    tables: [...new Set([...tables, ...views])],
    columns: [...new Map(columns.map((c) => [c.join('.'), c])).values()],
  };
}

/** What this file already declared at the base commit, as lookup sets.
 *  null when the file is new on this branch — then everything in it is new. */
function declaredAtBase(base, file) {
  let prior;
  try {
    prior = git(['show', `${base}:${file}`]);
  } catch {
    return null; // added by this branch
  }
  const d = declaredObjects(prior);
  return {
    fns: new Set(d.fns),
    tables: new Set(d.tables),
    columns: new Set(d.columns.map(([t, c]) => `${t}.${c}`)),
  };
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error('[check-migrations-applied] missing schema manifest — cannot judge.');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const liveFns = new Set(manifest.functions || []);
  const liveTables = new Set(manifest.tables || []);

  /* The column manifest is a separate snapshot ({table: [columns]}) and the
     phantom-column gate already depends on it. If it is absent this checks
     what it can rather than exiting 2 - a missing companion file should not
     turn off the function and table checks that do not need it. */
  const columnsPath = join(REPO, 'scripts/ci/supabase-columns-manifest.json');
  const liveColumns = existsSync(columnsPath)
    ? JSON.parse(readFileSync(columnsPath, 'utf8')).columns || {}
    : null;

  const base = baseRef();
  const files = changedMigrations(base);
  if (files.length === 0) {
    console.log(`[check-migrations-applied] no new migrations against ${base} — nothing to check.`);
    return;
  }

  const problems = [];
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue;
    const now = declaredObjects(readFileSync(join(REPO, file), 'utf8'));

    /* WHAT THIS BRANCH ACTUALLY ADDS (2026-08-22).
     *
     * The diff filter is AM, so a MODIFIED migration is in scope — correct,
     * because appending a CREATE FUNCTION to an old file strands it exactly
     * like a new one. But it judged the file's WHOLE contents, so touching a
     * historical migration at all re-asserted every object it had ever
     * declared.
     *
     * That made a whole class of file permanently untouchable. A migration
     * that was applied and then legitimately rolled back — the helpers dropped
     * on purpose — can no longer receive so much as a comment: the gate
     * re-asserts the objects that were deliberately removed and fails. Found
     * by adding a STATUS header to 20260821_library_only_avatars.sql, which
     * ran on 2026-08-21 and was rolled back afterwards.
     *
     * A gate that blocks a comment is a gate somebody starts bypassing, so
     * scope it to the DIFFERENCE. Objects already declared at the base commit
     * are that commit's business, not this branch's; only what this branch
     * newly declares gets checked. Appending a CREATE is still caught — that
     * is a new declaration — and a comment is correctly a no-op. */
    const before = declaredAtBase(base, file);
    const isNew = (kind, key) => !before || !before[kind].has(key);

    for (const fn of now.fns) {
      if (isNew('fns', fn) && !liveFns.has(fn)) problems.push([file, 'function', fn]);
    }
    for (const t of now.tables) {
      if (isNew('tables', t) && !liveTables.has(t)) problems.push([file, 'table/view', t]);
    }
    if (liveColumns) {
      for (const [t, c] of now.columns) {
        if (!isNew('columns', `${t}.${c}`)) continue;
        // A column on a table the manifest does not know cannot be judged; the
        // table itself is either brand new above or genuinely absent.
        if (!liveColumns[t]) continue;
        if (!liveColumns[t].includes(c)) problems.push([file, 'column', `${t}.${c}`]);
      }
    }
  }

  console.log(
    `[check-migrations-applied] ${files.length} changed migration(s) vs ${base}; ${problems.length} unapplied object(s).`
  );

  if (problems.length === 0) {
    console.log('OK — every object these migrations declare exists in the live schema.');
    return;
  }

  console.error('\nA MIGRATION IN THIS BRANCH DECLARES SOMETHING THE LIVE SCHEMA DOES NOT HAVE:\n');
  for (const [file, kind, name] of problems) console.error(`  ${file}\n    ${kind} ${name}`);
  console.error(
    '\nEither the migration was never applied — apply it with the Supabase MCP' +
      '\n`apply_migration`, which is the only sanctioned path — or the manifest is' +
      '\nstale: regenerate it with scripts/ci/gen-schema-manifest.mjs in this same PR.' +
      '\nA migration file that never ran is a feature the code believes in and the' +
      '\ndatabase has never heard of.'
  );
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error('[check-migrations-applied] script error:', err?.message || err);
  process.exit(2);
}
