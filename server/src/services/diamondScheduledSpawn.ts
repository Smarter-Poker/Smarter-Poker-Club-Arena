/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND ARENA RUNS THE MIDWAY UNION'S SCHEDULE (Dan, 2026-10-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-06 13:09 CT: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE
 * MIDWAY UNION FOR NOW" - for the Diamond Arena. And earlier the same day: the
 * horses that were in Deep Stack Society play the Diamond Arena.
 *
 * ScheduledTournamentService reads every active `tournament_schedules` row and
 * builds a chip `tournaments` row from it, which it INSERTs directly. That is
 * the wrong door for the arena: a Diamond tournament's fee is computed in
 * whole Diamonds by the database, its guarantee is earmarked on the arena's
 * house (`ca_diamond_house`) rather than charged against a club treasury or a
 * union wallet, and a direct insert would do neither. So a schedule whose club
 * is the Diamond Arena is spawned through
 * `fn_poker_diamond_spawn_scheduled_tournament(p_schedule_id,
 * p_scheduled_start, p_config)`, idempotent per (schedule, start), which
 * creates the event and earmarks its guarantee in one transaction.
 *
 * This file is the pure half: which club is the arena, and the p_config the
 * door reads. The schedule config is first built into the chip row exactly as
 * before (every structure preset, satellite target, blind contract and
 * payout check still runs once, in one place), and that row is translated
 * into the door's key shapes in whole Diamonds. Nothing here touches the
 * network.
 *
 * WHOLE DIAMONDS. A Diamond does not divide. The entry TOTAL is the same
 * snapped ladder price a chip event of this schedule charges
 * (`buyInFor(wholeChips(cfg.buyIn)).total`, server/src/config/buyIn.ts); the
 * DATABASE takes the 10% (5% heads-up) fee out of it and floors it to whole
 * Diamonds, so this file never states the fee. Guarantee, rebuy and add-on
 * prices are already whole on the chip row and are carried as integers. A
 * knockout bounty can be a fraction on the chip row (3.75) and is floored
 * here, never rounded up past what the entry funds.
 */

import { parseArenaIdentity } from '../domain/ArenaContext.js';
import { buyInFor, wholeChips } from '../config/buyIn.js';
import { DIAMOND_ARENA_HORSE_CLUBS } from './HorseFleetFundingBoundary.js';

/** The database door every scheduled Diamond event is created through. */
export const DIAMOND_SPAWN_RPC = 'fn_poker_diamond_spawn_scheduled_tournament';

/** The arena house's spare capacity: what is left to earmark a guarantee from. */
export const DIAMOND_HOUSE_AVAILABLE_RPC = 'fn_ca_diamond_house_available';

/** The club columns the arena identity is read from. */
export interface ArenaClubRow {
  id?: unknown;
  asset?: unknown;
  is_platform?: unknown;
  union_id?: unknown;
}

/**
 * Is this club row the Diamond Arena? The shared arena contract answers
 * (`parseArenaIdentity`: asset 'diamonds', is_platform exactly true, no
 * union), never a hard-coded id. Anything that does not parse is not the
 * arena - a malformed row is a chip club's problem, not a Diamond spawn.
 */
export function isDiamondArenaClubRow(row: ArenaClubRow | null | undefined): boolean {
  if (!row) return false;
  try {
    return parseArenaIdentity(row).kind === 'diamond_arena';
  } catch {
    return false;
  }
}

/**
 * The clubs whose members may be registered into a Diamond Arena event: the
 * arena's own members (its humans) and every club Dan assigned to play the
 * arena (Deep Stack Society's horses, DIAMOND_ARENA_HORSE_CLUBS). The arena
 * itself holds one member row and no horses, so without the second half the
 * membership rule would drop the entire fleet from the arena's schedule.
 */
export function diamondArenaEntrantClubIds(arenaClubId: string): string[] {
  return [...new Set([arenaClubId, ...DIAMOND_ARENA_HORSE_CLUBS])];
}

