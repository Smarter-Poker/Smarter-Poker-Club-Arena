/**
 * P13-B test support: rigged actual-controller hands for the joint economic
 * and format intersections.
 *
 * A `Rig` fixes every card a real HandController deals (hole cards in seat
 * order, then every flop, every turn and every river in board order), so the
 * same physical hand can be replayed down every response branch the joint
 * model enumerates. The controller posts the blinds, antes, straddle and bomb
 * antes itself, decides every action's legality, returns uncalled money,
 * builds the pots, splits the boards, takes rake and the BBJ drop and pays the
 * winners. Nothing here settles a pot: the three settlements compared by the
 * suites are the controller's, the joint model's (`settleJointTerminal`, the
 * terminal owner every response branch uses) and the independent benchmark
 * reference (`settleJointBoardReference`).
 */
import type {
  ActionType,
  Card,
  CardRank,
  CardSuit,
  GameVariant,
  HandConfig,
  HandEvent,
  RakeConfig,
  SeatPlayer,
} from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import type { TournamentUtilityShowdownSample } from '../HorseTournamentUtility.js';
import { HandController } from '../HandController.js';
import { RANKS, SUITS } from '../PokerEngine.js';
import { scoreHoldem, scoreOmahaHi, scoreOmahaLow } from '../HorseEval.js';
import { horseVariantRulesFor } from '../VariantRules.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { settleJointBoardReference } from '../../benchmark/JointBoardReference.js';
import { settleJointTerminal } from './JointActionShared.js';

const SUIT: Record<string, CardSuit> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
export const card = (code: string): Card => {
  const rank = code[0] as CardRank,
    suit = SUIT[code[1]];
  if (!RANKS.includes(rank) || !suit || code.length !== 2) throw new Error('bad card ' + code);
  return { rank, suit };
};
export const cards = (codes: string): Card[] => codes.trim().split(/\s+/).map(card);
const key = (c: Card) => c.rank + c.suit;

export interface RigSeat {
  id: string;
  stack: number;
  hole: string;
}
export interface Rig {
  variant: GameVariant;
  mode: 'cash' | 'tournament';
  asset?: 'chips' | 'diamonds';
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  bigBlindAnte?: boolean;
  straddles?: { seat: number; amount: number }[];
  rakeConfig: RakeConfig;
  bbjConfig?: HandConfig['bbjConfig'];
  bombPot?: { boardCount: 1 | 2 | 3; anteMultiplier: number };
  dealer: number;
  /** Seat i + 1. */
  seats: RigSeat[];
  /** Every board as dealt, five cards each. */
  boards: string[];
}
export type Step = [seat: number, action: ActionType, amount?: number];

export function rigConfig(rig: Rig): HandConfig {
  return {
    tableId: 'p13-b-' + rig.variant,
    handNumber: 1,
    gameVariant: rig.variant,
    smallBlind: rig.smallBlind,
    bigBlind: rig.bigBlind,
    ante: rig.ante ?? 0,
    ...(rig.bigBlindAnte ? { bigBlindAnte: true } : {}),
    isTournament: rig.mode === 'tournament',
    asset: rig.asset ?? 'chips',
    rakeConfig: rig.rakeConfig,
    ...(rig.bbjConfig ? { bbjConfig: rig.bbjConfig } : {}),
    ...(rig.straddles ? { straddles: rig.straddles } : {}),
    ...(rig.bombPot ? { bombPot: { ...rig.bombPot, triggerReason: 'every_n_hands' } } : {}),
  } as HandConfig;
}

