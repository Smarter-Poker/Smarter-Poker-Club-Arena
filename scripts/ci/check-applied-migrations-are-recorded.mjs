#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A MIGRATION THE DATABASE HAS APPLIED MUST HAVE A FILE IN THIS REPO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-31)
 *
 * check-migrations-applied.mjs asks one direction: does every migration THIS
 * BRANCH ADDS exist in the live schema. It exists because a committed file that
 * never ran is a feature the code believes in and the database has never heard
 * of.
 *
 * Nothing has ever asked the other direction, and the other direction is worse.
 * Measured the day this was written:
 *
 *     89 migrations applied since 14:00 UTC
 *     49 of them had no file on origin/main
 *
 * Among those 49 were all THIRTEEN zero-drift ledger-hardening migrations - the
 * append-only chip_ledger, the auto-journal triggers, the incident system. They
 * sat unrecorded for hours because that session's GitHub token was refused, and
 * nothing anywhere noticed the repo had stopped matching the database.
 *
 * A Midway Union master reset rebuilds from these files. An applied migration
 * with no file is a hardening the production database has and the rebuild does
 * not - which is the one difference nobody would find until the money moved.
 *
 * SCOPE. The estate's own rule (see check-migrations-applied.mjs) is that older
 * migration files are history rather than truth, and auditing all 2,862 of them
 * is archaeology. So this defaults to a SEVEN DAY window: what has been applied
 * recently, and is it written down. Widen with --since for a deliberate audit.
 *
 * REPORTS BY DEFAULT, DOES NOT BLOCK. There are ~36 outstanding gaps from other
 * agents' in-flight work on the day this shipped, and failing every PR until
 * somebody else's branch lands would be an outage of its own. Run it with
 * --fail in a scheduled job or once the backlog is clear.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/ci/check-applied-migrations-are-recorded.mjs [--since 20260825000000] [--fail] [--json]
 *
 * Exit: 0 clean (or gaps found without --fail) · 1 gaps found with --fail · 2 script error
 */
import { readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const DIR = 'supabase/migrations';
const args = process.argv.slice(2);
const FAIL_ON_GAP = args.includes('--fail');
const AS_JSON = args.includes('--json');

function argValue(name, dflt) {
  const i = args.indexOf(name);
  return i === -1 || !args[i + 1] ? dflt : args[i + 1];
}

/** Default floor: seven days ago, as a YYYYMMDD000000 version stamp. */
function defaultSince() {
  const d = new Date(Date.now() - 7 * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}000000`;
}

const SINCE = argValue('--since', defaultSince());
const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * THE PRECONDITIONS BELONG TO THE RUN, NOT TO THE IMPORT (2026-09-01).
 *
 * These two checks used to sit at module scope and call process.exit(2) there.
 * That is correct for the script and fatal for anything that wants to READ it:
 * a test importing the pure halves below never gets past the import, because a
 * missing SUPABASE_URL kills the process before the first assertion. Moved into
 * requireEnvironment(), which main() calls first, so the behaviour of running
 * the script is identical and the file can also be opened.
 */
function requireEnvironment() {
  if (!URL_BASE || !KEY) {
    console.error(
      'check-applied-migrations-are-recorded: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    );
    process.exit(2);
  }

  if (!existsSync(DIR)) {
    console.error(
      `check-applied-migrations-are-recorded: ${DIR} not found - run from the repo root.`
    );
    process.exit(2);
  }
}

/**
 * What the repo records, indexed BY NAME as well as by version.
 *
 * Matching on the version stamp alone does not work here. Filenames are not
 * uniform - `20260831_ca_leak_fixes.sql` and `20260831144826_...` both exist -
 * and 28 files share the bare `20260831` stamp. Treating a shorter stamp as a
 * prefix match would let any one of them "record" every migration applied that
 * day, which is precisely the blindness this check exists to remove: measured,
 * it hid 47 of 49 real gaps.
 *
 * So the key is the NAME. `20260831144826_ca_leak_fixes.sql` records the
 * applied migration named `ca_leak_fixes` whatever stamp the file carries, and
 * an exact version match counts too. Naming is policed by
 * check-new-migration-version-collisions.mjs, not here.
 */
/**
 * THE DATE PREFIX BELONGS TO THE FILE, SOMETIMES TO THE NAME, AND SOMETIMES TO
 * BOTH (2026-09-01).
 *
 * The regex below strips a leading stamp off the FILE to get its name. But the
 * applied migration's own `name` is whatever the author typed, and a great many
 * of them typed the date into it: production holds an applied migration called
 * `20260825_perf_rakeback_stats_batch_set_based`, and the file recording it is
 * `20260825_perf_rakeback_stats_batch_set_based.sql`. Stripping one side and
 * not the other made those two different strings, and this check reported a
 * file that is sitting right there as missing.
 *
 * Measured 2026-09-01 before the fix: of 426 applied migrations reported as
 * unrecorded, 87 -- one in five -- had a file whose name contained the applied
 * name exactly. An alarm that is wrong a fifth of the time is an alarm people
 * learn to scroll past, and the 339 real gaps underneath it are the ones that
 * matter.
 *
 * Both sides are normalised now: a file is indexed under its stem AND under
 * that stem with the stamp removed, and an applied name is looked up as given
 * AND with its own leading stamp removed. Matching a name to a file carrying a
 * different stamp is already this check's stated philosophy - the name is the
 * key, the stamp is not - so this only completes it.
 */
const withoutStamp = (s) => s.replace(/^\d+[_-]/, '');

export function indexFrom(files) {
  const versions = new Set();
  const names = new Set();
  for (const f of files) {
    if (!f.endsWith('.sql')) continue;
    const stem = f.slice(0, -'.sql'.length);
    // The whole stem, for an applied name that carries its own date.
    names.add(stem.toLowerCase());
    const m = /^(\d+)[_-]?(.*)$/.exec(stem);
    if (!m) continue;
    versions.add(m[1]);
    if (m[2]) names.add(m[2].toLowerCase());
  }
  return { versions, names };
}

/**
 * THE LEDGER HAS TWO REPOS (2026-09-03). One production database, and two
 * repositories that write migrations to it: this one and Smarter-Poker-World-Hub.
 * Indexing only this checkout meant every World Hub migration - dozens on
 * 2026-09-02/03 alone - was reported here as "applied with no file", which is
 * an alarm about files that exist. So the other repo's supabase/migrations
 * listing is fetched from the GitHub API and merged into the index. If the
 * API is unreachable the check says so and carries on with this repo alone,
 * because a migration missing from BOTH is still worth reporting.
 */
const SIBLING_REPOS = (process.env.MIGRATION_SIBLING_REPOS || 'Smarter-Poker/Smarter-Poker-World-Hub')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function siblingMigrationFiles(repos = SIBLING_REPOS) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const out = [];
  for (const repo of repos) {
    try {
      // NOT the Contents API: it caps a directory listing at 1,000 entries and
      // World Hub's supabase/migrations is past that, so the NEWEST files - the
      // ones this check exists to find - fell off the end (verified 2026-09-03:
      // 1000 entries returned, tonight's files absent). The Git Trees API lists
      // the whole directory: resolve the subtree, then read it.
      const headers = token
        ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
        : { Accept: 'application/vnd.github+json' };
      const parent = await fetch(`https://api.github.com/repos/${repo}/contents/supabase?ref=main`, { headers });
      if (!parent.ok) {
        console.warn(`[applied-migrations-recorded] could not read ${repo}/supabase (${parent.status}); indexing this repo only.`);
        continue;
      }
      const dir = (await parent.json()).find((e) => e && e.type === 'dir' && e.name === 'migrations');
      if (!dir) {
        console.warn(`[applied-migrations-recorded] ${repo} has no supabase/migrations; indexing this repo only.`);
        continue;
      }
      const tree = await fetch(`https://api.github.com/repos/${repo}/git/trees/${dir.sha}`, { headers });
      if (!tree.ok) {
        console.warn(`[applied-migrations-recorded] could not list ${repo}/supabase/migrations tree (${tree.status}); indexing this repo only.`);
        continue;
      }
      const body = await tree.json();
      if (body.truncated) console.warn(`[applied-migrations-recorded] ${repo} migrations tree was truncated by the API; the index may be short.`);
      for (const e of body.tree || []) if (e && e.type === 'blob') out.push(e.path);
    } catch (err) {
      console.warn(`[applied-migrations-recorded] could not reach ${repo}: ${err?.message || err}; indexing this repo only.`);
    }
  }
  return out;
}

