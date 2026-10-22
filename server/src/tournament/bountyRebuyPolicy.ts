/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A BOUNTY TOURNAMENT IS NEVER A FREEZEOUT (Dan 2026-10-21, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "NO BOUNTY OR MYSTERY BOUNTY TOURNAMENT SHOULD BE A
 * FREEZEOUT, THEY SHOULD ALL HAVE REBUY TILL THE END OF REGISTRATION."
 *
 * WHAT IT DID BEFORE. Whether an event allowed rebuys was whatever its
 * schedule row happened to say. The Midway Union's rows were given rebuys on
 * October 20 (migration 20261020194921), but the Diamond Arena's copies of the
 * same events never were, so every Diamond bounty, PKO and mystery bounty
 * spawned as a freezeout, and a row edited by hand could do the same anywhere.
 *
 * WHAT IT DOES NOW. Every scheduled bounty MTT (bounty, progressive knockout,
 * mystery bounty) leaves the spawner as a rebuy event whose rebuy window is
 * its late-registration window, at the entry price for the starting stack,
 * with no cap on the count. Satellites, Sit & Gos and Spins are not MTT
 * bounty events and are untouched; so is a freeroll, which has no money to
 * fund a head and keeps its own Free Buy rules. The database applies the same
 * rule to every other creation path (trigger
 * `fn_ca_bounty_mtt_rebuys_until_registration_closes`), so the two agree.
 *
 * Pure. Returns a new row; never mutates its input.
 */

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Is this row a paid bounty MTT the rule applies to? */
export function isBountyMttRow(row: Record<string, unknown>): boolean {
  const bounty = row.is_bounty === true || row.is_pko === true || row.is_mystery_bounty === true;
  if (!bounty) return false;
  if (String(row.tournament_type ?? 'MTT').toUpperCase() !== 'MTT') return false;
  if (String(row.variant ?? '').toLowerCase() === 'satellite') return false;
  if (row.satellite_target_id != null && row.satellite_target_id !== '') return false;
  const total = num(row.buy_in_amount) + num(row.buy_in_fee);
  return total > 0;
}

export function withBountyRebuyUntilRegistrationCloses(
  row: Record<string, unknown>
): Record<string, unknown> {
  if (!isBountyMttRow(row)) return row;
  const total = num(row.buy_in_amount) + num(row.buy_in_fee);
  const startingChips = Math.floor(num(row.starting_chips));
  const lateRegLevels = Math.floor(num(row.late_reg_levels));
  const rebuyLevels = lateRegLevels > 0 ? lateRegLevels : Math.max(1, Math.floor(num(row.rebuy_levels)) || 6);
  return {
    ...row,
    is_rebuy: true,
    is_reentry: true,
    rebuy_cost: num(row.rebuy_cost) > 0 ? row.rebuy_cost : total,
    rebuy_chips: num(row.rebuy_chips) > 0 ? row.rebuy_chips : startingChips > 0 ? startingChips : 10000,
    rebuy_levels: rebuyLevels,
    // Zero means "no rebuys at all" to fn_open_tournament_rebuy_decisions;
    // a bounty event's cap is the window, not a count.
    max_rebuys: num(row.max_rebuys) > 0 ? row.max_rebuys : null,
    max_reentries: num(row.max_reentries) > 0 ? row.max_reentries : null,
  };
}
