/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHEN THE RAIL IS ALLOWED TO MAKE A NOISE (2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The audit promised a chime for the overlay announcement and then shipped four
 * phases without one, which was the right order: a sound is the easiest thing
 * on this strip to get wrong. A bar that beeps is a bar that gets muted, and a
 * player who mutes the app to silence an advertisement also mutes their own
 * turn alert. The cost of a bad chime is not annoyance, it is a player timing
 * out on a hand.
 *
 * So the rules here are narrow on purpose, and all four of them matter:
 *
 *   ONLY OVERLAYS. An overlay guarantee is the one announcement on this rail
 *     that is worth money to the player: the club has promised a prize pool
 *     larger than the entries will cover. Tournaments starting soon, tables
 *     opening, results and operator notices all stay silent. They are useful;
 *     they are not worth a sound.
 *
 *   ONCE PER ANNOUNCEMENT, PER TAB. The lane re-computes on every poll and the
 *     container remounts on every route change, so "the overlay is the top
 *     item" is true continuously for as long as the overlay is live. The event
 *     worth hearing is its ARRIVAL, which happens once.
 *
 *   NEVER THE FIRST STRIP A TAB SHOWS. Arriving on a page that immediately
 *     beeps at you is a different experience from an announcement arriving
 *     while you sit there, and only the second one is news. (A cold load also
 *     has no user gesture yet, so the AudioContext is suspended and the tone
 *     would usually be dropped anyway - this makes that deliberate rather than
 *     accidental.)
 *
 *   THE PLAYER'S SWITCH WINS. `soundService.isEnabled()` consults the shared
 *     gate, so either sound toggle being off silences this like everything
 *     else. Asking first also means a muted tab never constructs or resumes an
 *     AudioContext on account of the ticker.
 *
 * The module keeps its memory in module scope rather than in the component,
 * because the component unmounts on every navigation and a memory that resets
 * with it would chime again on each one - the exact defect this file exists to
 * prevent.
 */

import { soundService } from '../../services/SoundService';
import type { TickerKind } from './tickerMessages';

/** The only kind that earns a sound. */
const AUDIBLE: TickerKind = 'overlays';

/** Announcement ids already chimed in this tab. */
const chimed = new Set<string>();

/** Bounded for the same reason the telemetry seen-set is: a tab can live for days. */
const MEMORY_LIMIT = 200;

/** False until the rail has announced anything at all in this tab. */
let hasSpokenBefore = false;

/**
 * Tell the chime what the rail is currently saying.
 *
 * Call this once per announcement - the same effect that reports `shown` to
 * telemetry is the right place, because it is already keyed on the id and
 * already runs outside the render body.
 *
 * @returns true when a tone was actually requested, for the tests and for
 *          nobody else. The caller has no use for it.
 */
export function announce(kind: TickerKind, id: string): boolean {
  const first = !hasSpokenBefore;
  hasSpokenBefore = true;

  if (kind !== AUDIBLE) return false;
  if (chimed.has(id)) return false;

  /* Remember it either way. A first-strip overlay that was deliberately silent
     must not chime later when the lane re-computes and offers it again. */
  if (chimed.size >= MEMORY_LIMIT) chimed.clear();
  chimed.add(id);

  if (first) return false;
  if (!soundService.isEnabled()) return false;

  soundService.playRailAlert();
  return true;
}

/** Test seam. Nothing in `src/` calls this. */
export function resetTickerChime(): void {
  chimed.clear();
  hasSpokenBefore = false;
}
