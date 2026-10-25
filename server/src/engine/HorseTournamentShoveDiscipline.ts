/**
 * TOURNAMENT SHOVE DISCIPLINE (Dan 2026-10-25)
 *
 * Dan, after real players told him so: "BIGGER STACKS SHOULD NOT BE OPEN
 * RIPPING 35+ BIGS UTG OR PERIOD!"
 *
 * Measured on production before this rule, NLH tournaments, last 24-48 hours:
 *  - heads-up Sit & Gos open-shoved 93% of first-in hands at 20-25bb and 64%
 *    at 25-35bb; Spins open-shoved 59% at 25-35bb;
 *  - MTT stacks of 20-25bb open-shoved 26% of their first-in decisions;
 *  - every day 50-130 re-raise shoves went in with 35+ big blinds effective,
 *    most of them AA/KK/QQ/AK 3-bet or 4-bet ALL-IN for 50-100+ big blinds,
 *    which only ever gets called by the hands that beat them.
 *
 * Several policy owners can propose that shove (the reference ladder, the
 * Phase 7 utility arbiter, the joint node). This is a WAGER RULE, applied
 * once at the end of the decision and again at commit time, so it holds
 * whoever proposed the shove: a tournament shove is only ever allowed at a
 * depth where shoving is the real strategy. Deeper than that, the same
 * aggression is a sized raise.
 *
 *  first in (open)          shove only at <= 15bb effective
 *  facing one raise (3-bet) shove only at <= 25bb effective
 *  facing a 3-bet (4-bet)   shove only at <= 40bb effective
 *  facing a 4-bet or more   unchanged (a 5-bet is all-in by nature)
 *
 * Above the line the shove becomes a standard raise. If that standard raise
 * would already put 40% of the effective stack in, the shove is kept: at that
 * point the raise IS the commitment and a raise-fold would be the worst line.
 *
 * And at any depth, a stack that COVERS everyone who can still call never
 * shoves more chips than they can call: it raises to exactly what the biggest
 * of them has. The pressure is identical; the "big stack rips 80 blinds"
 * picture players see is gone.
 *
 * Never touched: cash games, pot-limit and fixed-limit betting, all-in-or-
 * fold tables, postflop streets, and a "shove" that is really a call because
 * nobody behind has chips left to act with.
 */

import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';

/** Deepest effective stack (in big blinds) that may shove first in. */
export const TOURNAMENT_OPEN_SHOVE_MAX_BB = 15;
/** Deepest effective stack that may shove over a single raise. */
export const TOURNAMENT_THREE_BET_SHOVE_MAX_BB = 25;
/** Deepest effective stack that may shove over a 3-bet. */
export const TOURNAMENT_FOUR_BET_SHOVE_MAX_BB = 40;
/** A standard raise this large a share of the effective stack is a shove. */
export const TOURNAMENT_COMMITTED_RAISE_SHARE = 0.4;

export interface ShoveDisciplineRead {
  /** 0 unopened, 1 facing an open, 2 facing a 3-bet, 3+ facing a 4-bet or more. */
  level: number;
  /** Effective stack against everyone who can still put chips in, in big blinds. */
  effectiveBB: number;
  /** Most chips (street total) any live opponent can reach this street. */
  coverTo: number;
  /** Callers of the current bet (limpers when unopened). */
  callers: number;
}

const EPS = 0.000001;

function isTournament(gs: HorseGameStateV2): boolean {
  if (gs.gameMode) return gs.gameMode === 'tournament';
  return gs.tournament != null;
}

function noLimit(gs: HorseGameStateV2): boolean {
  if (gs.bettingStructure) return gs.bettingStructure === 'no_limit';
  const v = String(gs.gameVariant ?? 'nlh').toLowerCase();
  return !v.startsWith('plo') && !v.includes('omaha') && !v.includes('limit');
}

/** Down to the table's settlement unit (whole chips in tournaments). */
function wholeChip(gs: HorseGameStateV2, amount: number): number {
  const unit = gs.chipUnit === 0.01 ? 0.01 : 1;
  return Math.round(Math.floor(amount / unit + EPS) * unit * 100) / 100;
}

/** Same routing count HorseLogic's preflop glue uses (V28: any all-in that
 * moved the bet is a raise; an all-in call-off is a caller). */
