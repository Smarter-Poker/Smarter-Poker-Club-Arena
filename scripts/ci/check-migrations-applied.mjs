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

/** Objects a migration CREATES. Drops and alters are out of scope: this asks
 *  "did the thing you added actually land", not "is the schema perfect". */
function declaredObjects(sql) {
  const clean = sql.replace(/--[^\n]*/g, '');
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
  return { fns: [...new Set(fns)], tables: [...new Set([...tables, ...views])] };
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.error('[check-migrations-applied] missing schema manifest — cannot judge.');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const liveFns = new Set(manifest.functions || []);
  const liveTables = new Set(manifest.tables || []);

  const base = baseRef();
  const files = changedMigrations(base);
  if (files.length === 0) {
    console.log(`[check-migrations-applied] no new migrations against ${base} — nothing to check.`);
    return;
  }

  const problems = [];
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue;
    const { fns, tables } = declaredObjects(readFileSync(join(REPO, file), 'utf8'));
    for (const fn of fns) if (!liveFns.has(fn)) problems.push([file, 'function', fn]);
    for (const t of tables) if (!liveTables.has(t)) problems.push([file, 'table/view', t]);
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
