/** Bounded, funded NLH future hands under an explicit shallow rollout population.
 * Synthetic hands are common random numbers across candidates, never live cards.
 * No table-break or blind-level transition probability is invented here.
 */
import type { Card, SeatPlayer, Pot } from '../types.js';
import { calculatePots } from './PokerEngine.js';
import { bigBlindAnteTotal } from './AnteMath.js';
import { scoreHoldem } from './HorseEval.js';
import {
  CONTINUATION_POLICY,
  continuationStrength,
  simulateTournamentContinuation,
} from './HorseTournamentContinuation.js';

export const FUTURE_HAND_POLICY = Object.freeze({
  version: 'funded-nlh-future-hands-v2',
  maxHands: 1,
  maxSeats: 10,
  maxIcmTrials: 128,
  population: 'own-cards-preflop-and-one-wager-per-street',
  levelSelection: 'conservative-utility-envelope',
  tableBreak: 'unavailable',
} as const);
export interface FutureBlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  anteType: 'none' | 'per_player' | 'big_blind';
}
export interface FutureHandConfig {
  levels: FutureBlindLevel[];
  /** Zero means the authoritative next level is already due. */
  nextLevelDue: boolean;
}
export interface FutureElimination {
  userId: string;
  /** Places occupied by equal-starting-stack simultaneous busts. */
  places: number[];
  claimants: string[];
}
export interface FutureHandResult {
  vector: number[];
  eliminations: FutureElimination[];
  hands: number;
  forcedPaid: Record<string, number>;
  conservationError: number;
}
/** Decision-local common cards/facts. Stack and betting outcomes are never cached here. */
export interface FutureHandDraw {
  board: Card[];
  seats: Map<string, FutureSeatFacts>;
}

interface FutureSeatFacts {
  cards: Card[];
  preflop: number;
  streets: number[];
  showdown: number;
}

type SyntheticDealFacts = {
  board: Card[];
  seats: FutureSeatFacts[];
};
// These are the rollout model's synthetic cards and scores, never live cards,
// player identities, stacks, pot rights or bounty values. The one-hand model's
// shuffle depends only on the outcome index and number of surviving seats.
// At most 32 * 9 entries are possible. Caller-visible draws are copied so an
// observer's mutation cannot contaminate another decision's facts.
const syntheticDealFacts = new Map<string, SyntheticDealFacts>();
const copySeatFacts = (facts: SyntheticDealFacts['seats'][number]) => ({
  ...facts,
  cards: facts.cards.map((c) => ({ ...c })),
  streets: facts.streets.slice(),
});

/** NLH-only synthetic rollout settlement. Compared against production per-pot
 * awards in the differential suite; never used to settle a real hand. */
export function settleFutureHand(
  players: SeatPlayer[],
  pots: Pot[],
  dealerSeat: number,
  scores: Map<string, number>
) {
  const awards: Array<{ userId: string; potIndex: number; amount: number }> = [];
  const live = players.filter((p) => !p.is_folded);
  for (const [potIndex, pot] of pots.entries()) {
    const eligible =
      live.length === 1 ? live : live.filter((p) => pot.eligiblePlayers.includes(p.user_id));
    if (!eligible.length) return null;
    const best = Math.max(...eligible.map((p) => scores.get(p.user_id) ?? -Infinity));
    if (!Number.isFinite(best)) return null;
    const winners = eligible
      .filter((p) => scores.get(p.user_id) === best)
      .sort(
        (a, b) => Number(a.seat <= dealerSeat) - Number(b.seat <= dealerSeat) || a.seat - b.seat
      );
    const cents = Math.round(pot.amount * 100),
      units = Math.floor(cents / 100);
    const base = Math.floor(units / winners.length),
      remainder = units % winners.length;
    winners.forEach((p, i) =>
      awards.push({
        userId: p.user_id,
        potIndex,
        amount: base + Number(i < remainder) + (i === 0 ? (cents - units * 100) / 100 : 0),
      })
    );
  }
  return awards;
}

function preflopStrength(cards: Card[]): number {
  const ranks = cards.map((c) => '23456789TJQKA'.indexOf(c.rank) + 2);
  const high = Math.max(...ranks),
    low = Math.min(...ranks);
  return Math.min(
    0.98,
    ranks[0] === ranks[1]
      ? 0.5 + high / 30
      : (high + low) / 40 +
          Number(cards[0].suit === cards[1].suit) * 0.08 -
          Math.max(0, high - low - 1) * 0.02
  );
}