/** The deck order a real HandController deals for this rig. */
function deckOrder(rig: Rig): Card[] {
  const boards = rig.boards.map(cards);
  if (boards.some((b) => b.length !== 5)) throw new Error('rig boards need five cards');
  const order = [
    ...rig.seats.flatMap((s) => cards(s.hole)),
    ...boards.flatMap((b) => b.slice(0, 3)),
    ...boards.map((b) => b[3]),
    ...boards.map((b) => b[4]),
  ];
  const seen = new Set(order.map(key));
  if (seen.size !== order.length) throw new Error('rig deals a card twice');
  const short = rig.variant === 'short_deck';
  for (const suit of SUITS)
    for (const rank of RANKS) {
      if (short && ['2', '3', '4', '5'].includes(rank)) continue;
      const c = { rank, suit } as Card;
      if (!seen.has(key(c))) order.push(c);
    }
  if (order.some((c) => short && ['2', '3', '4', '5'].includes(c.rank)))
    throw new Error('short deck rig holds a removed card');
  return order;
}

export interface Played {
  controller: HandController;
  config: HandConfig;
  events: HandEvent[];
  /** Players exactly as completeHandInner received them (before the refund). */
  snapshot: SeatPlayer[] | null;
  boards: Card[][];
}

/** Starts the rigged hand and performs `steps`, each by the seat whose turn it is. */
export function play(rig: Rig, steps: Step[]): Played {
  const config = rigConfig(rig);
  const players: SeatPlayer[] = rig.seats.map((s, i) => ({
    seat: i + 1,
    user_id: s.id,
    username: s.id,
    stack: s.stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  }));
  const controller = new HandController(config, players, rig.dealer);
  const internal = controller as unknown as {
    state: { deck: { cards: Card[] }; players: SeatPlayer[] } & Record<string, unknown>;
    completeHandInner: () => void;
  };
  internal.state.deck.cards = deckOrder(rig);
  const played: Played = { controller, config, events: [], snapshot: null, boards: [] };
  const original = internal.completeHandInner.bind(controller);
  internal.completeHandInner = () => {
    played.snapshot = internal.state.players.map((p) => structuredClone(p));
    const s = controller.getState();
    played.boards = [s.communityCards, s.communityCards2, s.communityCards3]
      .slice(0, controller.getActiveBoardCount())
      .map((b) => b.map((c) => ({ ...c })));
    original();
  };
  controller.onEvent((e) => played.events.push(e));
  controller.start();
  const dealt = controller.getState().players;
  rig.seats.forEach((s, i) => {
    if (dealt[i].cards.map(key).join() !== cards(s.hole).map(key).join())
      throw new Error('rig hole cards were not dealt as specified');
  });
  for (const [seat, action, amount] of steps) {
    const turn = controller.getState().currentPlayerSeat;
    if (turn !== seat)
      throw new Error(`rig step ${seat}:${action} out of turn (seat ${turn} to act)`);
    if (!controller.performAction(seat, action, amount))
      throw new Error(`rig step ${seat}:${action}:${amount ?? ''} refused by the controller`);
  }
  return played;
}

export interface Settled {
  stacks: Record<string, number>;
  rake: number;
  bbjFee: number;
  refunds: Record<string, number>;
  snapshot: SeatPlayer[];
  boards: Card[][];
}

/** Lets the controller finish the hand and reads what it paid. */
export function settle(played: Played): Settled {
  const done = () => played.events.some((e) => e.type === 'HAND_COMPLETE');
  if (!done()) played.controller.continueRunout();
  const complete = played.events.find((e) => e.type === 'HAND_COMPLETE') as
    | Extract<HandEvent, { type: 'HAND_COMPLETE' }>
    | undefined;
  if (!complete || !played.snapshot) throw new Error('the rigged hand did not complete');
  const refunds: Record<string, number> = {};
  for (const e of played.events)
    if (e.type === 'UNCALLED_BET_RETURNED')
      refunds[e.userId] = Math.round(((refunds[e.userId] ?? 0) + e.amount) * 100) / 100;
  return {
    stacks: Object.fromEntries(
      played.controller.getState().players.map((p) => [p.user_id, p.stack])
    ),
    rake: complete.rake,
    bbjFee: complete.bbjFee,
    refunds,
    snapshot: played.snapshot,
    boards: played.boards,
  };
}

