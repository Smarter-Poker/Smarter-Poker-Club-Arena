import { describe, expect, it } from 'vitest';
import type { SeatPlayer, PerPotAward } from '../types.js';
import {
  simulateTournamentFutureHands,
  FUTURE_HAND_POLICY,
  settleFutureHand,
  commitFutureChips,
} from './HorseTournamentFutureHand.js';
import { referenceDeck } from '../benchmark/OmahaReference.js';
import { calculatePots, determineWinners } from './PokerEngine.js';
import { scoreHoldem } from './HorseEval.js';

const player = (i: number, stack: number): SeatPlayer => ({
  user_id: `p${i}`,
  username: `p${i}`,
  seat: i + 1,
  stack,
  cards: [],
  bet: 0,
  totalInvested: 0,
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
});
const run = (
  stacks: number[],
  dealerSeat: number,
  sampleIndex: number,
  anteType: 'none' | 'per_player' | 'big_blind' = 'none'
) => {
  const players = stacks.map((stack, i) => player(i, stack));
  const args = {
    players,
    vector: stacks,
    localIndex: new Map(players.map((p, i) => [p.user_id, i])),
    heroId: 'p0',
    dealerSeat,
    sampleIndex,
    level: { smallBlind: 5, bigBlind: 10, ante: 3, anteType },
  };
  const before = JSON.stringify(args);
  const result = simulateTournamentFutureHands(args);
  expect(JSON.stringify(args)).toBe(before);
  return result;
};
describe('Phase 8 funded future-hand transition', () => {
  it('keeps reusable synthetic facts independent of player identities and caller mutations', () => {
    const players = [player(0, 100), player(1, 300), player(2, 25)];
    const args = {
      players,
      vector: [100, 300, 25],
      localIndex: new Map(players.map((p, i) => [p.user_id, i])),
      heroId: 'p0',
      dealerSeat: 2,
      sampleIndex: 27,
      level: { smallBlind: 5, bigBlind: 10, ante: 3, anteType: 'per_player' as const },
    };
    const drawCache = new Map();
    const first = simulateTournamentFutureHands({ ...args, drawCache })!;
    for (const draw of drawCache.values()) {
      draw.board[0].rank = '2';
      for (const facts of draw.seats.values()) {
        facts.cards[0].rank = '2';
        facts.streets.fill(0);
        facts.showdown = 0;
      }
    }
    const renamed = players.map((p) => ({ ...p, user_id: 'renamed-' + p.user_id }));
    const second = simulateTournamentFutureHands({
      ...args,
      players: renamed,
      heroId: 'renamed-p0',
      localIndex: new Map(renamed.map((p, i) => [p.user_id, i])),
    })!;
    expect(second.vector).toEqual(first.vector);
    expect(second.conservationError).toBe(0);
    expect(Object.keys(second.forcedPaid).every((id) => id.startsWith('renamed-'))).toBe(true);
    expect(simulateTournamentFutureHands(args)).toEqual(first);
  });
  it('preserves an individual ante through zero-value shared-ante posting and caps short stacks', () => {
    const short = player(0, 7),
      deep = player(1, 100);
    for (const p of [short, deep]) {
      commitFutureChips(p, 3, 'per_player');
      commitFutureChips(p, 10);
      commitFutureChips(p, 0, 'per_player');
      expect(p.deadInvested).toBe(3);
      expect(p.individualAnteInvested).toBe(3);
    }
    expect(short.stack).toBe(0);
    expect(short.bet).toBe(4);
    expect(deep.stack).toBe(87);
    expect(deep.bet).toBe(10);
    expect(calculatePots([short, deep])).toEqual([
      { amount: 14, eligiblePlayers: ['p0', 'p1'] },
      { amount: 6, eligiblePlayers: ['p1'] },
    ]);
  });
  it('matches production per-pot payouts for 512 dealt, folded, side-pot and tied NLH cases', () => {
    let seed = 804011;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 512; trial++) {
      const deck = referenceDeck();
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const board =
        trial % 8 === 0
          ? referenceDeck().filter((c) => c.suit === 'spades' && 'TJQKA'.includes(c.rank))
          : deck.splice(0, 5);
      const rest = deck.filter((c) => !board.some((b) => b.suit === c.suit && b.rank === c.rank));
      const players = Array.from({ length: 2 + (trial % 9) }, (_, i) => ({
        ...player(i, 100),
        cards: rest.splice(0, 2),
        totalInvested: 5 + ((trial + i * 29) % 100),
        is_folded: i > 1 && (trial + i) % 3 === 0,
      }));
      const pots = calculatePots(players),
        dealer = (trial % players.length) + 1;
      const expected: PerPotAward[] = [];
      determineWinners(players, board, pots, 'nlh', dealer, expected, undefined, 1);
      const actual = settleFutureHand(
        players,
        pots,
        dealer,
        new Map(players.map((p) => [p.user_id, scoreHoldem([...p.cards, ...board], 7, false)]))
      );
      const normalized = (rows: Array<{ userId: string; potIndex: number; amount: number }>) =>
        rows
          .map(({ userId, potIndex, amount }) => ({ userId, potIndex, amount }))
          .sort((a, b) => a.potIndex - b.potIndex || a.userId.localeCompare(b.userId));
      expect(normalized(actual!)).toEqual(normalized(expected));
    }
  });
  it.each(['none', 'per_player', 'big_blind'] as const)(
    'conserves actual funded stacks across 2–10 seats, short stacks and %s antes',
    (ante) => {
      for (let seats = 2; seats <= 10; seats++)
        for (let sample = 0; sample < 24; sample++) {
          const stacks = Array.from(
            { length: seats },
            (_, i) => [2, 7, 13, 29, 100, 350][(sample + i) % 6]
          );
          const result = run(stacks, (sample % seats) + 1, sample, ante);
          expect(result).not.toBeNull();
          expect(result!.hands).toBe(FUTURE_HAND_POLICY.maxHands);
          expect(result!.vector.reduce((a, b) => a + b, 0)).toBe(stacks.reduce((a, b) => a + b, 0));
          expect(result!.vector.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
          expect(result!.conservationError).toBe(0);
          expect(
            result!.eliminations.every((e) => e.places.every((p) => p >= 2 && p <= seats))
          ).toBe(true);
          expect(run(stacks, (sample % seats) + 1, sample, ante)).toEqual(result);
        }
    }
  );
  it('rotates the next heads-up dealer and forces only affordable blinds', () => {
    const result = run([7, 100], 1, 1)!;
    // Next dealer is seat 2 (SB); hero at seat 1 fronts the BB, capped at seven.
    expect(result.forcedPaid).toEqual({ p0: 7, p1: 5 });
  });
  it('uses individual-ante first and BB-first shared BBA rules', () => {
    expect(run([7, 100], 1, 1, 'per_player')!.forcedPaid).toEqual({ p0: 7, p1: 8 });
    expect(run([100, 100], 1, 1, 'big_blind')!.forcedPaid).toEqual({ p0: 16, p1: 5 });
    expect(run([7, 100], 1, 1, 'big_blind')!.forcedPaid).toEqual({ p0: 7, p1: 5 });
  });
  it('preserves remote field chips and returns unavailable on expired work', () => {
    const players = [player(0, 100), player(1, 100)];
    const args = {
      players,
      vector: [100, 100, 350],
      localIndex: new Map([
        ['p0', 0],
        ['p1', 1],
      ]),
      heroId: 'p0',
      dealerSeat: 1,
      sampleIndex: 1,
      level: { smallBlind: 5, bigBlind: 10, ante: 0, anteType: 'none' as const },
    };
    expect(simulateTournamentFutureHands(args)!.vector[2]).toBe(350);
    expect(simulateTournamentFutureHands({ ...args, withinBudget: () => false })).toBeNull();
  });
  it('reuses only common card facts while every stack and blind bound settles independently', () => {
    const players = [player(0, 100), player(1, 300), player(2, 25)];
    const drawCache = new Map();
    for (let sampleIndex = 0; sampleIndex < 24; sampleIndex++) {
      for (const vector of [
        [100, 300, 25],
        [10, 390, 25],
        [125, 300, 0],
      ]) {
        for (const bigBlind of [10, 100]) {
          const args = {
            players,
            vector,
            localIndex: new Map(players.map((p, i) => [p.user_id, i])),
            heroId: 'p0',
            dealerSeat: 2,
            sampleIndex,
            level: { smallBlind: bigBlind / 2, bigBlind, ante: 3, anteType: 'per_player' as const },
          };
          const cold = simulateTournamentFutureHands(args);
          expect(simulateTournamentFutureHands({ ...args, drawCache })).toEqual(cold);
          expect(simulateTournamentFutureHands({ ...args, drawCache })).toEqual(cold);
        }
      }
    }
    expect(drawCache.size).toBe(48);
  });
});

it('common future-hand samples react to candidate stack vectors rather than projecting a fixed penalty', () => {
  const funded = run([100, 300, 25], 2, 19)!;
  const committed = run([10, 390, 25], 2, 19)!;
  expect(funded.vector).not.toEqual(committed.vector);
  expect(funded.vector.reduce((a, b) => a + b, 0)).toBe(425);
  expect(committed.vector.reduce((a, b) => a + b, 0)).toBe(425);
});
