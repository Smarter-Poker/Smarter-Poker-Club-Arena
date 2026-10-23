import { ownerWindowPredicate } from './owner-window-migration.mjs';
/**
 * ===========================================================================
 *  A MIGRATION THAT NEEDS THE LIVE TABLES WAITS FOR THE DAILY BREAK
 * ===========================================================================
 *
 * WHY (2026-10-22). Sampling showed public.clubs, public.tables and
 * public.hand_history held by some transaction older than 200 ms in 150 of 150
 * samples during live play, so a migration that needs ACCESS EXCLUSIVE on them
 * cannot be installed while tables deal. The Midway rake-cap migration tried
 * twice (02:34 and 02:48 UTC) and its queued lock froze the hand commit path:
 * 32 engine kills on 30 tables. 20261022030326 made the database cancel any
 * direct session that keeps live writers waiting; this module gives such a
 * migration a route that works instead of one that is cancelled.
 *
 * THE ROUTE. A migration declares, on a line of its own:
 *
 *     -- @install-window: daily-maintenance
 *
 * The ordinary applier (apply-recorded-migration.mjs, Apply Merged Migration)
 * then refuses it with a message saying it is queued. "Queued" is durable and
 * needs no table: the file is on protected main and its version is not in
 * supabase_migrations.schema_migrations. The daily 03:30 America/Chicago run of
 * stage-engine-release.yml (the owner-requested daily engine preparation, the
 * one schedule that already exists for this window) reads that queue with
 * scripts/ci/install-window-migrations.mjs, waits once for the 04:00 break's
 * confirmed freeze, and sends each queued file through the same applier with
 * --maintenance-window, one transaction each, once.
 *
 * WHAT THE TRANSACTION CARRIES (windowTransactionSQL):
 *   - the documented break-window override with a reason, so the DDL guard
 *     admits it and records it in public.ca_break_window_migration_overrides;
 *   - lock_timeout 1s and statement_timeout 5s: a lock that is not free is a
 *     refusal and a rollback, never a queue behind live work;
 *   - an opening assertion that the daily break is in counting_down, its freeze
 *     is confirmed by fn_platform_frozen(), and at least START_RESERVE_SECONDS
 *     remain before break_ends_at;
 *   - a closing assertion, after the history row, that the whole transaction
 *     took at most TRANSACTION_BUDGET_SECONDS and that COMMIT_RESERVE_SECONDS
 *     still remain, so a commit can never land in the thaw's preparation
 *     (the engine begins thaw 90 s before break_ends_at).
 * The budget keeps every install far below the 15 s age at which
 * fn_ca_writer_lock_sentinel cancels a session, so the sentinel needs no
 * exemption, and a short install cannot delay the thaw or the restart.
 *
 * NO RETRY LOOP (CLAUDE.md section 2 rules 2 and 9, 10.12). Each queued file is
 * sent at most once per window. A refusal stops the run, leaves the file
 * queued for the next day's window, and fails the job, which is read by its
 * summary and by the red-main detector (CLAUDE.md 10.83).
 */

export const WINDOW_ANNOTATION = '-- @install-window: daily-maintenance';
export const WINDOW_LOCK_TIMEOUT_MS = 1000;
export const WINDOW_STATEMENT_TIMEOUT_MS = 5000;
export const TRANSACTION_BUDGET_SECONDS = 8;
export const START_RESERVE_SECONDS = 150;
export const COMMIT_RESERVE_SECONDS = 100;
export const MAINTENANCE_TIME_ZONE = 'America/Chicago';

const ANNOTATION_LINE = /^--[ \t]*@install-window:[ \t]*(\S*)[ \t]*$/gm;

/**
 * 'daily-maintenance' when the file declares the window, null when it does not.
 * A malformed or unknown declaration throws: a typo must not quietly turn a
 * window migration back into one the live tables cannot take.
 */
export function windowDeclaration(sql) {
  const found = [...String(sql).matchAll(ANNOTATION_LINE)].map((m) => m[1]);
  const loose = String(sql)
    .split('\n')
    .filter((line) => /@install-window/.test(line));
  if (found.length === 0 && loose.length === 0) return null;
  if (found.length !== 1 || loose.length !== 1 || found[0] !== 'daily-maintenance')
    throw new Error(
      `an install-window declaration must be exactly one line "${WINDOW_ANNOTATION}"`
    );
  return 'daily-maintenance';
}

/** Non-throwing form for readers that only classify. */
export function declaresMaintenanceWindow(sql) {
  try {
    return windowDeclaration(sql) === 'daily-maintenance';
  } catch {
    return false;
  }
}

/** Blank comments and dollar-quoted bodies' tags are kept; only `--` text goes. */
const uncommented = (sql) => String(sql).replace(/--[^\n]*/g, ' ');

function durationMs(raw) {
  const m = /^\s*'?\s*(\d+(?:\.\d+)?)\s*(ms|s|min)?\s*'?\s*$/i.exec(String(raw));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60000;
}

