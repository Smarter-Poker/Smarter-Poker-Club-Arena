/**
 * V54 RIVER BLUFF fixtures (2026-10-24). Shared by HorseV54RiverBluff.test.ts
 * and by the one-off script that recorded the flag-off golden decisions from
 * the code as it stood before V54 (see HorseV54RiverBluff.golden.json).
 *
 * Every spot is a river decision with no bet to face, heads-up unless named
 * otherwise. Hero is seat 1 and holds the button, so hero acts last
 * postflop. 1/2 cash, 100bb, preflop raise to 6 and a call (pot 12), flop bet
 * 8 called (pot 28), turn bet 20 called (pot 68), the river checked to hero.
 */
import { HorseLogic, type HorseDecideOpts, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { HorseMind } from './HorseMind.js';
import type { ActionRecord, Card, SeatPlayer } from '../types.js';

export const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const H = 'hearts';
const D = 'diamonds';
const S = 'spades';
const C = 'clubs';

/** Fixed decision clock: the hourly mood multiplier must not move a result. */
export const DECISION_TIME_MS = Date.UTC(2026, 9, 24, 21, 0, 0);

export interface V54Spot {
  name: string;
  variant: 'nlh' | 'plo4';
  hole: Card[];
  board: Card[];
  /** behind, per player, once the river starts */
  behind: number;
  /** extra live opponents (multiway) */
  extraOpponents?: number;
  /** the opponent is all in (cannot call) */
  oppAllIn?: boolean;
  /** hero's line: 'barrel' bets flop and turn (default); 'turn' checks the
   *  flop behind and bets the turn; 'passive' checks behind both */
  line?: 'barrel' | 'turn' | 'passive';
  tournament?: boolean;
  /** the opponent BET the river into hero (a facing-bet control spot) */
  facingRiverBet?: boolean;
}

/** 6-high on 9-8-5-K-2: no pair, and the six blocks the 7-6 straight. */
export const NLH_AIR_BLOCKER: V54Spot = {
  name: 'nlh_air_blocker',
  variant: 'nlh',
  hole: [c('6', C), c('3', D)],
  board: [c('9', H), c('8', S), c('5', D), c('K', C), c('2', H)],
  behind: 166,
};
/** The same air with no blocker: 4-3 blocks no straight and no flush. */
export const NLH_AIR_NO_BLOCKER: V54Spot = {
  ...NLH_AIR_BLOCKER,
  name: 'nlh_air_no_blocker',
  hole: [c('4', C), c('3', D)],
  board: [c('Q', H), c('J', S), c('9', D), c('K', C), c('Q', D)],
};
/** Middle pair: showdown value, never a bluff. */
export const NLH_MIDDLE_PAIR: V54Spot = {
  ...NLH_AIR_BLOCKER,
  name: 'nlh_middle_pair',
  hole: [c('9', C), c('6', D)],
};
/** Shallow: 50 behind into a 68 pot, so the bluff is the shove. */
export const NLH_AIR_SHALLOW: V54Spot = { ...NLH_AIR_BLOCKER, name: 'nlh_air_shallow', behind: 50 };
/** Hero checked behind the flop and turn: no value story to tell. */
export const NLH_AIR_PASSIVE: V54Spot = {
  ...NLH_AIR_BLOCKER,
  name: 'nlh_air_passive',
  line: 'passive',
};
/** Three-handed to the river. */
export const NLH_AIR_MULTIWAY: V54Spot = {
  ...NLH_AIR_BLOCKER,
  name: 'nlh_air_multiway',
  extraOpponents: 1,
};
/** The opponent is all in for less: nobody can fold. */
export const NLH_AIR_OPP_ALL_IN: V54Spot = {
  ...NLH_AIR_BLOCKER,
  name: 'nlh_air_opp_all_in',
  oppAllIn: true,
};
/** Tournament on the stone bubble (10 left, 9 paid). */
export const NLH_AIR_BUBBLE: V54Spot = {
  ...NLH_AIR_BLOCKER,
  name: 'nlh_air_bubble',
  tournament: true,
};
/** Facing a river bet: V54 only bets when checked to or first in. */
export const NLH_AIR_FACING_BET: V54Spot = {
  ...NLH_AIR_BLOCKER,
  name: 'nlh_air_facing_bet',
  facingRiverBet: true,
};
/** PLO4: the As blocks the nut flush on a three-spade river, no made hand.
 *  Hero checked the flop behind, bet the turn and was flatted. */
export const PLO4_NUT_BLOCKER_AIR: V54Spot = {
  name: 'plo4_nut_blocker_air',
  variant: 'plo4',
  hole: [c('A', S), c('Q', H), c('4', C), c('3', D)],
  board: [c('K', S), c('9', S), c('6', D), c('2', S), c('J', C)],
  behind: 166,
  line: 'turn',
};
/** PLO4: the same air after two barrels were called: the V40 rule says the
 *  range that called pot twice is not capped (the river changed nothing). */
export const PLO4_TWO_BARRELS_CALLED: V54Spot = {
  ...PLO4_NUT_BLOCKER_AIR,
  name: 'plo4_two_barrels_called',
  line: 'barrel',
};
/** PLO4 air with no nut blocker (the queen of spades is not the ace). */
export const PLO4_AIR_NO_BLOCKER: V54Spot = {
  ...PLO4_NUT_BLOCKER_AIR,
  name: 'plo4_air_no_blocker',
  hole: [c('Q', S), c('8', H), c('4', C), c('3', D)],
};
/** PLO4 top two: a made hand with showdown value, never a bluff. */
export const PLO4_TWO_PAIR: V54Spot = {
  ...PLO4_NUT_BLOCKER_AIR,
  name: 'plo4_two_pair',
  hole: [c('K', H), c('J', D), c('4', C), c('3', D)],
};

export const GOLDEN_SPOTS: V54Spot[] = [
  NLH_AIR_BLOCKER,
  NLH_AIR_NO_BLOCKER,
  NLH_MIDDLE_PAIR,
  NLH_AIR_SHALLOW,
  NLH_AIR_PASSIVE,
  NLH_AIR_MULTIWAY,
  NLH_AIR_OPP_ALL_IN,
  NLH_AIR_BUBBLE,
  NLH_AIR_FACING_BET,
  PLO4_NUT_BLOCKER_AIR,
  PLO4_AIR_NO_BLOCKER,
  PLO4_TWO_PAIR,
  PLO4_TWO_BARRELS_CALLED,
];

function seat(n: number, cards: Card[], over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: n,
    user_id: n === 1 ? 'hero' : `opp${n}`,
    username: n === 1 ? 'hero' : `opp${n}`,
    stack: 0,
    bet: 0,
    totalInvested: 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    cards,
    ...over,
  } as SeatPlayer;
}

