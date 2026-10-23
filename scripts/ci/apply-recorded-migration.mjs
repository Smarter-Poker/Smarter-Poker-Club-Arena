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
 *   3  UNKNOWN - inspect durable state; an operation may have been sent
 *
 * NO RETRY LOOP (CLAUDE.md section 2 rule 2). One attempt per dispatch.
 *
 * CONCURRENT INDEXES (2026-09-26). A file may open with CREATE INDEX
 * CONCURRENTLY IF NOT EXISTS statements before its BEGIN; and nothing else
 * (migration-concurrent-preamble.mjs). Each is sent alone, outside any
 * transaction, only with room to finish before the :50 break window, and read
 * back VALID before the next; the transaction is sent only after all of them.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/ci/apply-recorded-migration.mjs \
 *     --migration 20260922143541_club_and_union_diamond_commerce.sql [--dry-run]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { supersededBy } from './check-migrations-are-live.mjs';
import {
  splitConcurrentPreamble,
  minutesBeforeBreakWindow,
} from './migration-concurrent-preamble.mjs';

import {
  recoveryRequest,
  recoveryCatalog,
  cleanupStatement,
  RECOVERY_TRANSIENT_CATALOG,
  validateRecoveryPair,
  recoveryStatement,
  RECOVERY_SNAPSHOTS,
  validateRecoveryCatalog,
  validateRecoverySnapshots,
  MAX_SNAPSHOT_AGE_SECONDS,
  recoverySnapshotDiagnostic,
} from './contract-index-recovery.mjs';

import { batchRequest, applyFinalTablePages } from './final-table-cleanup-batches.mjs';
import { withSettlementLane } from './settlement-lane.mjs';
import { bindMigrationSession } from './migration-session-identity.mjs';
import { accountingAdmissionSQL } from './accounting-migration-admission.mjs';
import {
  validateThawRepair,
  THAW_REPAIR_ADMISSION,
  thawRepairSQL,
} from './maintenance-thaw-repair.mjs';
import {
  windowDeclaration,
  validateWindowMigration,
  windowTransactionSQL,
  WINDOW_STATE_QUERY,
  TRANSACTION_BUDGET_SECONDS,
} from './maintenance-window-migrations.mjs';
import { ACCOUNTING_ADMISSION_SOURCES } from './accounting-migration-admission.mjs';

const DIR = 'supabase/migrations';
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SETTLEMENT_LANE = args.includes('--settlement-lane');
const MAINTENANCE_THAW_REPAIR = args.includes('--maintenance-thaw-repair');
// The daily-maintenance window route (maintenance-window-migrations.mjs). Only
// scripts/ci/install-window-migrations.mjs passes it, from the daily 03:30
// America/Chicago run of stage-engine-release.yml; the database decides
// whether the window is really open, inside the transaction it sends.
const MAINTENANCE_WINDOW = args.includes('--maintenance-window');
const argValue = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? null : args[i + 1] || null;
};

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_UNKNOWN = 3;