async function repoIndex() {
  return indexFrom([...readdirSync(DIR), ...(await siblingMigrationFiles())]);
}

export function recordedBy(index, migration) {
  if (index.versions.has(migration.version)) return true;
  const name = String(migration.name || '').toLowerCase();
  if (name.length === 0) return false;
  if (index.names.has(name)) return true;
  const bare = withoutStamp(name);
  return bare.length > 0 && index.names.has(bare);
}

/**
 * PAGED (2026-09-03). PostgREST caps a response at 1,000 rows, and the RPC
 * orders oldest-first, so with 1,080 migrations applied since the window's
 * floor this check was silently blind to the NEWEST eighty - the ones most
 * likely to be unrecorded, including everything applied on the day it ran.
 * "5 of 1000" was read as a healthy report for days. Walk `limit`/`offset`
 * (a Range header is ignored on this RPC - verified live) until a page comes
 * back short.
 */
async function appliedMigrations() {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/fn_ca_applied_migrations?limit=${PAGE}&offset=${from}`, {
      method: 'POST',
      headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_since: SINCE }),
    });
    if (!res.ok && res.status !== 206) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `fn_ca_applied_migrations returned ${res.status}. ` +
          `If it is missing, apply 20260831191832_the_repo_can_ask_what_the_database_has_applied. ${body.slice(0, 300)}`
      );
    }
    const page = await res.json();
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

async function main() {
  requireEnvironment();
  const applied = await appliedMigrations();
  const index = await repoIndex();
  const missing = applied.filter((m) => !recordedBy(index, m));

  if (AS_JSON) {
    console.log(JSON.stringify({ since: SINCE, applied: applied.length, missing }, null, 1));
  } else if (missing.length === 0) {
    console.log(
      `[applied-migrations-recorded] OK — all ${applied.length} migration(s) applied since ${SINCE} have a file in ${DIR} or a sibling repo.`
    );
  } else {
    console.log('');
    console.log(
      `[applied-migrations-recorded] ${missing.length} of ${applied.length} migration(s) applied since ${SINCE} have NO FILE in this repo:`
    );
    console.log('');
    for (const m of missing) console.log(`  ${m.version}  ${m.name}`);
    console.log('');
    console.log('  These ran against production and are not written down. A rebuild from this');
    console.log('  repo would not have them. Export each one and commit it — the applied SQL is');
    console.log('  in supabase_migrations.schema_migrations.statements, and the file should be');
    console.log('  named for the version it was applied under so the two can be tied together.');
    console.log('');
  }

  if (missing.length > 0 && FAIL_ON_GAP) process.exit(1);
}

/* Guarded so a test can import indexFrom/recordedBy without this script
   reaching for production. Same idiom as check-definer-authorization.mjs. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('check-applied-migrations-are-recorded failed:', err.message);
    process.exit(2);
  });
}
