/**
 * A SHORT ALL IN IS CALLED BY A BIG STACK (Dan 2026-10-26, BINDING).
 *
 * Dan, verbatim:
 *   "WHEN A PLAYER SHOVES ALL IN WITH LESS THEN 3 BB A STACK OF 20 OR MORE BB
 *    SHOULD BE CALLING WITH ALMOST ANYTHING IN A TOURNAMENT."
 *
 * The rule, exactly:
 *  - Applies in every tournament (MTT, Sit & Go, Spin, satellite: anything
 *    that is not a cash game) and in every variant a horse plays there.
 *  - The horse faces an all in: the bet it must match was put in by a player
 *    who is all in (other callers in the pot do not matter, and players still
 *    to act behind do not matter).
 *  - The shover's whole-hand total (what the horse would have to put in, in
 *    total, to match) is under 3 big blinds, OR the amount the horse must ADD
 *    to call that all in is under 3 big blinds.
 *  - The horse has at least 20 big blinds: its stack before calling plus the
 *    chips it already has in this pot.
 *
 * The floor, and why it is defensible:
 *  - Preflop, every variant: CALL, always. At under 3 big blinds to call with
 *    the blinds and antes already in the middle, the price is better than
 *    roughly 2:1 against a short-stack shoving range, and no starting hand in
 *    hold'em (7-2 offsuit included, about 30% against a random hand), Omaha or
 *    short deck is far enough behind for a fold to be right. Calling risks
 *    under 15% of a 20 big blind stack.
 *  - Postflop: CALL, unless the brain's own Monte Carlo equity for this hand
 *    is under 5% AND under the price the call is laid. That is the "drawing
 *    dead" case and nothing else. When no equity was measured (the main
 *    thread's commit door, a worker fallback), it calls.
 *  - Only a FOLD is converted. A raise, call or shove the brain already chose
 *    is left exactly as it is.
 *  - It is a hard rule: no style, profile, mood, tilt, tightness, solver, ICM
 *    or push/fold layer can fold this spot, because it runs after all of them
 *    (see HorseLogic's `wager_rules` node and the commit door in
 *    ServerTableEngineTurns). There is no option to turn it off.
 *  - On an all-in-or-fold table the only way to call is to go all in, so that
 *    is what it does there.
 *
 * Against the PLO paired-board fold (Dan 2026-10-25): that rule folds a hand
 * without a full house to a COMMITTING bet, and it counts ANY all in as
 * committing. A sub-3BB shove against a 20BB+ horse is not a stack-off: it is
 * under 15% of the horse's chips. So the two rules are ordered like this:
 *  - the paired-board fold keeps priority ONLY for a real stack-off, measured
 *    on the horse's own chips with that rule's own lines: the call is at
 *    least a quarter of the stack the horse has left, or it leaves the horse
 *    all in (a horse that has already put most of its chips in this pot);
 *  - otherwise, in the short all-in spot, the paired-board fold stands aside
 *    (HorseLogic.pairedBoardFold asks pairedBoardFoldYieldsToShortAllIn) and
 *    this floor calls.
 * Every paired-board fold outside the short all-in spot is unchanged.
 */
import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import { variantInfo } from './HorseEval.js';
import { ploPairedBoardMustFold } from './HorsePloPairedBoardFold.js';

/** The shove (or the amount to add) must be UNDER this many big blinds. */
export const SHORT_ALL_IN_MAX_BB = 3;
/** The horse must hold at least this many big blinds. */
export const SHORT_ALL_IN_CALLER_MIN_BB = 20;
/** Postflop, a hand measured under this equity is drawing (nearly) dead. */
export const SHORT_ALL_IN_DEAD_EQUITY = 0.05;

/** The paired-board rule's own commitment share of the horse's stack. */
const PAIRED_BOARD_STACK_OFF_SHARE = 0.25;

const EPS = 0.005;

export interface ShortAllInSpot {
  /** The shover's whole-hand total, in big blinds. */
  shoveBB: number;
  /** What the horse must add to call, in big blinds. */
  toCallBB: number;
  /** The horse's stack plus what it already has in the pot, in big blinds. */
  heroBB: number;
  /** What the horse must add to call, in chips. */
  toCall: number;
  /** The share of the final pot the call pays for. */
  requiredEquity: number;
}

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** The engine always passes gameMode; offline callers fall back to the context. */
function isTournament(gs: HorseGameStateV2): boolean {
  if (gs.gameMode) return gs.gameMode === 'tournament';
  return gs.tournament != null;
}

