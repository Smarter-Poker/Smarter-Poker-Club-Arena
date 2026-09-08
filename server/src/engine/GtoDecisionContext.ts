/**
 * Canonical postflop solver-node classification.
 *
 * The compact V31 corpus and the live horse must name a decision state the
 * same way.  A response policy is only eligible when the public betting line
 * proves that exact response node; an open-node policy is never substituted.
 * This module is deliberately deterministic and I/O-free so the worker-side
 * compact builder can mirror it byte-for-byte.
 */

import type { ActionRecord, HandStage, SeatPlayer } from '../types.js';

export type GtoV31NodeRole =
  | 'open'
  | 'cbet'
  | 'probe'
  | 'delayed_cbet'
  | 'barrel'
  | 'facing_bet'
  | 'facing_raise'
  | 'check_raise'
  | 'bet_raise'
  | 'all_in';

export type GtoV31FacingKind = 'none' | 'bet' | 'raise' | 'all_in';
export type GtoV31SizeBucket = 'none' | 'small' | 'mid' | 'big' | 'all_in';
export type GtoV31PotType = 'limped' | 'srp' | '3bet' | '4bet_plus';
export type GtoV31Position =
  | 'UTG'
  | 'UTG1'
  | 'UTG2'
  | 'UTG3'
  | 'MP'
  | 'HJ'
  | 'CO'
  | 'BTN'
  | 'SB'
  | 'BB';
export type GtoV31UtilityContext =
  | 'cash_ev'
  | 'chip_ev'
  | 'spin_ladder'
  | 'satellite'
  | 'bubble'
  | 'final_table'
  | 'in_money'
  | 'ladder';

export interface GtoDecisionContext {
  nodeRole: GtoV31NodeRole;
  facingKind: GtoV31FacingKind;
  facingSizeBucket: GtoV31SizeBucket;
}

const POSTFLOP_STREETS: HandStage[] = ['flop', 'turn', 'river'];

function committedOnStreet(
  history: ActionRecord[] | undefined,
  seat: number,
  street: HandStage
): { amount: number; acted: boolean } | null {
  let committed = 0;
  let acted = false;
  for (const action of Array.isArray(history) ? history : []) {
    if (action.stage !== street || action.seat !== seat || action.action === 'discard') continue;
    acted = true;
    const amount = action.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
    if (action.action === 'call') {
      if (amount <= 0) return null;
      committed += amount;
    } else if (action.action === 'bet' || action.action === 'raise' || action.action === 'all_in') {
      if (amount <= 0 || amount < committed) return null;
      committed = amount;
    } else if (action.action === 'fold' || amount !== 0) {
      // A seat that folded cannot own a later-street decision. Checks carry
      // no chips. Either shape is contradictory evidence, not a zero spend.
      return null;
    }
  }
  return { amount: committed, acted };
}

/**
 * Effective-stack depth in a Pio postflop tree is the stack behind at its flop
 * root. `stack + bet` only recovers the start of the current street, so turn
 * and river lookups must add back chips committed on completed postflop
 * streets. Otherwise a line solved from 80bb can silently consume a 20bb cell
 * after a large flop and turn.
 */
export function gtoV31FlopRootStack(args: {
  street: Extract<HandStage, 'flop' | 'turn' | 'river'>;
  player: Pick<SeatPlayer, 'seat' | 'stack' | 'bet'>;
  actionHistory?: ActionRecord[];
}): number | null {
  const stack = args.player.stack;
  const bet = args.player.bet;
  if (
    typeof stack !== 'number' ||
    !Number.isFinite(stack) ||
    stack < 0 ||
    typeof bet !== 'number' ||
    !Number.isFinite(bet) ||
    bet < 0
  ) {
    return null;
  }
  const streetIndex = POSTFLOP_STREETS.indexOf(args.street);
  if (streetIndex < 0) return null;
  const current = committedOnStreet(args.actionHistory, args.player.seat, args.street);
  // Postflop has no forced wager. A state/history disagreement means the
  // amount already spent on this street is unknowable, so a certified depth
  // lookup must decline rather than guess.
  if (current === null || Math.abs(current.amount - bet) > 0.005) return null;
  let rootStack = stack + bet;
  for (const priorStreet of POSTFLOP_STREETS.slice(0, streetIndex)) {
    const committed = committedOnStreet(args.actionHistory, args.player.seat, priorStreet);
    // Reaching a later street heads-up requires this seat to have completed
    // every earlier betting round. An absent street is missing evidence, not
    // proof that zero chips were committed.
    if (committed === null || !committed.acted) return null;
    rootStack += committed.amount;
  }
  return Number.isFinite(rootStack) && rootStack > 0 ? rootStack : null;
}

