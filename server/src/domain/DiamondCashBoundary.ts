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
 * BOMB POTS ARE ADMITTED (2026-09-12, Phase 7 line three).
 *
 * A bomb pot is an equal forced ante from every dealt-in player and then a
 * showdown across one to three boards. Neither half needs anything from the
 * chip economy: the ante leaves a stack and enters the pot, and the multi-board
 * settlement in HandController has cut its shares in the table's own unit since
 * the tournament fix, so a Diamond bomb pot divides in whole Diamonds by the
 * same rule run it twice does.
 *
 * Two things about the ROW still have to be refused, because either one deals a
 * hand the rest of the boundary then rejects, and a table that deals a hand it
 * cannot settle is worse than a table that never deals:
 *
 *   - an ante that is not a whole Diamond. The multiplier slider steps by 0.5,
 *     so 1.5x a one Diamond blind is one and a half Diamonds, and the hand guard
 *     refuses a fractional forced bet. Both modes are checked here: a fixed ante
 *     on its own, and the blind multiple when there is no fixed ante.
 *   - a bomb variant override. `bomb_pot_variant` lets an NLH table deal PLO
 *     bombs, which is the classic bomb pot and is refused here for the same
 *     reason plo4 is refused on the table itself: no variant beyond NLH is
 *     certified for Diamond yet. An override the scheduler would IGNORE is
 *     refused too, because a column that says one game while the table deals
 *     another is a lie whichever way the engine resolves it.
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE GAMES A DIAMOND TABLE MAY DEAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA
 * (ONLY DIFFERENCE IS ... ITS PLAYED WITH DIAMONDS INSTEAD OF CHIPS)". The chip
 * cash create screen offers nine variants; this is the same nine.
 *
 * WHY THIS IS SAFE, WHICH IS NOT THE SAME AS WHY IT IS WANTED. A Diamond does
 * not divide, so the only question a new variant raises is whether it divides
 * a pot somewhere the cent-denominated code did not have to care about. Every
 * such place was already made unit-aware while this arena was still NLH only:
 *
 *   the run-it-twice per-board slice      ServerTableEngineRunout
 *   the multi-board settlement            HandController
 *   the tie chop inside one board         PokerEngine.distributePot
 *   the payout unit                       HandController.scaleWinnerUnitsForRake
 *   THE HI-LO SPLIT                       PokerEngine.determineWinners
 *
 * The last of those is the one this list newly reaches, and it takes the SAME
 * `chipUnit` the tie chop takes - `floor(potCents / (2 * unitCents)) *
 * unitCents` - so the low half of a Diamond pot is always a whole number of
 * Diamonds and the odd unit goes to high, which is the standard rule. A pot of
 * ONE Diamond therefore pays high entirely and the qualifying low hand nothing;
 * that is not a rounding defect, it is what an indivisible pot means.
 *
 * Nothing else divides. Pot-limit sizing is `currentBet + pot + toCall`, pure
 * addition. Fixed-limit sizing multiplies the big blind by one or two; its two
 * `/ 2` expressions are reopen THRESHOLDS and are never wagered. Short deck
 * strips the deck and derives no ante. The bomb-pot ante is already Diamond
 * aware.
 *
 * `pineapple` is admitted as a TABLE variant while `pineapple_holdem` stays in
 * the refused column list, and the two are not the same fact: the column turns
 * an `nlh` table into a hand DEALT as pineapple, which is the chip schedule
 * reaching into a table this arena declared as hold'em. A Diamond pineapple
 * game is a table that says so.
 */
export const DIAMOND_CASH_VARIANTS = [
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'pineapple',
  'short_deck',
  'flh',
  'flo8',
] as const;

/** Whether this arena may deal that game at all. */
export function isDiamondCashVariant(variant: unknown): boolean {
  return (DIAMOND_CASH_VARIANTS as readonly string[]).includes(String(variant));
}

