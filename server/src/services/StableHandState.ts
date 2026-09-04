/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - the write side of the horse state
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `stable_hand_horse_state` was created on 2026-09-04 with every counter the
 * mutex needs - sits per game key, minutes played today, the two-hour window
 * that stops a horse buying straight back into a game it just left - and the
 * tagger filled in the sticky identity columns and nothing else. Every counter
 * stayed at its default forever, so `maySitOnKey` compared 0 against a cap of
 * 3-5 and always said yes, and `mayRebuyInSeat`'s window check was reading a
 * map nobody wrote to.
 *
 * This module is what writes them.
 *
 * ── ONE ROUND TRIP PER CYCLE, NOT ONE PER SEAT ─────────────────────────────
 *
 * The seeding cycle takes tens of seats in a pass. Incrementing a jsonb
 * counter per seat is tens of round trips inside a 30-second tick, so the
 * mutations are collected in memory, folded onto the book's own copy of the
 * state, and upserted as ONE array. The engine is a single writer, so a
 * read-modify-write is safe here in a way it would not be against a table two
 * processes touch.
 *
 * ── THE DATE IS PART OF EVERY WRITE ────────────────────────────────────────
 *
 * Every row carries the Chicago date its counters belong to, and a fold that
 * finds yesterday's date starts the counters from zero rather than adding to
 * them. Combined with the readers in StableHandTags - which return zero for a
 * stale date - the daily reset needs no scheduled job at all. See the note
 * over `countersAreToday`.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import type { HorseState } from './StableHandTags.js';

/**
 * How often minutes-played is accrued.
 *
 * The seeding cycle is 30 seconds and there are about a thousand horses, so
 * accruing every cycle would write the whole table twice a minute to move a
 * counter by 0.5. Five minutes is 1/100th of the smallest daily cap, which is
 * far finer than the cap needs, and it is one write every ten cycles.
 */
export const MINUTES_ACCRUAL_MS = 5 * 60_000;

export interface StateMutation {
  horseId: string;
  /** A cash seat was taken on this game key. */
  sitOnKey?: string;
  /** A seat on this game key was given up: open the two-hour window. */
  closedKey?: string;
  /** Minutes to add to the day's play. */
  addMinutes?: number;
  /** Set when a session begins, so the 50% commit cap has a baseline. */
  sessionStartBalance?: number;
}

/** The row shape written back to stable_hand_horse_state. */
export interface StateRow {
  horse_id: string;
  minutes_played_today: number;
  cash_sits_today: Record<string, number>;
  two_hour_window: Record<string, number>;
  session_start_balance: number | null;
  counters_reset_on: string;
}

/**
 * PURE. Fold a cycle's mutations onto the states we already hold and return
 * exactly the rows that changed.
 *
 * Rows that did not change are not returned, so a quiet cycle writes nothing.
 */
export function foldMutations(
  states: ReadonlyMap<string, HorseState>,
  mutations: readonly StateMutation[],
  todayKey: string,
  nowMs: number
): { rows: StateRow[]; next: Map<string, HorseState> } {
  const touched = new Map<string, HorseState>();

  const startOf = (horseId: string): HorseState => {
    const existing = touched.get(horseId) ?? states.get(horseId);
    const fresh: HorseState = existing
      ? { ...existing }
      : {
          horseId,
          restWeekday: null,
          dailyCapMinutes: null,
          minutesPlayedToday: 0,
          sessionStartBalance: null,
          cashSitsToday: {},
          twoHourWindow: {},
          countersResetOn: null,
        };
    /* A NEW DAY STARTS FROM ZERO. Folding onto yesterday's numbers is how a
       daily cap becomes a lifetime cap. */
    if (fresh.countersResetOn !== todayKey) {
      fresh.minutesPlayedToday = 0;
      fresh.cashSitsToday = {};
      /* The two-hour window is NOT cleared: it is a rolling two hours, not a
         daily allowance, and a horse that cashed out at 23:30 is still inside
         it at 00:30. Stale entries are dropped below instead. */
      fresh.countersResetOn = todayKey;
    } else {
      fresh.cashSitsToday = { ...fresh.cashSitsToday };
      fresh.twoHourWindow = { ...fresh.twoHourWindow };
    }
    return fresh;
  };

  for (const m of mutations) {
    const st = startOf(m.horseId);
    if (m.sitOnKey) {
      st.cashSitsToday = {
        ...st.cashSitsToday,
        [m.sitOnKey]: (st.cashSitsToday[m.sitOnKey] ?? 0) + 1,
      };
    }
    if (m.closedKey) {
      st.twoHourWindow = { ...st.twoHourWindow, [m.closedKey]: nowMs };
    }
    if (m.addMinutes && m.addMinutes > 0) {
      st.minutesPlayedToday = st.minutesPlayedToday + m.addMinutes;
    }
    if (m.sessionStartBalance !== undefined) {
      st.sessionStartBalance = m.sessionStartBalance;
    }
    touched.set(m.horseId, st);
  }

  const rows: StateRow[] = [];
  for (const [horseId, st] of touched) {
    /* Drop windows that have long expired so the column does not grow without
       bound: a horse plays many keys over months and every one of them would
       otherwise leave a permanent entry. */
    const window: Record<string, number> = {};
    for (const [k, at] of Object.entries(st.twoHourWindow)) {
      if (nowMs - at < 24 * 60 * 60_000) window[k] = at;
    }
    st.twoHourWindow = window;
    rows.push({
      horse_id: horseId,
      minutes_played_today: Math.round(st.minutesPlayedToday),
      cash_sits_today: st.cashSitsToday,
      two_hour_window: window,
      session_start_balance: st.sessionStartBalance,
      counters_reset_on: todayKey,
    });
  }
  return { rows, next: touched };
}

/**
 * Write the folded rows, in chunks, and fold them back into the book's own map
 * so the next cycle sees them without waiting for the cache to expire.
 *
 * Returns how many rows were written. A failure is reported and returns 0: a
 * counter that did not persist means one extra sit is allowed, which is a far
 * cheaper failure than a cycle that throws.
 */
export async function writeStateRows(rows: readonly StateRow[], chunkSize = 250): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await (supabase as any)
      .from('stable_hand_horse_state')
      .upsert(chunk, { onConflict: 'horse_id' });
    if (error) {
      reportError(error, 'StableHandState.writeStateRows');
      continue;
    }
    written += chunk.length;
  }
  return written;
}
