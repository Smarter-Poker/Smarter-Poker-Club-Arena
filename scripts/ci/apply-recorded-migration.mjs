#!/usr/bin/env node
/**
 * ===========================================================================
 *  APPLY ONE MERGED-BUT-UNAPPLIED MIGRATION, FROM ITS OWN BYTES
 * ===========================================================================
 *
 * WHY THIS EXISTS (2026-09-23)
 *
 * check-migrations-are-live.mjs (2026-09-19) asks "a migration that merged
 * must be live" and, when the answer is no, tells you to apply it with the
 * Supabase MCP apply_migration. That instruction has a size it cannot cross.
 * apply_migration takes the SQL as a CALL ARGUMENT, so whoever applies it has
 * to reproduce the whole file by hand.
 *
 * 20260922143541_club_and_union_diamond_commerce.sql is 126,446 bytes. It
 * merged on 2026-09-22 (PR #5077), never reached the database, and because
 * server/src/index.ts starts a commerce renewal consumer at boot, the
 * auto-deploy doors gate "Prove The Exact Engine Has Every Production Door"
 * correctly refused every engine build after it. The engine sat on 8825af51
 * with 65 stalled tables behind a migration nobody could retype.
 *
 * Retyping a money migration is not a safe operation and is not one this repo
 * should ask for. This applies THE FILE: the runner checks out the commit,
 * reads the bytes off disk and sends them once. Nothing is transcribed, so
 * nothing can be mistranscribed.
 *
 * WHAT IT IS NOT. Not a deploy step, not a scheduled job, not a repair job
 * (CLAUDE.md 10.12): it never writes money, never retries, and runs only when
 * a person dispatches it with an explicit filename. It never applies
 * "pending migrations" as a set - exactly one named file per run.
 *
 * THE THREE OUTCOMES (CLAUDE.md 10.86 rule 1):
 *   0  APPLIED or ALREADY-APPLIED (stated separately in the log)
 *   1  REFUSED - a guard or the database said no, with the reason
 *   3  UNKNOWN - could not determine the state; NOTHING was sent
 *
 * NO RETRY LOOP (CLAUDE.md section 2 rule 2). One attempt per dispatch.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/ci/apply-recorded-migration.mjs \
 *     --migration 20260922143541_club_and_union_diamond_commerce.sql [--dry-run]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argValue = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? null : args[i + 1] || null;
};

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_UNKNOWN = 3;

function unknown(msg) {
  console.error(`[apply] UNKNOWN: ${msg}`);
  console.error('[apply] Nothing was sent to the database.');
  process.exit(EXIT_UNKNOWN);
}
function refused(msg) {
  console.error(`[apply] REFUSED: ${msg}`);
  process.exit(EXIT_REFUSED);
}

const file = argValue('--migration');
if (!file) unknown('--migration <filename> is required');
if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) {
  refused(`"${file}" is not a migration filename (14 digits, underscore, slug, .sql)`);
}
const version = file.slice(0, 14);
const slug = file.slice(15, -4);

const path = join(DIR, file);
if (!existsSync(path)) refused(`${path} does not exist in this checkout`);
const sql = readFileSync(path, 'utf8');
if (!sql.trim()) refused(`${path} is empty`);

// The production DDL policy (CLAUDE.md section 2 rule 1) requires one
// migration to be one transaction. Refuse a file that does not carry its own,
// because this sends the whole file as a single simple query and an unwrapped
// file would autocommit statement by statement - up to one ~28s PostgREST
// schema reload each, and a partial schema if one of them fails.
if (!/^\s*BEGIN\s*;/im.test(sql) || !/COMMIT\s*;\s*$/i.test(sql.trim())) {
  refused(`${file} does not open with BEGIN; and close with COMMIT; - refusing to apply it outside one transaction`);
}

// CLAUDE.md section 2 rule 8: the database refuses non-temporary DDL from a
// postgres-role session inside minute-of-hour :50-:03 UTC, the hourly
// maintenance break window (section 13). The event trigger is the real guard;
// this is the polite half, so a refusal reads as a sentence here rather than
// an aborted transaction there.
const minute = new Date().getUTCMinutes();
if (minute >= 50 || minute <= 3) {
  refused(`it is :${String(minute).padStart(2, '0')} UTC and the break window is :50-:03. Dispatch again after :03. Do not loop.`);
}

const CONN = process.env.DATABASE_URL;
if (!CONN) unknown('DATABASE_URL is not set');

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: CONN, application_name: 'apply-recorded-migration' });

try {
  await client.connect();
} catch (e) {
  unknown(`could not connect: ${e.message}`);
}

let already;
try {
  // Read the history the way CLAUDE.md section 2 rule 8 prescribes: a plain
  // SELECT. Never list_migrations, which runs five no-op ALTER TABLEs and
  // reloads PostgREST on every call.
  const { rows } = await client.query(
    `SELECT version, name FROM supabase_migrations.schema_migrations
      WHERE version = $1 OR name = $2 OR name = left($2, 55)`,
    [version, slug]
  );
  already = rows;
} catch (e) {
  await client.end().catch(() => {});
  unknown(`could not read schema_migrations: ${e.message}`);
}

if (already.length > 0) {
  console.log(`[apply] ALREADY-APPLIED: ${file}`);
  for (const r of already) console.log(`[apply]   recorded as version=${r.version} name=${r.name}`);
  console.log('[apply] Nothing sent. This run changed nothing.');
  await client.end().catch(() => {});
  process.exit(EXIT_OK);
}

console.log(`[apply] ${file}`);
console.log(`[apply]   version ${version}, slug ${slug}, ${Buffer.byteLength(sql)} bytes`);
console.log('[apply]   not present in schema_migrations; applying as ONE transaction');

if (DRY_RUN) {
  console.log('[apply] DRY RUN: nothing sent.');
  await client.end().catch(() => {});
  process.exit(EXIT_OK);
}

const started = Date.now();
try {
  await client.query(sql);
} catch (e) {
  await client.end().catch(() => {});
  console.error(`[apply] the migration did not commit after ${Date.now() - started}ms`);
  console.error(`[apply] ${e.severity || 'ERROR'} ${e.code || ''}: ${e.message}`);
  if (e.detail) console.error(`[apply] DETAIL: ${e.detail}`);
  if (e.hint) console.error(`[apply] HINT: ${e.hint}`);
  if (e.where) console.error(`[apply] WHERE: ${e.where}`);
  console.error('[apply] The transaction rolled back. Read the error; do not re-dispatch in a loop.');
  process.exit(EXIT_REFUSED);
}
console.log(`[apply] committed in ${Date.now() - started}ms`);

// Record it under the FILE's version, not the apply time. Supabase's own
// transport stamps history rows with the moment of application, which is why
// check-migrations-are-live.mjs has to match on name rather than version (see
// its header). Recording the true version keeps the repo and the history
// answering the same question.
try {
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
     VALUES ($1, $2, ARRAY[$3::text])
     ON CONFLICT (version) DO NOTHING`,
    [version, slug, sql]
  );
  const { rows } = await client.query(
    'SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = $1',
    [version]
  );
  if (rows.length !== 1) {
    console.error('[apply] APPLIED, but the history row is not readable back.');
    await client.end().catch(() => {});
    process.exit(EXIT_REFUSED);
  }
  console.log(`[apply] recorded version=${rows[0].version} name=${rows[0].name}`);
} catch (e) {
  console.error(`[apply] APPLIED, but recording the history row failed: ${e.message}`);
  console.error('[apply] The schema change is committed and must NOT be applied again.');
  await client.end().catch(() => {});
  process.exit(EXIT_REFUSED);
}

console.log('[apply] APPLIED');
await client.end().catch(() => {});
process.exit(EXIT_OK);