/** The decision state the live builder hands the joint owner, bomb boards included. */
export function decisionSpot(played: Played, rig: Rig) {
  const spot = controllerDecisionState(
    played.controller,
    rig.variant as never,
    rig.mode,
    played.config
  );
  if (!spot) throw new Error('no decision is pending');
  const live = played.controller.getState();
  const boards = played.controller.getActiveBoardCount();
  Object.assign(spot.state, {
    gameVariant: rig.variant,
    variantRules: horseVariantRulesFor(rig.variant),
    communityCards2: boards >= 2 ? [...live.communityCards2] : [],
    communityCards3: boards >= 3 ? [...live.communityCards3] : [],
    boardCount: boards,
    bombPot: Boolean(rig.bombPot),
    straddleActive: Boolean(rig.straddles?.length),
  });
  return { hero: spot.hero, state: spot.state as HorseGameStateV2, baseline: spot.baseline };
}

/** Scores the real cards on the real boards exactly as the sampler scores them. */
export function trueSample(
  variant: GameVariant,
  boards: Card[][],
  holes: Record<string, Card[]>,
  heroId: string,
  opponentIds: string[],
  strength: Record<string, number> = {}
): TournamentUtilityShowdownSample {
  const rules = horseVariantRulesFor(variant);
  const high = (hole: Card[], board: Card[]) =>
    rules.holeCardsUse === 'exactly_two'
      ? scoreOmahaHi(hole, board)
      : scoreHoldem([...hole, ...board], hole.length + board.length, rules.deckSize === 36);
  const low = (hole: Card[], board: Card[]) => {
    if (!rules.splitLow8OrBetter) return null;
    const v = scoreOmahaLow(hole, board);
    return Number.isFinite(v) ? v : null;
  };
  return {
    boards: boards.map((board) => ({
      heroHigh: high(holes[heroId], board),
      heroLow: low(holes[heroId], board),
      opponentHigh: opponentIds.map((id) => high(holes[id], board)),
      opponentLow: opponentIds.map((id) => low(holes[id], board)),
      opponentDecisionStrength: opponentIds.map((id) => strength[id] ?? 0.5),
    })),
  };
}

export const holesOf = (rig: Rig) =>
  Object.fromEntries(rig.seats.map((s) => [s.id, cards(s.hole)]));

/** The joint terminal owner's settlement of the controller's own final state. */
export function modelSettle(
  settled: Settled,
  state: HorseGameStateV2,
  rig: Rig,
  heroId: string,
  sawFlop = true
) {
  const seats = settled.snapshot.map((p) => ({ ...p, cards: [] }));
  const hero = seats.find((p) => p.user_id === heroId)!;
  const opponentIds = seats
    .filter((p) => !p.is_folded && p.user_id !== heroId)
    .map((p) => p.user_id);
  const t = settleJointTerminal({
    hero,
    state: { ...state, players: seats },
    seats,
    opponentIds,
    sample: trueSample(rig.variant, settled.boards, holesOf(rig), heroId, opponentIds),
    dealtPlayers: seats.filter((p) => !p.is_sitting_out).length,
    sawFlop,
  });
  return {
    stacks: Object.fromEntries(t.prepared.seats.map((p, i) => [p.user_id, t.vector[i]])),
    rake: t.fees.rake,
    bbjFee: t.fees.bbjFee,
    refunds: t.fees.refunds,
    pots: t.prepared.pots,
  };
}

/** Independent gross settlement (benchmark reference): awards and refunds.
 * The reference builds pots from whole contributions, so it has no notion of
 * shared dead money (a big blind ante or a dead blind); such a hand returns
 * null and its case pins the pots by hand. */
