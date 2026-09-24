#!/usr/bin/env node
/**
 * ===========================================================================
 *  A RECORDING IS NOT A DECLARATION - AND SAYING SO IS NOT ENOUGH
 * ===========================================================================
 *
 * WHY THIS EXISTS (2026-09-23, issue #5008)
 *
 * Production applies migrations through the Supabase MCP. The .sql file does
 * not always get committed, so `Applied Migrations Are Recorded` periodically
 * finds versions the database has run and this repo has never seen - 40 of 226
 * on 2026-09-22, the oldest six days old. The recovery is byte-exact and comes
 * from `supabase_migrations.schema_migrations.statements`, the only place the
 * SQL still lives.
 *
 * Four separate rules refuse those files:
 *
 *   check-definer-authorization    the writer rule, and the anon rule
 *   check-money-trigger-declared   a trigger on a money table, undeclared
 *   check-no-new-band-aids         a repair-shaped function being declared
 *
 * Every one of them asks the same question: "is this branch INTRODUCING
 * something unreviewed?" For a file that records SQL production executed six
 * days ago, that question has already been answered by the database. Refusing
 * the FILE protects nothing - the schema is live either way - while the repo
 * stays unable to describe its own database, which is how the finding got lost
 * in the first place. Measured against production on 2026-09-23, all four
 * claims were false as stated about today's schema, with one exception that was
 * real and had already been closed; the evidence is per file in the manifest.
 *
 * -- WHY NOT THE MARKER THAT ALREADY EXISTED --------------------------------
 *
 * `-- BACKFILLED` on the first line has been honoured by
 * check-definer-authorization and check-migrations-applied since 2026-09-01,
 * and it is a BLANKET BYPASS: any file whose first line is that comment skips
 * all four definer rules, whatever it actually contains. Nothing anywhere
 * checked that the file was a recording of anything. check-migrations-applied's
 * own header already names the hazard - "a BACKFILLED marker on a file that was
 * not backfilled" - as one of the dishonest escapes it did not want to leave
 * open.
 *
 * A comment cannot carry evidence. This module replaces it with a claim that
 * can be checked, and that a fabrication cannot satisfy:
 *
 *   1. a row in scripts/ci/recorded-migrations.manifest.json naming the
 *      version, the path and the md5 of the FILE BYTES;
 *   2. the file on disk hashing to exactly that md5;
 *   3. that same md5 being what production returns for that version, from
 *      md5(convert_to(array_to_string(statements, chr(10)) || chr(10),'UTF8'))
 *      - checked by scripts/ci/check-recorded-migrations-evidence.mjs, which
 *      runs with the database credentials inside the `Applied Migrations Are
 *      Recorded` workflow.
 *
 * (1) and (2) are offline and hold in every checkout. (3) is the lock: a file
 * that is byte-identical to SQL production has already executed is, by
 * definition, not new work. A genuinely new migration cannot be made to hash to
 * a version production holds, so it cannot wear this marker - and if somebody
 * writes the row anyway, the live check refuses it in a workflow that files an
 * issue.
 *
 * -- THREE OUTCOMES, NOT TWO (CLAUDE.md 10.86 rule 1) -----------------------
 *
 *   'new'       an ordinary migration. Judge it exactly as strictly as before.
 *   'recorded'  a verified recording. The file-text prediction is not the
 *               question; production's live state is, and that is what
 *               check-recorded-migrations-evidence.mjs asks.
 *   'unknown'   a recording was CLAIMED and could not be checked - the manifest
 *               is missing, unreadable or malformed. This never means
 *               'recorded'. Callers judge the file strictly and say out loud
 *               that they could not tell.
 *
 * -- THE LEGACY MARKER IS FROZEN, NOT REVIVED -------------------------------
 *
 * 577 files on main carry `-- BACKFILLED` or `-- UNRECOVERABLE STUB`; the
 * newest is 20260914130826. They are history, they are already on main and
 * already applied, and rewriting 577 files to add manifest rows would be a
 * larger and riskier diff than the hole it closes. So the old marker keeps
 * working BELOW a cutoff and stops working at or above it. The cutoff is
 * provably clean today: nothing at or after 20260915 carries it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = 'scripts/ci/recorded-migrations.manifest.json';
export const MIGRATION_DIR = 'supabase/migrations/';

/**
 * The first version at which the old first-line marker stops being accepted and
 * a manifest row is required instead.
 *
 * Measured 2026-09-23 on origin/main: 577 files carry the legacy marker and the
 * newest is 20260914130826, so this cutoff refuses nothing that exists and
 * covers everything written from here on. Moving it FORWARD would re-open the
 * blanket bypass for a range of versions;
 * tests/a-recording-is-verified-not-asserted.law.test.ts refuses that.
 */
export const RECORDING_BINDS_FROM = '20260915';

/** `.../20260916111614_owner_operational_notification.sql` -> `20260916111614`. */
export function migrationVersion(file) {
  const base = String(file).split('/').pop() || '';
  const cut = base.indexOf('_');
  return cut < 0 ? base.replace(/\.sql$/i, '') : base.slice(0, cut);
}

/** The legacy first-line comment. Kept as a named predicate so the one place
 *  that still honours it stays greppable. */