export function assertDiamondCashTable(table: Record<string, unknown>): void {
  const disabled = [
    'is_template',
    'insurance_enabled',
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
    !isDiamondCashVariant(table.game_variant) ||
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
  if (table.bomb_pot_enabled === true) {
    /* An override is admitted only when it names the table's OWN game. This
       read the literal 'nlh' until 2026-09-12, which was correct while that
       was the only game and became wrong the moment it was not: it would have
       refused a Diamond PLO4 table whose bomb variant said plo4, and admitted
       one whose bomb variant said nlh, both backwards. The rule was always
       "the bomb deals the table's game"; it is now written that way. */
    const variant = String(table.bomb_pot_variant ?? '').toLowerCase();
    if (variant !== '' && variant !== String(table.game_variant))
      throw new Error('Diamond Bomb Pots Require The Table Game');
    const fixed = table.bomb_pot_ante_fixed;
    const bombAnte =
      typeof fixed === 'number' && fixed > 0
        ? fixed
        : Number(table.big_blind) * Number(table.bomb_pot_ante_multiplier ?? 2);
    if (!Number.isSafeInteger(bombAnte) || bombAnte <= 0)
      throw new Error('Diamond Bomb Pots Require A Whole Ante');
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND TOURNAMENT TABLE IS A TOURNAMENT TABLE (PHASE 8, 2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It deals TOURNAMENT CHIPS, exactly as a chip tournament table does: the
 * entry is custody (poker_diamond_custody, purpose tournament_entry), the
 * stack is not, the prize is settled from the entry custody by the database
 * at the terminal, and no seat is ever bound to a custody row (P0810-P0815).
 * So the cash boundary above is the wrong shape for it on purpose: it sells
 * no seat (min and max buy-in are zero), the manager writes the chip
 * schedule's column defaults for rake and the jackpot (which every tournament
 * hand ignores - `rakeConfig` is zero and the BBJ fee is off for every
 * tournament table, cash or Diamond), and the money it must keep whole is the
 * blinds and the ante, not a buy-in range.
 *
 * What it keeps from the cash boundary: the games this arena deals, the
 * chip-schedule columns that are refused outright, and the refusal of a
 * template or a union scope. What it adds: it must SAY it is a tournament
 * table (`game_type` and `tournament_id` both), so a row that carries a
 * tournament id by accident is not admitted as one.
 */
export function assertDiamondTournamentTable(table: Record<string, unknown>): void {
  const disabled = [
    'is_template',
    'insurance_enabled',
    'seven_deuce_enabled',
    'nit_game',
    'pineapple_holdem',
    'cap_enabled',
    'bomb_pot_enabled',
  ];
  if (
    !isDiamondCashVariant(table.game_variant) ||
    table.tournament_id == null ||
    table.game_type !== 'tournament' ||
    table.union_id != null ||
    !['waiting', 'running', 'playing', 'active'].includes(String(table.status)) ||
    disabled.some((key) => table[key] === true)
  )
    throw new Error('Diamond Tournament Table Required');
  for (const key of ['small_blind', 'big_blind']) {
    const amount = table[key];
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > 2147483647
    )
      throw new Error('Diamond Tournaments Require Whole Positive Blinds');
  }
  const ante = table.ante ?? 0;
  if (typeof ante !== 'number' || !Number.isSafeInteger(ante) || ante < 0)
    throw new Error('Diamond Tournaments Require A Whole Ante');
  for (const key of ['min_buy_in', 'max_buy_in']) {
    if (Number(table[key] ?? 0) !== 0) throw new Error('A Diamond Tournament Table Sells No Seat');
  }
}

/**
 * The one door for a Diamond table of either kind. A table that says it is a
 * tournament table is held to the tournament boundary, everything else to the
 * cash boundary; neither admits the other's shape.
 */
export function assertDiamondTable(table: Record<string, unknown>): void {
  if (table.tournament_id != null || table.game_type === 'tournament') {
    assertDiamondTournamentTable(table);
  } else {
    assertDiamondCashTable(table);
  }
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
    !isDiamondCashVariant(input.variant) ||
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
