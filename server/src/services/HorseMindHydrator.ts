/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE MIND HYDRATOR — Boot-Time Memory Restoration (V6 — 2026-07-24)
 * ═══════════════════════════════════════════════════════════════════════════════
 * HorseMind's opponent stats (VPIP / PFR / 3-bet / AF / fold-vs-aggression)
 * live in process memory, so every deploy or restart used to wipe them and
 * the horses re-learned every opponent from zero.
 *
 * This service replays the last 24 hours of REAL hand history through
 * HorseMind.observe() at boot. The persisted `hand_history.actions` arrays
 * are the exact ActionRecord objects the live engine produced (seat, userId,
 * action, amount, timestamp, stage, isFullRaise), so the replay rebuilds the
 * same statistics the engine would have accumulated had it never restarted.
 *
 * Design constraints honored:
 *  - Non-blocking: fired after boot, never delays table startup. A horse that
 *    acts mid-hydration simply has fewer reads for a few hundred ms — the
 *    exact behavior of the pre-V6 engine, so this is strictly an upgrade.
 *  - Bounded: row limit + HorseMind's own memory caps (4000 players / 60k
 *    action keys / 20k hand flags). Flag-generation swaps during a one-pass
 *    replay are harmless because each historical hand is observed exactly
 *    once.
 *  - Fail-safe: any error is reported and swallowed — hydration can never
 *    take the engine down.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { HorseMind } from '../engine/HorseMind.js';
import { reportError } from './errorReporter.js';
import { POSTGREST_PAGE } from './supabase/pagination.js';

// V11 (Dan 2026-08-22): deeper memory — the horses keep improving the more
// they play, and a restart should cost as little of that learning as
// possible. 72h/12000 hands keeps replay under a few seconds while tripling
// the retained sample per opponent (HorseMind's own caps still bound memory).
const HYDRATION_WINDOW_HOURS = 72;
const HYDRATION_MAX_HANDS = 12000;

type HistoryCursor = { created_at: string; id: string };
const HISTORY_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HISTORY_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/;
/** Keep PostgreSQL microseconds: Date.parse alone collapses distinct cursors. */
function historyTime(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const match = HISTORY_TIME.exec(value),
    milliseconds = Date.parse(value);
  if (!match || !Number.isSafeInteger(milliseconds)) return null;
  return BigInt(milliseconds) * 1000n + BigInt((match[1] ?? '').padEnd(6, '0').slice(3));
}

function precedes(row: HistoryCursor, cursor: HistoryCursor): boolean {
  const time = historyTime(row.created_at)!,
    prior = historyTime(cursor.created_at)!;
  return time < prior || (time === prior && row.id < cursor.id);
}

/**
 * @param sinceIso V12: when the DB hydration already restored the flushed
 * stats, only the un-flushed tail needs replaying — pass the last flush
 * timestamp. Clamped to the full window so a bogus future/ancient value can
 * never replay more than the pre-V12 behavior did.
 */
export async function hydrateHorseMind(sinceIso?: string | null): Promise<void> {
  try {
    const t0 = Date.now();
    const windowStart = new Date(Date.now() - HYDRATION_WINDOW_HOURS * 3600 * 1000).toISOString();
    const suppliedTime = historyTime(sinceIso),
      floor = historyTime(windowStart)!;
    const ceiling = BigInt(t0) * 1000n;
    const since =
      suppliedTime !== null && suppliedTime >= floor && suppliedTime <= ceiling
        ? sinceIso!
        : windowStart;
    const sinceTime = historyTime(since)!;
    const through = new Date(t0).toISOString();

    /* PAGED, NEWEST FIRST (2026-09-09). This was one select with
       `.limit(12000)`, and PostgREST caps every select at db-max-rows (1,000)
       without a word - so the replay was the OLDEST thousand hands of the
       window, ascending from seventy-two hours ago, out of the 1.56 million
       the window holds. Keyset on (created_at, id), descending, up to the cap, then
       replayed in the order they were dealt. A short read replays what it
       read: fewer hands is the pre-V6 engine, not a wrong engine. */
    type HandRow = HistoryCursor & { actions: unknown };
    const newestFirst: HandRow[] = [];
    let cursor: HistoryCursor | null = null;
    while (newestFirst.length < HYDRATION_MAX_HANDS) {
      const want = Math.min(POSTGREST_PAGE, HYDRATION_MAX_HANDS - newestFirst.length);
      let q = supabase
        .from('hand_history')
        .select('id, actions, created_at')
        .gt('created_at', since)
        .lte('created_at', through)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(want);
      if (cursor)
        q = q.or(
          `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
        );
      const { data: rows, error } = await q;
      if (error) {
        reportError(
          new Error(error.message || 'hydration query failed'),
          'HorseMindHydrator.query'
        );
        break; // replay what was read
      }
      const got = (rows ?? []) as HandRow[];
      // Validate the entire page before replay. A repeated or malformed cursor
      // must not duplicate evidence or widen the next database filter.
      let previous = cursor;
      let valid = Array.isArray(got) && got.length <= want;
      if (valid)
        for (const row of got) {
          const at = row && historyTime(row.created_at);
          if (
            !row ||
            typeof row.id !== 'string' ||
            !HISTORY_UUID.test(row.id) ||
            at === null ||
            at <= sinceTime ||
            at > ceiling ||
            (previous && !precedes(row, previous))
          ) {
            valid = false;
            break;
          }
          previous = row;
        }
      if (!valid) {
        reportError(
          new Error('history page identity or ordering invalid'),
          'HorseMindHydrator.page'
        );
        break;
      }
      newestFirst.push(...got);
      if (got.length < want) break;
      const last = got[got.length - 1];
      if (!last) break;
      cursor = { created_at: last.created_at, id: last.id };
    }
    const data = newestFirst.reverse();
    if (data.length === 0) {
      console.log('[HorseMind] Hydration: no recent hand history to replay');
      return;
    }

    let hands = 0;
    let actions = 0;
    for (const row of data) {
      const a = (row as { actions?: unknown }).actions;
      if (!Array.isArray(a) || a.length === 0) continue;
      try {
        HorseMind.observe(a as never, []);
        hands++;
        actions += a.length;
      } catch {
        /* one malformed historical row must never stop the replay */
      }
    }

    console.log(
      `[HorseMind] Hydrated opponent memory from ${hands} hands / ${actions} actions ` +
        `(last ${HYDRATION_WINDOW_HOURS}h) in ${Date.now() - t0}ms`
    );
  } catch (err) {
    reportError(err, 'HorseMindHydrator.failed');
  }
}
