/**
 * HORSE BANKROLL MANAGEMENT (Dan 2026-08-31)
 *
 * Dan: "we will have to add bankroll management fundamentals to all the
 * horses where they need to be aware of their current bankroll when choosing
 * what games to play... they need to understand the fundamentals of bankroll
 * management and learn how to book wins and not risk more of their stack than
 * they should, going down or up in stakes as their bankroll grows or shrinks."
 *
 * Every horse is reset to 10,000 chips. From that moment its `club_members
 * .chip_balance` is a REAL constraint rather than a number nobody consults:
 * it decides which games it may sit in, how much it may bring, when it books
 * a win and leaves, when it drops down, and when it is broke and has to go
 * and win chips back in a freeroll while it waits on the weekly rakeback from
 * its club or upline agent.
 *
 * ── WHY BUY-INS, NOT CHIPS ────────────────────────────────────────────────
 * A bankroll rule stated in chips is meaningless across a stake ladder:
 * 10,000 chips is fifty buy-ins at 1/2 and twenty at 2/5. Every rule here is
 * therefore denominated in BUY-INS of the game being considered, which is how
 * the fundamentals are actually taught and the only unit that compares across
 * stakes.
 *
 * ── THE FUNDAMENTALS THIS ENCODES ─────────────────────────────────────────
 *  1. SIT ONLY WHAT YOU COVER. A stake needs `buyInsToSit` buy-ins behind it.
 *  2. MOVE UP ON A CUSHION, NOT ON A HEATER. Moving up needs strictly more
 *     buy-ins than staying (`buyInsToMoveUp`), so a single winning session
 *     cannot promote a horse into a game it cannot sustain.
 *  3. MOVE DOWN EARLY. Dropping below `moveDownAt` sends it down a level
 *     while it still has a roll to rebuild from. This is deliberately a
 *     HIGHER bar than going broke: the point of moving down is to never get
 *     there.
 *  4. NEVER BRING TOO MUCH. A single buy-in is capped at
 *     `maxBankrollFraction` of the roll, whatever the table allows. A 200bb
 *     max buy-in is not an instruction to put a fifth of a bankroll on one
 *     table.
 *  5. BOOK WINS. Up `stopWinBuyIns` for the session, the horse racks up and
 *     leaves. This is the part players find hardest and the reason the
 *     instruction exists.
 *  6. STOP LOSSES. Down `stopLossBuyIns`, the session is over — it does not
 *     reload into a game that is going badly.
 *  7. BROKE MEANS FREEROLLS. Below one buy-in of the cheapest game there is
 *     no cash play at all: freerolls, and the weekly rakeback.
 *
 * ── TEMPERAMENT ───────────────────────────────────────────────────────────
 * Real players are not identical, and a fleet where all 584 horses move up
 * and down in lockstep would be visible. Temperament is derived from the id
 * hash, so it is stable per horse and spread across the fleet: a nit needs
 * 40 buy-ins, a standard player 25, a gambler 12. Every temperament still
 * obeys all seven rules — the numbers move, the discipline does not.
 *
 * ── WHAT THIS MODULE IS NOT ───────────────────────────────────────────────
 * Pure arithmetic, no IO, no clock. It is given a bankroll and a game and
 * returns a verdict, which is what makes every rule above directly testable.
 */

import { horseHash } from './HorseBehavior.js';

export type BankrollTemperament = 'nit' | 'standard' | 'gambler';

export interface BankrollPolicy {
  temperament: BankrollTemperament;
  /** Buy-ins required behind a stake before sitting in it. */
  buyInsToSit: number;
  /** Buy-ins required before MOVING UP into a bigger game. */
  buyInsToMoveUp: number;
  /** Below this many buy-ins of the current stake, drop down. */
  moveDownAt: number;
  /** Hard ceiling on one buy-in as a share of the whole bankroll. */
  maxBankrollFraction: number;
  /** Up this many buy-ins for the session: rack up and book it. */
  stopWinBuyIns: number;
  /** Down this many buy-ins for the session: done for now. */
  stopLossBuyIns: number;
  /**
   * Buy-ins of an EVENT required before entering it.
   *
   * Much higher than the cash bar, and not out of caution - out of variance.
   * A cash session is a shallow, continuous distribution: a bad night costs a
   * couple of buy-ins. A tournament pays nothing to most of the field most of
   * the time, so a roll that survives 25 cash buy-ins is busted by a routine
   * run of 25 min-cashes. The textbook figures are 20-40 buy-ins for cash and
   * 100+ for MTTs; these keep that ratio while staying inside the temperament.
   */
  tournamentBuyInsToEnter: number;
}