function unknown(msg) {
  console.error(`[apply] UNKNOWN: ${msg}`);
  console.error('[apply] Inspect the retained operation and durable state before another attempt.');
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

// A FILE MARKED SUPERSEDED MUST NEVER RUN, whoever hands it to this applier.
// 20261005151712_diamond_cash_rake_economics_and_accrual carries that marker on
// its first line and carries "THIS FILE MUST NEVER RUN" in its header, and it
// reached production anyway on 2026-10-05 between 21:55 and 22:40 UTC - not
// through this script (every run in the window was checked), and by what route
// is not known. It overwrote a live settings contract and took the parameter
// default off two readers, which broke six money-path functions at runtime.
// This is the sanctioned route; from here the answer is no.
//
// The parser is check-migrations-are-live's own supersededBy and not a second
// copy of it, so there is one definition of what the marker means. It requires
// the marker to NAME a successor version and a file with that version to exist
// in this directory, which is what keeps "superseded" from becoming the easiest
// lie to tell about a migration somebody simply does not want to run.
const superseded = supersededBy(sql, readdirSync(DIR));
if (superseded) {
  refused(
    `${file} is marked "SUPERSEDED BY ${superseded}" and must never run. ` +
      `Apply ${superseded}_* instead. Nothing was sent.`
  );
}
let recovery;
try {
  recovery = recoveryRequest(
    file,
    sql,
    argValue('--recover-index'),
    argValue('--recover-oid'),
    argValue('--recover-before'),
    argValue('--recover-transient-oid')
  );
} catch (e) {
  refused(e.message);
}

let batches;
try {
  batches = batchRequest(
    file,
    argValue('--final-table-pages'),
    argValue('--final-table-operation'),
    recovery
  );
} catch (e) {
  refused(e.message);
}

let rakeHistory = false;
let qualifyRakeReportHistory;
try {
  if (args.includes('--qualify-rake-report-history')) {
    const report = await import('./rake-report-history-baseline.mjs');
    rakeHistory = report.rakeReportRequest(file, true, recovery, batches);
    qualifyRakeReportHistory = report.qualifyRakeReportHistory;
  }
} catch (e) {
  refused(e.message);
}

// The production DDL policy (CLAUDE.md section 2 rule 1) requires one
// migration to be one transaction. Refuse a file that does not carry its own,
// because this sends the whole file as a single simple query and an unwrapped
// file would autocommit statement by statement - up to one ~28s PostgREST
// schema reload each, and a partial schema if one of them fails.
if (!/^\s*BEGIN\s*;/im.test(sql) || !/COMMIT\s*;\s*$/i.test(sql.trim())) {
  refused(
    `${file} does not open with BEGIN; and close with COMMIT; - refusing to apply it outside one transaction`
  );
}
// The one sanctioned exception (migration-concurrent-preamble.mjs): CREATE
// INDEX CONCURRENTLY statements before BEGIN;, which cannot run inside any
// transaction block. Each is sent on its own; everything else must still be
// inside the one transaction.
const shape = splitConcurrentPreamble(sql);
if (!shape.ok) refused(`${file}: ${shape.reason}`);
const preamble = shape.indexes;

// A MIGRATION THAT NEEDS THE LIVE TABLES WAITS FOR THE DAILY BREAK
// (2026-10-22). A file that declares "-- @install-window: daily-maintenance"
// is installed only by the window route, and only after these static rules.
let windowMigration = false;
try {
  windowMigration = windowDeclaration(sql) === 'daily-maintenance';
} catch (e) {
  refused(`${file}: ${e.message}`);
}
if (MAINTENANCE_WINDOW && !windowMigration)
  refused(
    `${file} does not declare "-- @install-window: daily-maintenance"; the window route installs only declared files`
  );
if (windowMigration) {
  try {
    validateWindowMigration(file, sql, {
      preamble,
      recovery,
      batches,
      settlementLane: SETTLEMENT_LANE,
      thawRepair: MAINTENANCE_THAW_REPAIR,
      rakeHistory,
      accountingAdmission: Object.hasOwn(ACCOUNTING_ADMISSION_SOURCES, file),
    });
  } catch (e) {
    refused(e.message);
  }
}
if (MAINTENANCE_THAW_REPAIR) {
  try {
    validateThawRepair(file, sql, {
      dryRun: DRY_RUN,
      settlementLane: SETTLEMENT_LANE,
      recovery,
      batches,
      preamble,
    });
  } catch (e) {
    refused(e.message);
  }
}
if (
  SETTLEMENT_LANE &&
  (file !== '20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql' ||
    recovery ||
    batches ||
    preamble.length)
)
  refused(
    'settlement lane admission is limited to the exact scoped reset without other operations'
  );
// Leave room for the slowest ledger build to finish before :50: a concurrent
// build still running when the break window opens is refused at its end and
// leaves an INVALID index behind.
const PREAMBLE_MINUTES_NEEDED = 12;

// CLAUDE.md section 2 rule 8: the database refuses non-temporary DDL from a
// postgres-role session inside minute-of-hour :50-:03 UTC, the hourly
// maintenance break window (section 13). The event trigger is the real guard;
// this is the polite half, so a refusal reads as a sentence here rather than
// an aborted transaction there.
// The window route runs exactly inside that window, under the documented
// override; its admission is the database's window predicate instead.
const minute = new Date().getUTCMinutes();
if (!MAINTENANCE_WINDOW && (minute >= 50 || minute <= 3)) {
  refused(
    `it is :${String(minute).padStart(2, '0')} UTC and the break window is :50-:03. Dispatch again after :03. Do not loop.`
  );
}

const CONN = process.env.DATABASE_URL;
if (!CONN) unknown('DATABASE_URL is not set');

// TLS verification is explicit and cannot be disabled by URL parameters.
// CA material is public provider trust, never a copied password or token.
let connectionURL;
try {
  connectionURL = new URL(CONN);
} catch {
  unknown('configured database connection syntax is invalid');
}
if (!['postgres:', 'postgresql:'].includes(connectionURL.protocol))
  refused('database connection protocol is invalid');
if (connectionURL.searchParams.has('sslcert') || connectionURL.searchParams.has('sslkey'))
  refused('client-certificate transport requires its maintained qualified route');
const sslRoot =
  argValue('--ssl-root-cert') ||
  process.env.PGSSLROOTCERT ||
  connectionURL.searchParams.get('sslrootcert') ||
  'system';
let ssl = { rejectUnauthorized: true };
if (sslRoot !== 'system') {
  try {
    ssl.ca = readFileSync(sslRoot, 'utf8');
  } catch {
    unknown('configured provider CA certificate is unavailable');
  }
}
for (const key of ['sslmode', 'ssl', 'sslrootcert']) connectionURL.searchParams.delete(key);
const { default: pg } = await import('pg');
const client = new pg.Client({
  connectionString: connectionURL.toString(),
  ssl,
  application_name: 'apply-recorded-migration',
});
client.on('error', () =>
  unknown(
    'database transport disconnected; inspect exact durable migration history and postimages before another attempt'
  )
);

try {
  await client.connect();
  await client.query("SET application_name = 'apply-recorded-migration'");
  const identity = await client.query("SELECT current_setting('application_name') AS name");
  if (identity.rows[0]?.name !== 'apply-recorded-migration')
    throw new Error('Installer backend identity did not bind');
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

if (batches) {
  try {
    await applyFinalTablePages(client, batches, sql, DRY_RUN);
    await client.end();
    process.exit(EXIT_OK);
  } catch (e) {
    await client.end().catch(() => {});
    unknown(`bounded cleanup stopped: ${e.message}`);
  }
}

if (already.length > 0) {
  if (recovery) {
    await client.end().catch(() => {});
    refused(
      'Migration history already present; recovery not sent and index recovery not certified.'
    );
  }
  console.log(`[apply] ALREADY-APPLIED: ${file}`);
  for (const r of already) console.log(`[apply]   recorded as version=${r.version} name=${r.name}`);
  console.log(
    rakeHistory
      ? '[apply] Migration not sent. Explicit report history qualification follows.'
      : '[apply] Nothing sent. This run changed nothing.'
  );
  if (rakeHistory) {
    try {
      await qualifyRakeReportHistory(client, sql, DRY_RUN);
    } catch (e) {
      await client.end().catch(() => {});
      unknown(`rake report qualification stopped: ${e.message}`);
    }
  }
  await client.end().catch(() => {});
  process.exit(EXIT_OK);
}

if (windowMigration && !MAINTENANCE_WINDOW) {
  await client.end().catch(() => {});
  refused(
    `${file} declares "-- @install-window: daily-maintenance": it needs exclusive locks the live tables ` +
      'cannot give during play. It is QUEUED, not lost: it stays on main and absent from ' +
      'schema_migrations until the daily 03:30 America/Chicago run of stage-engine-release.yml installs it ' +
      'inside the 04:00 maintenance freeze. Nothing was sent. Do not loop, and do not apply it by hand.'
  );
}

console.log(`[apply] ${file}`);
console.log(`[apply]   version ${version}, slug ${slug}, ${Buffer.byteLength(sql)} bytes`);
if (preamble.length > 0) {
  console.log(
    `[apply]   ${preamble.length} CREATE INDEX CONCURRENTLY statement(s) first, each on its own:`
  );
  for (const ix of preamble) console.log(`[apply]     ${ix.name} ON ${ix.schema}.${ix.table}`);
}
console.log(
  '[apply]   not present in schema_migrations; applying the migration as ONE transaction'
);

// The dynamic half of the break window: an announced engine maintenance window
// or its thaw refuses DDL outside the fixed :50-:03 minutes too
// (fn_ca_break_window_refuses_migrations). Read it before sending anything, so
// a refusal is a sentence here and not an aborted build there.
async function refusalNow() {
  try {
    const { rows } = await client.query(
      'SELECT public.fn_ca_break_window_refuses_migrations(clock_timestamp()) AS refusal'
    );
    return rows[0].refusal;
  } catch (e) {
    await client.end().catch(() => {});
    unknown(`could not read fn_ca_break_window_refuses_migrations: ${e.message}`);
  }
}
{
  const refusal = MAINTENANCE_WINDOW ? null : await refusalNow();
  if (MAINTENANCE_WINDOW) {
    let state;
    try {
      state = (await client.query(WINDOW_STATE_QUERY)).rows[0];
    } catch (e) {
      await client.end().catch(() => {});
      unknown(`could not read the maintenance window state: ${e.message}`);
    }
    if (!state || state.open !== true) {
      await client.end().catch(() => {});
      refused(
        `the daily maintenance window is not open (frozen=${state?.frozen}, break=${state?.break_row ?? 'none'}). Nothing was sent; the file stays queued.`
      );
    }
    console.log(
      `[apply]   daily maintenance window open at ${state.observed_at}: ${state.break_row}`
    );
  } else if (MAINTENANCE_THAW_REPAIR) {
    const { rows } = await client.query(THAW_REPAIR_ADMISSION);
    if (rows.length !== 1 || rows[0].admitted !== true) {
      await client.end().catch(() => {});
      refused('maintenance thaw repair requires an expired coherent owned freeze');
    }
  } else if (refusal) {
    await client.end().catch(() => {});
    refused(`the database would refuse DDL now: ${refusal}. Nothing was sent. Do not loop.`);
  }
}
if (preamble.length > 0 && minutesBeforeBreakWindow(new Date()) < PREAMBLE_MINUTES_NEEDED) {
  await client.end().catch(() => {});
  refused(
    `${PREAMBLE_MINUTES_NEEDED} minutes are needed before :50 UTC to build the concurrent indexes; dispatch again after :03. Nothing was sent.`
  );
}

if (DRY_RUN && !recovery) {
  console.log('[apply] DRY RUN: nothing sent.');
  await client.end().catch(() => {});
  process.exit(EXIT_OK);
}

// Explicit source-bound recovery is a single operation within this existing installer.
// Unknown acknowledgment never triggers another attempt or proceeds to the body.
if (recovery) {
  let recoverySent = false;
  try {
    const deadline = performance.now() + 600000;
    async function freshAdmission(withTransient) {
      await client.query("SET statement_timeout = '3s'");
      const original = (await client.query(recoveryCatalog(recovery))).rows;
      if (withTransient)
        validateRecoveryPair(
          original,
          (await client.query(RECOVERY_TRANSIENT_CATALOG)).rows,
          recovery
        );
      else validateRecoveryCatalog(original, recovery);
      const refusal = await refusalNow();
      if (refusal || minutesBeforeBreakWindow(new Date()) < PREAMBLE_MINUTES_NEEDED)
        throw new Error('recovery lacks full maintenance runway or database refuses DDL');
      const snapshots = (await client.query(RECOVERY_SNAPSHOTS)).rows;
      console.log(
        `[apply] recovery admission diagnostic: ${recoverySnapshotDiagnostic(snapshots)}`
      );
      validateRecoverySnapshots(snapshots);
      console.log(
        `[apply] current snapshot admission ${snapshots[0].observed_at}: ${snapshots[0].holders} holder(s), oldest ${snapshots[0].oldest_age_seconds ?? 0}s <= ${MAX_SNAPSHOT_AGE_SECONDS}s; historical operation ${recovery.before}`
      );
    }
    async function sendOnce(statement) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error('shared 600s recovery budget exhausted');
      await client.query("SELECT set_config('statement_timeout',$1,false)", [remaining + 'ms']);
      recoverySent = true;
      await client.query(statement);
    }
    await freshAdmission(Boolean(recovery.transientOid));
    if (DRY_RUN) {
      console.log(
        '[apply] DRY RUN: exact recovery pair/catalog and fresh snapshot preconditions passed; no DDL sent.'
      );
      await client.end();
      process.exit(EXIT_OK);
    }
    if (recovery.transientOid) {
      await sendOnce(cleanupStatement(recovery));
      await client.query("SET statement_timeout = '3s'");
      if ((await client.query(RECOVERY_TRANSIENT_CATALOG)).rows.length !== 0)
        throw new Error('transient cleanup not proven');
      validateRecoveryCatalog((await client.query(recoveryCatalog(recovery))).rows, recovery);
      console.log(
        `[apply] exact interrupted transient OID ${recovery.transientOid} removed; original OID ${recovery.oid} unchanged`
      );
      await freshAdmission(false);
    }
    await sendOnce(recoveryStatement(recovery));
    await client.query("SET statement_timeout = '3s'");
    const replacement = validateRecoveryCatalog(
      (await client.query(recoveryCatalog(recovery))).rows,
      recovery,
      true
    );
    console.log(`[apply] recovered exact index OID ${recovery.oid} -> ${replacement.oid}`);
    await client.query('RESET statement_timeout');
  } catch (e) {
    await client.end().catch(() => {});
    console.error(
      `[apply] recovery ${recoverySent ? 'SENT; inspect durable outcome before any further action' : 'NOT SENT'}: ${e.code || ''} ${e.message}`
    );
    console.error(
      '[apply] Migration transaction/history NOT sent. No automatic retry, unbound cleanup or cancellation.'
    );
    process.exit(recoverySent ? EXIT_UNKNOWN : EXIT_REFUSED);
  }
}

for (const ix of preamble) {
  const refusal = await refusalNow();
  if (refusal || minutesBeforeBreakWindow(new Date()) < 5) {
    await client.end().catch(() => {});
    refused(
      `stopped before ${ix.name}: ${refusal || 'fewer than 5 minutes before :50 UTC'}. Indexes already built stay (IF NOT EXISTS skips them); the transaction was NOT sent. Dispatch again after :03.`
    );
  }
  const t0 = Date.now();
  try {
    // Session-level and outside any transaction block: CONCURRENTLY requires it.
    await client.query("SET statement_timeout = '600s'");
    await client.query(ix.statement);
    await client.query('RESET statement_timeout');
  } catch (e) {
    await client.end().catch(() => {});
    console.error(
      `[apply] ${ix.name} did not build after ${Date.now() - t0}ms: ${e.code || ''} ${e.message}`
    );
    console.error(
      '[apply] A failed CONCURRENTLY build can leave an INVALID index. Inspect its exact catalog and owning operation; do not blindly redispatch or drop it.'
    );
    console.error(
      '[apply] The migration transaction was NOT sent. Preserve any earlier index operation and inspect its durable outcome.'
    );
    process.exit(EXIT_REFUSED);
  }
  let valid;
  try {
    const { rows } = await client.query(
      `SELECT i.indisvalid AND i.indisready AS valid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [ix.schema, ix.name]
    );
    valid = rows.length === 1 && rows[0].valid === true;
  } catch (e) {
    await client.end().catch(() => {});
    console.error(
      `[apply] UNKNOWN: ${ix.name} was sent but its validity could not be read (${e.message}).`
    );
    console.error(
      '[apply] The transaction was NOT sent. Read pg_index for it before dispatching again.'
    );
    process.exit(EXIT_UNKNOWN);
  }
  if (!valid) {
    await client.end().catch(() => {});
    refused(
      `${ix.name} exists but is not VALID. Inspect the original operation and supported exact-index recovery before another dispatch. The transaction was NOT sent.`
    );
  }
  console.log(`[apply]   ${ix.name} valid (${Date.now() - t0}ms)`);
}

// Keep exact file bytes in history inside the SAME owning transaction as
// schema installation. A transport failure can then only have an all-or-none
// durable outcome, resolved by readback rather than migration replay.
const historyTag = '$ca_file_history_' + version + '$';
if (sql.includes(historyTag) || sql.includes('$ca_atomic_history_guard$'))
  refused('migration conflicts with the reserved history literal delimiter');
const exactSQLLiteral = historyTag + sql + historyTag;
const historyStatement = `
INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES ('${version}','${slug}',ARRAY[${exactSQLLiteral}::text]);
DO $ca_atomic_history_guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${version}' AND name='${slug}' AND statements=ARRAY[${exactSQLLiteral}::text]) THEN
  RAISE EXCEPTION 'atomic migration history does not match the exact source file';
 END IF;
END $ca_atomic_history_guard$;
`;
const transactionBody = preamble.length > 0 ? shape.body : sql;
const atomicSQL = transactionBody.replace(/COMMIT\s*;\s*$/i, () => historyStatement + '\nCOMMIT;');
if (atomicSQL === transactionBody)
  refused('atomic migration history could not bind the final COMMIT');
let admittedSQL;
let transactionSQL;
try {
  admittedSQL = MAINTENANCE_THAW_REPAIR
    ? thawRepairSQL(atomicSQL)
    : accountingAdmissionSQL(file, sql, atomicSQL);
  // A window file is never an accounting-admission file (validated above), so
  // the line before returned atomicSQL unchanged; wrap it in the window.
  if (MAINTENANCE_WINDOW) admittedSQL = windowTransactionSQL(file, atomicSQL);
  transactionSQL = bindMigrationSession(SETTLEMENT_LANE ? atomicSQL : admittedSQL);
} catch (e) {
  await client.end().catch(() => {});
  refused(e.message);
}
if (MAINTENANCE_WINDOW) {
  // PostgreSQL 17 also bounds the whole transaction server-side, a few seconds
  // past the closing assertion's budget and still under the 15 s age at which
  // fn_ca_writer_lock_sentinel would cancel it; on older servers the closing
  // assertion and the per-statement timeout are the bound.
  try {
    const { rows } = await client.query(
      "SELECT current_setting('server_version_num')::int >= 170000 AS has_transaction_timeout"
    );
    if (rows[0]?.has_transaction_timeout === true)
      await client.query(`SET transaction_timeout = '${TRANSACTION_BUDGET_SECONDS + 4}s'`);
  } catch (e) {
    await client.end().catch(() => {});
    unknown(`could not bound the window transaction: ${e.message}`);
  }
}
const started = Date.now();
try {
  // Send one owning transaction; history retains the exact source bytes.
  if (SETTLEMENT_LANE) await withSettlementLane(client, () => client.query(transactionSQL));
  else await client.query(transactionSQL);
} catch (e) {
  await client.end().catch(() => {});
  const definiteRefusal =
    e.code &&
    /^[0-9A-Z]{5}$/.test(e.code) &&
    !e.code.startsWith('08') &&
    !['57P01', '57P02', '57P03'].includes(e.code);
  console.error(
    `[apply] ${definiteRefusal ? 'REFUSED' : 'UNKNOWN'} after ${Date.now() - started}ms`
  );
  console.error(`[apply] ${e.severity || 'ERROR'} ${e.code || ''}: ${e.message}`);
  if (e.detail) console.error(`[apply] DETAIL: ${e.detail}`);
  if (e.hint) console.error(`[apply] HINT: ${e.hint}`);
  if (e.where) console.error(`[apply] WHERE: ${e.where}`);
  console.error(
    definiteRefusal
      ? '[apply] Database refused the transaction; inspect before another explicit attempt.'
      : '[apply] Durable outcome UNKNOWN; read exact atomic history and postimages before any possible retry.'
  );
  process.exit(definiteRefusal ? EXIT_REFUSED : EXIT_UNKNOWN);
}
console.log(`[apply] committed in ${Date.now() - started}ms`);

// History was committed atomically. This step is read-only; never insert or
// re-apply after an unknown transport outcome.
try {
  const { rows } = await client.query(
    'SELECT version,name,statements FROM supabase_migrations.schema_migrations WHERE version=$1',
    [version]
  );
  if (
    rows.length !== 1 ||
    rows[0].name !== slug ||
    !Array.isArray(rows[0].statements) ||
    rows[0].statements.length !== 1 ||
    rows[0].statements[0] !== sql
  )
    unknown('migration sent; exact atomic history readback is unavailable or mismatched');
  console.log(`[apply] recorded version=${rows[0].version} name=${rows[0].name}`);
} catch {
  await client.end().catch(() => {});
  unknown('migration sent; read durable atomic history before another attempt');
}

console.log('[apply] APPLIED');
if (rakeHistory) {
  try {
    await qualifyRakeReportHistory(client, sql, DRY_RUN);
  } catch (e) {
    await client.end().catch(() => {});
    unknown(`migration installed; rake report qualification stopped: ${e.message}`);
  }
}
await client.end().catch(() => {});
process.exit(EXIT_OK);
