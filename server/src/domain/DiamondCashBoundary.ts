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
/**
 * RUN IT TWICE IS ADMITTED (2026-09-12, Phase 7 line three).
 *
 * It was refused because the RIT runout cut every pot into integer CENTS: a
 * five Diamond pot over two runs paid two and a half Diamonds a board, and a
 * fractional Diamond is refused by the hand guard, the accepted-hand guard and
 * the settler alike. The runout now cuts in the table's own unit and passes
 * that unit to `determineWinners`, so the per-board slice and a tie chopped on
 * one board are both whole Diamonds, with the odd unit going to the earliest
 * board and then to the first seat clockwise of the button - the same stated
 * rules, counted in Diamonds.
 *
 * `run_it_twice` and `allow_run_it_twice` still have to be STATED. The engine
 * reads an absent one as true, which would make the chip schedule's default the
 * arena's answer, and this arena inherits nothing. `run_it_twice_enabled` reads
 * as false when absent and only ever turns the feature ON, which is now
 * allowed, so it leaves the refusal list entirely.
 */
/**
 * STRADDLES ARE ADMITTED (2026-09-12, Phase 7 line three).
 *
 * A straddle is the one optional cash feature that needs nothing from the chip
 * economy. It is a blind post: `StraddleEngine` prices it at exactly
 * `straddleMultiplier` (2) times the current blind, and this guard already
 * refuses a table whose blinds are not whole positive integers, so a Diamond
 * straddle is a whole number by construction with no division anywhere on the
 * path. There is no counterparty, no ledger and no obligation - the units come
 * out of one player's stack and into the pot, which the accepted-hand guard
 * already requires to be whole.
 *
 * The three columns are also safe to read as absent-means-off, unlike the
 * run-it columns above: every engine read is truthy (`if (straddle_enabled)`,
 * `auto_utg_straddle === true`), so an unset column disables the feature in the
 * engine exactly as it does here. That is why they leave the `disabled` list
 * rather than joining `explicitlyStated`.
 *
 * `seven_deuce_enabled` stays refused and is not a straddle: it is a side bet
 * paid between players at a table-configured `seven_deuce_amount`, which is a
 * separate money fact this phase has not certified.
 */
export function assertDiamondCashTable(table: Record<string, unknown>): void {
  const disabled = [
    'is_template',
    'insurance_enabled',
    'bomb_pot_enabled',
    'seven_deuce_enabled',
    'nit_game',
    'all_in_or_fold',
    'pineapple_holdem',
    'cap_enabled',
  ];
  /* These two default to ON in the engine, so an ABSENT column is a decision
     the chip schedule made rather than one this arena made. Running it twice is
     admitted now, so the rule is no longer "off" but "stated": either boolean
     is fine, a missing one is not. */
  const explicitlyStated = ['run_it_twice', 'allow_run_it_twice'];
  /* Every one of these defaults to a nonzero chip figure when it is unset. */
  const explicitlyZero = ['rake_percent', 'rake_cap_bb', 'bbj_percent'];
  if (
    table.game_variant !== 'nlh' ||
    table.tournament_id != null ||
    table.cluster_id != null ||
    !['waiting', 'running', 'playing', 'active'].includes(String(table.status)) ||
    disabled.some((key) => table[key] === true) ||
    explicitlyStated.some((key) => typeof table[key] !== 'boolean') ||
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
