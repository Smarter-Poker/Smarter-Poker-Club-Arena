/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE MIND HYDRATOR — Boot-Time Memory Restoration (V6 — 2026-07-24)
 * ═══════════════════════════════════════════════════════════════════════════════
 * HorseMind's opponent stats (VPIP / PFR / 3-bet / AF / fold-vs-aggression)
 * live in process memory, so every deploy or restart used to wipe them and
 * the horses re-learned every opponent from zero.
 *
 * This service attempts bounded replay of the last 72 hours of retained hand history through
 * HorseMind.observe() at boot. Only complete controller-compatible actions
 * with the stored table UUID and safe allocated global hand number enter the
 * new basic-read namespace. Missing identity is not reconstructed from time.
 * This is a bounded pooled replay, not an equivalent scoped/deep checkpoint;
 * aggregate persistence timestamps still cannot prove per-row replay coverage.
 *
 * Design constraints honored:
 *  - The worker awaits hydration before READY; failures leave incomplete reads.
 *  - Existing row limits and HorseMind's pre-call eviction thresholds remain
 *    unchanged (4000 players / 60k action keys / 20k hand flags). Evicted keys
 *    and prior aggregate counters cannot certify durable replay coverage.
 *  - Query/page errors are reported; unusable rows and per-hand consumer
 *    failures are skipped. None establishes complete restoration.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { HorseMind } from '../engine/HorseMind.js';
import { horseMindHandFromHistory } from '../engine/HorseMindHandIdentity.js';
import { completedHandActionsForMind } from '../engine/horseDecision/completedHandActions.js';
import { reportError } from './errorReporter.js';
import { POSTGREST_PAGE } from './supabase/pagination.js';

// V11 (Dan 2026-08-22): deeper memory — the horses keep improving the more
// they play, and a restart should cost as little of that learning as
// possible. The existing 72h/12000-hand limits remain unchanged; this source
// change does not establish a replay latency or complete-population guarantee.
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
       replayed oldest selected (created_at,id) first. This is persistence
       ordering, not proof of deal order or a complete window. */
    type HandRow = HistoryCursor & { actions: unknown; table_id?: unknown; hand_number?: unknown };
    const newestFirst: HandRow[] = [];
    let cursor: HistoryCursor | null = null;
    while (newestFirst.length < HYDRATION_MAX_HANDS) {
      const want = Math.min(POSTGREST_PAGE, HYDRATION_MAX_HANDS - newestFirst.length);
      let q = supabase
        .from('hand_history')
        .select('id, table_id, hand_number, actions, created_at')
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
        const identity = horseMindHandFromHistory(row);
        const projected = completedHandActionsForMind(a, null);
        // Neither old low-number rows nor missing coordinates can be upgraded
        // from a timestamp. Skip this new basic ingestion explicitly.
        if (!identity || !projected) continue;
        const previousScope = HorseMind.currentScope();
        HorseMind.setDecisionScope(null);
        try {
          HorseMind.observe(projected.actions, [], identity);
        } finally {
          HorseMind.setDecisionScope(previousScope);
        }
        hands++;
        actions += projected.actions.length;
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
