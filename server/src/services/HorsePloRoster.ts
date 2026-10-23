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
 * Every PLO variant (plo4, plo5, plo6, plo8, any later plo*) is gated at CASH
 * tables. A horse not on the list is never offered a PLO cash seat, and one
 * already sitting at a PLO cash table is walked out at the end of the hand by
 * HorseSessionRotator. Tournaments are open to every horse (Dan 2026-10-23
 * 11:06: "THEY CAN PLAY TOURNAMENTS, JUST NOT CASH GAMES.").
 *
 * The same read carries `ca_horse_active_roster`, the 45 horses that are the
 * only ones to sit at cash at all (`cashRosterAllows`).
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
/** ca_horse_active_roster: the only horses that sit at CASH (Dan 2026-10-23). */
let cashRoster: Set<string> | null = null;
/**
 * ca_horse_roster_exempt_clubs: clubs whose cash tables are outside both
 * roster rules (Dan 2026-10-23: "EXEMPT LIGHTNING PILOT"). Kept across a
 * failed read; empty until the first good one.
 */
let exemptClubs: Set<string> = new Set();
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
    const cash = await supabase.from('ca_horse_active_roster').select('horse_id').limit(5000);
    if (cash.error || !Array.isArray(cash.data)) {
      reportError(
        new Error(`[HorsePloRoster] cash roster read failed: ${cash.error?.message ?? 'no rows'}`),
        'HorsePloRoster.cash_read_failed'
      );
      return;
    }
    const exempt = await supabase
      .from('ca_horse_roster_exempt_clubs')
      .select('club_id')
      .limit(1000);
    if (!exempt.error && Array.isArray(exempt.data)) {
      exemptClubs = new Set(
        exempt.data
          .map((r: { club_id?: unknown }) => (typeof r.club_id === 'string' ? r.club_id : ''))
          .filter((id: string) => id.length > 0)
      );
    } else {
      reportError(
        new Error(
          `[HorsePloRoster] exempt club read failed: ${exempt.error?.message ?? 'no rows'}`
        ),
        'HorsePloRoster.exempt_read_failed'
      );
    }
    roster = new Set(data.map((r: { horse_id: string }) => String(r.horse_id)));
    // The refresh never commits an empty roster, so zero rows is a read we
    // cannot trust, not "nobody plays cash": keep no verdict.
    const cashIds = cash.data
      .map((r: { horse_id?: unknown }) => (typeof r.horse_id === 'string' ? r.horse_id : ''))
      .filter((id: string) => id.length > 0);
    cashRoster = cashIds.length > 0 ? new Set(cashIds) : null;
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
 * THE LOW STAKES ARE OPEN TO EVERY HORSE (Dan 2026-10-23 12:59: "all horses
 * can play the lower stakes plo games under .10-.25 and .25-.50. make sure
 * thats enabled"). The PLO roster gates 0.50/1 and up only; a PLO cash table
 * whose big blind is 0.50 or less is open to every horse on the cash roster.
 * An unknown big blind is NOT open (the roster decides), so a missing read
 * never widens the gate. Mirrored in `fn_ca_horse_roster_seat_guard`.
 */
export const PLO_OPEN_MAX_BIG_BLIND = 0.5;

export function isOpenStakePlo(bigBlind: unknown): boolean {
  const bb = Number(bigBlind);
  return Number.isFinite(bb) && bb > 0 && bb <= PLO_OPEN_MAX_BIG_BLIND;
}

/**
 * May this horse play THIS variant at THIS big blind?
 *   true      - not a PLO variant, a PLO table at 0.50 big blind or less,
 *               or the horse is on the PLO roster
 *   false     - a PLO variant and the horse is not on the roster
 *   undefined - a PLO variant and no roster has ever been read (callers: not allowed)
 */
export function ploRosterAllows(
  horseId: string,
  variant: unknown,
  bigBlind?: unknown
): boolean | undefined {
  if (!isPloVariant(variant)) return true;
  if (isOpenStakePlo(bigBlind)) return true;
  if (!roster) return undefined;
  return roster.has(horseId);
}

/**
 * May this horse sit at a CASH table at all? Dan 2026-10-23: "THEY CAN PLAY
 * TOURNAMENTS, JUST NOT CASH GAMES." Only the 45-horse active roster plays
 * cash; every horse plays tournaments. `undefined` before any good read (the
 * callers keep their own rule; the database seat door is the backstop).
 */
export function cashRosterAllows(horseId: string): boolean | undefined {
  if (!cashRoster) return undefined;
  return cashRoster.has(horseId);
}

/**
 * Is this club's cash floor outside the roster rules? The Lightning private
 * pilot is: any of its horses sits at its tables, PLO included.
 */
export function rosterExemptClub(clubId: unknown): boolean {
  return typeof clubId === 'string' && exemptClubs.has(clubId);
}

/** Test seam for the exempt clubs. */
export function __setRosterExemptClubsForTest(ids: string[]): void {
  exemptClubs = new Set(ids);
}

/** Test seam for the cash roster. */
export function __setCashRosterForTest(ids: string[] | null): void {
  cashRoster = ids ? new Set(ids) : null;
}

/** Test seam. */
export function __setPloRosterForTest(ids: string[] | null): void {
  roster = ids ? new Set(ids) : null;
  loadedAt = ids ? Date.now() : 0;
}
