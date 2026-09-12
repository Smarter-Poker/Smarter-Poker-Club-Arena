/** Bounded, funded NLH future hands under an explicit shallow rollout population.
 * Synthetic hands are common random numbers across candidates, never live cards.
 * No table-break or blind-level transition probability is invented here.
 */
import type { Card, SeatPlayer, Pot } from '../types.js';
import { calculatePots } from './PokerEngine.js';
import { bigBlindAnteTotal } from './AnteMath.js';
import { scoreHoldem } from './HorseEval.js';
import {
  continuationStrength,
  simulateTournamentContinuation,
} from './HorseTournamentContinuation.js';

export const FUTURE_HAND_POLICY = Object.freeze({
  version: 'funded-nlh-future-hands-v1',
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
  seats: Map<string, { cards: Card[]; preflop: number; streets: number[]; showdown: number }>;
}

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
  const initialTotal = vector.reduce((a, b) => a + b, 0);
  const eliminations: FutureElimination[] = [];
  const forcedPaid: Record<string, number> = {};
  let dealerSeat = args.dealerSeat;
  let hands = 0;
  let seed = Math.imul(args.sampleIndex + 1, 0x9e3779b1) >>> 0;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  for (let hand = 0; hand < FUTURE_HAND_POLICY.maxHands; hand++) {
    if (args.withinBudget?.() === false) return null;
    const players = args.players
      .filter((p) => vector[args.localIndex.get(p.user_id)!] > 0)
      .map((p) => ({
        ...p,
        stack: vector[args.localIndex.get(p.user_id)!],
        cards: [] as Card[],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        totalInvested: 0,
        bet: 0,
        deadInvested: 0,
        individualAnteInvested: 0,
      }))
      .sort((a, b) => a.seat - b.seat);
    if (players.length < 2 || !players.some((p) => p.user_id === args.heroId)) break;
    const fieldCount = vector.filter((s) => s > 0).length;
    const starts = new Map(players.map((p) => [p.user_id, p.stack]));
    dealerSeat = players.find((p) => p.seat > dealerSeat)?.seat ?? players[0].seat;
    const button = players.findIndex((p) => p.seat === dealerSeat);
    const sb = (button + (players.length === 2 ? 0 : 1)) % players.length;
    const bb = (sb + 1) % players.length;
    const drawKey = `${args.sampleIndex}:${hand}:${players.map((p) => p.user_id).join(',')}`;
    let draw = args.drawCache?.get(drawKey);
    if (!draw) {
      const deck: Card[] = [];
      for (const suit of ['clubs', 'diamonds', 'hearts', 'spades'] as const)
        for (const rank of '23456789TJQKA') deck.push({ rank: rank as Card['rank'], suit });
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      for (const p of players) p.cards = [deck.pop()!, deck.pop()!];
      const board = Array.from({ length: 5 }, () => deck.pop()!);
      draw = {
        board,
        seats: new Map(
          players.map((p) => {
            const preflop = preflopStrength(p.cards);
            return [
              p.user_id,
              {
                cards: p.cards,
                preflop,
                showdown: scoreHoldem([...p.cards, ...board], 7, false),
                streets: [3, 4, 5].map((size) =>
                  continuationStrength(
                    Math.floor(
                      scoreHoldem([...p.cards, ...board.slice(0, size)], size + 2, false) / 0x100000
                    ),
                    preflop
                  )
                ),
              },
            ];
          })
        ),
      };
      args.drawCache?.set(drawKey, draw);
    }
    for (const p of players) p.cards = draw.seats.get(p.user_id)!.cards;
    const commit = (p: SeatPlayer, requested: number, ante = false) =>
      commitFutureChips(p, requested, ante ? level.anteType : null);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const individual = level.anteType === 'per_player' ? level.ante : 0;
      const bba =
        level.anteType === 'big_blind' && i === bb
          ? bigBlindAnteTotal(level.ante, players.length, level.bigBlind)
          : 0;
      const paid =
        commit(p, individual, true) +
        commit(p, i === sb ? level.smallBlind : i === bb ? level.bigBlind : 0) +
        commit(p, bba, true);
      forcedPaid[p.user_id] = (forcedPaid[p.user_id] ?? 0) + paid;
    }
    // Return a street's uncalled live wager before advancing its betting state.
    const refund = () => {
      const sorted = players.slice().sort((a, b) => b.bet - a.bet);
      const top = sorted[0];
      const excess = top.bet - (sorted[1]?.bet ?? 0);
      if (!top.is_folded && excess > 0) {
        top.stack += excess;
        top.bet -= excess;
        top.totalInvested -= excess;
        top.is_all_in = top.stack <= 0;
      }
    };
    const order = players.slice(bb + 1).concat(players.slice(0, bb + 1));
    const strength = new Map(players.map((p) => [p.user_id, draw.seats.get(p.user_id)!.preflop]));
    // One open, then fold/call responses; a short stack can fund only its own all-in.
    const opener = order.find((p) => !p.is_all_in && strength.get(p.user_id)! >= 0.72);
    const price = opener
      ? Math.max(level.bigBlind, Math.min(opener.bet + opener.stack, 3 * level.bigBlind))
      : level.bigBlind;
    if (opener) commit(opener, price - opener.bet);
    for (const p of order) {
      if (p === opener || p.is_all_in) continue;
      const due = Math.min(p.stack, Math.max(0, price - p.bet));
      if (due > 0 && strength.get(p.user_id)! < (opener ? 0.55 : 0.38)) p.is_folded = true;
      else commit(p, due);
    }
    refund();
    const opponents = players.filter((p) => p.user_id !== args.heroId);
    for (const [i, street] of (['flop', 'turn', 'river'] as const).entries()) {
      if (args.withinBudget?.() === false) return null;
      const contact = (p: SeatPlayer) => draw.seats.get(p.user_id)!.streets[i];
      if (
        !simulateTournamentContinuation(
          players,
          {
            heroId: args.heroId,
            dealerSeat,
            bigBlind: level.bigBlind,
            currentStreet: 'preflop',
            heroChecked: false,
            opponentIds: opponents.map((p) => p.user_id),
            sampleIndex: args.sampleIndex,
            streets: [
              {
                street,
                heroStrength: contact(players.find((p) => p.user_id === args.heroId)!),
                opponentStrength: opponents.map(contact),
              },
            ],
          },
          (p, n) => {
            commit(p, n);
          }
        )
      )
        return null;
      refund();
    }
    const pots = calculatePots(players);
    const winners = settleFutureHand(
      players,
      pots,
      dealerSeat,
      new Map(players.map((p) => [p.user_id, draw.seats.get(p.user_id)!.showdown]))
    );
    if (!winners) return null;
    for (const p of players) vector[args.localIndex.get(p.user_id)!] = p.stack;
    for (const win of winners) vector[args.localIndex.get(win.userId)!] += win.amount;
    const busted = players.filter((p) => vector[args.localIndex.get(p.user_id)!] <= 0);
    for (const p of busted) {
      const shorter = busted.filter((q) => starts.get(q.user_id)! < starts.get(p.user_id)!).length;
      const tied = busted.filter((q) => starts.get(q.user_id) === starts.get(p.user_id)).length;
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
    if (Math.abs(vector.reduce((a, b) => a + b, 0) - initialTotal) > 0.005) return null;
  }
  return {
    vector,
    eliminations,
    hands,
    forcedPaid,
    conservationError: Math.abs(vector.reduce((a, b) => a + b, 0) - initialTotal),
  };
}