function syntheticRandom(sampleIndex: number): () => number {
  let seed = Math.imul(sampleIndex + 1, 0x9e3779b1) >>> 0;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
}

function buildSyntheticDealFacts(count: number, random: () => number): SyntheticDealFacts {
  const deck: Card[] = [];
  for (const suit of ['clubs', 'diamonds', 'hearts', 'spades'] as const)
    for (const rank of '23456789TJQKA') deck.push({ rank: rank as Card['rank'], suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const cards = Array.from({ length: count }, () => [deck.pop()!, deck.pop()!]);
  const board = Array.from({ length: 5 }, () => deck.pop()!);
  return {
    board,
    seats: cards.map((cards) => {
      const preflop = preflopStrength(cards);
      return {
        cards,
        preflop,
        showdown: scoreHoldem([...cards, ...board], 7, false),
        streets: [3, 4, 5].map((size) =>
          continuationStrength(
            Math.floor(
              scoreHoldem([...cards, ...board.slice(0, size)], size + 2, false) / 0x100000
            ),
            preflop
          )
        ),
      };
    }),
  };
}

/** Prepare the bounded, identity-free model facts before accepting decisions.
 * No betting, settlement, observation, telemetry or live cards are involved.
 * Repeated startup calls reuse the same facts; caller draws remain copies.
 */
export function prepareTournamentFutureHandFacts(): void {
  if (FUTURE_HAND_POLICY.maxHands !== 1) return;
  for (let sample = 0; sample < CONTINUATION_POLICY.maxOutcomeSamples; sample++) {
    for (let seats = 2; seats <= FUTURE_HAND_POLICY.maxSeats; seats++) {
      const key = `${sample}:${seats}`;
      if (!syntheticDealFacts.has(key))
        syntheticDealFacts.set(key, buildSyntheticDealFacts(seats, syntheticRandom(sample)));
    }
  }
}

const FUTURE_STREETS = ['flop', 'turn', 'river'] as const;

export function commitFutureChips(
  p: SeatPlayer,
  requested: number,
  anteType: FutureBlindLevel['anteType'] | null = null
): number {
  const paid = Math.min(p.stack, Math.max(0, Math.round(requested)));
  p.stack -= paid;
  p.totalInvested += paid;
  if (anteType !== null) {
    p.deadInvested = (p.deadInvested ?? 0) + paid;
    if (anteType === 'per_player')
      p.individualAnteInvested = (p.individualAnteInvested ?? 0) + paid;
  } else p.bet += paid;
  p.is_all_in = p.stack <= 0;
  return paid;
}

export function simulateTournamentFutureHands(args: {
  players: SeatPlayer[];
  vector: number[];
  localIndex: Map<string, number>;
  heroId: string;
  dealerSeat: number;
  level: FutureBlindLevel;
  sampleIndex: number;
  withinBudget?: () => boolean;
  drawCache?: Map<string, FutureHandDraw>;
}): FutureHandResult | null {
  const { level } = args;
  if (
    args.players.length > FUTURE_HAND_POLICY.maxSeats ||
    ![level.smallBlind, level.bigBlind, level.ante].every((n) => Number.isFinite(n) && n >= 0) ||
    level.bigBlind <= 0 ||
    level.smallBlind > level.bigBlind ||
    !['none', 'per_player', 'big_blind'].includes(level.anteType)
  )
    return null;
  const vector = args.vector.slice();
  let initialTotal = 0;
  for (let index = 0; index < vector.length; index++)
    if (index in vector) initialTotal += vector[index];
  let finalTotal = initialTotal;
  const eliminations: FutureElimination[] = [];
  const forcedPaid: Record<string, number> = {};
  let dealerSeat = args.dealerSeat;
  let hands = 0;
  const random = syntheticRandom(args.sampleIndex);
  // The continuation's voluntary wagers are live chips (no ante type).
  const commitLive = (p: SeatPlayer, n: number): void => {
    commitFutureChips(p, n, null);
  };
  for (let hand = 0; hand < FUTURE_HAND_POLICY.maxHands; hand++) {
    if (args.withinBudget?.() === false) return null;
    // Surviving seats in seat order. The stable sort is skipped only when the
    // caller's seats are already in that order, which is the same sequence.
    const players: SeatPlayer[] = [];
    let seatOrdered = true;
    for (const p of args.players) {
      const stack = vector[args.localIndex.get(p.user_id)!];
      if (!(stack > 0)) continue;
      if (players.length > 0 && players[players.length - 1].seat > p.seat) seatOrdered = false;
      players.push({
        // A simulated next hand owns only rule/settlement state. Keep its
        // shape stable instead of copying unrelated live seat metadata.
        user_id: p.user_id,
        username: p.username,
        seat: p.seat,
        stack,
        cards: [] as Card[],
        is_folded: false,
        is_all_in: false,
        // No reconnect probability is invented by the one-hand model.
        is_sitting_out: p.is_sitting_out,
        totalInvested: 0,
        bet: 0,
        deadInvested: 0,
        individualAnteInvested: 0,
      });
    }
    if (!seatOrdered) players.sort((a, b) => a.seat - b.seat);
    if (players.length < 2 || !players.some((p) => p.user_id === args.heroId)) break;
    let fieldCount = 0;
    for (let index = 0; index < vector.length; index++) if (vector[index] > 0) fieldCount++;
    const seats = players.length;
    // Pre-hand stacks by seat position (the elimination order below).
    const starts: number[] = new Array(seats);
    for (let i = 0; i < seats; i++) starts[i] = players[i].stack;
    dealerSeat = players.find((p) => p.seat > dealerSeat)?.seat ?? players[0].seat;
    const button = players.findIndex((p) => p.seat === dealerSeat);
    const sb = (button + (seats === 2 ? 0 : 1)) % seats;
    const bb = (sb + 1) % seats;
    let drawKey = `${args.sampleIndex}:${hand}:`;
    for (let i = 0; i < seats; i++)
      drawKey += i === 0 ? players[i].user_id : `,${players[i].user_id}`;
    let draw = args.drawCache?.get(drawKey);
    const templateKey =
      FUTURE_HAND_POLICY.maxHands === 1 &&
      Number.isInteger(args.sampleIndex) &&
      args.sampleIndex >= 0 &&
      args.sampleIndex < CONTINUATION_POLICY.maxOutcomeSamples
        ? `${args.sampleIndex}:${seats}`
        : null;
    const template = templateKey === null ? undefined : syntheticDealFacts.get(templateKey);
    if (!draw && template) {
      draw = {
        board: template.board.map((c) => ({ ...c })),
        seats: new Map(players.map((p, i) => [p.user_id, copySeatFacts(template.seats[i])])),
      };
      args.drawCache?.set(drawKey, draw);
    }
    if (!draw) {
      const facts = buildSyntheticDealFacts(seats, random);
      draw = {
        board: facts.board,
        seats: new Map(players.map((p, index) => [p.user_id, facts.seats[index]])),
      };
      if (templateKey !== null)
        syntheticDealFacts.set(templateKey, {
          board: draw.board.map((c) => ({ ...c })),
          seats: players.map((p) => copySeatFacts(draw!.seats.get(p.user_id)!)),
        });
      args.drawCache?.set(drawKey, draw);
    }
    // One fact lookup per seat for the whole hand; the draw is not mutated.
    const facts: FutureSeatFacts[] = new Array(seats);
    for (let i = 0; i < seats; i++) {
      facts[i] = draw.seats.get(players[i].user_id)!;
      players[i].cards = facts[i].cards;
    }
    const commit = (p: SeatPlayer, requested: number, ante = false) =>
      commitFutureChips(p, requested, ante ? level.anteType : null);
    for (let i = 0; i < seats; i++) {
      const p = players[i];
      const individual = level.anteType === 'per_player' ? level.ante : 0;
      const bba =
        level.anteType === 'big_blind' && i === bb
          ? bigBlindAnteTotal(level.ante, seats, level.bigBlind)
          : 0;
      const paid =
        commit(p, individual, true) +
        commit(p, i === sb ? level.smallBlind : i === bb ? level.bigBlind : 0) +
        commit(p, bba, true);
      forcedPaid[p.user_id] = (forcedPaid[p.user_id] ?? 0) + paid;
    }
    // Return a street's uncalled live wager before advancing its betting state.
    const refund = () => {
      let top = players[0];
      let secondBet = 0;
      for (let i = 1; i < players.length; i++) {
        const player = players[i];
        if (player.bet > top.bet) {
          secondBet = top.bet;
          top = player;
        } else if (player.bet > secondBet) secondBet = player.bet;
      }
      const excess = top.bet - secondBet;
      if (!top.is_folded && excess > 0) {
        top.stack += excess;
        top.bet -= excess;
        top.totalInvested -= excess;
        top.is_all_in = top.stack <= 0;
      }
    };
    // Preflop action order starts after the big blind (positions bb + 1, ...,
    // wrapping to bb). Strength is the seat's own preflop fact; sitting-out 0.
    const preflop = (i: number) => (players[i].is_sitting_out ? 0 : facts[i].preflop);
    // One open, then fold/call responses; a short stack can fund only its own all-in.
    let opener: SeatPlayer | undefined;
    for (let k = 0; k < seats; k++) {
      const i = (bb + 1 + k) % seats;
      if (!players[i].is_all_in && preflop(i) >= 0.72) {
        opener = players[i];
        break;
      }
    }
    const price = opener
      ? Math.max(level.bigBlind, Math.min(opener.bet + opener.stack, 3 * level.bigBlind))
      : level.bigBlind;
    if (opener) commit(opener, price - opener.bet);
    for (let k = 0; k < seats; k++) {
      const i = (bb + 1 + k) % seats;
      const p = players[i];
      if (p === opener || p.is_all_in) continue;
      const due = Math.min(p.stack, Math.max(0, price - p.bet));
      if (due > 0 && preflop(i) < (opener ? 0.55 : 0.38)) p.is_folded = true;
      else commit(p, due);
    }
    refund();
    let hero: SeatPlayer | undefined;
    let heroFacts: FutureSeatFacts | undefined;
    const opponentIds: string[] = [];
    const opponentFacts: FutureSeatFacts[] = [];
    for (let i = 0; i < seats; i++) {
      if (players[i].user_id !== args.heroId) {
        opponentIds.push(players[i].user_id);
        opponentFacts.push(facts[i]);
      } else if (!hero) {
        hero = players[i];
        heroFacts = facts[i];
      }
    }
    for (let i = 0; i < FUTURE_STREETS.length; i++) {
      if (args.withinBudget?.() === false) return null;
      const opponentStrength: number[] = new Array(opponentFacts.length);
      for (let j = 0; j < opponentFacts.length; j++)
        opponentStrength[j] = opponentFacts[j].streets[i];
      if (
        !simulateTournamentContinuation(
          players,
          {
            heroId: args.heroId,
            dealerSeat,
            bigBlind: level.bigBlind,
            currentStreet: 'preflop',
            heroChecked: false,
            opponentIds,
            sampleIndex: args.sampleIndex,
            streets: [
              {
                street: FUTURE_STREETS[i],
                heroStrength: heroFacts!.streets[i],
                opponentStrength,
              },
            ],
          },
          commitLive
        )
      )
        return null;
      refund();
    }
    const pots = calculatePots(players);
    const scores = new Map<string, number>();
    for (let i = 0; i < seats; i++) scores.set(players[i].user_id, facts[i].showdown);
    const winners = settleFutureHand(players, pots, dealerSeat, scores);
    if (!winners) return null;
    for (const p of players) vector[args.localIndex.get(p.user_id)!] = p.stack;
    for (const win of winners) vector[args.localIndex.get(win.userId)!] += win.amount;
    const busted: number[] = [];
    for (let i = 0; i < seats; i++)
      if (vector[args.localIndex.get(players[i].user_id)!] <= 0) busted.push(i);
    for (const b of busted) {
      const p = players[b];
      let shorter = 0;
      let tied = 0;
      for (const q of busted) {
        if (starts[q] < starts[b]) shorter++;
        if (starts[q] === starts[b]) tied++;
      }
      const lastPot = pots
        .map((pot, i) => (pot.eligiblePlayers.includes(p.user_id) ? i : -1))
        .reduce((a, b) => Math.max(a, b), -1);
      // Pot-index winners are authoritative for the last pot containing the bust's chips.
      let claimants: string[] = [];
      for (let i = lastPot; i >= 0 && !claimants.length; i--)
        claimants = [
          ...new Set(
            winners.filter((w) => w.potIndex === i && w.userId !== p.user_id).map((w) => w.userId)
          ),
        ];
      eliminations.push({
        userId: p.user_id,
        places: Array.from({ length: tied }, (_, i) => fieldCount - shorter - i),
        claimants,
      });
    }
    hands++;
    finalTotal = 0;
    for (let index = 0; index < vector.length; index++)
      if (index in vector) finalTotal += vector[index];
    if (Math.abs(finalTotal - initialTotal) > 0.005) return null;
  }
  return {
    vector,
    eliminations,
    hands,
    forcedPaid,
    conservationError: Math.abs(finalTotal - initialTotal),
  };
}