const POLICIES: Record<BankrollTemperament, Omit<BankrollPolicy, 'temperament'>> = {
  // The careful one. 40 buy-ins is the textbook conservative cash roll.
  nit: {
    buyInsToSit: 40,
    buyInsToMoveUp: 55,
    moveDownAt: 28,
    maxBankrollFraction: 0.03,
    stopWinBuyIns: 2,
    stopLossBuyIns: 2,
    tournamentBuyInsToEnter: 100,
  },
  // The middle of the road, and most of the fleet.
  standard: {
    buyInsToSit: 25,
    buyInsToMoveUp: 35,
    moveDownAt: 17,
    maxBankrollFraction: 0.05,
    stopWinBuyIns: 3,
    stopLossBuyIns: 3,
    tournamentBuyInsToEnter: 60,
  },
  // Rolls thinner and takes shots. Still books wins and still moves down —
  // a gambler is not a player with no rules, it is a player with looser ones.
  gambler: {
    buyInsToSit: 12,
    buyInsToMoveUp: 16,
    moveDownAt: 8,
    maxBankrollFraction: 0.1,
    stopWinBuyIns: 5,
    stopLossBuyIns: 4,
    tournamentBuyInsToEnter: 30,
  },
};

/** Stable per horse: the same id always yields the same temperament. */
export function bankrollTemperamentFor(horseId: string): BankrollTemperament {
  const bucket = horseHash(`bankroll:${horseId}`) % 100;
  if (bucket < 20) return 'nit';
  if (bucket < 80) return 'standard';
  return 'gambler';
}

export function bankrollPolicyFor(horseId: string): BankrollPolicy {
  const t = bankrollTemperamentFor(horseId);
  return { temperament: t, ...POLICIES[t] };
}

/**
 * The reference buy-in for a game. A stake's cost is not its minimum — a
 * player sitting a 1/2 game with an 80 minimum and a 400 maximum is normally
 * buying in for about 100bb, and pricing the bankroll rule off the MINIMUM
 * would let a horse sit games it cannot actually play at a normal stack.
 */
export function referenceBuyIn(bigBlind: number, minBuyIn?: number, maxBuyIn?: number): number {
  const bb = Number(bigBlind);
  if (!Number.isFinite(bb) || bb <= 0) return 0;
  const standard = bb * 100;
  const lo =
    Number.isFinite(Number(minBuyIn)) && Number(minBuyIn) > 0 ? Number(minBuyIn) : standard;
  const hi =
    Number.isFinite(Number(maxBuyIn)) && Number(maxBuyIn) > 0 ? Number(maxBuyIn) : standard;
  return Math.min(Math.max(standard, lo), Math.max(lo, hi));
}

/** Rule 1: may this bankroll sit in this game at all? */
export function canSit(bankroll: number, refBuyIn: number, policy: BankrollPolicy): boolean {
  if (!(refBuyIn > 0)) return false;
  return bankroll >= refBuyIn * policy.buyInsToSit;
}

/** Rule 2: may it MOVE UP into this game (a stricter bar than staying)? */
export function canMoveUp(bankroll: number, refBuyIn: number, policy: BankrollPolicy): boolean {
  if (!(refBuyIn > 0)) return false;
  return bankroll >= refBuyIn * policy.buyInsToMoveUp;
}

/** Rule 3: is it time to drop down out of this game? */
export function shouldMoveDown(
  bankroll: number,
  refBuyIn: number,
  policy: BankrollPolicy
): boolean {
  if (!(refBuyIn > 0)) return false;
  return bankroll < refBuyIn * policy.moveDownAt;
}

/**
 * Rule 4: what may it actually bring, given the table's own limits and the
 * share-of-bankroll ceiling? Returns 0 when the game is unaffordable, so a
 * caller that ignores `canSit` still cannot seat an underrolled horse.
 */
export function bankrollBuyIn(args: {
  bankroll: number;
  desired: number;
  minBuyIn: number;
  maxBuyIn: number;
  policy: BankrollPolicy;
}): number {
  const { bankroll, desired, minBuyIn, maxBuyIn, policy } = args;
  if (!(bankroll > 0) || !(minBuyIn > 0)) return 0;
  // Never more than the policy's share of the roll...
  const ceiling = Math.min(maxBuyIn, bankroll * policy.maxBankrollFraction);
  // ...but the table minimum is a floor that cannot be negotiated: if the
  // share does not reach it, this is simply not a game for this bankroll.
  if (ceiling < minBuyIn) return 0;
  const clamped = Math.min(Math.max(desired, minBuyIn), ceiling);
  return Math.floor(clamped * 100) / 100;
}

/** Rule 7: below one buy-in of the cheapest game, there is no cash play. */
export function isBroke(bankroll: number, cheapestBuyIn: number): boolean {
  if (!(cheapestBuyIn > 0)) return false;
  return bankroll < cheapestBuyIn;
}

export type SessionVerdict = 'play_on' | 'book_win' | 'stop_loss';

