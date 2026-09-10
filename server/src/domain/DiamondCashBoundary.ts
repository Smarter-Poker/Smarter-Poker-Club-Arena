import type { ArenaIdentity } from './ArenaContext.js';

/** The first custody-backed game is plain NLH; optional financial paths are not admitted. */
export function assertDiamondCashTable(table: Record<string, unknown>): void {
  const disabled = [
    'is_template',
    'insurance_enabled',
    'bomb_pot_enabled',
    'run_it_twice_enabled',
    'run_it_twice',
    'allow_run_it_twice',
    'straddle_enabled',
    'auto_utg_straddle',
    'voluntary_straddle',
    'seven_deuce_enabled',
    'nit_game',
    'all_in_or_fold',
    'pineapple_holdem',
    'cap_enabled',
  ];
  if (
    table.game_variant !== 'nlh' ||
    table.tournament_id != null ||
    table.cluster_id != null ||
    !['waiting', 'running', 'playing', 'active'].includes(String(table.status)) ||
    disabled.some((key) => table[key] === true) ||
    Number(table.rake_percent ?? 0) !== 0 ||
    Number(table.bbj_percent ?? 0) !== 0
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
