/** Owner October 27: the selected half plays Club Arena cash; all registered
 * horses remain candidates for Diamond cash and tournaments. */

import { parseTableArenaIdentity } from '../domain/ArenaContext.js';
import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import type { PloPerformance } from './HorseMadnessSelection.js';

export const PLO_ROSTER_TTL_MS = 60_000;

let roster: Set<string> | null = null;
/** ca_horse_active_roster selects Club Arena cash candidates only. */
let cashRoster: Set<string> | null = null;
/**
 * ca_horse_roster_exempt_clubs: clubs whose cash tables are outside both
 * roster rules (Dan 2026-10-23: "EXEMPT LIGHTNING PILOT"). Kept across a
 * failed read; empty until the first good one.
 */
let exemptClubs: Set<string> = new Set();
let loadedAt = 0;
let inflight: Promise<void> | null = null;
let performance: ReadonlyMap<string, PloPerformance> = new Map();
let performanceLoadedAt = 0;
const NO_PERFORMANCE: ReadonlyMap<string, PloPerformance> = new Map();

/** Advisory only. Unknown/expired evidence falls back to the existing draw. */
export function getPloPerformance(): ReadonlyMap<string, PloPerformance> {
  return performanceLoadedAt > 0 && Date.now() - performanceLoadedAt < PLO_ROSTER_TTL_MS
    ? performance
    : NO_PERFORMANCE;
}

/** Is this game variant (or tournament game_type such as 'PLO4') in the Omaha family? */
export function isPloVariant(variant: unknown): boolean {
  return typeof variant === 'string' && variant.trim().toLowerCase().startsWith('plo');
}

async function load(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('ca_horse_plo_roster')
      .select('horse_id,plo_hands,plo_bb100')
      .limit(5000);
    if (error || !Array.isArray(data)) {
      reportError(
        new Error(`[HorsePloRoster] roster read failed: ${error?.message ?? 'no rows'}`),
        'HorsePloRoster.read_failed'
      );
    }
    performance = new Map();
    performanceLoadedAt = 0;
    if (!error && Array.isArray(data)) {
      const measured = new Map<string, PloPerformance>();
      for (const row of data) {
        if (typeof row.horse_id !== 'string' || row.plo_hands == null || row.plo_bb100 == null)
          continue;
        const hands = Number(row.plo_hands),
          bb100 = Number(row.plo_bb100);
        if (Number.isFinite(hands) && hands > 0 && Number.isFinite(bb100))
          measured.set(row.horse_id, { hands, bb100 });
      }
      performance = measured;
      performanceLoadedAt = Date.now();
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
    roster = new Set(
      (Array.isArray(data) ? data : []).map((r: { horse_id: string }) => String(r.horse_id))
    );
    // The refresh never commits an empty roster, so zero rows is a read we
    // cannot trust, not "nobody plays cash": keep no verdict.
    const cashIds = cash.data
      .map((r: { horse_id?: unknown }) => (typeof r.horse_id === 'string' ? r.horse_id : ''))
      .filter((id: string) => id.length > 0);
    cashRoster = cashIds.length > 0 ? new Set(cashIds) : null;
    loadedAt = Date.now();
  } catch (err) {
    performance = NO_PERFORMANCE;
    performanceLoadedAt = 0;
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

/** Historical API retained for callers. PLO profit history never denies a
 * cash seat; the cash roster and normal bankroll/admission checks decide. */
export function ploRosterAllows(_horseId: string, _variant: unknown, _bigBlind?: unknown): boolean {
  return true;
}

/** Unknown membership blocks new admission in callers but does not evict existing seats. */
export function cashRosterAllows(
  horseId: string,
  table?: { club_id?: unknown; union_id?: unknown; arena?: unknown }
): boolean | undefined {
  // This is only the roster verdict. Identity/status, schedule, capacity and
  // the ordinary funded Diamond buy-in door still decide actual admission.
  if (table) {
    try {
      if (parseTableArenaIdentity(table).kind === 'diamond_arena') return true;
    } catch {
      // Missing or malformed arena evidence cannot widen Club Arena eligibility.
    }
  }
  return cashRoster === null ? undefined : cashRoster.has(horseId);
}

/** Legacy club-id exemptions cannot widen Club Arena selection. Diamond scope
 * requires the authoritative table arena identity in cashRosterAllows. */
export function rosterExemptClub(_clubId: unknown): boolean {
  return false;
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
