/**
 * How a horse refills its stack at a PLO5 cash table.
 *
 * Dan 2026-10-24: "70% OF HORSES SHOULD BE ADDING ON IN THE PLO5 GAME. 30%
 * SHOULD BE ON 'AUTO TOP UP'."
 *
 * A human at a cash table has two ways to refill a live stack: switch on Auto
 * Top Up (the seat's `auto_rebuy` flag; the table tops the stack back to the
 * maximum between hands), or press Add Chips when the stack has run down. Horses
 * are players (CLAUDE.md 10.5), and each PLO5 horse now does exactly one:
 *
 *   - The nearest whole-horse 30% are AUTO TOP UP horses. They sit with `auto_rebuy` on, and between
 *     hands the engine tops the stack back toward the table maximum - the human
 *     Auto Top Up rule (TablePage, "Auto Top Up (Cash Games Only)") - inside the
 *     horse's bankroll policy (`cappedAutoTopUp`).
 *   - The remaining horses are ADD-ON horses. They sit with `auto_rebuy` off and add on the way
 *     every horse already did before this rule: HorseSessionRotator's V8/V9
 *     top-up (short stack after a while at the table, a chance per cycle, a
 *     round-figure target, `topUpAllowance`, through the human Add Chips door).
 *     The rotator skips a seat whose Auto Top Up flag is on, as a human on Auto
 *     Top Up does not also press Add Chips.
 *
 * WHICH HORSE IS WHICH is a hash of its user id, so a horse keeps one habit
 * at admission. The hand boundary then holds the whole seated cash-game roster to
 * the nearest whole-horse 30/70 split, changing the fewest existing choices. The seat's own
 * `auto_rebuy` flag, written at the buy-in door, is the single source of truth
 * the engine and the rotator both read. Every other game is untouched.
 *
 * MONEY: this module decides only WHETHER and HOW MUCH. The chips move through
 * `fn_horse_fund_from_treasury` exactly like a horse rebuy - the horse's own
 * club wallet first, through the human add-on door - and the amount never takes
 * the stack past the table maximum.
 *
 * PAID FROM THE HORSE'S OWN WALLET, INSIDE ITS BANKROLL POLICY. A human cannot
 * add chips they do not have, and an unknown balance never tops a human up. A
 * horse is additionally held to `topUpAllowance` (the stop-loss and per-table
 * exposure cap every horse reload meets, Dan 2026-08-31): otherwise a losing
 * horse topped back to the maximum every hand would never bust, never reach its
 * stop-loss, and bleed its roll one top-up at a time.
 *
 * NOT LIGHTNING. A Lightning Cluster refills through its own pooled auto-rebuy
 * (`fn_lightning_auto_rebuy`, keyed to the pool session's anchor seat), and no
 * Classic rule touches it. The engine skips Lightning tables; the seat flag is
 * only written for non-Lightning tables.
 */

import { createHash } from 'node:crypto';
import { bankrollPolicyFor, referenceBuyIn, topUpAllowance } from './HorseBankroll.js';

export type HorseTopUpStyle = 'auto_top_up' | 'add_on';

/** Share of PLO5 horses on Auto Top Up. The rest add on. */
export const PLO5_AUTO_TOP_UP_SHARE = 0.3;

/** True for the PLO5 game ('plo5', 'PLO5', 'plo-5', 'PLO 5' all qualify). */
export function isPlo5Variant(variant: unknown): boolean {
  if (typeof variant !== 'string') return false;
  return variant.toLowerCase().replace(/[^a-z0-9]/g, '') === 'plo5';
}

/** A stable number in [0, 1) for this horse and this purpose. */
function unitHash(userId: string, purpose: string): number {
  const hex = createHash('sha256').update(`${purpose}|${userId}`).digest('hex');
  return parseInt(hex.slice(0, 8), 16) / 0x1_0000_0000;
}

/**
 * The horse's refill habit at this game, or null when the game has no rule
 * (every variant except PLO5 keeps its existing behaviour).
 */
export function horseCashTopUpStyle(userId: string, variant: unknown): HorseTopUpStyle | null {
  if (!userId || !isPlo5Variant(variant)) return null;
  return unitHash(userId, 'horse-topup-style') < PLO5_AUTO_TOP_UP_SHARE ? 'auto_top_up' : 'add_on';
}

/** Should this horse sit down with the seat's Auto Top Up flag on? */
export function horseSitsWithAutoTopUp(userId: string, variant: unknown): boolean {
  return horseCashTopUpStyle(userId, variant) === 'auto_top_up';
}

