import type {
  ActionRecord,
  ActionType,
  BettingState,
  HandStage,
  HorseDecision,
  SeatPlayer,
} from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { calculateBettingState, validateAction } from '../PokerEngine.js';
import {
  fixedLimitBetSize,
  fixedLimitStreetBounds,
  isFixedLimitCapped,
  type BettingStructure,
} from '../BettingStructure.js';
import { buildTournamentActionCandidates } from '../HorseTournamentUtility.js';

/**
 * Phase 13 P13-A: the betting state of ONE street inside the bounded joint
 * response tree. It is a memory-only replica of the HandController street
 * state that matters for a response: pot, standing bet, last full raise and
 * this street's accepted action records (with their isFullRaise flags).
 *
 * The legality functions below follow HandController exactly:
 * buildBettingState -> jointBettingState, canReopenBetting -> jointMayReopen,
 * clampToStructure -> clampJointAllIn, getAvailableActions plus
 * getAuthoritativeActionState -> jointLegalMenu, and the performAction
 * mutation -> applyJointAction. The controller methods are private, so these
 * are replicas; JointStreetBetting.test.ts drives a real HandController
 * through full raises, short all-ins, fixed-limit caps and pot-limit ceilings
 * and requires the replica's menu, bounds and reopening rights to equal the
 * controller's authoritative action state at every step.
 */
export interface JointStreet {
  stage: HandStage;
  structure: BettingStructure;
  pot: number;
  currentBet: number;
  lastRaise: number;
  bigBlind: number;
  /** Effective fixed-limit small bet (the kill's on a kill hand). */
  smallBet: number;
  chipUnit: 0.01 | 1;
  history: ActionRecord[];
}

const EPS = 0.005;
const snap = (value: number, unit: number) => Math.round(value / unit) * unit;

export function openJointStreet(state: HorseGameStateV2): JointStreet {
  const structure = state.bettingStructure;
  if (
    !structure ||
    !['no_limit', 'pot_limit', 'fixed_limit'].includes(structure) ||
    !(state.bigBlind > 0) ||
    !Number.isFinite(state.pot) ||
    !Number.isFinite(state.currentBet)
  )
    throw new Error('joint_response_street_unavailable');
  const history = (state.actionHistory ?? [])
    .filter((a) => a.stage === state.stage)
    .map((a) => ({ ...a }));
  // The controller passes lastRaise on every live request. Offline fixtures
  // that omit it carry no full raise beyond the standing bet itself.
  const lastRaise =
    typeof state.lastRaise === 'number' && Number.isFinite(state.lastRaise)
      ? state.lastRaise
      : Math.max(0, state.currentBet);
  return {
    stage: state.stage,
    structure,
    pot: state.pot,
    currentBet: state.currentBet,
    lastRaise,
    bigBlind: state.bigBlind,
    smallBet:
      typeof state.fixedLimitSmallBet === 'number' && state.fixedLimitSmallBet > 0
        ? state.fixedLimitSmallBet
        : state.bigBlind,
    chipUnit: state.chipUnit!,
    history,
  };
}

/** HandController.advanceStage: the next street opens with no wager. */
export function nextJointStreet(street: JointStreet, stage: HandStage, seats: SeatPlayer[]) {
  for (const p of seats) p.bet = 0;
  return { ...street, stage, currentBet: 0, lastRaise: 0, history: [] } as JointStreet;
}

export const cloneJointStreet = (street: JointStreet): JointStreet => ({
  ...street,
  history: street.history.slice(),
});

const streetBetSize = (street: JointStreet) => fixedLimitBetSize(street.smallBet, street.stage);

/** HandController.buildBettingState. */
export function jointBettingState(street: JointStreet, player: SeatPlayer): BettingState {
  if (street.structure === 'fixed_limit') {
    const betSize = streetBetSize(street);
    return calculateBettingState(
      street.pot,
      street.currentBet,
      player.bet,
      street.smallBet,
      street.lastRaise,
      false,
      {
        betSize,
        raiseSize: fixedLimitStreetBounds(street.history, street.stage, betSize, street.currentBet)
          .raiseSize,
        capped: isFixedLimitCapped(street.history, street.stage, betSize),
      }
    );
  }
  // Turn and river only: pot-limit's preflop blind adjustment never applies.
  return calculateBettingState(
    street.pot,
    street.currentBet,
    player.bet,
    street.bigBlind,
    street.lastRaise,
    street.structure === 'pot_limit'
  );
}

/** HandController.canReopenBetting (TDA 44/47, Bible V8 4.14). */
export function jointMayReopen(street: JointStreet, player: SeatPlayer): boolean {
  const actions = street.history;
  let aggressorSeat = -1,
    aggressorIndex = -1;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (
      ((a.action === 'bet' || a.action === 'raise') && a.isFullRaise !== false) ||
      (a.action === 'all_in' && a.isFullRaise)
    ) {
      aggressorSeat = a.seat;
      aggressorIndex = i;
    }
  }
  let own = -1;
  for (let i = actions.length - 1; i >= 0; i--)
    if (actions[i].seat === player.seat) {
      own = i;
      break;
    }
  const increment =
    street.structure === 'fixed_limit'
      ? streetBetSize(street) / 2
      : Math.max(street.bigBlind, street.lastRaise);
  if (own !== -1 && street.currentBet - player.bet >= increment - EPS) return true;
  if (aggressorSeat !== -1 && aggressorSeat !== player.seat) return own < aggressorIndex;
  return own === -1;
}

