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
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DATA-ONLY BLIND SPOT, CLOSED (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Everything above verifies that objects a migration DECLARES exist in
 * production. A migration whose payload is a DELETE, an UPDATE or an INSERT
 * declares NOTHING, so it passed this gate green while never having run.
 *
 * That is exactly how the 5/5 rake-schedule deletion shipped: the code half
 * landed, `20260901050000_the_rake_row_no_table_can_match.sql` sat unapplied
 * for hours, and every gate in the repo stayed green because every gate was
 * comparing a file to a file. Its whole payload is one DELETE and a CHECK
 * constraint added inside a DO block — zero declared objects.
 *
 * THE LEVER USED. Supabase records every migration it applies in
 * `supabase_migrations.schema_migrations`, and this project already exposes it
 * to CI as the SECURITY DEFINER RPC `public.fn_ca_applied_migrations(p_since)`
 * (added for check-applied-migrations-are-recorded.mjs, which asks the OPPOSITE
 * question: applied but not committed). A migration file this branch ADDS whose
 * version and name appear nowhere in that ledger has never run, whatever it
 * declares or does not declare.
 *
 * WHAT THIS STILL CANNOT CATCH, said plainly:
 *
 *   - A migration APPLIED OUTSIDE the sanctioned path. SQL pasted into the
 *     Supabase SQL editor writes no ledger row, so this reports it as
 *     unapplied. That is not a false positive worth softening — CLAUDE.md says
 *     `apply_migration` is the only sanctioned path, and this makes the rule
 *     enforceable rather than aspirational.
 *   - Whether the payload DID WHAT IT CLAIMS. The ledger row proves a file with
 *     that version ran, not that its DELETE matched a row or its UPDATE moved
 *     one. `public.exec_sql` is permanently disabled on this project (by
 *     design), so CI has no channel to run a migration's own
 *     `DO $$ ... RAISE EXCEPTION` post-apply assertions against production, and
 *     re-creating one would hand arbitrary SQL execution to any holder of the
 *     service key. The right home for those assertions is the migration itself,
 *     where they already run at apply time and abort the transaction. The gate
 *     that checks the RESULT of the two rake mirrors landing is
 *     scripts/ci/check-db-mirror-parity.mjs.
 *   - A migration MODIFIED rather than added. Historical files are history, not
 *     truth (see SCOPE above), and ~36 of them are legitimately unrecorded.
 *
 * DELIBERATELY NOT APPLYING ONE. Put `-- @unapplied: <reason>` in the file's
 * header. The whole file is then skipped by BOTH halves of this gate and
 * printed in a loud block so a reviewer sees it in the log rather than
 * discovering it in production. There is precedent in the tree already —
 * `011_hand_events.sql` carries "STATUS: authored but INTENTIONALLY NOT
 * APPLIED" as prose that no tool could read.
 *
 * Usage:  node scripts/ci/check-migrations-applied.mjs [baseRef]
 * Exit:   0 clean · 1 an unapplied object or migration · 2 script error
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

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
  const clean = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
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

/** `-- @unapplied: reason` in the header. A deliberate, reviewable opt-out for
 *  a migration this branch ships but does not apply — a retirement waiting on
 *  Dan, a guard staged for a quiet window. Without it, an author who cannot
 *  apply yet has only one way past this gate: delete the check. */
function unappliedMarker(sql) {
  const m = /^[ \t]*--[ \t]*@unapplied[ \t]*:?[ \t]*(.*)$/m.exec(sql);
  return m ? m[1].trim() || '(no reason given)' : null;
}

/** version + name as the Supabase ledger records them, from the filename. */
function ledgerKeyOf(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const m = /^(\d+)[_-]?(.*)\.sql$/.exec(base);
  if (!m) return null;
  return { version: m[1], name: (m[2] || '').toLowerCase(), file };
}

/** The applied-migration ledger, or null when this run has no credentials. */
async function appliedLedger(since) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const res = await fetch(`${url}/rest/v1/rpc/fn_ca_applied_migrations`, {
    method: 'POST',
    headers: supabaseServerHeaders(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_since: since }),
  });
  if (!res.ok) {
    throw new Error(
      `fn_ca_applied_migrations -> ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }
  const rows = await res.json();
  return {
    versions: new Set(rows.map((r) => String(r.version))),
    names: new Set(rows.map((r) => String(r.name || '').toLowerCase()).filter(Boolean)),
  };
}

async function main() {
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
  const deliberate = [];
  const addedFiles = [];
  for (const file of files) {
    if (!existsSync(join(REPO, file))) continue;
    const sql = readFileSync(join(REPO, file), 'utf8');

    /* A file marked @unapplied is skipped by both halves. It is NOT silent:
       every one is printed below, so "we shipped a migration we did not run"
       is a sentence a reviewer reads rather than a thing they discover. */
    const marker = unappliedMarker(sql);
    if (marker) {
      deliberate.push([file, marker]);
      continue;
    }
    if (declaredAtBase(base, file) === null) addedFiles.push(file);

    const now = declaredObjects(sql);

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

  /* ── THE DATA-ONLY HALF ──────────────────────────────────────────────────
     A migration that declares nothing cannot fail the loop above, so ask the
     production ledger whether it ran at all. Scoped to files this branch ADDS:
     a modified historical file is history, and ~36 of those are legitimately
     unrecorded (see check-applied-migrations-are-recorded.mjs). */
  const keys = addedFiles.map(ledgerKeyOf).filter(Boolean);
  let ledgerVerdict = 'no new migration files to check against the ledger';
  if (keys.length > 0) {
    const since = keys.map((k) => k.version).sort()[0];
    let ledger = null;
    try {
      ledger = await appliedLedger(since);
    } catch (err) {
      console.error(`[check-migrations-applied] ledger unavailable: ${err.message}`);
      process.exit(2);
    }
    if (ledger === null) {
      /* No credentials — a local run or a fork. Say which half did not run.
         A gate that silently skips reports success for a check it never made. */
      ledgerVerdict =
        `SKIPPED for ${keys.length} added migration(s) — no SUPABASE_URL / ` +
        'SUPABASE_SERVICE_ROLE_KEY, so this run could not ask production whether ' +
        'they were applied. CI supplies both.';
    } else {
      let ran = 0;
      for (const k of keys) {
        if (ledger.versions.has(k.version) || (k.name && ledger.names.has(k.name))) {
          ran++;
          continue;
        }
        problems.push([k.file, 'migration', 'never ran — no row in the production ledger']);
      }
      ledgerVerdict = `${ran}/${keys.length} added migration(s) recorded as applied in production`;
    }
  }

  if (deliberate.length > 0) {
    console.log('\n[check-migrations-applied] DELIBERATELY NOT APPLIED (@unapplied):');
    for (const [file, why] of deliberate) console.log(`  ${file}\n    ${why}`);
    console.log(
      '  These ship as files only. Nothing in production has changed for them, and\n' +
        '  any code that assumes they ran is wrong until somebody applies them.\n'
    );
  }

  console.log(
    `[check-migrations-applied] ${files.length} changed migration(s) vs ${base}; ` +
      `${problems.length} problem(s); ledger: ${ledgerVerdict}.`
  );

  if (problems.length === 0) {
    console.log('OK — every object these migrations declare exists in the live schema.');
    return;
  }

  console.error('\nA MIGRATION IN THIS BRANCH HAS NOT LANDED IN PRODUCTION:\n');
  for (const [file, kind, name] of problems) console.error(`  ${file}\n    ${kind} ${name}`);
  console.error(
    '\nEither the migration was never applied — apply it with the Supabase MCP' +
      '\n`apply_migration`, which is the only sanctioned path — or the manifest is' +
      '\nstale: regenerate it with scripts/ci/gen-schema-manifest.mjs in this same PR.' +
      '\nA migration file that never ran is a feature the code believes in and the' +
      '\ndatabase has never heard of.' +
      '\n' +
      '\nA line reading `migration  never ran` is the DATA-ONLY half: the file' +
      '\ndeclares no object to look for, and production has no ledger row for it.' +
      '\nApply it, or — if it is meant to ship unapplied — put' +
      '\n`-- @unapplied: <reason>` in its header so the skip is a decision on the' +
      '\nrecord instead of a gate somebody turned off.'
  );
  process.exit(1);
}

try {
  await main();
} catch (err) {
  console.error('[check-migrations-applied] script error:', err?.message || err);
  process.exit(2);
}
