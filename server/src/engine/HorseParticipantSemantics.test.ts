import { beforeEach, describe, expect, it } from 'vitest';
import { HorseLogic, bubblePressure, satelliteRead } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import type { SeatPlayer, Card } from '../types.js';

const cards = (text: string): Card[] => {
  const suits: Record<string, string> = { h: 'hearts', d: 'diamonds', s: 'spades', c: 'clubs' };
  return Array.from(
    { length: text.length / 2 },
    (_, i) => ({ rank: text[i * 2], suit: suits[text[i * 2 + 1]] }) as Card
  );
};
const seat = (n: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer => ({
  seat: n,
  user_id: `p${n}`,
  username: `p${n}`,
  stack: 400,
  bet: 0,
  totalInvested: 0,
  cards: n === 1 ? cards('AhKh') : [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  ...overrides,
});
beforeEach(() => {
  HorseMind.reset();
  seedFastRandom(150415);
  enableBrainTelemetry();
  drainFires();
});

describe('Horse response rights and showdown rights are different populations', () => {
  it.each([false, true])(
    'retains a large all-in threat to a satellite seat after sitting out (%s)',
    (away) => {
      const hero = seat(1, { stack: 40000 });
      const rival = seat(2, {
        stack: 0,
        bet: 35000,
        totalInvested: 35000,
        is_all_in: true,
        is_sitting_out: away,
      });
      const gs = {
        players: [hero, rival, seat(3, { stack: 2500 })],
        bigBlind: 200,
        ante: 25,
        gameMode: 'tournament',
        format: 'mtt',
        tournament: {
          satellite: true,
          satelliteSeats: 2,
          spotsPaid: 2,
          playersLeft: 3,
          stacks: [40000, 35000, 2500],
        },
      };
      const read = satelliteRead(gs as never, hero, 200);
      expect(read.locked).toBe(true);
      expect(read.coversAll).toBe(false);
    }
  );

  it.each([false, true])(
    'cannot apply bubble fold pressure when every opponent is all-in (%s)',
    (away) => {
      const hero = seat(1, { stack: 50000 });
      const gs = {
        players: [hero, seat(2, { stack: 0, bet: 10000, is_all_in: true, is_sitting_out: away })],
        gameMode: 'tournament',
        format: 'mtt',
        tournament: { playersLeft: 12, spotsPaid: 9, inMoney: false },
      };
      expect(bubblePressure(gs as never, hero, 2)).toBe(0);
    }
  );

  it('does not mistake an away covering all-in for an opportunity to bluff that raiser', () => {
    const hero = seat(1, { stack: 50000 });
    const gs = {
      players: [
        hero,
        seat(2, { stack: 0, bet: 45000, is_all_in: true, is_sitting_out: true }),
        seat(3, { stack: 10000 }),
      ],
      gameMode: 'tournament',
      format: 'mtt',
      tournament: { playersLeft: 12, spotsPaid: 9, inMoney: false },
    };
    expect(bubblePressure(gs as never, hero, 2)).toBe(0);
    // The smaller live responder can still be pressured for a side pot.
    expect(bubblePressure(gs as never, hero, 3)).toBe(0.6);
  });

  it.each([1, 2])('keeps the real heads-up policy based on %s showdown opponents', (count) => {
    const results = [false, true].map((away) => {
      seedFastRandom(150415);
      drainFires();
      const hero = seat(1, { totalInvested: 10 });
      const allin = seat(2, {
        stack: 0,
        bet: 15,
        totalInvested: 25,
        is_all_in: true,
        is_sitting_out: away,
      });
      const players = [
        hero,
        allin,
        ...(count === 2 ? [seat(3, { stack: 375, bet: 15, totalInvested: 25 })] : []),
      ];
      const gs = {
        players,
        dealtSeatIds: players.map((p) => p.seat),
        communityCards: cards('Qh9d3s7c2c'),
        pot: count === 2 ? 60 : 35,
        currentBet: 15,
        minRaise: 15,
        stage: 'river',
        gameVariant: 'nlh',
        gameMode: 'cash',
        bigBlind: 2,
        dealerSeat: 1,
        actionHistory: [
          {
            seat: 2,
            userId: 'p2',
            stage: 'river',
            action: 'all_in',
            amount: 15,
            timestamp: 1,
            isFullRaise: true,
          },
        ],
      };
      const d = HorseLogic.decide(
        hero,
        gs as never,
        'balanced',
        {},
        { telemetry: true, mind: false, phase7Utility: false, phase13Joint: 'off' }
      );
      const fires = Object.fromEntries(drainFires().map((f) => [f.feature, f.fires]));
      return {
        action: d.action,
        amount: d.amount,
        thinkTime: d.thinkTime,
        overlay: fires.v16_hu_overlay ?? 0,
      };
    });
    expect(results[0].overlay).toBe(count === 1 ? 1 : 0);
    expect(results[1]).toEqual(results[0]);
  });

  it.each([false, true])(
    'uses only responders for bluff/value-thin reads but retains all-in call-down evidence (%s)',
    (away) => {
      HorseMind.importStats([
        { user_id: 'p2', hands: 100, facedAggr: 100, folds: 0, aggr: 10, passive: 100 },
        { user_id: 'p3', hands: 100, facedAggr: 100, folds: 90, aggr: 100, passive: 10 },
      ]);
      const responder = HorseMind.exploit('p2', false);
      const jammer = HorseMind.exploit('p3', false);
      expect(responder.valueThinMod).not.toBe(jammer.valueThinMod);
      const read = HorseMind.tableExploit(
        1,
        [seat(1), seat(2), seat(3, { stack: 0, bet: 50, is_all_in: true, is_sitting_out: away })],
        false
      );
      expect(read.bluffMod).toBe(responder.bluffMod);
      expect(read.valueThinMod).toBe(responder.valueThinMod);
      expect(read.callDownMod).toBe((responder.callDownMod + jammer.callDownMod) / 2);
    }
  );
});