export function spotState(spot: V54Spot): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const opps = [3, ...Array.from({ length: spot.extraOpponents ?? 0 }, (_, i) => 5 + i)];
  const passive = spot.line === 'passive';
  const history: ActionRecord[] = [];
  let ts = 1;
  const push = (seatN: number, action: ActionRecord['action'], amount: number, stage: string) =>
    history.push({
      seat: seatN,
      userId: seatN === 1 ? 'hero' : `opp${seatN}`,
      action,
      amount,
      timestamp: ts++,
      stage,
    } as ActionRecord);
  push(1, 'raise', 6, 'preflop');
  for (const o of opps) push(o, 'call', 6, 'preflop');
  const flopBet = passive || spot.line === 'turn' ? 0 : 8;
  const turnBet = passive ? 0 : spot.line === 'turn' ? 28 : 20;
  for (const [stage, bet] of [
    ['flop', flopBet],
    ['turn', turnBet],
  ] as const) {
    for (const o of opps) push(o, 'check', 0, stage);
    if (bet > 0) {
      push(1, 'bet', bet, stage);
      for (const o of opps) push(o, 'call', bet, stage);
    } else push(1, 'check', 0, stage);
  }
  const contributed = 6 + flopBet + turnBet;
  const n = opps.length + 1;
  let pot = contributed * n;
  for (const o of opps) push(o, 'check', 0, 'river');
  const riverBet = spot.facingRiverBet ? 50 : 0;
  if (riverBet > 0) {
    // replace the first opponent's river check with a bet
    history.pop();
    push(opps[0], 'bet', riverBet, 'river');
    pot += riverBet;
  }
  const start = contributed + spot.behind;
  const hero = seat(1, spot.hole, { stack: spot.behind, totalInvested: contributed });
  const others = opps.map((o, i) =>
    seat(o, [], {
      stack:
        i === 0 && spot.oppAllIn
          ? 0
          : i === 0 && riverBet > 0
            ? spot.behind - riverBet
            : spot.behind,
      bet: i === 0 && riverBet > 0 ? riverBet : 0,
      is_all_in: i === 0 && spot.oppAllIn === true,
      totalInvested: contributed + (i === 0 ? riverBet : 0),
    })
  );
  void start;
  const gs = {
    players: [hero, ...others],
    communityCards: spot.board,
    pot,
    currentBet: riverBet,
    minRaise: riverBet > 0 ? riverBet : 2,
    lastRaise: riverBet > 0 ? riverBet : 2,
    stage: 'river',
    gameVariant: spot.variant,
    bigBlind: 2,
    dealerSeat: 1,
    actionHistory: history,
    gameMode: spot.tournament ? 'tournament' : 'cash',
    format: spot.tournament ? 'mtt' : 'cash',
    ...(spot.tournament
      ? {
          tournament: {
            playersLeft: 10,
            spotsPaid: 9,
            inMoney: false,
            avgStackChips: 200,
          },
        }
      : {}),
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

/** One river decision at a pinned RNG seed and decision clock. */
export function decideSpot(spot: V54Spot, seed: number, opts: HorseDecideOpts = {}) {
  const { hero, gs } = spotState(spot);
  seedFastRandom(seed);
  return HorseLogic.decide(
    hero,
    gs,
    'balanced',
    {},
    { observeMind: false, decisionTimeMs: DECISION_TIME_MS, ...opts }
  );
}

/** Opponent memory for seat 3: how often it folds to a river bet. */
export function seedOpponentRiverRead(riverFolds: number, riverOpps: number): void {
  HorseMind.reset();
  const foldRate = riverFolds / riverOpps;
  HorseMind.importStats([
    {
      user_id: 'opp3',
      hands: 300,
      vpip: 75,
      pfr: 40,
      threeBet: 10,
      aggr: 120,
      passive: 120,
      folds: Math.round(100 * foldRate),
      facedAggr: 100,
      riverBetOpps: riverOpps,
      riverBetFolds: riverFolds,
    },
  ]);
}

export const GOLDEN_SEEDS = Array.from({ length: 24 }, (_, i) => 1009 + i * 7919);
