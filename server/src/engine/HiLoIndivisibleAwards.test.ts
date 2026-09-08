import { describe, it, expect } from 'vitest';
import { determineWinners } from './PokerEngine.js';
import { HandController } from './HandController.js';
import type { Card, SeatPlayer, PerPotAward, HandConfig, HandEvent } from '../types.js';

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
const board = [
  card('K', 'clubs'),
  card('K', 'diamonds'),
  card('7', 'hearts'),
  card('3', 'spades'),
  card('2', 'clubs'),
];
const players = [
  {
    user_id: 'high1',
    seat: 1,
    is_folded: false,
    cards: [card('K', 'hearts'), card('Q', 'hearts'), card('J', 'hearts'), card('9', 'clubs')],
  },
  {
    user_id: 'low',
    seat: 2,
    is_folded: false,
    cards: [card('A', 'spades'), card('4', 'diamonds'), card('5', 'clubs'), card('6', 'hearts')],
  },
  {
    user_id: 'high2',
    seat: 3,
    is_folded: false,
    cards: [card('K', 'spades'), card('Q', 'spades'), card('J', 'diamonds'), card('9', 'diamonds')],
  },
] as SeatPlayer[];

function award(amount: number, variant: string, unit: number) {
  const detail: PerPotAward[] = [];
  const winners = determineWinners(
    players,
    board,
    [{ amount, eligiblePlayers: players.map((p) => p.user_id) }],
    variant,
    1,
    detail,
    undefined,
    unit
  );
  return { winners, detail };
}

describe('high-low split respects the indivisible unit before splitting winners', () => {
  for (const variant of ['plo8', 'flo8']) {
    for (const amount of [1, 3, 5, 9, 959]) {
      it(`${variant}: ${amount} tournament chips stay whole in every award leg`, () => {
        const { winners, detail } = award(amount, variant, 1);
        expect(winners.reduce((s, w) => s + w.amount, 0)).toBe(amount);
        expect(detail.reduce((s, w) => s + w.amount, 0)).toBe(amount);
        expect(detail.filter((w) => w.low).reduce((s, w) => s + w.amount, 0)).toBe(
          Math.floor(amount / 2)
        );
        expect(detail.filter((w) => !w.low).reduce((s, w) => s + w.amount, 0)).toBe(
          Math.ceil(amount / 2)
        );
        expect(detail.every((w) => Number.isInteger(w.amount))).toBe(true);
        expect(winners.every((w) => Number.isInteger(w.amount))).toBe(true);
        const high = Object.fromEntries(
          detail.filter((w) => !w.low).map((w) => [w.userId, w.amount])
        );
        expect(high.high2).toBe(Math.ceil(Math.ceil(amount / 2) / 2));
        expect(high.high1).toBe(Math.floor(Math.ceil(amount / 2) / 2));
      });
    }
    it(`${variant}: cash still divides into cents and gives the odd cent to high`, () => {
      const { detail } = award(9.59, variant, 0.01);
      expect(detail.filter((w) => w.low).reduce((s, w) => s + w.amount, 0)).toBe(4.79);
      expect(detail.filter((w) => !w.low).reduce((s, w) => s + w.amount, 0)).toBe(4.8);
    });
    it(`${variant}: each side pot applies its own high-low split and eligibility`, () => {
      const detail: PerPotAward[] = [];
      determineWinners(
        players,
        board,
        [
          { amount: 9, eligiblePlayers: ['high1', 'low', 'high2'] },
          { amount: 5, eligiblePlayers: ['low', 'high1'] },
        ],
        variant,
        1,
        detail,
        undefined,
        1
      );
      expect(
        detail.filter((w) => w.potIndex === 1).map((w) => [w.userId, w.amount, w.low])
      ).toEqual([
        ['high1', 3, false],
        ['low', 2, true],
      ]);
      expect(detail.reduce((s, w) => s + w.amount, 0)).toBe(14);
      expect(detail.every((w) => Number.isInteger(w.amount))).toBe(true);
    });
  }
});

describe('tournament high-low awards are wired through HandController', () => {
  for (const gameVariant of ['plo8', 'flo8'] as const) {
    it(`${gameVariant}: a complete nine-chip hand emits and applies whole awards`, () => {
      const events: HandEvent[] = [];
      const seated = players.map((p) => ({
        ...p,
        username: p.user_id,
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_all_in: false,
        is_sitting_out: false,
      }));
      const hc = new HandController(
        {
          tableId: 'hilo-fixture',
          handNumber: 1,
          gameVariant,
          smallBlind: 1,
          bigBlind: 2,
          ante: 1,
          isTournament: true,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        } as HandConfig,
        seated,
        1
      );
      hc.onEvent((e) => events.push(e));
      hc.start();
      expect(hc.performAction(1, 'call')).toBe(true);
      expect(hc.performAction(2, 'call')).toBe(true);
      expect(hc.performAction(3, 'check')).toBe(true);
      for (let street = 0; street < 2; street++) {
        for (const seat of [2, 3, 1]) expect(hc.performAction(seat, 'check')).toBe(true);
      }
      const state = (
        hc as unknown as { state: { stage: string; players: SeatPlayer[]; communityCards: Card[] } }
      ).state;
      expect(state.stage).toBe('river');
      state.communityCards = [...board];
      state.players.forEach((p) => {
        p.cards = [...players.find((f) => f.user_id === p.user_id)!.cards];
      });
      for (const seat of [2, 3, 1]) expect(hc.performAction(seat, 'check')).toBe(true);
      const event = events.find((e) => e.type === 'WINNERS') as Extract<
        HandEvent,
        { type: 'WINNERS' }
      >;
      expect(event).toBeDefined();
      expect(Object.fromEntries(event.winners.map((w) => [w.userId, w.amount]))).toEqual({
        high1: 2,
        high2: 3,
        low: 4,
      });
      expect(state.players.every((p) => Number.isInteger(p.stack))).toBe(true);
      expect(state.players.reduce((s, p) => s + p.stack, 0)).toBe(300);
      expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toHaveLength(1);
    });
  }
});
