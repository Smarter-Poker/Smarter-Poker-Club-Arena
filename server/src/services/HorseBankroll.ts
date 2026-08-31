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
  },
  // The middle of the road, and most of the fleet.
  standard: {
    buyInsToSit: 25,
    buyInsToMoveUp: 35,
    moveDownAt: 17,
    maxBankrollFraction: 0.05,
    stopWinBuyIns: 3,
    stopLossBuyIns: 3,
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
