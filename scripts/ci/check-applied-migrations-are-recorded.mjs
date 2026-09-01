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

function repoIndex() {
  return indexFrom(readdirSync(DIR));
}

export function recordedBy(index, migration) {
  if (index.versions.has(migration.version)) return true;
  const name = String(migration.name || '').toLowerCase();
  if (name.length === 0) return false;
  if (index.names.has(name)) return true;
  const bare = withoutStamp(name);
  return bare.length > 0 && index.names.has(bare);
}

async function appliedMigrations() {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/fn_ca_applied_migrations`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_since: SINCE }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `fn_ca_applied_migrations returned ${res.status}. ` +
        `If it is missing, apply 20260831191832_the_repo_can_ask_what_the_database_has_applied. ${body.slice(0, 300)}`
    );
  }
  return res.json();
}

async function main() {
  requireEnvironment();
  const applied = await appliedMigrations();
  const index = repoIndex();
  const missing = applied.filter((m) => !recordedBy(index, m));

  if (AS_JSON) {
    console.log(JSON.stringify({ since: SINCE, applied: applied.length, missing }, null, 1));
  } else if (missing.length === 0) {
    console.log(
      `[applied-migrations-recorded] OK — all ${applied.length} migration(s) applied since ${SINCE} have a file in ${DIR}.`
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