/**
 * Rules 5 and 6, from the session's own P&L in buy-ins.
 *
 * `netChips` is this session's profit or loss — what the horse is up or down
 * since it sat, NOT its stack, so a deep-stacked horse that is stuck is not
 * mistaken for a winner.
 */
export function sessionVerdict(
  netChips: number,
  refBuyIn: number,
  policy: BankrollPolicy
): SessionVerdict {
  if (!(refBuyIn > 0)) return 'play_on';
  const buyIns = netChips / refBuyIn;
  if (buyIns >= policy.stopWinBuyIns) return 'book_win';
  if (buyIns <= -policy.stopLossBuyIns) return 'stop_loss';
  return 'play_on';
}

export interface GameOption {
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}

/**
 * Rules 1-3 together: of the games on offer, the biggest this bankroll
 * genuinely covers — with the move-up cushion applied when it would be a
 * step ABOVE what it is already playing.
 *
 * Returns null when nothing is affordable, which is the broke path: the
 * caller sends it to the freerolls.
 */
export function bestAffordableGame(
  bankroll: number,
  options: GameOption[],
  policy: BankrollPolicy,
  currentBigBlind?: number
): GameOption | null {
  const ranked = [...options]
    .filter((o) => Number(o.bigBlind) > 0)
    .sort((a, b) => b.bigBlind - a.bigBlind);
  for (const o of ranked) {
    const ref = referenceBuyIn(o.bigBlind, o.minBuyIn, o.maxBuyIn);
    const movingUp = currentBigBlind !== undefined && o.bigBlind > currentBigBlind;
    const ok = movingUp ? canMoveUp(bankroll, ref, policy) : canSit(bankroll, ref, policy);
    if (
      ok &&
      bankrollBuyIn({
        bankroll,
        desired: ref,
        minBuyIn: o.minBuyIn,
        maxBuyIn: o.maxBuyIn,
        policy,
      }) > 0
    ) {
      return o;
    }
  }
  return null;
}

/**
 * TOP-UP DISCIPLINE (2026-08-31).
 *
 * Reloading a short stack is the single easiest way to lose a bankroll, and
 * it was the one path that ignored the roll entirely: the session rotator
 * topped a horse back to a full buy-in every cycle it fell under 45%, funded
 * from the wallet, with no reference to what the wallet could stand.
 *
 * A top-up is a fresh commitment of chips to a table where the horse is
 * ALREADY losing, so it is held to a stricter test than the original seat:
 *
 *  - the roll must still cover the stake (`canSit`) AFTER the top-up leaves
 *    the wallet — a reload that drops the horse under its own sit bar is the
 *    reload that turns a bad session into a bust;
 *  - what is already sunk in THIS table plus the top-up may not exceed the
 *    policy's share of the roll, so a table cannot quietly accumulate three
 *    buy-ins of exposure one reload at a time;
 *  - and the session stop-loss still applies: a horse that is down its
 *    stop-loss does not reload, it leaves.
 *
 * Returns the permitted amount, or 0 for "do not reload".
 */
export function topUpAllowance(args: {
  bankroll: number;
  investedThisTable: number;
  desired: number;
  refBuyIn: number;
  minBuyIn: number;
  maxBuyIn: number;
  policy: BankrollPolicy;
}): number {
  const { bankroll, investedThisTable, desired, refBuyIn, minBuyIn, maxBuyIn, policy } = args;
  if (!(desired > 0) || !(bankroll > 0)) return 0;

  // The stop-loss owns this decision before the arithmetic does.
  if (investedThisTable >= refBuyIn * policy.stopLossBuyIns) return 0;

  // Total exposure to ONE table is capped at the same share a single buy-in
  // is, so reloads cannot walk past the ceiling one step at a time.
  const exposureCap = bankroll * policy.maxBankrollFraction;
  const headroom = exposureCap - investedThisTable;
  if (headroom <= 0) return 0;

  const allowed = Math.min(desired, headroom, maxBuyIn);
  if (allowed <= 0) return 0;

  // After paying for it, can the horse still afford to be in this game?
  if (!canSit(bankroll - allowed, refBuyIn, policy)) return 0;

  // A reload under one big-blind-ish sliver is not a reload.
  if (allowed < Math.max(1, minBuyIn * 0.1)) return 0;
  return Math.floor(allowed * 100) / 100;
}

