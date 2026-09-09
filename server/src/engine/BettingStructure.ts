/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BETTING STRUCTURE — no-limit / pot-limit / fixed-limit
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-23 (Dan): the lobby has always had a LIMIT tab and `cashKind()` has
 * always classified on `flh`/`limit_*`, but FIX 116 removed every limit variant
 * from the type unions and the create-table screen. The tab could therefore
 * never contain a single table, and there was no way to create one. Worse, the
 * engine only ever knew two structures — the codebase asked
 * `gameVariant.startsWith('plo')` in nine separate places and treated
 * everything else as no-limit, so even a restored `flh` row would have DEALT
 * fixed-limit hold'em and PLAYED no-limit.
 *
 * This module is the single source of truth for which structure a variant uses
 * and what a legal wager is under it. Every site that used to ask
 * `startsWith('plo')` now asks here.
 *
 * ── FIXED-LIMIT RULES (as implemented) ────────────────────────────────────────
 *  • Bets and raises are a FIXED size — no sizing choice, no slider.
 *  • Small bet on preflop and flop; big bet (2×) on turn and river.
 *  • The small bet equals the big blind, so a table posting blinds 1/2 is a
 *    "2/4" limit game: small bet 2, big bet 4. This is the standard live and
 *    online convention and is why `stakesLabel()` below doubles the BB.
 *  • Four wagers per street: one bet and three raises. Preflop the big blind
 *    IS the bet, so preflop allows three raises on top of it. Once the cap is
 *    reached the only actions are fold and call.
 *  • The cap applies at every table size. Uncapping heads-up is a common house
 *    rule but is deliberately NOT implemented — a cap that changes when a third
 *    player folds is the kind of rule the fuzzer catches and players dispute.
 *  • A player who cannot cover a full bet may still go all in for less; that
 *    short all-in reopens betting when a previously acted player faces at
 *    least half the street bet (HandController.canReopenBetting, TDA 47B).
 */

import type { HandStage, ActionRecord, ActionType } from '../types.js';

export type BettingStructure = 'no_limit' | 'pot_limit' | 'fixed_limit';

/** Variants played pot-limit. */
const POT_LIMIT_VARIANTS = new Set(['plo4', 'plo5', 'plo6', 'plo8']);

/** Variants played fixed-limit. */
const FIXED_LIMIT_VARIANTS = new Set(['flh', 'flo8']);

/**
 * Four wagers per betting round: one bet plus three raises. Preflop the blind
 * counts as the bet.
 */
export const FIXED_LIMIT_MAX_WAGERS = 4;

export function bettingStructureFor(variant?: string | null): BettingStructure {
  const v = (variant || '').toLowerCase();
  if (FIXED_LIMIT_VARIANTS.has(v)) return 'fixed_limit';
  // `startsWith('plo')` was the historical test and is kept as a fallback so a
  // future plo variant is pot-limit by default rather than silently no-limit.
  if (POT_LIMIT_VARIANTS.has(v) || v.startsWith('plo')) return 'pot_limit';
  return 'no_limit';
}

export function isFixedLimitVariant(variant?: string | null): boolean {
  return bettingStructureFor(variant) === 'fixed_limit';
}

export function isPotLimitVariant(variant?: string | null): boolean {
  return bettingStructureFor(variant) === 'pot_limit';
}

/**
 * THE POT-LIMIT RAISE-TO CEILING (Bible V8 4.14).
 *
 * The maximum raise SIZE under pot limit is the pot AFTER calling, so the
 * biggest legal raise-TO is `currentBet + pot + toCall`. This is the same
 * arithmetic `calculateBettingState` uses to build `maxRaise`, lifted into
 * this module so the horses can SIZE to it rather than only be clamped by it,
 * and so there is one formula rather than one per caller.
 *
 * Reading it off the live pot is the whole point: a hardcoded multiple of the
 * big blind is correct in exactly one blind structure and wrong the moment
 * there is an ante, a straddle, a dead blind or a limper. At 1/2 six-handed
 * this returns 7 (3.5x BB) first in, 6 (3x BB) from the small blind, and 9
 * with one limper - the standard Omaha opening sizes, derived rather than
 * guessed.
 *
 * `pot` must include the chips already wagered on the current street, which is
 * the convention every caller in the engine already uses.
 */
export function potLimitRaiseTo(pot: number, currentBet: number, toCall: number): number {
  const p = Number.isFinite(pot) ? Math.max(0, pot) : 0;
  const cb = Number.isFinite(currentBet) ? Math.max(0, currentBet) : 0;
  const tc = Number.isFinite(toCall) ? Math.max(0, toCall) : 0;
  return cb + p + tc;
}

