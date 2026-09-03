/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FIELD SIZE AND PAID PLACES — the two numbers fn_create_tournament refuses on
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from CreateTournamentModal on 2026-08-31 so the rules can be tested
 * without rendering a 2,000-line form — the same reason
 * `tournamentFromTableConfig` was extracted from TableConfigPage.
 *
 * Both rules exist because the database enforces them and the modal did not:
 *
 *   IF v_max_players <= 0 THEN RETURN 'max_players_must_be_positive';
 *   IF jsonb_array_length(v_payouts) > v_max_players
 *     THEN RETURN 'more_paid_places_than_players';
 *
 * THE SECOND RULE READ `>=` UNTIL 2026-08-31 and that was an off-by-one: the
 * error names "more paid places THAN players", and the operator for that is
 * `>`. Migration `20260831200000_a_spin_pays_three_places_at_three_seats`
 * corrects the RPC, matching the table-level `tournaments_creation_guard`
 * which has enforced `>` since the day before. Both layers now say the same
 * thing, so nothing here has to be trimmed to appease one of them.
 *
 * The modal sent `maxPlayers: 0` for every MTT-shaped format — freezeout,
 * rebuy, re-entry, bounty, progressive, mystery, satellite and XMTT — under the
 * comment "0 = unlimited". There is no unlimited field: registration is refused
 * once `current_players >= max_players`, so 0 is a locked door, and the insert
 * never got that far anyway. And it paired "Heads Up (2)" with the `sng6`
 * preset, which pays TWO places, so the two-handed Sit & Go it offered was
 * refused by the second rule every single time.
 */

import type { PayoutEntry } from '../services/PayoutEngine';

/**
 * The field size actually sent, for every format.
 *
 * Floored at 2: a one-seat tournament cannot be played and the database refuses
 * a non-positive field. Anything unparseable becomes the floor rather than 0,
 * because 0 is the exact value that produced an unexplained failure.
 */
export function fieldCapFor(raw: string | number | null | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 2 ? n : 2;
}

/**
 * The minimum field a format should start on.
 *
 * An SNG or a Spin starts only when it is FULL (GameServer: `isSngOrSpin ?
 * maxReached : ...`), so its minimum IS its cap — a 9-max Sit & Go stored with
 * `min_players: 3` advertises a threshold that means nothing.
 * `buildTournamentConfig` has had this rule since 2026-08-19; the modal
 * hard-coded 3 for every format, and the RPC's own clamp only hid it in the
 * 2-max case.
 */
export function minPlayersFor(startsWhenFull: boolean, fieldCap: number): number {
  const cap = fieldCapFor(fieldCap);
  return startsWhenFull ? cap : Math.min(cap, 3);
}

/**
 * Trim a payout ladder to the seats that exist, and renormalise to 100.
 *
 * THE CAP IS THE FIELD, NOT THE FIELD MINUS ONE (2026-08-31). A ladder may pay
 * EVERY seat: a Spin & Go is three-handed and its 25x, 50x and 100x tiers pay
 * 80 / 12 / 8 across all three, and 21 such tournaments are sitting completed
 * and paid in `tournaments` right now. The `- 1` that used to be here existed
 * for exactly one reason - `fn_create_tournament` refused
 * `paid_places >= max_players` - and it was never a rule about poker. Fed the
 * Spin ladder at a three-seat field it dropped third place and rescaled the
 * rest, so the operator was shown, and the row was written, as 86.96 / 13.04.
 * The RPC now agrees (`>` , not `>=`), so the trim is only what it says: a
 * structure cannot pay a place nobody can reach.
 *
 * The renormalisation is not optional: `TournamentService` refuses a ladder that
 * does not total 100, so a trimmed-but-unscaled ladder would swap one refusal
 * for another. A ladder that already fits is returned untouched, so a preset
 * that sums to 100 is never rounded through this path at all.
 *
 * Rounding is to two decimals with the whole drift pushed onto first place,
 * which is what `PayoutEngine.normalizePayouts` does — first place is the one
 * number large enough to absorb a cent without changing what a player reads.
 */
export function capPaidPlaces(entries: PayoutEntry[], fieldCap: number): PayoutEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [{ place: 1, percentage: 100 }];
  /* A LADDER THAT PAYS NOTHING IS CHECKED BEFORE THE TRIM, not inside it
     (2026-08-31). It used to be checked only on the path that sliced, so while
     the cap was `field - 1` a two-place all-zero ladder was always sliced and
     always caught. Raising the cap to the field made that same ladder FIT, and
     a fitting ladder is returned untouched — so 0 / 0 would have been sent to
     a service that refuses anything not totalling 100, as a refusal the
     operator cannot see the cause of. Winner-take-all is the same net it has
     always been. */
  const declared = entries.reduce((a, e) => a + (Number(e.percentage) || 0), 0);
  if (!(declared > 0)) return [{ place: 1, percentage: 100 }];

  const maxPlaces = Math.max(1, fieldCapFor(fieldCap));
  if (entries.length <= maxPlaces) return entries;

  const kept = entries.slice(0, maxPlaces);
  const sum = kept.reduce((a, e) => a + (Number(e.percentage) || 0), 0);
  if (sum <= 0) return [{ place: 1, percentage: 100 }];

  const scaled = kept.map((e) => ({
    place: e.place,
    percentage: Math.round(((Number(e.percentage) || 0) / sum) * 10000) / 100,
  }));
  const drift = Math.round((100 - scaled.reduce((a, e) => a + e.percentage, 0)) * 100) / 100;
  scaled[0] = { ...scaled[0], percentage: Math.round((scaled[0].percentage + drift) * 100) / 100 };
  return scaled;
}
