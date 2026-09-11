import type { ArenaIdentity } from './ArenaContext.js';

/**
 * The first custody-backed game is plain NLH; optional financial paths are not
 * admitted.
 *
 * UNSET IS NOT OFF (2026-09-11). This guard used to read an absent column as a
 * zero or a false, and the engine reads the same absent column as "inherit the
 * chip club's schedule". They are opposite defaults, so a table could pass
 * admission here and then be refused by HandController on every single hand:
 * admitted, seated, and unable to deal. Three columns did exactly that.
 *
 *   rake_cap_bb   unset -> RakeConfig falls back to the published SCHEDULE cap
 *                 (see the `rakeCap` resolution in config/RakeConfig.ts), which
 *                 is nonzero at every stake. This guard did not look at the
 *                 column at all, and HandController refuses a nonzero cap.
 *   bbj_percent   unset -> the engine reads `?? 100`, so the jackpot is ON and
 *                 HandController refuses the hand. This guard read `?? 0`.
 *   run_it_twice / allow_run_it_twice
 *                 unset -> the engine reads `?? true`, so running it twice is
 *                 ON. This guard only refused an explicit `true`.
 *
 * So a deduction column must be EXPLICITLY zero and a feature flag EXPLICITLY
 * false. An arena table that inherits anything from the chip schedule is not a
 * Diamond table, and refusing it at the door is the only place the refusal
 * costs nobody a seat.
 */
export function assertDiamondCashTable(table: Record<string, unknown>): void {
  const disabled = [
    'is_template',
    'insurance_enabled',
    'bomb_pot_enabled',
    'run_it_twice_enabled',
    'straddle_enabled',
    'auto_utg_straddle',
    'voluntary_straddle',
    'seven_deuce_enabled',
    'nit_game',
    'all_in_or_fold',
    'pineapple_holdem',
    'cap_enabled',
  ];
  /* These two default to ON in the engine, so "not true" is not good enough. */
  const explicitlyOff = ['run_it_twice', 'allow_run_it_twice'];
  /* Every one of these defaults to a nonzero chip figure when it is unset. */
  const explicitlyZero = ['rake_percent', 'rake_cap_bb', 'bbj_percent'];
  if (
    table.game_variant !== 'nlh' ||
    table.tournament_id != null ||
    table.cluster_id != null ||
    !['waiting', 'running', 'playing', 'active'].includes(String(table.status)) ||
    disabled.some((key) => table[key] === true) ||
    explicitlyOff.some((key) => table[key] !== false) ||
    explicitlyZero.some((key) => typeof table[key] !== 'number' || Number(table[key]) !== 0)
  )
    throw new Error('Diamond Plain Cash Table Required');
  for (const key of ['small_blind', 'big_blind', 'min_buy_in', 'max_buy_in']) {
    const amount = table[key];
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > 2147483647
    )
      throw new Error('Diamond Cash Requires Whole Positive Amounts');
  }
  const ante = table.ante ?? 0;
  if (typeof ante !== 'number' || !Number.isSafeInteger(ante) || ante < 0)
    throw new Error('Diamond Cash Requires A Whole Ante');
}

/** Refuse unsupported facts rather than suppressing a deduction after it was paid. */
export function assertDiamondAcceptedHand(input: {
  arena?: ArenaIdentity;
  verifiedLease: boolean;
  variant: string;
  rake: number;
  bbj: number;
  inflow: number;
  insuranceCount: number;
  amounts: number[];
}): void {
  if (input.arena?.asset !== 'diamonds') return;
  if (!input.verifiedLease) throw new Error('atomic hand commit refused (diamond_lease_required)');
  if (
    input.variant !== 'nlh' ||
    input.rake !== 0 ||
    input.bbj !== 0 ||
    input.inflow !== 0 ||
    input.insuranceCount !== 0
  )
    throw new Error('atomic hand commit refused (diamond_plain_cash_required)');
  if (
    input.amounts.some(
      (amount) => !Number.isSafeInteger(amount) || amount < 0 || amount > 2147483647
    )
  )
    throw new Error('atomic hand commit refused (diamond_whole_amount_required)');
}