function wasDealtIn(player: SeatPlayer, requiredSeat?: number): boolean {
  return (
    player.seat === requiredSeat ||
    (Number(player.totalInvested) || 0) > 0 ||
    (Array.isArray(player.cards) && player.cards.length > 0) ||
    !player.is_sitting_out
  );
}

/** Seats in the original hand, not merely the players still live now. */
export function gtoV31DealtInSeats(players: SeatPlayer[], requiredSeat?: number): number[] {
  return (Array.isArray(players) ? players : [])
    .filter((player) => wasDealtIn(player, requiredSeat))
    .map((player) => player.seat)
    .filter((seat) => Number.isInteger(seat))
    .sort((a, b) => a - b);
}

function clockwiseOrder(seats: number[], dealerSeat: number): number[] {
  const result: number[] = [];
  let cursor = dealerSeat;
  for (let index = 0; index < seats.length; index++) {
    const next = seats.find((seat) => seat > cursor) ?? seats[0];
    if (next === undefined || result.includes(next)) return [];
    result.push(next);
    cursor = next;
  }
  return result;
}

const NON_BLIND_POSITIONS: Record<number, GtoV31Position[]> = {
  3: ['BTN'],
  4: ['CO', 'BTN'],
  5: ['HJ', 'CO', 'BTN'],
  6: ['UTG', 'HJ', 'CO', 'BTN'],
  7: ['UTG', 'MP', 'HJ', 'CO', 'BTN'],
  8: ['UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['UTG', 'UTG1', 'UTG2', 'MP', 'HJ', 'CO', 'BTN'],
  10: ['UTG', 'UTG1', 'UTG2', 'UTG3', 'MP', 'HJ', 'CO', 'BTN'],
};

/**
 * Exact solver seat label for 2-10 handed tables.
 *
 * `tableSize` remains a separate key, so labels that collapse by convention
 * (for example five-handed HJ and six-handed HJ) can never share a cell.
 */
export function gtoV31Position(args: {
  seat: number;
  dealerSeat?: number;
  players: SeatPlayer[];
}): { position: GtoV31Position; tableSize: number } | null {
  const seats = gtoV31DealtInSeats(args.players, args.seat);
  if (
    args.dealerSeat === undefined ||
    !Number.isInteger(args.dealerSeat) ||
    seats.length < 2 ||
    seats.length > 10 ||
    !seats.includes(args.seat) ||
    !seats.includes(args.dealerSeat)
  ) {
    return null;
  }
  if (seats.length === 2) {
    return {
      position: args.seat === args.dealerSeat ? 'SB' : 'BB',
      tableSize: 2,
    };
  }
  const order = clockwiseOrder(seats, args.dealerSeat);
  const index = order.indexOf(args.seat);
  if (index === 0) return { position: 'SB', tableSize: seats.length };
  if (index === 1) return { position: 'BB', tableSize: seats.length };
  const position = NON_BLIND_POSITIONS[seats.length]?.[index - 2];
  return position ? { position, tableSize: seats.length } : null;
}

/** Preflop raise family carried into every postflop solver key. */
export function gtoV31PotType(history: ActionRecord[] | undefined): GtoV31PotType {
  const raises = (Array.isArray(history) ? history : []).filter(
    (action) =>
      action.stage === 'preflop' &&
      (action.action === 'raise' ||
        action.action === 'bet' ||
        (action.action === 'all_in' && action.isFullRaise !== undefined))
  ).length;
  if (raises === 0) return 'limped';
  if (raises === 1) return 'srp';
  if (raises === 2) return '3bet';
  return '4bet_plus';
}

/**
 * The finite tournament-utility abstraction a compact policy was solved for.
 * Bounty events fail closed because ordinary Pio ICM does not price bounties.
 */
export function gtoV31UtilityContext(args: {
  objective: 'cash_ev' | 'chip_ev' | 'icm';
  family: 'cash' | 'spin' | 'tourney_ev' | 'tourney_icm';
  tournament?: {
    nearBubble?: boolean;
    inMoney?: boolean;
    finalTable?: boolean;
    satellite?: boolean;
    bountyFactor?: number;
    mysteryChestsLeft?: number;
    meanBountyCents?: number;
  };
}): GtoV31UtilityContext | null {
  if (args.objective === 'cash_ev') return args.family === 'cash' ? 'cash_ev' : null;
  const tournament = args.tournament;
  // Inspect event utility before accepting even a chip-EV tournament cell.
  // Otherwise a bounty event with incomplete ICM inputs silently falls into
  // tourney_ev and consumes a freezeout policy that cannot price the head.
  if (
    (tournament?.bountyFactor ?? 0) > 0 ||
    (tournament?.mysteryChestsLeft ?? 0) > 0 ||
    (tournament?.meanBountyCents ?? 0) > 0
  ) {
    return null;
  }
  if (args.objective === 'chip_ev') {
    return args.family === 'spin' || args.family === 'tourney_ev' ? 'chip_ev' : null;
  }
  if (!tournament) return null;
  if (args.family === 'spin') return 'spin_ladder';
  if (args.family !== 'tourney_icm') return null;
  if (tournament.satellite) return 'satellite';
  if (tournament.finalTable) return 'final_table';
  if (tournament.nearBubble) return 'bubble';
  if (tournament.inMoney) return 'in_money';
  return 'ladder';
}

/** A heads-up solver tree cannot answer a pot with prior postflop third-party action. */
export function gtoV31HasHeadsUpPostflopLine(
  history: ActionRecord[] | undefined,
  heroSeat: number,
  opponentSeat: number
): boolean {
  const allowed = new Set([heroSeat, opponentSeat]);
  return (Array.isArray(history) ? history : []).every(
    (action) =>
      !POSTFLOP_STREETS.includes(action.stage) ||
      action.action === 'discard' ||
      allowed.has(action.seat)
  );
}

function isAggressive(action: ActionRecord | undefined): boolean {
  return (
    action?.action === 'bet' ||
    action?.action === 'raise' ||
    (action?.action === 'all_in' && action.isFullRaise !== undefined)
  );
}

function previousStreet(street: HandStage): HandStage | null {
  if (street === 'flop') return 'preflop';
  if (street === 'turn') return 'flop';
  if (street === 'river') return 'turn';
  return null;
}

function priorToPreviousStreet(street: HandStage): HandStage | null {
  if (street === 'turn') return 'preflop';
  if (street === 'river') return 'flop';
  return null;
}

/** Last aggressor on a street, or null when that street had no wager. */
export function lastAggressor(
  history: ActionRecord[] | undefined,
  street: HandStage
): number | null {
  const actions = Array.isArray(history) ? history : [];
  for (let index = actions.length - 1; index >= 0; index--) {
    const action = actions[index];
    if (action.stage === street && isAggressive(action)) return action.seat;
  }
  return null;
}

/**
 * Size family shared by corpus production and runtime lookup.
 *
 * The fraction is bet/pot-before for a bet and raise-increment/pot-after-call
 * for a raise.  Those denominators are intentionally different and must be
 * calculated before calling this function.
 */
export function gtoV31SizeBucket(
  fraction: number | null | undefined,
  allIn = false
): GtoV31SizeBucket {
  if (allIn) return 'all_in';
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0) return 'none';
  if (fraction < 0.6) return 'small';
  if (fraction < 1.1) return 'mid';
  return 'big';
}