/**
 * Static admission for a window migration. Throws with the reason; the caller
 * turns it into a REFUSED that sends nothing.
 */
export function validateWindowMigration(file, sql, opts = {}) {
  if (windowDeclaration(sql) !== 'daily-maintenance')
    throw new Error(`${file} does not declare "${WINDOW_ANNOTATION}"`);
  if (opts.preamble && opts.preamble.length > 0)
    throw new Error(
      `${file}: a window migration cannot carry CREATE INDEX CONCURRENTLY; build the index in an ordinary migration first`
    );
  for (const [flag, on] of Object.entries({
    recovery: opts.recovery,
    'final-table pages': opts.batches,
    'settlement lane': opts.settlementLane,
    'maintenance thaw repair': opts.thawRepair,
    'rake report qualification': opts.rakeHistory,
    'accounting admission': opts.accountingAdmission,
  }))
    if (on) throw new Error(`${file}: a window migration cannot be combined with ${flag}`);

  const code = uncommented(sql);
  if ((code.match(/^[ \t]*BEGIN[ \t]*;/gim) || []).length !== 1)
    throw new Error(`${file}: a window migration is exactly one BEGIN; ... COMMIT; transaction`);
  if ((code.match(/^[ \t]*COMMIT[ \t]*;/gim) || []).length !== 1)
    throw new Error(`${file}: a window migration is exactly one BEGIN; ... COMMIT; transaction`);
  if (/\b(ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|START\s+TRANSACTION)\b/i.test(code))
    throw new Error(`${file}: a window migration cannot manage its own transaction`);
  if (/\bpg_sleep\b/i.test(code))
    throw new Error(`${file}: a window migration never sleeps; it refuses instead of waiting`);
  if (/\bpg_advisory(_xact)?_lock(_shared)?\s*\(/i.test(code))
    throw new Error(
      `${file}: a window migration never waits on an advisory lock; use pg_try_advisory_xact_lock and refuse`
    );
  for (const loop of code.match(/\bLOOP\b[\s\S]*?\bEND\s+LOOP\b/gi) || [])
    if (/\bLOCK\s+TABLE\b/i.test(loop))
      throw new Error(`${file}: a window migration never retries LOCK TABLE in a loop`);
  if (/ca\.break_window_migration_override/i.test(code))
    throw new Error(
      `${file}: the window installer supplies the break-window override and its reason; the file must not`
    );
  if (/app\.freeze_bypass/i.test(code))
    throw new Error(
      `${file}: a window migration cannot bypass the platform freeze; money and seat rows stay frozen`
    );
  if (
    /\bset_config\s*\(\s*'(lock_timeout|statement_timeout|transaction_timeout|idle_in_transaction_session_timeout)'/i.test(
      code
    )
  )
    throw new Error(`${file}: a window migration sets its timeouts with SET LOCAL only`);
  const sets = [
    ...code.matchAll(
      /\bSET\s+(LOCAL\s+|SESSION\s+)?(lock_timeout|statement_timeout|transaction_timeout|idle_in_transaction_session_timeout)\s*(?:=|\bTO\b)\s*([^;]+);/gi
    ),
  ];
  for (const s of sets) {
    const scope = (s[1] || '').trim().toUpperCase();
    const name = s[2].toLowerCase();
    if (scope !== 'LOCAL')
      throw new Error(`${file}: ${name} may only be SET LOCAL inside a window migration`);
    const ms = durationMs(s[3]);
    const cap =
      name === 'lock_timeout'
        ? WINDOW_LOCK_TIMEOUT_MS
        : name === 'statement_timeout'
          ? WINDOW_STATEMENT_TIMEOUT_MS
          : null;
    if (cap === null)
      throw new Error(`${file}: a window migration does not set ${name}; the installer bounds it`);
    if (ms === null || ms <= 0 || ms > cap)
      throw new Error(
        `${file}: SET LOCAL ${name} = ${s[3].trim()} exceeds the window cap of ${cap} ms`
      );
  }
  return true;
}

/**
 * The one definition of "the daily window is open", as a boolean SQL
 * expression. It is read by the waiting installer and asserted inside every
 * install transaction, so the two cannot disagree.
 */
export function windowOpenPredicate(reserveSeconds) {
  const r = Number(reserveSeconds);
  if (!Number.isInteger(r) || r < 0 || r > 300) throw new Error('invalid window reserve');
  return `(public.fn_platform_frozen()
  AND EXISTS (
    SELECT 1 FROM public.engine_maintenance_break b
     WHERE b.enforce_freeze
       AND b.phase = 'counting_down'
       AND b.break_started_at IS NOT NULL
       AND b.break_ends_at IS NOT NULL
       AND b.break_started_at <= clock_timestamp()
       AND b.break_ends_at - clock_timestamp() >= make_interval(secs => ${r})
       AND (b.break_started_at AT TIME ZONE '${MAINTENANCE_TIME_ZONE}')::time >= time '03:55'
       AND (b.break_started_at AT TIME ZONE '${MAINTENANCE_TIME_ZONE}')::time < time '04:05'))`;
}

export const WINDOW_STATE_QUERY = `SELECT ${windowOpenPredicate(START_RESERVE_SECONDS)} AS open,
  public.fn_platform_frozen() AS frozen,
  (SELECT row_to_json(b)::text FROM public.engine_maintenance_break b) AS break_row,
  clock_timestamp() AS observed_at`;

export function overrideReason(file) {
  if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) throw new Error('invalid migration filename');
  return (
    `daily-maintenance window install of ${file}: it needs exclusive locks on live tables, ` +
    `so it is installed once inside the confirmed 04:00 ${MAINTENANCE_TIME_ZONE} freeze ` +
    `(scripts/ci/install-window-migrations.mjs, budget ${TRANSACTION_BUDGET_SECONDS}s)`
  );
}

/**
 * Wrap the exact atomic transaction (the file plus its history row) with the
 * window prelude after BEGIN and the window close before the final COMMIT.
 */
export function windowTransactionSQL(file, atomicSQL, ownerWindow = null) {
  const predicate = (reserve) =>
    ownerWindow ? ownerWindowPredicate(reserve, ownerWindow) : windowOpenPredicate(reserve);
  const reason = ownerWindow
    ? `owner-ordered ${ownerWindow.id}: ${ownerWindow.ownerOrder}; migration ${file}; same certified freeze and 8s budget`
    : overrideReason(file);
  const prelude = `
SET LOCAL ca.break_window_migration_override = '${reason.replaceAll("'", "''")}';
SET LOCAL lock_timeout = '${WINDOW_LOCK_TIMEOUT_MS}ms';
SET LOCAL statement_timeout = '${WINDOW_STATEMENT_TIMEOUT_MS}ms';
SET LOCAL idle_in_transaction_session_timeout = '${TRANSACTION_BUDGET_SECONDS}s';
DO $ca_install_window_open$
BEGIN
  IF NOT ${predicate(START_RESERVE_SECONDS)} THEN
    RAISE EXCEPTION 'install_window_closed: the daily maintenance break is not in a confirmed freeze with ${START_RESERVE_SECONDS}s to spare; nothing was installed'
      USING ERRCODE = '55000';
  END IF;
END $ca_install_window_open$;
`;
  const close = `
DO $ca_install_window_close$
BEGIN
  IF clock_timestamp() - transaction_timestamp() > make_interval(secs => ${TRANSACTION_BUDGET_SECONDS}) THEN
    RAISE EXCEPTION 'install_window_budget_exceeded: the install took longer than ${TRANSACTION_BUDGET_SECONDS}s; rolled back'
      USING ERRCODE = '55000';
  END IF;
  IF NOT ${predicate(COMMIT_RESERVE_SECONDS)} THEN
    RAISE EXCEPTION 'install_window_closed_before_commit: fewer than ${COMMIT_RESERVE_SECONDS}s remained before the thaw; rolled back'
      USING ERRCODE = '55000';
  END IF;
END $ca_install_window_close$;
`;
  if (/\$ca_install_window_(open|close)\$/.test(atomicSQL))
    throw new Error('migration conflicts with the reserved window delimiters');
  const opened = atomicSQL.replace(/^([ \t]*BEGIN[ \t]*;)/im, (m) => m + prelude);
  if (opened === atomicSQL) throw new Error('window transaction has no initial BEGIN');
  const closed = opened.replace(/COMMIT\s*;\s*$/i, () => close + 'COMMIT;');
  if (closed === opened) throw new Error('window transaction has no final COMMIT');
  return closed;
}

/**
 * Daily windows near `at`: 04:00-04:05 America/Chicago, DST aware, the same
 * computation as server/src/maintenance/maintenanceSchedule.ts.
 */
const chicagoHour = new Intl.DateTimeFormat('en-US', {
  timeZone: MAINTENANCE_TIME_ZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});
const DAY_MS = 86_400_000;
export function dailyWindows(at) {
  const midnight = Math.floor(at / DAY_MS) * DAY_MS;
  const out = [];
  for (let day = -1; day <= 2; day++)
    for (const utcHour of [9, 10]) {
      const startsAt = midnight + day * DAY_MS + utcHour * 3_600_000;
      if (Number(chicagoHour.format(startsAt)) !== 4) continue;
      out.push({ startsAt, endsAt: startsAt + 5 * 60_000 });
    }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * The window this run serves: the next one that can still admit an install
 * (start + 300 - START_RESERVE seconds), if it begins within `horizonMs`.
 */
export function windowToServe(at, horizonMs = 3 * 3_600_000) {
  const lastStart = (w) => w.endsAt - START_RESERVE_SECONDS * 1000;
  return dailyWindows(at).find((w) => lastStart(w) > at && w.startsAt - at <= horizonMs) ?? null;
}