/** HandController.clampToStructure for the all-in button. */
export function clampJointAllIn(
  street: JointStreet,
  player: SeatPlayer,
  bs: BettingState
): { action: ActionType; amount?: number } {
  if (bs.maxRaise === undefined) return { action: 'all_in' };
  const allInTo = player.bet + player.stack;
  const fixed = bs.structure === 'fixed_limit';
  const capTo = fixed && bs.wagersCapped ? street.currentBet : street.currentBet + bs.maxRaise;
  if (allInTo <= capTo + EPS) return { action: 'all_in' };
  if (!fixed)
    return {
      action: street.currentBet > 0 ? 'raise' : 'bet',
      amount: Math.round(capTo * 100) / 100,
    };
  if (capTo <= player.bet + EPS)
    return { action: street.currentBet > player.bet + EPS ? 'call' : 'check' };
  if (capTo <= street.currentBet + EPS) return { action: 'call' };
  const wager: ActionType = street.currentBet > 0 ? 'raise' : 'bet';
  if (wager === 'raise' && !jointMayReopen(street, player)) return { action: 'call' };
  return { action: wager, amount: Math.round(capTo * 100) / 100 };
}

export interface JointLegalMenu {
  legalActions: ActionType[];
  toCall: number;
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
}

/** HandController.getAvailableActions plus getAuthoritativeActionState's
 * sized-wager interval, for a seat that may act on a post-flop street. */
export function jointLegalMenu(street: JointStreet, player: SeatPlayer): JointLegalMenu {
  const bs = jointBettingState(street, player);
  const cents = (value: number) => Math.round(value * 100) / 100;
  if (player.is_folded || player.is_all_in || player.is_sitting_out || player.stack <= 0)
    return {
      legalActions: [],
      toCall: cents(Math.max(0, bs.toCall)),
      minRaiseTo: null,
      maxRaiseTo: null,
    };
  const actions: ActionType[] = ['fold'];
  const toCall = street.currentBet - player.bet;
  const capped =
    street.structure === 'fixed_limit' &&
    isFixedLimitCapped(street.history, street.stage, streetBetSize(street));
  if (toCall === 0) {
    actions.push('check');
    if (player.stack > 0 && !capped) {
      if (street.currentBet === 0) actions.push('bet');
      else if (jointMayReopen(street, player)) actions.push('raise');
    }
  } else {
    actions.push('call');
    if (player.stack > toCall && !capped && jointMayReopen(street, player)) actions.push('raise');
  }
  if (player.stack > 0) {
    const probe = clampJointAllIn(street, player, bs);
    const raisesBet =
      probe.action === 'raise' || (probe.action === 'all_in' && player.stack > bs.toCall + EPS);
    if (
      validateAction(probe.action, probe.amount, player.stack, bs).valid &&
      (!raisesBet || jointMayReopen(street, player))
    )
      actions.push('all_in');
  }
  let legalActions = actions;
  let minRaiseTo: number | null = null,
    maxRaiseTo: number | null = null;
  const hasRaise = legalActions.includes('raise');
  if (hasRaise || legalActions.includes('bet')) {
    minRaiseTo = cents(hasRaise ? street.currentBet + bs.minRaise : bs.minRaise);
    const stackBound = hasRaise ? player.bet + player.stack : player.stack;
    const structureBound =
      bs.maxRaise === undefined
        ? Infinity
        : hasRaise
          ? street.currentBet + bs.maxRaise
          : bs.maxRaise;
    maxRaiseTo = cents(Math.min(stackBound, structureBound));
    if (maxRaiseTo < minRaiseTo - EPS) {
      legalActions = legalActions.filter((a) => a !== (hasRaise ? 'raise' : 'bet'));
      minRaiseTo = null;
      maxRaiseTo = null;
    }
  }
  return { legalActions, toCall: cents(Math.max(0, bs.toCall)), minRaiseTo, maxRaiseTo };
}

/** The HandController.performAction mutation for an already legal action.
 * Hero's candidate comes from the authoritative live menu, so it is applied
 * here directly; every simulated opponent action passes performJointAction. */