/**
 * The shortfall an Auto Top Up horse wants filled between hands, to the cent,
 * or 0. Only Auto Top Up horses at a PLO5 table get one. A busted stack (0) is
 * not a top-up - that is a rebuy and HorseRebuyPolicy owns it.
 */
export function horseAutoTopUpWanted(input: {
  userId: string;
  variant: unknown;
  stack: number;
  maxBuyIn: number;
  /** The persisted seat choice takes precedence over the initial hash. */
  autoTopUp?: boolean;
}): number {
  if (!isPlo5Variant(input.variant) || !input.userId) return 0;
  const enabled = input.autoTopUp ?? horseSitsWithAutoTopUp(input.userId, input.variant);
  if (!enabled) return 0;
  const stack = Number(input.stack);
  const max = Number(input.maxBuyIn);
  if (!Number.isFinite(stack) || !Number.isFinite(max) || stack <= 0 || max <= 0) return 0;
  if (stack >= max) return 0;
  // Price canonical cent amounts BEFORE subtracting: 200 - 191.31 in binary
  // is 8.689999..., whose floor otherwise leaves the observed 199.99 stack.
  const maxCents = Math.round(max * 100);
  const stackCents = Math.round(stack * 100);
  if (!Number.isSafeInteger(maxCents) || !Number.isSafeInteger(stackCents)) return 0;
  if (Math.abs(max - maxCents / 100) > 1e-9 || Math.abs(stack - stackCents / 100) > 1e-9) return 0;
  const amount = (maxCents - stackCents) / 100;
  return amount > 0 ? amount : 0;
}

/**
 * What an Auto Top Up horse actually adds: the shortfall, held to the same
 * bankroll rule as every horse reload (`topUpAllowance`: stop-loss, per-table
 * exposure, can-still-sit-after-paying, no sliver reloads) and then to its own
 * wallet. An unknown wallet or an unknown session total tops up nothing: a
 * top-up is optional, so unlike a rebuy it fails CLOSED.
 */
export function cappedAutoTopUp(args: {
  userId: string;
  wanted: number;
  wallet: number | undefined;
  investedThisTable: number | undefined;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}): number {
  const { wanted, wallet, investedThisTable } = args;
  if (!(wanted > 0)) return 0;
  if (wallet === undefined || !Number.isFinite(wallet) || wallet <= 0) return 0;
  if (
    investedThisTable === undefined ||
    !Number.isFinite(investedThisTable) ||
    investedThisTable < 0
  ) {
    return 0;
  }
  const bb = Number(args.bigBlind) > 0 ? Number(args.bigBlind) : 0;
  const max = Number(args.maxBuyIn) > 0 ? Number(args.maxBuyIn) : 0;
  if (!(bb > 0) || !(max > 0)) return 0;
  const min = Number(args.minBuyIn) > 0 ? Number(args.minBuyIn) : bb * 40;
  const allowed = topUpAllowance({
    bankroll: wallet,
    investedThisTable,
    desired: wanted,
    refBuyIn: referenceBuyIn(bb, min, max),
    minBuyIn: min,
    maxBuyIn: max,
    policy: bankrollPolicyFor(args.userId),
  });
  const cents = Math.min(allowed, wallet) * 100;
  const capped = Math.floor(cents + Number.EPSILON * Math.max(1, Math.abs(cents))) / 100;
  return capped >= wanted ? wanted : 0;
}

/**
 * Nearest whole-horse 30% of a live Classic PLO5 cash-game roster. Keep current
 * choices wherever possible; a departure never reshuffles every remaining
 * horse. Hash order only breaks ties when the quota actually needs a change.
 * Applied by the existing hand boundary, never by a timer or repair service.
 */
export function balancedHorseAutoTopUps(
  seats: ReadonlyArray<{ userId: string; autoTopUp: boolean }>
): Set<string> {
  const unique = new Map<string, boolean>();
  for (const seat of seats) {
    if (seat.userId) unique.set(seat.userId, (unique.get(seat.userId) ?? false) || seat.autoTopUp);
  }
  const ranked = [...unique].sort(
    ([a, onA], [b, onB]) =>
      Number(onB) - Number(onA) ||
      unitHash(a, 'horse-topup-style') - unitHash(b, 'horse-topup-style') ||
      a.localeCompare(b)
  );
  return new Set(
    ranked.slice(0, Math.round(ranked.length * PLO5_AUTO_TOP_UP_SHARE)).map(([id]) => id)
  );
}
