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
 * SCOPE: only migrations this branch ADDS or MODIFIES. The 432 files already in
 * the directory are intentionally stale — CLAUDE.md is explicit that schema is
 * applied straight to production via the Supabase MCP and the older files are
 * history, not truth (68 functions and 80 tables in them no longer exist).
 * Auditing those is a separate archaeology project; letting a NEW one slip is a
 * bug that ships today.
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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchemaManifest, loadColumnsManifest } from './schema-manifest.mjs';

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
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(DIR) && l.endsWith('.sql'))
      // BACKFILL EXEMPTION (2026-09-01). A file whose first line marks it as a
      // recovered record of an ALREADY-APPLIED migration is history, not a new
      // migration awaiting apply. This gate asks "does what this migration
      // declares exist in the live schema NOW" - the right question for new
      // work, a false positive for a backfill of an old migration whose object
      // was since dropped, renamed or superseded (backup tables, a removed
      // column, a replaced function). Those objects genuinely ran and are
      // genuinely gone; the byte-exact record is correct and the live schema is
      // correct. The gate stays strict on every genuinely new migration. Marker
      // written by scripts/ci/backfill-unrecorded-migrations.mjs.
      // SUPERSEDED EXEMPTION (2026-09-07), and it is deliberately narrower than
      // the one above. A migration can be applied and then correctly undone in
      // the SAME session: 20260907192843 added three columns to hand_history so
      // a repair job could rebuild rake attribution, the root fix landed in the
      // engine two hours later, and 20260907195116 dropped them again because
      // 1.3 GB a month to feed a job that must never run is the band-aid 10.12
      // forbids. Both files must stay - both ran, and
      // check-applied-migrations-are-recorded demands a file for each - but the
      // first one declares columns that are deliberately gone, so this gate
      // failed the branch for doing exactly the right thing.
      //
      // The marker is NOT a free pass, because "this was superseded" is the
      // easiest possible lie to tell about a migration that simply never
      // applied. It must NAME the migration that superseded it, and that file
      // must exist in this directory, or the exemption does not apply and the
      // file is checked as strictly as any other:
      //
      //   -- SUPERSEDED BY 20260907195116
      .filter((f) => {
        let head;
        try {
          head = readFileSync(join(REPO, f), 'utf8').slice(0, 400);
        } catch {
          return true; // unreadable: check it rather than skip it
        }
        if (/^--\s*(BACKFILLED|UNRECOVERABLE STUB)\b/.test(head)) return false;
        const superseded = head.match(/^--\s*SUPERSEDED BY\s+(\d{14})\b/m);
        if (superseded) {
          const named = migrationFileFor(superseded[1]);
          if (named) return false;
          console.error(
            `[check-migrations-applied] ${f} claims "SUPERSEDED BY ${superseded[1]}" ` +
              'but no migration with that version exists in this tree. A superseding ' +
              'migration that is not here is a migration that did not run.'
          );
        }
        return true;
      })
  );
}

/** Does a migration with this version exist on disk? The superseded marker is
 *  worthless without it - see the exemption above. */
function migrationFileFor(version) {
  try {
    return readdirSync(join(REPO, DIR)).find((n) => n.startsWith(`${version}_`)) ?? null;
  } catch {
    return null;
  }
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
function executableSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
}

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
  const clean = executableSql(sql);
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

/** Objects the branch DROPS.
 *
 * A branch that creates a table and then drops it again declares nothing, and
 * this gate used to report both halves as missing from the live schema - which
 * is true, and is exactly what the author intended.
 *
 * Found 2026-09-06. A migration scheduled two repair sweeps and a roster table
 * to watch them; Dan ruled that no cron may monitor or repair chip drift, so a
 * later migration in the same branch dropped all of it. Both objects genuinely
 * ran and are genuinely gone, the live schema is correct, and the gate failed
 * anyway - so the only ways past it were to lie in a schema-manifest fragment
 * (which the nightly refresh would turn red within a day) or to put a
 * BACKFILLED marker on a file that was not backfilled. A gate whose only
 * escapes are dishonest is a gate somebody routes around.
 *
 * Scoped to the branch's OWN migrations: dropping something an earlier commit
 * created is not covered here and is still checked by everything else. */
function droppedObjects(sql) {
  const clean = executableSql(sql);
  const fns = [
    ...clean.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi),
  ].map((m) => m[1]);
  const tables = [
    ...clean.matchAll(
      /drop\s+(?:materialized\s+)?(?:table|view)\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
    ),
  ].map((m) => m[1]);
  return { fns: new Set(fns), tables: new Set(tables) };
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
  /* Base snapshot UNION scripts/ci/schema-manifest.d/*.json. A migration's own
     branch declares its new functions in its own fragment file, which is what
     stopped this gate from forcing every migration through one shared array. */
  let manifest;
  try {
    manifest = loadSchemaManifest(REPO);
  } catch (err) {
    console.error(`[check-migrations-applied] ${err.message}`);
    process.exit(2);
  }
  const liveFns = new Set(manifest.functions || []);
  const liveTables = new Set(manifest.tables || []);

  /* The column manifest is a separate snapshot ({table: [columns]}) and the
     phantom-column gate already depends on it. If it is absent this checks
     what it can rather than exiting 2 - a missing companion file should not
     turn off the function and table checks that do not need it. */
  const liveColumns = loadColumnsManifest(REPO).columns;

  const base = baseRef();
  const files = changedMigrations(base);
  if (files.length === 0) {
    console.log(`[check-migrations-applied] no new migrations against ${base} — nothing to check.`);
    return;
  }

  /* Everything this branch drops, across ALL its migrations, gathered before
     the loop: the create and the drop are usually in different files, and the
     file that creates is checked before the file that drops is even read. */
  const branchDropped = { fns: new Set(), tables: new Set() };
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue;
    const d = droppedObjects(readFileSync(join(REPO, file), 'utf8'));
    for (const f of d.fns) branchDropped.fns.add(f);
    for (const t of d.tables) branchDropped.tables.add(t);
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
      if (isNew('fns', fn) && !liveFns.has(fn) && !branchDropped.fns.has(fn)) {
        problems.push([file, 'function', fn]);
      }
    }
    for (const t of now.tables) {
      if (isNew('tables', t) && !liveTables.has(t) && !branchDropped.tables.has(t)) {
        problems.push([file, 'table/view', t]);
      }
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
