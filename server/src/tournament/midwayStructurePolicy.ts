import type { GeneratedBlindLevel } from './blindLadder.js';
import { maxSeatsFor } from '../engine/VariantRules.js';
import { mttLateRegistrationMinutes, mttSpeedColumns } from './mttStructurePolicy.js';

export const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';
export const MIDWAY_STRUCTURE_VERSION = 'midway-25-25-v1';
export const MIDWAY_FREE_BUY_GUARANTEES: Readonly<Record<string, number>> = {
  'Morning Free Buy (NLH)': 250,
  'Prime Time Free Buy (NLH)': 500,
  'Midnight Free Buy (NLH)': 250,
};

// Explicit opening, then the conventional 100/200, 150/300, 200/400 ladder.
// Speed is the published clock, never faster blind jumps or a hidden taper.
const BIG_BLINDS = [
  25, 50, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1600, 2000, 2500, 3000, 4000,
  5000, 6000, 8000, 10000, 12000, 16000, 20000, 25000, 30000, 40000, 50000, 60000, 80000, 100000,
  120000, 160000, 200000, 250000, 300000, 400000, 500000, 600000,
];

export function midwayBlindStructure(minutes: number, holdEm: boolean): GeneratedBlindLevel[] {
  return BIG_BLINDS.map((bigBlind, index) => ({
    level: index + 1,
    smallBlind: index === 0 ? 25 : bigBlind / 2,
    bigBlind,
    // An authored TOTAL big-blind ante, collected once by AnteMath. Omaha
    // has no ante; the first four Hold'em levels have no ante either.
    ante: holdEm && index >= 4 ? bigBlind : 0,
    durationMinutes: minutes,
  }));
}

/** Applied by the original spawn transaction, before anyone can register.
 * No mutation of live/funded events, no timer and no change to entry prices,
 * bounty economics, destinations or the published timetable. Only the three
 * explicitly requested Free Buy guarantee reductions apply. */
export function withMidwayStructure<T extends Record<string, unknown>>(
  row: T,
  authored: Record<string, unknown> = {}
): T {
  if (row.club_id !== MIDWAY_UNION_ID && row.union_id !== MIDWAY_UNION_ID) return row;
  if (String(row.tournament_type).toUpperCase() !== 'MTT') return row;
  const free = Number(row.buy_in_amount) + Number(row.buy_in_fee) === 0;
  const old =
    typeof row.blind_structure === 'string' ? JSON.parse(row.blind_structure) : row.blind_structure;
  if (!Array.isArray(old) || !old.length) throw new Error('Midway requires an authored structure');
  const opening = old.find((level) => !level.isBreak);
  const originalMinutes = Number(
    opening?.durationMinutes ?? opening?.duration_minutes ?? Number(opening?.duration) / 60
  );
  if (!(originalMinutes > 0)) throw new Error('Midway requires an authored clock');
  const minutes = free ? 12 : originalMinutes <= 5 ? 5 : originalMinutes >= 12 ? 12 : 8;
  const originalStack = Number(row.starting_chips);
  if (!Number.isSafeInteger(originalStack) || originalStack <= 0) {
    throw new Error('Midway requires a positive whole starting stack');
  }
  const stack = free ? 3000 : Math.max(5000, Math.ceil(originalStack / 5000) * 5000);
  const holdEm = String(row.game_type).toUpperCase() === 'NLH';
  const blinds = midwayBlindStructure(minutes, holdEm);
  const requested = Number(row.late_reg_levels ?? 0);
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new Error('Invalid Midway late registration');
  // Free Buys: exactly five 12-minute levels, one hour, then the add-on.
  // Other entries/rebuys retain at least 20 BB at the last admitted level.
  let cutoff = free ? 5 : Math.min(requested, blinds.length);
  while (!free && cutoff > 0 && stack / blinds[cutoff - 1].bigBlind < 20) cutoff--;
  // Generic MTT rows also use variant=freezeout; only authored formats opt out.
  const explicitFreezeout =
    ['freezeout', 'mtt_freezeout'].includes(String(authored.type).toLowerCase()) ||
    /\bfreeze[ -]?out\b/i.test(String(authored.name ?? row.name));
  const rebuy = !explicitFreezeout;
  const reentry = rebuy;
  const addon = rebuy && !/^Sunday[ -]?200(?:\b|$)/i.test(String(row.name));
  const purchaseCost = (value: unknown): number => {
    const existing = Number(value);
    return Number.isFinite(existing) && existing > 0
      ? existing
      : free
        ? 1
        : Number(row.buy_in_amount) + Number(row.buy_in_fee);
  };
  return {
    ...row,
    starting_chips: stack,
    // Match the launcher's deck ceiling, never the tighter CASH seat policy.
    table_size: Math.min(
      10,
      row.name === 'Mid-Morning Turbo (6-Max NLH)' ? 6 : 10,
      Math.max(2, Number(row.table_size) || 9),
      maxSeatsFor(String(row.game_type).toLowerCase())
    ),
    ...(!free || MIDWAY_FREE_BUY_GUARANTEES[String(row.name)] === undefined
      ? {}
      : {
          guaranteed_prize: MIDWAY_FREE_BUY_GUARANTEES[String(row.name)],
        }),
    blind_structure: blinds,
    ...mttSpeedColumns(blinds),
    big_blind_ante: holdEm,
    late_reg_levels: cutoff,
    late_reg_mins: mttLateRegistrationMinutes(blinds, cutoff),
    is_rebuy: rebuy,
    is_reentry: reentry,
    rebuy_cost: rebuy ? purchaseCost(row.rebuy_cost) : null,
    rebuy_chips: reentry ? stack : null,
    rebuy_levels: rebuy ? cutoff : null,
    add_on_available: addon,
    addon_cost: addon ? purchaseCost(row.addon_cost) : null,
    // Free Buy's owner-approved early add-on remains available at sit-down.
    addon_from_start: addon && free ? row.addon_from_start === true : false,
    addon_chips: addon ? (free ? 10000 : Math.max(Number(row.addon_chips) || 0, stack * 2)) : null,
    addon_levels: addon ? 1 : null,
    addon_break_minutes: addon ? 5 : row.addon_break_minutes,
  };
}