export function applyJointAction(
  street: JointStreet,
  player: SeatPlayer,
  action: ActionType,
  amount?: number
) {
  const unit = street.chipUnit;
  const bs = jointBettingState(street, player);
  let added = 0;
  let isFullRaise: boolean | undefined;
  let recorded = 0;
  switch (action) {
    case 'fold':
      player.is_folded = true;
      break;
    case 'check':
      break;
    case 'call':
      added = Math.min(Math.max(0, bs.toCall), player.stack);
      recorded = added;
      break;
    case 'bet':
    case 'raise': {
      const to = snap(amount!, unit);
      const raiseSize = to - street.currentBet;
      isFullRaise = raiseSize >= bs.minRaise - EPS;
      if (raiseSize > street.lastRaise) street.lastRaise = raiseSize;
      added = Math.min(player.stack, Math.max(0, to - player.bet));
      recorded = to;
      break;
    }
    case 'all_in':
      added = player.stack;
      recorded = player.bet + player.stack;
      break;
    default:
      throw new Error('joint_response_invalid_action');
  }
  added = snap(added, unit);
  player.stack = snap(player.stack - added, unit);
  player.bet = snap(player.bet + added, unit);
  player.totalInvested = snap(player.totalInvested + added, unit);
  street.pot = snap(street.pot + added, unit);
  if (player.stack <= 0 && action !== 'fold' && action !== 'check') {
    player.stack = 0;
    player.is_all_in = true;
  }
  if (action === 'bet' || action === 'raise') street.currentBet = player.bet;
  if (action === 'all_in' && player.bet > street.currentBet) {
    const raiseSize = player.bet - street.currentBet;
    isFullRaise = raiseSize >= bs.minRaise - EPS;
    if (isFullRaise) street.lastRaise = raiseSize;
    street.currentBet = player.bet;
  }
  street.history.push({
    seat: player.seat,
    userId: player.user_id,
    action,
    amount: Math.round(recorded * 100) / 100,
    timestamp: 0,
    stage: street.stage,
    isFullRaise,
  });
}

/** performAction for a simulated seat: the structure clamp, the authoritative
 * legality test (including reopening), then the mutation. An illegal request
 * is a defect in the tree, never silently rewritten. */
export function performJointAction(
  street: JointStreet,
  player: SeatPlayer,
  action: ActionType,
  amount?: number
) {
  const bs = jointBettingState(street, player);
  const clamped = action === 'all_in' ? clampJointAllIn(street, player, bs) : { action, amount };
  const valid = validateAction(clamped.action, clamped.amount, player.stack, bs).valid;
  const raisesBet =
    clamped.action === 'raise' || (clamped.action === 'all_in' && player.stack > bs.toCall + EPS);
  if (!valid || (raisesBet && !jointMayReopen(street, player)))
    throw new Error('joint_response_illegal_simulated_action');
  applyJointAction(street, player, clamped.action, clamped.amount);
}

/**
 * The one bounded wager a simulated seat may make: a pot-sized bet or raise
 * under the structure's cap (the fixed increment in fixed limit), never more
 * than the seat's stack. It is selected from the horses' own candidate
 * builder over the seat's authoritative menu, so unit rounding, the canonical
 * near-stack all-in and the pot-limit jam ceiling are the builder's. Returns
 * null when the menu offers no bet or raise.
 */
export function jointOneWager(
  street: JointStreet,
  player: SeatPlayer
): { action: 'bet' | 'raise' | 'all_in'; amount: number | undefined } | null {
  const menu = jointLegalMenu(street, player);
  if (!menu.legalActions.some((a) => a === 'bet' || a === 'raise' || a === 'all_in')) return null;
  const toCall = Math.min(player.stack, menu.toCall);
  if (player.stack <= toCall + EPS) return null;
  const baseline: HorseDecision = { action: toCall > 0 ? 'call' : 'check', thinkTime: 0 };
  const candidates = buildTournamentActionCandidates({
    hero: player,
    toCall,
    legalActions: menu.legalActions,
    minRaiseTo: menu.minRaiseTo,
    maxRaiseTo: menu.maxRaiseTo,
    pot: street.pot,
    currentBet: street.currentBet,
    bettingStructure: street.structure,
    baseline,
    settlement: { chipUnit: street.chipUnit },
  });
  const wagers = candidates.filter((c) => c.kind === 'bet' || c.kind === 'raise');
  const jam = candidates.find((c) => c.kind === 'jam');
  if (menu.minRaiseTo !== null && menu.maxRaiseTo !== null) {
    const unit = street.chipUnit;
    const raw =
      street.structure === 'fixed_limit'
        ? menu.minRaiseTo
        : street.currentBet + Math.max(1, street.pot + toCall);
    const target = Math.min(
      Math.floor((menu.maxRaiseTo + EPS) / unit) * unit,
      Math.max(Math.ceil((menu.minRaiseTo - EPS) / unit) * unit, Math.round(raw / unit) * unit)
    );
    const exact = wagers.find((c) => Math.abs(c.amount! - target) < EPS);
    if (exact) return { action: exact.kind as 'bet' | 'raise', amount: exact.amount! };
  }
  // The builder folds near-stack sizes into its canonical jam; a stack below
  // the minimum wager can raise only by moving all in. The all-in button is
  // on the menu even where the controller executes it as a call (a capped
  // fixed-limit street), so only an all-in that actually wagers counts.
  if (jam) {
    const probe = clampJointAllIn(street, player, jointBettingState(street, player));
    const wagers =
      probe.action === 'bet' ||
      probe.action === 'raise' ||
      (probe.action === 'all_in' && player.bet + player.stack > street.currentBet + EPS);
    if (wagers) return { action: 'all_in', amount: undefined };
  }
  return null;
}
