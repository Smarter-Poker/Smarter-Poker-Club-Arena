/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHAT A TOURNAMENT TAB SAYS UNDER ITS CODE - the buy-in, never the blinds
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-04, verbatim: "THE ACTION BOX SHOULDN'T SAY MTT 200/400 OR MTT
 * 25/50 IT SHOULD BE DISPLAYING THE HOLE CARDS WHEN THEY ARE PRESENT, OR MTT
 * AND BUY IN AMOUNT UNDER IT FOR QUICK REFERENCE."
 *
 * WHAT IT DID BEFORE. The pill's sub-line was written for cash tables: the live
 * pot while a hand runs, otherwise `stakes`, which for a cash table is the one
 * thing that tells two NLH tabs apart. A tournament reports its CURRENT BLIND
 * LEVEL in that same field, so an MTT tab read "MTT 200/400" and changed every
 * level, and once the level (or the pot) grew past what a ~47px pill can hold
 * the line was ellipsised mid-number ("51115/..."). Neither figure identifies
 * the tournament. Its buy-in does, and it never changes.
 *
 * THE LABEL CANNOT OVERFLOW, BY CONSTRUCTION. `compactChips` is the house
 * forward-facing figure (whole numbers under 1,000, then 1.2K / 10K / 3.4M,
 * rounded down), so the longest string this can return for any buy-in is six
 * glyphs ("999.9K"), and the freeroll word is eight. The pill's sub-line fits
 * ten at its smallest size (see .table-tab-bar__tab-sub, <=480px).
 *
 * Pure except for `readTournamentBuyIns`, which is one bounded read.
 */

import { supabase } from './supabase';
import { compactChips } from '../utils/format';
import { FREE_BUY_LABEL } from '../utils/freeBuy';
import { totalBuyIn } from '../utils/buyIn';

/** The longest sub-line a tournament pill can ever print, in glyphs. */
export const TOURNAMENT_TAB_LABEL_MAX_GLYPHS = 8;

/**
 * The sub-line for a tournament tab: the total a player pays to enter (buy-in
 * plus fee), the same total the tournament lobby prints, in compact form.
 *
 * '' means "not known yet" and the pill then shows its code alone. It never
 * falls back to blinds or a pot: an absent figure is better than a wrong one.
 * A known total of 0 is a freeroll and reads the lobby's own word for it.
 */
export function tournamentTabBuyInLabel(total: number | null | undefined): string {
  if (total === null || total === undefined) return '';
  const n = Number(total);
  if (!Number.isFinite(n) || n < 0) return '';
  const whole = Math.round(n);
  if (whole <= 0) return FREE_BUY_LABEL;
  return compactChips(whole);
}

/**
 * The buy-in total (prize side plus fee) of the tournament each of these
 * TABLES belongs to, keyed by table id. Tables that are not tournament tables,
 * and anything unreadable, are simply absent from the map: the caller treats
 * absence as "not known" and prints no figure.
 *
 * Two reads for the whole set, never one per tab. A tournament's price does not
 * change after it is created, so this is asked once per table and kept.
 */
export async function readTournamentBuyIns(
  tableIds: ReadonlyArray<string>
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = Array.from(new Set((tableIds || []).filter(Boolean)));
  if (ids.length === 0) return out;

  const { data: tbls, error: tblErr } = await supabase
    .from('tables')
    .select('id, tournament_id')
    .in('id', ids);
  // A failed read is thrown, not answered with "no buy-ins": the caller
  // reports it (tournament_buy_in_read_failed).
  if (tblErr) throw tblErr;
  if (!tbls) return out;

  const tournamentOf = new Map<string, string>();
  for (const row of tbls as Array<{ id: string; tournament_id: string | null }>) {
    if (row.tournament_id) tournamentOf.set(String(row.id), String(row.tournament_id));
  }
  const tournamentIds = Array.from(new Set(tournamentOf.values()));
  if (tournamentIds.length === 0) return out;

  const { data: tours, error: tourErr } = await supabase
    .from('tournaments')
    .select('id, buy_in_amount, buy_in_fee')
    .in('id', tournamentIds);
  if (tourErr) throw tourErr;
  if (!tours) return out;

  const totalOf = new Map<string, number>();
  for (const t of tours as Array<{
    id: string;
    buy_in_amount: number | string | null;
    buy_in_fee: number | string | null;
  }>) {
    totalOf.set(String(t.id), totalBuyIn(Number(t.buy_in_amount) || 0, Number(t.buy_in_fee) || 0));
  }
  for (const [tableId, tournamentId] of tournamentOf) {
    const total = totalOf.get(tournamentId);
    if (total !== undefined) out.set(tableId, total);
  }
  return out;
}