export function carriesLegacyMarker(head) {
  return /^--\s*(BACKFILLED|UNRECOVERABLE STUB)\b/.test(String(head));
}

export function md5OfFile(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function repoRoot(repo) {
  return repo || join(HERE, '..', '..');
}

/**
 * Read the manifest.
 *
 * Returns `{ rows, error }`. A non-null `error` is the COULD-NOT-TELL case and
 * is never silently turned into an empty manifest. An unreadable manifest read
 * as "no recordings" re-arms every rule, which is the harmless direction; read
 * as "everything is recorded" it would disarm all of them, and a caller that
 * cannot tell the two apart will eventually write the second one.
 */
export function loadManifest(repo) {
  const path = join(repoRoot(repo), MANIFEST_PATH);
  if (!existsSync(path)) {
    return { rows: new Map(), error: `manifest not found at ${MANIFEST_PATH}` };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { rows: new Map(), error: `manifest is not valid JSON: ${err.message}` };
  }
  const list = raw?.recordings;
  if (!Array.isArray(list)) {
    return { rows: new Map(), error: 'manifest has no `recordings` array' };
  }
  const rows = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { version, file, md5 } = entry;
    if (!/^\d{14}$/.test(String(version ?? ''))) continue;
    if (typeof file !== 'string' || !file.startsWith(MIGRATION_DIR)) continue;
    if (!/^[0-9a-f]{32}$/.test(String(md5 ?? ''))) continue;
    rows.set(String(version), entry);
  }
  return { rows, error: null };
}

/**
 * What kind of migration file is this?
 *
 * `{ state: 'new' | 'recorded' | 'unknown', reason }`. The reason is written for
 * a human reading a BLOCKED message, so it says what was checked rather than
 * what was assumed.
 */
export function classifyMigration(file, { repo, manifest } = {}) {
  const root = repoRoot(repo);
  const path = join(root, file);
  const version = migrationVersion(file);

  let head = '';
  try {
    head = readFileSync(path, 'utf8').slice(0, 400);
  } catch {
    return { state: 'new', reason: 'file could not be read; judged as new work' };
  }

  const legacy = carriesLegacyMarker(head);
  if (legacy && version < RECORDING_BINDS_FROM) {
    return {
      state: 'recorded',
      reason: `legacy BACKFILLED marker, frozen set (version < ${RECORDING_BINDS_FROM})`,
    };
  }

  const loaded = manifest ?? loadManifest(root);
  const row = loaded.rows.get(version);

  if (!row) {
    if (legacy) {
      return {
        state: 'new',
        reason:
          `the first line claims BACKFILLED, but that marker is frozen at ` +
          `${RECORDING_BINDS_FROM} and this version is at or after it. A recording ` +
          `needs a verified row in ${MANIFEST_PATH}.`,
      };
    }
    // No claim was made, so an unreadable manifest changes nothing about THIS
    // file: it is ordinary new work and is judged strictly.
    return { state: 'new', reason: 'no recording claimed' };
  }

  if (loaded.error) {
    return { state: 'unknown', reason: `could not read ${MANIFEST_PATH}: ${loaded.error}` };
  }
  if (row.file !== file) {
    return {
      state: 'new',
      reason: `${MANIFEST_PATH} records version ${version} at ${row.file}, not at ${file}`,
    };
  }
  let actual;
  try {
    actual = md5OfFile(path);
  } catch (err) {
    return { state: 'unknown', reason: `could not hash ${file}: ${err.message}` };
  }
  if (actual !== row.md5) {
    return {
      state: 'new',
      reason:
        `${file} hashes to ${actual}, but ${MANIFEST_PATH} records ${row.md5}. A ` +
        `recording is byte-identical to what production ran; an edited one is new work.`,
    };
  }
  return {
    state: 'recorded',
    reason:
      `byte-identical (md5 ${actual}) to the SQL production applied as ${version}; ` +
      `live evidence is recorded in ${MANIFEST_PATH}`,
  };
}

/** Convenience for the three guards: the subset of `files` that must be judged
 *  strictly, plus the ones that could not be told apart. */
export function partitionMigrations(files, { repo } = {}) {
  const manifest = loadManifest(repoRoot(repo));
  const judge = [];
  const recorded = [];
  const unknown = [];
  for (const file of files) {
    const verdict = classifyMigration(file, { repo, manifest });
    if (verdict.state === 'recorded') {
      recorded.push({ file, ...verdict });
    } else if (verdict.state === 'unknown') {
      unknown.push({ file, ...verdict });
      judge.push(file); // could not tell is never a pass
    } else {
      judge.push(file);
    }
  }
  return { judge, recorded, unknown };
}

/** One line per file a guard exempted, so a reader of the log can see what was
 *  skipped and why. A silent exemption is the same failure as a silent check. */
export function reportRecorded(label, recorded, unknown) {
  for (const r of recorded) {
    console.log(`[${label}] recording-only: ${r.file} - ${r.reason}`);
  }
  for (const u of unknown) {
    console.error(
      `[${label}] COULD NOT TELL whether ${u.file} is a recording (${u.reason}); ` +
        'judging it as new work.'
    );
  }
}
