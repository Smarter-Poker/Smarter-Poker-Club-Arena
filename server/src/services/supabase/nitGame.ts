/**
 * NIT GAME — the VPIP rules, read from the one place VPIP already lives.
 *
 * Dan 2026-08-25: "VPIP NEEDS TO BE BUILT OUT AND ADDED INTO THE TABLE
 * CREATIONS ... FULLY BUILT OUT AND IMPLEMENTED FOR ALL CASH GAMES."
 *
 * `tables.nit_game`, `maintain_percent_min`, `maintain_hands` and
 * `career_percent_min` were four columns the creation page wrote and NOTHING
 * read. The NIT Game toggle's own tooltip says "Penalty for tight play" and
 * there was no penalty.
 *
 * WHY THIS IS A QUERY AND NOT AN ENGINE. `ca_hand_facts` already stores one
 * row per player per hand with a `vpip` boolean, derived by deriveFlowFlags()
 * from the action log — the same definition the seat HUD shows the player.
 * Tracking VPIP a second time in engine memory would be a second answer to the
 * same question, and the two would disagree the first time a process restarted
 * mid-session. So the rule is `fn_nit_evictions`, and this module is the thin
 * call to it.
 *
 * The eviction itself is not special: it feeds the SAME machinery the dealing
 * loop already uses for sit-out and away-blind evictions (atomicCashout, then
 * unregister from the four per-table engines, with a `seat_left` event).
 */
import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

export interface NitEviction {
  userId: string;
  vpip: number;
  required: number;
  hands: number;
}

/**
 * Everyone the nit rule says should be stood up at this table right now.
 *
 * Returns an EMPTY ARRAY on any failure. A stats query that cannot answer must
 * never remove a player from a live game: the cost of a missed eviction is one
 * more tight orbit, and the cost of a wrong one is a player thrown out of a
 * hand they were entitled to play.
 *
 * HORSES ARE PLAYERS (Dan 2026-08-27). This comment used to read "horses are
 * excluded inside the function", and by then that was already false: the
 * horse-only predicate had been removed from fn_nit_evictions the same day.
 * What was still true, and worse, is that the fix could not bite - fn_nit_check
 * judges VPIP from ca_hand_facts, and handFacts.ts wrote humans only, so a
 * horse's sample was permanently zero and every horse cleared the floor for
 * ever. Horses get fact rows at NIT tables now, so the rule and its evidence
 * cover the same seats.
 *
 * Both rules still fail open below their sample floor - a player with no
 * history has a VPIP of 0/0, not 0%.
 */
export async function collectNitEvictions(tableId: string): Promise<NitEviction[]> {
  try {
    const { data, error } = await supabase.rpc('fn_nit_evictions', { p_table_id: tableId });
    if (error) {
      reportError(error, 'nitGame.collectNitEvictions', { tableId });
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        userId: String(r.user_id),
        vpip: Number(r.vpip) || 0,
        required: Number(r.required) || 0,
        hands: Number(r.hands) || 0,
      }))
      .filter((r) => r.userId && r.userId !== 'undefined');
  } catch (err) {
    reportError(err, 'nitGame.collectNitEvictions.unhandled', { tableId });
    return [];
  }
}