/** The fee ratio `fn_poker_diamond_create_tournament` applies, by field size. */
function diamondFeeRatio(maxPlayers: number | null): number {
  return maxPlayers !== null && maxPlayers <= 2 ? 0.05 : 0.1;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A whole Diamond count of at least one, or null. */
const wholePositive = (v: unknown): number | null => {
  const n = Math.floor(num(v) + 1e-9);
  return n >= 1 ? n : null;
};

export type DiamondSpawnConfig =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Translate the chip row ScheduledTournamentService built for this occurrence
 * into the jsonb `fn_poker_diamond_spawn_scheduled_tournament` reads: the
 * shape `fn_poker_diamond_create_tournament` accepts, plus the guarantee,
 * rebuy/add-on, bounty and satellite keys the Midway schedule configs carry.
 *
 * Refuses (ok:false, with the reason) rather than guessing when a price cannot
 * be expressed in whole Diamonds. A refusal here happens BEFORE the spawn key
 * is claimed, so nothing is burnt.
 */
export function diamondSpawnConfig(
  row: Record<string, unknown>,
  cfg: Record<string, unknown>,
  startTime: Date
): DiamondSpawnConfig {
  const variant = String(row.variant ?? 'freezeout').toLowerCase();
  const tournamentType = String(row.tournament_type ?? 'MTT').toUpperCase();
  const isSatellite = variant === 'satellite' || row.satellite_target_id != null;
  const type = isSatellite
    ? 'satellite'
    : tournamentType === 'SNG'
      ? 'sng'
      : ['bounty', 'progressive_bounty', 'mystery_bounty'].includes(variant)
        ? variant
        : 'mtt';
  if (tournamentType === 'SPIN') {
    // buildInsertRow already refuses a scheduled Spin; this is the same answer.
    return { ok: false, reason: 'diamond_schedule_spin_has_no_scheduled_time' };
  }

  // The same ladder price a chip event of this schedule charges, as a TOTAL.
  const total = buyInFor(wholeChips(cfg.buyIn)).total;
  const maxPlayers = row.max_players == null ? null : Math.floor(num(row.max_players));
  const freeBuy = row.free_buy === true;

  const config: Record<string, unknown> = {
    name: String(row.name ?? ''),
    type,
    gameVariant: String(row.game_type ?? 'NLH'),
    buyIn: total,
    guaranteedPrize: Math.floor(num(row.guaranteed_prize)),
    startingStack: Math.floor(num(row.starting_chips)),
    maxPlayers,
    minPlayers: Math.floor(num(row.min_players)),
    tableSize: Math.floor(num(row.table_size)),
    blindStructure: row.blind_structure,
    payoutStructure: row.payout_structure,
    payoutPercent: row.payout_percent,
    lateRegLevels: Math.floor(num(row.late_reg_levels)),
    startTime: startTime.toISOString(),
    shortDescription: row.short_description ?? null,
    actionTimeSeconds: row.action_time_seconds,
    bigBlindAnte: row.big_blind_ante === true,
  };
  if (freeBuy) config.freeBuy = true;

  // Bounty: whole Diamonds, at least one, never more than the entry funds
  // after the fee the database will take.
  if (type === 'bounty' || type === 'progressive_bounty' || type === 'mystery_bounty') {
    const fee = Math.floor(total * diamondFeeRatio(maxPlayers) + 1e-9);
    const funded = total - fee;
    const bounty = Math.min(Math.max(1, Math.floor(num(row.bounty_amount) + 1e-9)), funded);
    if (!(funded >= 1) || !(bounty >= 1)) {
      return { ok: false, reason: 'diamond_schedule_bounty_not_whole_within_the_buy_in' };
    }
    config.bountyAmount = bounty;
  }
  if (type === 'mystery_bounty') {
    const mult = (v: unknown, dflt: number) => (num(v) > 0 ? num(v) : dflt);
    config.mysteryBountyMin = mult(cfg.mysteryBountyMin, 0.5);
    config.mysteryBountyMax = mult(cfg.mysteryBountyMax, 13);
    const mystery: Record<string, unknown> = {
      activation: row.mystery_bounty_activation ?? 'at_the_money',
      profile: row.mystery_bounty_profile ?? 'classic',
      topPercent: row.mystery_bounty_top_percent,
      poolPercent: row.mystery_bounty_pool_percent,
      regularPoolPercent: row.mystery_bounty_regular_pool_percent,
    };
    if (row.mystery_bounty_activation_value != null) {
      mystery.activationValue = row.mystery_bounty_activation_value;
    }
    config.mysteryBounty = mystery;
  }

  // Rebuy / re-entry / add-on: the door's own keys, whole Diamond prices.
  const rebuy = row.is_rebuy === true;
  const reentry = row.is_reentry === true;
  const addOn = row.add_on_available === true;
  if (rebuy || reentry) {
    const cost = wholePositive(row.rebuy_cost);
    if (cost === null) return { ok: false, reason: 'diamond_schedule_rebuy_cost_not_whole' };
    config.rebuy = rebuy;
    config.reentry = reentry;
    config.rebuyCost = cost;
    config.rebuyChips = Math.floor(num(row.rebuy_chips));
    if (row.rebuy_levels != null) config.rebuyLevels = Math.floor(num(row.rebuy_levels));
    if (row.max_rebuys != null) config.maxRebuys = Math.floor(num(row.max_rebuys));
    if (row.max_reentries != null) config.maxReentries = Math.floor(num(row.max_reentries));
  }
  if (addOn) {
    const cost = wholePositive(row.addon_cost);
    if (cost === null) return { ok: false, reason: 'diamond_schedule_addon_cost_not_whole' };
    config.addOn = true;
    config.addonCost = cost;
    config.addonChips = Math.floor(num(row.addon_chips));
    if (row.addon_levels != null) config.addonLevels = Math.floor(num(row.addon_levels));
  }

  // Satellite: the target buildInsertRow resolved in the arena's own events.
  if (isSatellite) {
    if (typeof row.satellite_target_id !== 'string' || !row.satellite_target_id) {
      return { ok: false, reason: 'diamond_schedule_satellite_target_unresolved' };
    }
    config.satelliteTargetId = row.satellite_target_id;
    if (row.satellite_seats != null) config.satelliteSeats = Math.floor(num(row.satellite_seats));
  }

  return { ok: true, config };
}

/**
 * The door's answer, read without folding "could not tell" into either
 * outcome (CLAUDE.md 10.86): a transport error, a missing body or a body that
 * is neither shape is a refusal with a reason, never a spawn.
 */
export function readDiamondSpawnAnswer(
  data: unknown,
  error: { message?: string } | null | undefined
): { ok: true; tournamentId: string; replayed: boolean } | { ok: false; reason: string } {
  if (error) return { ok: false, reason: `rpc_error: ${error.message ?? 'unknown'}` };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'no_answer' };
  }
  const body = data as Record<string, unknown>;
  if (body.ok === true) {
    const id = body.tournament_id;
    if (typeof id === 'string' && id) {
      return { ok: true, tournamentId: id, replayed: body.replayed === true };
    }
    return { ok: false, reason: 'ok_without_tournament_id' };
  }
  return {
    ok: false,
    reason: typeof body.reason === 'string' && body.reason ? body.reason : 'refused_without_reason',
  };
}
