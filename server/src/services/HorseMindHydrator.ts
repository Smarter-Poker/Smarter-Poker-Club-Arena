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

const HYDRATION_WINDOW_HOURS = 24;
const HYDRATION_MAX_HANDS = 4000;

export async function hydrateHorseMind(): Promise<void> {
  try {
    const t0 = Date.now();
    const since = new Date(Date.now() - HYDRATION_WINDOW_HOURS * 3600 * 1000).toISOString();

    const { data, error } = await supabase
      .from('hand_history')
      .select('actions')
      .gt('created_at', since)
      .order('created_at', { ascending: true })
      .limit(HYDRATION_MAX_HANDS);

    if (error) {
      reportError(new Error(error.message || 'hydration query failed'), 'HorseMindHydrator.query');
      return;
    }
    if (!data || data.length === 0) {
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