/**
 * The legal wager size for a fixed-limit street.
 *
 * `bigBlind` is the SMALL BET (see the header note on stakes convention), so
 * preflop and flop wager exactly the big blind and turn and river wager twice
 * it. `pineapple_discard` never carries betting; `showdown` is included only so
 * callers holding a late stage value get the big bet rather than undefined.
 */
export function fixedLimitBetSize(bigBlind: number, stage: HandStage): number {
  switch (stage) {
    case 'preflop':
    case 'flop':
    case 'pineapple_discard':
      return bigBlind;
    case 'turn':
    case 'river':
    case 'showdown':
    default:
      return bigBlind * 2;
  }
}

/** Resolve completions and counted wagers from this street's actual raise-to levels.
 * WSOP 2026 rule 133: below half a wager completes; half or more is a wager.
 * Calls record chips added, so only aggressive actions carry a raise-to level.
 */
export function fixedLimitStreetBounds(
  actions: ActionRecord[],
  stage: HandStage,
  betSize: number,
  currentBet: number
): { raiseSize: number; wagers: number } {
  let level = stage === 'preflop' ? betSize : 0;
  let wagers = stage === 'preflop' ? 1 : 0;
  for (const action of actions) {
    if (action.stage !== stage || !['bet', 'raise', 'all_in'].includes(action.action)) continue;
    if (action.amount - level >= betSize / 2 - 0.005) {
      level = action.amount;
      wagers++;
    }
  }
  const short = currentBet - level;
  const raiseSize = short > 0.005 && short < betSize / 2 - 0.005 ? betSize - short : betSize;
  return { raiseSize: Math.round(raiseSize * 100) / 100, wagers };
}

/**
 * How many wagers have already gone in on this street.
 *
 * Counts bets, raises, and all-ins large enough to be a full raise — exactly
 * the actions `canReopenBetting` treats as aggression, so the cap and the
 * reopen rule can never disagree. Preflop starts at 1 because the big blind is
 * the first wager.
 */
export function fixedLimitWagerCount(actions: ActionRecord[], stage: HandStage): number {
  const base = stage === 'preflop' ? 1 : 0;
  let n = 0;
  for (const a of actions) {
    if (a.stage !== stage) continue;
    if (
      ((a.action === 'bet' || a.action === 'raise') && a.isFullRaise !== false) ||
      (a.action === 'all_in' && a.isFullRaise)
    ) {
      n++;
    }
  }
  return base + n;
}

/** True once the street has taken a bet and three raises. */
export function isFixedLimitCapped(
  actions: ActionRecord[],
  stage: HandStage,
  betSize?: number
): boolean {
  const wagers =
    betSize === undefined
      ? fixedLimitWagerCount(actions, stage)
      : fixedLimitStreetBounds(actions, stage, betSize, 0).wagers;
  return wagers >= FIXED_LIMIT_MAX_WAGERS;
}

/**
 * What an automated seat should do instead, when it wants to wager on a street
 * that is already capped.
 *
 * 2026-08-24. The horses decide independently of `getAvailableActions` — the
 * menu is only for the client — and a rejected horse action degrades to
 * `check() || fold()` (Bible V8 §1.7.4 preferCheckOverFold, added by the
 * 2026-08-15 freeze fix so a seat is never left unacted). On a CAPPED
 * fixed-limit street facing a bet, `check` is illegal because toCall > 0. So a
 * horse that wanted to RAISE had its raise refused and then FOLDED a hand it
 * had just decided to put money in with — the worst possible substitution, and
 * invisible because the seat did act.
 *
 * A capped street offers exactly two moves. If money is owed, the intent
 * closest to "raise" is `call`; if nothing is owed, it is `check`. Neither can
 * be refused, so the fold path is never reached for this reason again.
 *
 * Deliberately NOT applied to the human path: a person's rejected raise should
 * be refused, not silently converted into chips they did not agree to commit.
 * The client already hides Raise on a capped street, so a human only reaches
 * this by hand-crafting a request.
 */
export function substituteOnCappedStreet(action: ActionType, toCall: number): ActionType {
  if (action !== 'bet' && action !== 'raise') return action;
  return toCall > 0.005 ? 'call' : 'check';
}

/**
 * How a table's stakes read to a player.
 *
 * Fixed-limit games are posted by BET size, not blind size: blinds 1/2 is a
 * "2/4" game. No-limit and pot-limit games are posted by blinds as usual.
 */
export function stakesLabel(smallBlind: number, bigBlind: number, variant?: string | null): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  if (isFixedLimitVariant(variant)) return `${fmt(bigBlind)}/${fmt(bigBlind * 2)}`;
  return `${fmt(smallBlind)}/${fmt(bigBlind)}`;
}
