import type { GeneratedBlindLevel } from './blindLadder.js';
import { maxSeatsFor } from '../engine/VariantRules.js';
import { mttLateRegistrationMinutes, mttSpeedColumns } from './mttStructurePolicy.js';
import { FREE_BUY_LATE_REG_MINUTES, lockedLevelMinutes } from './lockedLevelClock.js';

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
 * No mutation of live/funded events, no timer and no change to destinations
 * or the published timetable. Fixed bounty rounding requires a funded net entry;
 * Sunrise and Midnight use the owner-approved 5 prize/bounty + 0.5 fee split. Only the three
 * explicitly requested Free Buy guarantee reductions apply. */
export function withMidwayStructure<T extends Record<string, unknown>>(
  row: T,
  authored: Record<string, unknown> = {}
): T {
  if (row.club_id !== MIDWAY_UNION_ID && row.union_id !== MIDWAY_UNION_ID) return row;
  if (String(row.tournament_type).toUpperCase() !== 'MTT') return row;
  const fixedBounty =
    row.is_bounty === true && row.is_pko !== true && row.is_mystery_bounty !== true;
  const smallBounty =
    fixedBounty && ['Sunrise Bounty (NLH)', 'Midnight Bounty (NLH)'].includes(String(row.name));
  const netEntry = smallBounty ? 5 : Number(row.buy_in_amount);
  const entryFee = smallBounty ? 0.5 : Number(row.buy_in_fee);
  const free = netEntry + entryFee === 0;
  const old =
    typeof row.blind_structure === 'string' ? JSON.parse(row.blind_structure) : row.blind_structure;
  if (!Array.isArray(old) || !old.length) throw new Error('Midway requires an authored structure');
  const opening = old.find((level) => !level.isBreak);
  const originalMinutes = Number(
    opening?.durationMinutes ?? opening?.duration_minutes ?? Number(opening?.duration) / 60
  );
  if (!(originalMinutes > 0)) throw new Error('Midway requires an authored clock');
  // Dan 2026-10-21: one fixed clock per event, never a range. Freerolls and
  // turbos 5, standard and bounty 8, deep stack 10 (lockedLevelClock.ts).
  const minutes = lockedLevelMinutes({ ...row, blind_structure: old });
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
  // Free Buys: one hour of late registration (twelve 5-minute levels), then
  // the add-on. Other entries/rebuys retain at least 20 BB at the last
  // admitted level.
  let cutoff = free ? FREE_BUY_LATE_REG_MINUTES / minutes : Math.min(requested, blinds.length);
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
    return Number.isFinite(existing) && existing > 0 ? existing : free ? 1 : netEntry + entryFee;
  };
  const roundedBounty = smallBounty
    ? 2
    : fixedBounty
      ? Math.ceil(Number(row.bounty_amount) / 5) * 5
      : Number(row.bounty_amount);
  if (
    fixedBounty &&
    (!Number.isFinite(netEntry) ||
      !Number.isFinite(roundedBounty) ||
      Number(roundedBounty) <= 0 ||
      Number(roundedBounty) > netEntry)
  ) {
    throw new Error('Midway fixed bounty must be positive and funded by the net entry');
  }
  return {
    ...row,
    ...(fixedBounty
      ? {
          bounty_amount: roundedBounty,
          short_description: `Fixed Knockout Bounty: ${roundedBounty} Chips. Entry: ${netEntry - roundedBounty} Prize Pool + ${roundedBounty} Bounty + ${entryFee} Fee.`,
        }
      : {}),
    ...(smallBounty ? { buy_in_amount: netEntry, buy_in_fee: entryFee } : {}),
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
    // Dan 2026-10-25: "ADD ON BREAK SHOULD ONLY BE 60 SECONDS, UNLESS IT HAPPENS TO
    // BE AT THE SAME TIME AS THE :55 BREAK, THEN ITS 5 MINUTES, THEY ARE NOT THE
    // SAME BREAK". The :55 break is its own pause authority; this is the add-on's.
    addon_break_minutes: addon ? 1 : row.addon_break_minutes,
  };
}
