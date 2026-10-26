/**
 * A MERGED MIGRATION IS DISPATCHED BY ITS MERGER (2026-10-25).
 *
 * apply-merged-migration.yml is dispatch-only by design: "THE READER is the
 * person who dispatches it". The autopilot merges pull requests itself (it arms
 * protected squash auto-merge, and GitHub completes the merge as the autopilot
 * App), so for an automatically merged PR there was no person, and nothing
 * dispatched the applier. PR #7971 merged at 01:48 UTC on 2026-10-25 with
 * 20261024231549_lightning_voided_hand_returns_its_blind_stamps.sql and the
 * file sat uninstalled until an agent dispatched it by hand at 02:30 UTC.
 *
 * agent-autopilot.yml now reacts to its own merge (the native
 * pull_request_target `closed` event, merged by the autopilot App) and sends
 * one repository dispatch per migration file the PR added. This module is the
 * pure half: which files, which are skipped and why, and the earliest instant
 * at which the applier will admit them, so the merger waits once, bounded,
 * instead of dispatching into a refusal that leaves the file uninstalled.
 *
 * It sends nothing and reads no network. The shell half is
 * .github/scripts/dispatch-merged-migrations.sh.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowDeclaration } from './maintenance-window-migrations.mjs';
import { splitConcurrentPreamble } from './migration-concurrent-preamble.mjs';

/** The applier's own filename shape (apply-recorded-migration.mjs). */
export const MIGRATION_PATH = /^supabase\/migrations\/(\d{14}_[a-z0-9_]+\.sql)$/;

/**
 * The applier refuses at minute-of-hour >= 50 or <= 3 UTC
 * (apply-recorded-migration.mjs: `minute >= 50 || minute <= 3`), so the first
 * minute it admits is :04.
 */
export const FIRST_ADMITTED_MINUTE = 4;
export const WINDOW_OPENS_MINUTE = 50;
/** apply-recorded-migration.mjs PREAMBLE_MINUTES_NEEDED. */
export const PREAMBLE_MINUTES_NEEDED = 12;
/**
 * Headroom between the dispatch and the applier reading the clock: runner
 * start-up (~30 s measured) plus the applier's own one-at-a-time queue, about
 * a minute per earlier file (02:23-02:25 UTC 2026-10-25: 30-60 s per run).
 */
export const BASE_SLACK_MINUTES = 2;
export const PER_FILE_SLACK_MINUTES = 1;
/**
 * The daily engine maintenance (CLAUDE.md 13): 03:58 announcement, 04:00-04:05
 * break, then its thaw. 04:00 Chicago is always a whole UTC hour, so the fixed
 * :50-:03 minutes already cover 03:50-04:03; the database's dynamic refusal
 * (fn_ca_break_window_refuses_migrations) holds DDL on through the break and
 * its durable release, so the merger also stays clear until 04:10 Chicago.
 */
export const DAILY_GUARD_CHICAGO = { from: [3, 50], until: [4, 10] };
/**
 * The one bounded wait the merger may spend (job timeout 30 minutes). It
 * covers every ordinary file at any minute of the day: the worst hourly case
 * is a merge at :49 waiting to :04 (15 min), the worst daily case a merge at
 * 03:50 Chicago waiting to 04:10 (20 min). Only a CONCURRENTLY-preamble file
 * merged late in the hour can exceed it, and that is refused out loud.
 */
export const WAIT_BUDGET_MINUTES = 22;

const chicago = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function chicagoMinuteOfDay(ms) {
  const parts = Object.fromEntries(chicago.formatToParts(ms).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
const inDailyGuard = (ms) => {
  const m = chicagoMinuteOfDay(ms);
  const [fh, fm] = DAILY_GUARD_CHICAGO.from;
  const [uh, um] = DAILY_GUARD_CHICAGO.until;
  return m >= fh * 60 + fm && m < uh * 60 + um;
};

/** Minutes needed before :50 UTC for `count` files, preamble or not. */
export function minutesNeeded(count, preamble) {
  return (
    (preamble ? PREAMBLE_MINUTES_NEEDED : 0) + BASE_SLACK_MINUTES + PER_FILE_SLACK_MINUTES * count
  );
}

/** True when the applier will admit every file dispatched at `ms`. */
export function admissibleAt(ms, count, preamble) {
  const d = new Date(ms);
  const minute = d.getUTCMinutes() + d.getUTCSeconds() / 60;
  if (minute < FIRST_ADMITTED_MINUTE) return false;
  if (WINDOW_OPENS_MINUTE - minute < minutesNeeded(count, preamble)) return false;
  return !inDailyGuard(ms);
}

/**
 * The earliest instant at or after `now` (15 s resolution, two hours ahead)
 * at which a dispatch of `count` files is admitted, or null if none is.
 */
export function earliestDispatch(now, count, preamble) {
  if (count === 0) return now;
  for (let t = now; t <= now + 2 * 3_600_000; t += 15_000) {
    if (admissibleAt(t, count, preamble)) return t;
  }
  return null;
}

/**
 * Classify the files a merged PR added.
 *
 * @param {string[]} added   PR file paths whose status is "added"
 * @param {(name: string) => string | null} readSql  file text on main, null if absent
 * @param {number} now       epoch ms
 */
export function planDispatch(added, readSql, now) {
  const names = [...new Set(added.map((p) => MIGRATION_PATH.exec(p)?.[1]).filter(Boolean))].sort();
  const dispatch = [];
  const windowQueued = [];
  const notOnMain = [];
  const malformed = [];
  let preamble = false;
  for (const name of names) {
    const sql = readSql(name);
    if (sql === null) {
      notOnMain.push(name);
      continue;
    }
    let declared;
    try {
      declared = windowDeclaration(sql);
    } catch (e) {
      malformed.push({ name, reason: e.message });
      continue;
    }
    if (declared === 'daily-maintenance') {
      windowQueued.push(name);
      continue;
    }
    const shape = splitConcurrentPreamble(sql);
    if (shape.ok && shape.indexes.length > 0) preamble = true;
    dispatch.push(name);
  }
  const at = earliestDispatch(now, dispatch.length, preamble);
  const waitSeconds = at === null ? null : Math.ceil((at - now) / 1000);
  return {
    dispatch,
    windowQueued,
    notOnMain,
    malformed,
    preamble,
    dispatchAt: at === null ? null : new Date(at).toISOString(),
    waitSeconds,
    withinBudget: waitSeconds !== null && waitSeconds <= WAIT_BUDGET_MINUTES * 60,
  };
}

// CLI: node scripts/ci/merged-migration-dispatch.mjs plan <added-paths-file> [now-ms]
//      node scripts/ci/merged-migration-dispatch.mjs admitted <count> <preamble 0|1> [now-ms]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b, c] = process.argv.slice(2);
  const dir = join(process.cwd(), 'supabase', 'migrations');
  if (cmd === 'plan') {
    const added = readFileSync(a, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const now = b ? Number(b) : Date.now();
    const readSql = (name) => {
      const p = join(dir, name);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    };
    process.stdout.write(JSON.stringify(planDispatch(added, readSql, now)) + '\n');
  } else if (cmd === 'admitted') {
    const now = c ? Number(c) : Date.now();
    process.exit(admissibleAt(now, Number(a), b === '1') ? 0 : 1);
  } else {
    console.error('usage: merged-migration-dispatch.mjs plan <file> [now] | admitted <count> <0|1> [now]');
    process.exit(2);
  }
}
