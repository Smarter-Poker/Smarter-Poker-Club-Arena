/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PLO ROSTER - only horses that have shown a profit at PLO play Omaha
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-23: "REDUCE THE AMOUNT OF HORSES THAT CAN PLAY PLO, ONLY ALLOW
 * THE TOP PERFORMING HORSES PLAY PLO. KEEP IT UNDER 35-50 TOTAL HORSES AT ANY
 * TIME FOR ALL GAME TYPES." and then: "YOU CAN OPEN BACK UP 1-2 PLO BUT ONLY
 * ALLOW THE HORSES THAT HAVE SHOWN TO BE PROFITABLE PLAYING PLO PLAY THOSE
 * GAMES."
 *
 * The database owns the choice. `fn_ca_horse_roster_refresh` (migration
 * 20261023072007, daily at 04:15 Chicago) keeps 45 horses active, benches the
 * rest (horse_status 'disabled'), and writes into `ca_horse_plo_roster` only
 * the horses with 2,000+ PLO cash hands in 30 days and a net profit at PLO.
 * This module is the engine's read of that list.
 *
 * Every PLO variant (plo4, plo5, plo6, plo8, any later plo*) is gated, in cash
 * and in tournaments. A horse not on the list is never offered a PLO seat or
 * entry, and a horse already sitting at a PLO cash table is walked out at the
 * end of the hand by HorseSessionRotator.
 *
 * FAILING CLOSED FOR PLO ONLY: the last good list is kept across failed reads.
 * Before any good read, `ploRosterAllows` answers `undefined` for a PLO
 * variant and the callers treat that as "not allowed" - Dan's rule is that
 * only proven PLO winners sit, so an unreadable list seats nobody at PLO
 * rather than everybody. Non-PLO variants are never affected by this module.
 *
 * NEVER refer to the horses as "bots" - they are HORSES only.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

export const PLO_ROSTER_TTL_MS = 60_000;

let roster: Set<string> | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/** Is this game variant (or tournament game_type such as 'PLO4') in the Omaha family? */
export function isPloVariant(variant: unknown): boolean {
  return typeof variant === 'string' && variant.trim().toLowerCase().startsWith('plo');
}

async function load(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('ca_horse_plo_roster')
      .select('horse_id')
      .limit(5000);
    if (error || !Array.isArray(data)) {
      reportError(
        new Error(`[HorsePloRoster] roster read failed: ${error?.message ?? 'no rows'}`),
        'HorsePloRoster.read_failed'
      );
      return;
    }
    roster = new Set(data.map((r: { horse_id: string }) => String(r.horse_id)));
    loadedAt = Date.now();
  } catch (err) {
    reportError(err, 'HorsePloRoster.read_threw');
  }
}

/** Refresh the cached roster when it is older than the TTL. Never throws. */
export async function refreshPloRoster(force = false): Promise<void> {
  if (!force && roster && Date.now() - loadedAt < PLO_ROSTER_TTL_MS) return;
  if (!inflight) {
    inflight = load().finally(() => {
      inflight = null;
    });
  }
  await inflight;
}

/**
 * May this horse play THIS variant?
 *   true      - not a PLO variant, or the horse is on the PLO roster
 *   false     - a PLO variant and the horse is not on the roster
 *   undefined - a PLO variant and no roster has ever been read (callers: not allowed)
 */
export function ploRosterAllows(horseId: string, variant: unknown): boolean | undefined {
  if (!isPloVariant(variant)) return true;
  if (!roster) return undefined;
  return roster.has(horseId);
}

/** Test seam. */
export function __setPloRosterForTest(ids: string[] | null): void {
  roster = ids ? new Set(ids) : null;
  loadedAt = ids ? Date.now() : 0;
}
