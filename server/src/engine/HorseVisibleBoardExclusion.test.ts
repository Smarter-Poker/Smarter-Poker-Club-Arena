import { afterEach, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import * as equity from './HorseEval.js';
import type { Card, SeatPlayer } from '../types.js';

afterEach(() => vi.restoreAllMocks());
const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
const key = (c: Card) => `${c.rank}:${c.suit}`;

it.each(['nlh', 'plo4', 'pineapple'])(
  '%s marginal board equity excludes every other visible board and own known discard',
  (variant) => {
    const boards = [
      [card('2', 'clubs'), card('7', 'diamonds'), card('9', 'spades')],
      [card('3', 'clubs'), card('8', 'diamonds'), card('T', 'spades')],
      [card('4', 'clubs'), card('J', 'diamonds'), card('Q', 'spades')],
    ];
    const ownDiscard = variant === 'pineapple' ? [card('6', 'hearts')] : [];
    const hero: SeatPlayer = {
      seat: 1,
      user_id: 'board-hero',
      username: 'Horse',
      stack: 100,
      bet: 0,
      totalInvested: 3,
      is_horse: true,
      is_folded: false,
      is_sitting_out: false,
      is_all_in: false,
      cards: [
        card('A', 'hearts'),
        card('K', 'hearts'),
        ...(variant === 'plo4' ? [card('5', 'diamonds'), card('5', 'spades')] : []),
      ],
      knownDeadCards: ownDiscard,
    };
    const opponent = { ...hero, seat: 2, user_id: 'board-opponent', cards: [], knownDeadCards: [] };
    const gs: HorseGameStateV2 = {
      players: [hero, opponent],
      dealtSeatIds: [1, 2],
      stage: 'flop',
      gameVariant: variant,
      gameMode: 'cash',
      format: 'cash',
      communityCards: boards[0],
      communityCards2: boards[1],
      communityCards3: boards[2],
      boardCount: 3,
      bombPot: true,
      pot: 6,
      currentBet: 0,
      minRaise: 2,
      bigBlind: 2,
      dealerSeat: 2,
    };
    const original = structuredClone(gs);
    const sample = vi.spyOn(equity, 'simulateEquity');
    const result = HorseLogic.decide(
      hero,
      gs,
      'balanced',
      {},
      {
        mind: false,
        phase10Plo4: 'off',
        phase11Omaha: 'off',
        phase12Remaining: 'off',
        phase13Joint: 'off',
        v38Ev: false,
      }
    );
    expect(result.policyFallback).toBeUndefined();
    expect(sample).toHaveBeenCalledTimes(3);
    for (const [index, call] of sample.mock.calls.entries()) {
      const excluded = call[10] ?? [];
      expect(excluded.map(key).sort()).toEqual(
        [...ownDiscard, ...boards.filter((_, i) => i !== index).flat()].map(key).sort()
      );
      expect(excluded.every((c) => !boards[index].some((b) => key(c) === key(b)))).toBe(true);
    }
    expect(gs).toEqual(original);
  }
);