/**
 * AGGREGATE EXPOSURE (2026-08-31). The per-table cap says how much may go on
 * ONE table; this says how much may be on the felt at once. Four tables at
 * five percent each is a fifth of the bankroll in play, and `canSit` applied
 * per table cannot see that — it answers the same way for the first table and
 * the fourth.
 *
 * The ceiling is FOUR single-table shares (2026-09-06; it was three). Dan's
 * rule is four tables at once, and `MAX_TABLES_PER_HORSE` is four, but three
 * shares made a fourth full buy-in arithmetically impossible for any horse
 * whose per-table cap binds: the fleet logged `aggregate_exposure` for 277
 * horse/table pairs every cycle and the sittable pool for an opening feeder
 * was routinely the horses that were asleep. Four shares is four tables at the
 * per-table cap and no more; the per-table cap and the stop-loss still hold on
 * each table, so one bad session across four tables is still four shares of
 * the roll, not the roll.
 */
export const AGGREGATE_EXPOSURE_MULTIPLE = 4;

export function canOpenAnotherTable(args: {
  bankroll: number;
  liveExposure: number;
  nextBuyIn: number;
  policy: BankrollPolicy;
}): boolean {
  const { bankroll, liveExposure, nextBuyIn, policy } = args;
  if (!(bankroll > 0) || !(nextBuyIn > 0)) return false;
  const ceiling = bankroll * policy.maxBankrollFraction * AGGREGATE_EXPOSURE_MULTIPLE;
  return liveExposure + nextBuyIn <= ceiling;
}

/**
 * Rule 8: may this bankroll enter this EVENT?
 *
 * A FREEROLL IS ALWAYS YES. Free money is not a bankroll decision - it is the
 * recovery path a broke horse is supposed to take, and gating it behind a roll
 * the horse does not have is precisely the loop that never closes. This mirrors
 * the `allLanes` freeroll override the tournament service already applies to
 * game lanes (Dan 2026-08-27: "free money is not a lane decision").
 *
 * `cost` is the full entry - buy-in PLUS fee - because that is what leaves the
 * wallet. Pricing the rule off the prize contribution alone understates a
 * turbo's real cost by its whole rake.
 */
export function canEnterTournament(
  bankroll: number,
  cost: number,
  policy: BankrollPolicy
): boolean {
  if (!(cost > 0)) return true; // freeroll
  if (!(bankroll > 0)) return false;
  return bankroll >= cost * policy.tournamentBuyInsToEnter;
}

/**
 * Rule 9: the REBUY decision, for a horse that just busted a cash seat.
 *
 * Two separate questions, and the old code only asked the second one:
 *
 *  1. SHOULD it rebuy - is it still inside its stop-loss, and can its own roll
 *     still support this stake at all? A horse that keeps reloading a game it
 *     can no longer afford is the exact opposite of the discipline Dan asked
 *     for; the correct move is to leave, drop down a rung, and come back.
 *  2. FOR HOW MUCH - the old sites used `bigBlind * 100` flat, ignoring the
 *     table's own limits and the share-of-roll ceiling both.
 *
 * `rebuysTaken` counts reloads already made, so the buy-ins COMMITTED to this
 * session is `rebuysTaken + 1` - the initial buy-in plus each reload. The
 * comparison is therefore against `rebuysTaken + 1`, not `rebuysTaken`.
 *
 * That off-by-one is not academic. `rebuysTaken >= stopLossBuyIns` would let
 * the standard temperament - six in ten of the fleet - take THREE reloads for
 * four buy-ins committed, where the hard-coded `>= 2` it replaces allowed two
 * reloads for three. The first draft of this module carried that comparison
 * while its own comment claimed parity, so 60% of the fleet would have
 * quietly gained a buy-in of rope in a change described as a refactor.
 *
 * With `rebuysTaken + 1`: standard stops at exactly the old place, the nit
 * gives up a buy-in earlier, and the gambler takes one more.
 *
 * Returns the amount to rebuy for, or 0 for "do not rebuy - stand up".
 *
 * WHERE THE CHIPS COME FROM IS UNCHANGED. A horse is still funded from the
 * club treasury (`fn_horse_fund_from_treasury`); this is a DECISION, not a
 * money path. And it makes a horse MORE like a human, not less (CLAUDE.md
 * 10.5): a human's reload is limited by their own wallet, and until now a
 * horse's was limited by nothing at all.
 */
export function rebuyDecision(args: {
  bankroll: number;
  refBuyIn: number;
  minBuyIn: number;
  maxBuyIn: number;
  desired: number;
  rebuysTaken: number;
  policy: BankrollPolicy;
}): number {
  const { bankroll, refBuyIn, minBuyIn, maxBuyIn, desired, rebuysTaken, policy } = args;
  if (rebuysTaken + 1 >= policy.stopLossBuyIns) return 0;
  // Can the roll still carry this stake? If not, this is a move-down, not a
  // reload. Unknown or zero reference falls through to the old flat sizing
  // rather than standing a horse up on a number we could not read.
  if (refBuyIn > 0 && bankroll > 0 && !canSit(bankroll, refBuyIn, policy)) return 0;
  return bankrollBuyIn({ bankroll, desired, minBuyIn, maxBuyIn, policy });
}