function currentStreetActions(
  history: ActionRecord[] | undefined,
  street: HandStage
): ActionRecord[] {
  if (!Array.isArray(history)) return [];
  return history.filter((action) => action.stage === street && action.action !== 'discard');
}

function checkedThroughHeadsUp(
  history: ActionRecord[] | undefined,
  street: HandStage,
  heroSeat: number,
  opponentSeat: number
): boolean {
  const actions = currentStreetActions(history, street);
  if (actions.length !== 2) return false;
  return (
    actions.every((action) => action.action === 'check') &&
    new Set(actions.map((action) => action.seat)).size === 2 &&
    actions.some((action) => action.seat === heroSeat) &&
    actions.some((action) => action.seat === opponentSeat)
  );
}

/**
 * Classify the live public line at the instant hero must act.
 *
 * `pot` includes the wager currently faced, matching HorseGameState. For a
 * first bet, the raw wager divided by pot-before is the size. For a raise,
 * reconstruct the earlier decision boundary and divide the raise increment by
 * the pot after the raiser called the previous wager. The live hero's later
 * call boundary is larger and would systematically understate every raise.
 */
export function classifyGtoDecisionContext(args: {
  street: HandStage;
  hero: Pick<SeatPlayer, 'seat' | 'bet' | 'stack'>;
  opponents: Array<Pick<SeatPlayer, 'seat' | 'bet' | 'stack' | 'is_all_in'>>;
  actionHistory?: ActionRecord[];
  currentBet: number;
  pot: number;
}): GtoDecisionContext | null {
  if (!POSTFLOP_STREETS.includes(args.street)) return null;
  const actions = currentStreetActions(args.actionHistory, args.street);
  if (
    !Number.isFinite(args.hero.bet) ||
    args.hero.bet < 0 ||
    !Number.isFinite(args.hero.stack) ||
    args.hero.stack <= 0 ||
    !Number.isFinite(args.currentBet) ||
    args.currentBet < args.hero.bet ||
    !Number.isFinite(args.pot) ||
    args.pot <= 0
  ) {
    return null;
  }
  const heroBet = args.hero.bet;
  const currentBet = args.currentBet;
  const toCall = Math.max(0, currentBet - heroBet);
  const lastAggressive = [...actions].reverse().find(isAggressive);

  if (toCall > 0 && lastAggressive && lastAggressive.seat !== args.hero.seat) {
    const opponent = args.opponents.find((player) => player.seat === lastAggressive.seat);
    if (!opponent) return null;
    const wager = Number(lastAggressive.amount);
    // The latest wager target is the same number HandController publishes as
    // currentBet. If those two facts disagree, reconstructing either a size or
    // an effective all-in node would certify a state that never existed.
    if (!Number.isFinite(wager) || wager <= 0 || Math.abs(wager - currentBet) > 0.005) return null;
    const heroStack = args.hero.stack;
    // A covering opponent need not be all-in for the wager to put hero all-in.
    // Pio solves at effective stack, so a target that consumes every chip hero
    // can contest belongs to the all-in response node just as surely as an
    // opponent whose own stack reached zero.
    const allIn =
      lastAggressive.action === 'all_in' ||
      opponent.is_all_in === true ||
      wager >= heroBet + heroStack - 0.005;
    const lastAggressiveIndex = actions.lastIndexOf(lastAggressive);
    let heroAggressiveIndex = -1;
    for (let index = lastAggressiveIndex - 1; index >= 0; index--) {
      const action = actions[index];
      if (action.seat === args.hero.seat && isAggressive(action)) {
        heroAggressiveIndex = index;
        break;
      }
    }
    const heroAggressive = heroAggressiveIndex >= 0 ? actions[heroAggressiveIndex] : undefined;
    const opponentCheckedBeforeHeroBet =
      heroAggressiveIndex >= 0 &&
      actions
        .slice(0, heroAggressiveIndex)
        .some((action) => action.seat === lastAggressive.seat && action.action === 'check');

    let nodeRole: GtoV31NodeRole;
    let facingKind: GtoV31FacingKind;
    if (allIn) {
      nodeRole = 'all_in';
      facingKind = 'all_in';
    } else if (lastAggressive.action === 'raise') {
      if (!heroAggressive) return null;
      nodeRole =
        heroAggressive.action === 'raise' || heroAggressive.action === 'all_in'
          ? 'facing_raise'
          : opponentCheckedBeforeHeroBet
            ? 'check_raise'
            : 'bet_raise';
      facingKind = 'raise';
    } else {
      nodeRole = 'facing_bet';
      facingKind = 'bet';
    }

    let fraction: number | null = null;
    if (facingKind === 'bet') {
      const potBefore = args.pot - wager;
      if (potBefore <= 0) return null;
      fraction = wager / potBefore;
    } else if (facingKind === 'raise') {
      const priorActions = actions.slice(0, lastAggressiveIndex);
      const previousTarget = Math.max(
        0,
        ...priorActions.filter(isAggressive).map((action) => Number(action.amount) || 0)
      );
      const raiserPriorAggression = [...priorActions]
        .reverse()
        .find((action) => action.seat === lastAggressive.seat && isAggressive(action));
      const raiserPriorContribution = Math.max(0, Number(raiserPriorAggression?.amount) || 0);
      const raiseIncrement = Math.max(0, wager - previousTarget);
      const chipsAddedByRaise = wager - raiserPriorContribution;
      const raiserCall = previousTarget - raiserPriorContribution;
      const potBeforeRaise = args.pot - chipsAddedByRaise;
      const potAfterRaiserCall = potBeforeRaise + raiserCall;
      if (
        chipsAddedByRaise <= 0 ||
        raiserCall < 0 ||
        raiseIncrement <= 0 ||
        potBeforeRaise <= 0 ||
        potAfterRaiserCall <= 0
      ) {
        return null;
      }
      fraction = raiseIncrement / potAfterRaiserCall;
    }
    return {
      nodeRole,
      facingKind,
      facingSizeBucket: gtoV31SizeBucket(fraction, allIn),
    };
  }

  const previous = previousStreet(args.street);
  const priorAggressor = previous ? lastAggressor(args.actionHistory, previous) : null;
  const older = priorToPreviousStreet(args.street);
  const olderAggressor = older ? lastAggressor(args.actionHistory, older) : null;
  const heroActedThisStreet = actions.some((action) => action.seat === args.hero.seat);
  if (heroActedThisStreet) {
    // A second decision with no wager to answer cannot be an open node. It
    // should normally have advanced the street; decline rather than applying
    // an opening policy to a stale or incomplete action history.
    return null;
  }

  let nodeRole: GtoV31NodeRole = 'open';
  if (priorAggressor === args.hero.seat) {
    nodeRole = args.street === 'flop' ? 'cbet' : 'barrel';
  } else if (priorAggressor !== null) {
    // Leading into the immediately previous street's aggressor is a donk/lead
    // node, not a probe. Phase 4 has no certified donk corpus, so do not
    // relabel it as one of the supported open roles.
    return null;
  } else if (args.street !== 'flop') {
    const opponentSeat = args.opponents.length === 1 ? args.opponents[0].seat : null;
    if (
      opponentSeat === null ||
      !previous ||
      !checkedThroughHeadsUp(args.actionHistory, previous, args.hero.seat, opponentSeat)
    ) {
      return null;
    }
    if (olderAggressor === args.hero.seat) nodeRole = 'delayed_cbet';
    else if (olderAggressor !== null) nodeRole = 'probe';
  }
  return { nodeRole, facingKind: 'none', facingSizeBucket: 'none' };
}