export function referenceSettle(settled: Settled, rig: Rig) {
  if (settled.snapshot.some((p) => (p.deadInvested ?? 0) > (p.individualAnteInvested ?? 0)))
    return null;
  const holes = holesOf(rig);
  const ref = settleJointBoardReference({
    variant: rig.variant as never,
    players: settled.snapshot.map((p) => ({
      id: p.user_id,
      seat: p.seat,
      folded: p.is_folded,
      contributed: p.totalInvested,
      cards: holes[p.user_id],
    })),
    // The rig's boards are the ones the controller dealt (asserted by the
    // caller); a hand that ended before the river still needs a full board.
    boards: rig.boards.map(cards),
    chipUnit: rig.mode === 'tournament' || rig.asset === 'diamonds' ? 1 : 0.01,
    dealerSeat: rig.dealer,
  });
  return {
    gross: Object.fromEntries(
      settled.snapshot.map((p) => [
        p.user_id,
        Math.round(((ref.totals[p.user_id] ?? 0) + (ref.refunds[p.user_id] ?? 0)) * 100) / 100,
      ])
    ),
    refunds: ref.refunds,
    pots: ref.pots,
  };
}

/**
 * Replays one captured terminal state of a decision on the controller (a
 * river decision of the response tree, or any street of the one-response
 * model, whose later streets check down).
 * In the response tree's line, responders before the one raiser answer hero's
 * level, the raiser raises, and every seat still owing answers the raise once.
 * The raiser is the first responder at the top wager after whom no responder
 * folded having already put chips in (such a seat answered before the raise).
 * Every other seat is driven by its final state: a seat whose final wager is
 * what it has already put in folds when it owes, anyone else calls or checks.
 * The controller decides the turn order and the legality of every step.
 */
export function playBranch(
  rig: Rig,
  pre: Step[],
  decision: { hero: SeatPlayer; state: HorseGameStateV2 },
  heroAction: { action: ActionType; amount?: number | null },
  terminal: readonly SeatPlayer[]
): Played {
  const { hero, state } = decision;
  const final = new Map(terminal.map((p) => [p.user_id, p]));
  const ring = [
    ...state.players.filter((p) => p.seat > hero.seat).sort((a, b) => a.seat - b.seat),
    ...state.players.filter((p) => p.seat < hero.seat).sort((a, b) => a.seat - b.seat),
  ].filter((p) => !p.is_folded && !p.is_all_in);
  const top = Math.max(...terminal.map((p) => p.bet));
  const played = play(rig, pre);
  const c = played.controller;
  const step = (seat: number, action: ActionType, amount?: number) => {
    if (!c.performAction(seat, action, amount))
      throw new Error(`branch step ${seat}:${action}:${amount ?? ''} refused by the controller`);
  };
  if (c.getState().currentPlayerSeat !== hero.seat) throw new Error('hero is not to act');
  step(
    hero.seat,
    heroAction.action,
    heroAction.action === 'bet' || heroAction.action === 'raise' ? heroAction.amount! : undefined
  );
  // The level hero's own action set, as the controller executed it (a
  // fixed-limit all in is a capped wager, not the whole stack).
  const heroLevel = c.getState().currentBet;
  let raiser: string | null = null;
  if (top > heroLevel + 0.005)
    for (let k = 0; k < ring.length && !raiser; k++) {
      if (Math.abs(final.get(ring[k].user_id)!.bet - top) > 0.005) continue;
      if (
        ring
          .slice(k + 1)
          .every((p) => !final.get(p.user_id)!.is_folded || final.get(p.user_id)!.bet < 0.005)
      )
        raiser = ring[k].user_id;
    }
  if (top > heroLevel + 0.005 && !raiser) throw new Error('no raiser reaches the terminal');
  for (
    let guard = 0;
    guard < 40 && !played.events.some((e) => e.type === 'HAND_COMPLETE');
    guard++
  ) {
    const s = c.getState();
    const p = s.players.find((x) => x.seat === s.currentPlayerSeat);
    if (!p || p.is_folded || p.is_all_in) break;
    const t = final.get(p.user_id)!;
    if (p.user_id === raiser) {
      raiser = null;
      if (t.stack < 0.005) step(p.seat, 'all_in');
      else step(p.seat, 'raise', top);
      continue;
    }
    const owes = s.currentBet - p.bet > 0.005;
    if (t.is_folded && Math.abs(t.bet - p.bet) < 0.005 && owes) step(p.seat, 'fold');
    else if (owes) step(p.seat, 'call');
    else step(p.seat, 'check');
  }
  return played;
}
