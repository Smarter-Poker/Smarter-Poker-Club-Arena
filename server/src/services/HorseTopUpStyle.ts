/**
 * How a horse refills its stack at a PLO5 cash table.
 *
 * Dan 2026-10-24: "70% OF HORSES SHOULD BE ADDING ON IN THE PLO5 GAME. 30%
 * SHOULD BE ON 'AUTO TOP UP'."
 *
 * Until this module a horse never refilled a live stack at all - it only
 * reloaded after busting (HorseRebuyPolicy). A human at the same table has two
 * ways to refill: switch on Auto Top Up (the seat's `auto_rebuy` flag; the
 * table tops the stack back to the maximum between every hand), or press Add
 * Chips when the stack has run down. Horses are players (CLAUDE.md 10.5), so a
 * PLO5 horse now does one or the other:
 *
 *   - 30% are AUTO TOP UP horses. They sit with `auto_rebuy` on, and between
 *     hands any stack under the table maximum is filled back to it - the same
 *     rule the human Auto Top Up effect applies (TablePage, "Auto Top Up (Cash
 *     Games Only)").
 *   - 70% are ADD-ON horses. They sit with `auto_rebuy` off and add on the way
 *     a person does: once the stack has fallen under the horse's own comfort
 *     line (40-65% of the table maximum, fixed per horse), it adds back up to
 *     the maximum between hands.
 *
 * WHICH HORSE IS WHICH is a hash of its user id, so a horse keeps one habit
 * for life instead of flipping between hands or tables, and across the fleet
 * the split lands on 30/70. Every other game is untouched (null style).
 *
 * MONEY: this module decides only WHETHER and HOW MUCH. The chips move through
 * `fn_horse_fund_from_treasury` exactly like a horse rebuy - the horse's own
 * club wallet first, through the human add-on door, then the club treasury for
 * any shortfall - and the amount never takes the stack past the table maximum.
 */

import { createHash } from 'node:crypto';

export type HorseTopUpStyle = 'auto_top_up' | 'add_on';

/** Share of PLO5 horses on Auto Top Up. The rest add on. */
export const PLO5_AUTO_TOP_UP_SHARE = 0.3;

/** The add-on comfort line, as a share of the table maximum. */
export const ADD_ON_LINE_MIN = 0.4;
export const ADD_ON_LINE_MAX = 0.65;

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
 * (every variant except PLO5 keeps today's bust-only reload).
 */
export function horseCashTopUpStyle(userId: string, variant: unknown): HorseTopUpStyle | null {
  if (!userId || !isPlo5Variant(variant)) return null;
  return unitHash(userId, 'horse-topup-style') < PLO5_AUTO_TOP_UP_SHARE ? 'auto_top_up' : 'add_on';
}

/** Should this horse sit down with the seat's Auto Top Up flag on? */
export function horseSitsWithAutoTopUp(userId: string, variant: unknown): boolean {
  return horseCashTopUpStyle(userId, variant) === 'auto_top_up';
}

/** The add-on horse's comfort line, as a share of the table maximum. */
export function horseAddOnLine(userId: string): number {
  return (
    ADD_ON_LINE_MIN + unitHash(userId, 'horse-addon-line') * (ADD_ON_LINE_MAX - ADD_ON_LINE_MIN)
  );
}

export interface HorseTopUpInput {
  userId: string;
  variant: unknown;
  stack: number;
  maxBuyIn: number;
}

/**
 * How many chips this horse adds between hands, to the cent, or 0.
 *
 * A busted stack (0) is not a top-up - that is a rebuy and HorseRebuyPolicy
 * owns it. Nothing is ever sized past the table maximum.
 */
export function horseTopUpAmount(input: HorseTopUpInput): number {
  const style = horseCashTopUpStyle(input.userId, input.variant);
  if (!style) return 0;
  const stack = Number(input.stack);
  const max = Number(input.maxBuyIn);
  if (!Number.isFinite(stack) || !Number.isFinite(max) || stack <= 0 || max <= 0) return 0;
  if (stack >= max) return 0;
  if (style === 'add_on' && stack >= max * horseAddOnLine(input.userId)) return 0;
  const amount = Math.floor((max - stack) * 100) / 100;
  return amount > 0 ? amount : 0;
}