/** The spot the rule covers, or null when it does not apply. Pure. */
export function shortAllInSpot(hero: SeatPlayer, gs: HorseGameStateV2): ShortAllInSpot | null {
  if (!isTournament(gs)) return null;
  const bb = finite(gs.bigBlind);
  if (!(bb > 0)) return null;
  const stack = Math.max(0, finite(hero.stack));
  const heroBet = Math.max(0, finite(hero.bet));
  const currentBet = Math.max(0, finite(gs.currentBet));
  const toCall =
    typeof gs.toCall === 'number' && Number.isFinite(gs.toCall)
      ? Math.max(0, gs.toCall)
      : Math.max(0, currentBet - heroBet);
  if (toCall <= EPS || stack <= 0) return null;

  // The horse must be facing an all in: a live opponent who is all in and has
  // more in front of it this street than the horse does. Callers of that all
  // in (multiway) do not matter. A player WITH chips left who bet more than
  // the biggest all in is a raise, and then the horse is facing that raise,
  // not a short all in - unless that "bet" is only the posted big blind
  // (a short all in for less than the blind, preflop).
  let shover: SeatPlayer | null = null;
  let biggestLiveBet = 0;
  for (const p of gs.players ?? []) {
    if (p.seat === hero.seat || p.user_id === hero.user_id || p.is_folded) continue;
    const bet = finite(p.bet);
    if (p.is_all_in) {
      if (bet > heroBet + EPS && (!shover || bet > finite(shover.bet))) shover = p;
    } else {
      biggestLiveBet = Math.max(biggestLiveBet, bet);
    }
  }
  if (!shover) return null;
  const shoverBet = finite(shover.bet);
  const forcedBlindOnly = gs.stage === 'preflop' && biggestLiveBet <= bb + EPS;
  if (biggestLiveBet > shoverBet + EPS && !forcedBlindOnly) return null;
  if (shoverBet < currentBet - EPS && !forcedBlindOnly) return null;

  const shoveTotal = Math.max(shoverBet, finite(shover.totalInvested));
  const heroTotal = stack + Math.max(heroBet, finite(hero.totalInvested));
  const shoveBB = shoveTotal / bb;
  const toCallBB = toCall / bb;
  const heroBB = heroTotal / bb;
  if (heroBB < SHORT_ALL_IN_CALLER_MIN_BB - 1e-9) return null;
  if (!(shoveBB < SHORT_ALL_IN_MAX_BB || toCallBB < SHORT_ALL_IN_MAX_BB)) return null;
  const pot = Math.max(0, finite(gs.pot));
  return { shoveBB, toCallBB, heroBB, toCall, requiredEquity: toCall / (pot + toCall || 1) };
}

/**
 * True when the PLO paired-board fold would fold this hand AND calling is a
 * real stack-off for the horse (a quarter or more of the stack it has left,
 * or every chip of it). Only then does that fold outrank the short all-in
 * floor.
 */
export function pairedBoardStackOff(hero: SeatPlayer, gs: HorseGameStateV2): boolean {
  const stack = Math.max(0, finite(hero.stack));
  const toCall =
    typeof gs.toCall === 'number' && Number.isFinite(gs.toCall)
      ? Math.max(0, gs.toCall)
      : Math.max(0, finite(gs.currentBet) - finite(hero.bet));
  if (!(toCall >= stack * PAIRED_BOARD_STACK_OFF_SHARE || toCall >= stack - EPS)) return false;
  let hiLo: boolean;
  try {
    hiLo = gs.variantRules
      ? gs.variantRules.splitLow8OrBetter
      : variantInfo(gs.gameVariant ?? 'nlh').isHiLo;
  } catch {
    hiLo = false;
  }
  return ploPairedBoardMustFold({
    gameVariant: gs.gameVariant,
    hiLo,
    multiBoard: !!(gs.communityCards2?.length || gs.communityCards3?.length),
    board: gs.communityCards ?? [],
    hero,
    players: gs.players ?? [],
    currentBet: gs.currentBet,
    toCall: gs.toCall,
    pot: gs.pot,
  });
}

/**
 * Asked by HorseLogic's paired-board wrapper: in the short all-in spot, and
 * when calling is not a real stack-off, the paired-board fold stands aside.
 */
export function pairedBoardFoldYieldsToShortAllIn(hero: SeatPlayer, gs: HorseGameStateV2): boolean {
  return shortAllInSpot(hero, gs) !== null && !pairedBoardStackOff(hero, gs);
}

/** The legal way to call, from the authoritative menu when there is one. */
function legalCall(
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  toCall: number
): Pick<HorseDecision, 'action' | 'amount'> | null {
  const legal = Array.isArray(gs.legalActions) ? new Set(gs.legalActions) : null;
  const stack = Math.max(0, finite(hero.stack));
  const cents = (v: number): number => Math.round(v * 100) / 100;
  if (toCall >= stack - EPS) {
    if (!legal || legal.has('all_in')) return { action: 'all_in' };
    if (legal.has('call')) return { action: 'call', amount: cents(stack) };
    return null;
  }
  if (!legal || legal.has('call')) return { action: 'call', amount: cents(toCall) };
  // All-in-or-fold: going all in is the only call there is.
  if (legal.has('all_in')) return { action: 'all_in' };
  return null;
}

/**
 * The final chokepoint. Turns a FOLD into the legal call in the spot above;
 * returns the input object unchanged otherwise, so callers can test identity.
 *
 * `equity` is the brain's own Monte Carlo equity for this decision (postflop
 * only). null or undefined means it was not measured, and the horse calls.
 */
export function shortAllInCallFloor(
  decision: HorseDecision,
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  equity?: number | null
): HorseDecision {
  if (decision.action !== 'fold') return decision;
  const spot = shortAllInSpot(hero, gs);
  if (!spot) return decision;
  // A real paired-board stack-off keeps its fold (see the header).
  if (pairedBoardStackOff(hero, gs)) return decision;
  if (
    gs.stage !== 'preflop' &&
    typeof equity === 'number' &&
    Number.isFinite(equity) &&
    equity < SHORT_ALL_IN_DEAD_EQUITY &&
    equity < spot.requiredEquity
  ) {
    return decision;
  }
  const call = legalCall(hero, gs, spot.toCall);
  if (!call) return decision;
  // Keep the brain's own think time and receipts; drop the fold-only guard.
  const called: HorseDecision = { ...decision, action: call.action };
  if (call.amount === undefined) delete called.amount;
  else called.amount = call.amount;
  delete called.continuationGuard;
  return called;
}