export function readShoveSpot(hero: SeatPlayer, gs: HorseGameStateV2): ShoveDisciplineRead | null {
  const bb = gs.bigBlind;
  if (!(bb > 0)) return null;
  const history = (gs.actionHistory ?? []).filter((a) => a.stage === 'preflop');
  let raises = 0;
  let callers = 0;
  for (const a of history) {
    const aggr =
      a.action === 'raise' ||
      a.action === 'bet' ||
      (a.action === 'all_in' && a.isFullRaise !== undefined);
    if (aggr) {
      raises++;
      callers = 0;
    } else if (a.action === 'call' || a.action === 'all_in') callers++;
  }
  const straddled =
    gs.straddleActive === true &&
    raises === 0 &&
    gs.currentBet > bb * 1.05 &&
    gs.currentBet <= bb * 2.2;
  if (!straddled && history.length === 0 && gs.currentBet > bb * 1.05) {
    raises = gs.currentBet > bb * 4.5 ? 2 : 1;
  }
  let coverTo = 0;
  for (const p of gs.players) {
    if (p.seat === hero.seat || p.is_folded) continue;
    if (p.is_sitting_out && !p.is_all_in) continue;
    const total = (p.stack ?? 0) + (p.bet ?? 0);
    if (total > coverTo) coverTo = total;
  }
  const heroTotal = hero.stack + hero.bet;
  return {
    level: raises,
    effectiveBB: Math.min(heroTotal, coverTo) / bb,
    coverTo,
    callers,
  };
}

/** A legal no-limit raise to `to`, or null when the menu cannot carry it. */
function legalRaise(
  decision: HorseDecision,
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  to: number
): HorseDecision | null {
  if (!Array.isArray(gs.legalActions) || !gs.legalActions.includes('raise')) return null;
  const min = gs.minRaiseTo;
  const max = gs.maxRaiseTo;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const heroTotal = hero.stack + hero.bet;
  const amount = wholeChip(gs, Math.max(min as number, Math.min(to, max as number)));
  if (amount < (min as number) - EPS || amount > (max as number) + EPS) return null;
  // A raise that leaves nothing behind is the shove itself.
  if (amount >= heroTotal - EPS) return null;
  if (amount <= gs.currentBet + EPS) return null;
  return { ...decision, action: 'raise', amount };
}

/**
 * Rewrites a deep tournament preflop shove into the raise a strong player
 * makes instead. Returns the input object unchanged whenever the rule does
 * not apply, so callers can test identity.
 */
export function tournamentShoveDiscipline(
  decision: HorseDecision,
  hero: SeatPlayer,
  gs: HorseGameStateV2
): HorseDecision {
  if (gs.stage !== 'preflop' || !isTournament(gs) || !noLimit(gs)) return decision;
  if (gs.allInOrFold === true || gs.wagersCapped === true) return decision;
  const heroTotal = hero.stack + hero.bet;
  if (!(heroTotal > 0)) return decision;
  const shove =
    decision.action === 'all_in' ||
    (decision.action === 'raise' &&
      Number.isFinite(decision.amount) &&
      (decision.amount as number) >= heroTotal - EPS);
  if (!shove) return decision;
  // A shove that does not exceed the bet is a call-off, not a raise.
  if (heroTotal <= gs.currentBet + EPS) return decision;
  const spot = readShoveSpot(hero, gs);
  if (!spot) return decision;
  // Nobody behind can put another chip in: the "shove" only calls.
  const someoneCanAct = gs.players.some(
    (p) =>
      p.seat !== hero.seat &&
      !p.is_folded &&
      !p.is_all_in &&
      !p.is_sitting_out &&
      (p.stack ?? 0) > 0
  );
  if (!someoneCanAct || spot.coverTo <= gs.currentBet + EPS) return decision;

  const bb = gs.bigBlind;
  const eff = spot.effectiveBB;
  const effChips = eff * bb;
  const cap =
    spot.level <= 0
      ? TOURNAMENT_OPEN_SHOVE_MAX_BB
      : spot.level === 1
        ? TOURNAMENT_THREE_BET_SHOVE_MAX_BB
        : spot.level === 2
          ? TOURNAMENT_FOUR_BET_SHOVE_MAX_BB
          : Infinity;

  if (eff > cap) {
    let to: number;
    if (spot.level <= 0) {
      // Open 2.2x, plus one big blind per limper.
      to = bb * 2.2 + bb * spot.callers;
    } else if (spot.level === 1) {
      // 3-bet to 3x the open, plus one open per caller; 3.5x from the blinds.
      const blinds =
        gs.blindSeats != null &&
        (hero.seat === gs.blindSeats.bigBlind || hero.seat === gs.blindSeats.smallBlind);
      to = gs.currentBet * (blinds ? 3.5 : 3) + gs.currentBet * spot.callers;
    } else {
      to = gs.currentBet * 2.25 + gs.currentBet * spot.callers * 0.5;
    }
    if (to >= effChips * TOURNAMENT_COMMITTED_RAISE_SHARE)
      return coverOnly(decision, hero, gs, spot);
    return legalRaise(decision, hero, gs, to) ?? coverOnly(decision, hero, gs, spot);
  }
  return coverOnly(decision, hero, gs, spot);
}

/** Within the shove line: a stack that covers the field raises to exactly
 * what the biggest live opponent can call, never its whole stack. */
function coverOnly(
  decision: HorseDecision,
  hero: SeatPlayer,
  gs: HorseGameStateV2,
  spot: ShoveDisciplineRead
): HorseDecision {
  const heroTotal = hero.stack + hero.bet;
  if (heroTotal <= spot.coverTo + EPS) return decision;
  return legalRaise(decision, hero, gs, spot.coverTo) ?? decision;
}
