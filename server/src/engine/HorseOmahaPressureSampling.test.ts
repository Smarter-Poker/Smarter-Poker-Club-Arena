import { describe, expect, it } from 'vitest';
import {
  simulateEquity,
  seedFastRandom,
  variantInfo,
  placeOmahaPressureCombo,
  scoreOmahaHiPartial,
  type HorseEquityOutcomeCollector,
} from './HorseEval.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import fixtures from './fixtures/horse-pressure-oct24.json';
import { RANKS, SUITS } from './PokerEngine.js';
import type { Card, SeatPlayer, ActionRecord } from '../types.js';

const cards = (s: string): Card[] =>
  s.split(' ').map(
    (v) =>
      ({
        rank: v[0],
        suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[v[1] as 'c'],
      }) as Card
  );

describe('Omaha pressure sampling retains its declared value mass', () => {
  it('does not replace exhausted value redraws with weak hands in the naked-trips river', () => {
    const board = cards('5s 9c 2h 2d 7s');
    const read = {
      aggrW: 0.14,
      checked: 0,
      streets: 2,
      lastFrac: 0.7555,
      raised: false,
      bigBet: true,
      strictPressureRange: true,
    };
    const outcomes: HorseEquityOutcomeCollector = { maxSamples: 10000, samples: [] };
    seedFastRandom(20261025);
    simulateEquity(
      cards('2c 3h 4h 4s'),
      board,
      1,
      variantInfo('plo4'),
      10000,
      [[0.44, 0.91]],
      false,
      undefined,
      [read],
      outcomes
    );
    const strong = outcomes.samples.filter(
      (x) => Math.floor(x.opponentHigh[0] / 0x100000) >= 4
    ).length;
    expect(outcomes.samples).toHaveLength(10000);
    // The existing tier's value mixture is 85%. Its arbitrary/bluff arm may
    // also contain value. 82% leaves >8 standard deviations of headroom.
    expect(strong / outcomes.samples.length).toBeGreaterThanOrEqual(0.82);
  });

  it.each([4, 5, 6])(
    'preserves the physical deck and uses supported value combinations with %i cards',
    (holeCount) => {
      const board = cards('5s 9c 2h 2d 7s');
      const dead = cards('2c 3h 4h 4s Ac Kd');
      const key = (c: Card) => c.rank + ':' + c.suit;
      const excluded = new Set([...board, ...dead].map(key));
      const deck = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }) as Card)).filter(
        (c) => !excluded.has(key(c))
      );
      const before = deck.map(key).sort();
      seedFastRandom(315 + holeCount);
      for (let sample = 0; sample < 80; sample++) {
        // Reserve two cards before the window to stand for an earlier opponent.
        const fixed = deck.slice(0, 2).map(key);
        expect(
          placeOmahaPressureCombo(deck, 2, deck.length, [0.1, 1], holeCount, board, 4, 99)
        ).toBe(true);
        const hand = deck.slice(2, 2 + holeCount);
        expect(Math.floor(scoreOmahaHiPartial(hand, board) / 0x100000)).toBeGreaterThanOrEqual(4);
        expect(hand.some((c) => excluded.has(key(c)))).toBe(false);
        expect(deck.slice(0, 2).map(key)).toEqual(fixed);
        expect(deck.map(key).sort()).toEqual(before);
      }
    }
  );

  it('reports unavailable support without mutating the deck', () => {
    const deck = cards('Ac Kd Qh Js 9s 8c');
    const before = JSON.stringify(deck);
    expect(
      placeOmahaPressureCombo(deck, 0, deck.length, [0, 1], 4, cards('5s 9c 2h 2d 7s'), 9, 99)
    ).toBe(false);
    expect(JSON.stringify(deck)).toBe(before);
  });

  it.each(fixtures)(
    'prices recorded river review$review from its public pressure line',
    (fixture) => {
      const n = fixture.node;
      const players = n.seats.map(
        ([seat, stack, bet, totalInvested, deadInvested, individualAnteInvested, flags]) => ({
          seat,
          stack,
          bet,
          totalInvested,
          deadInvested,
          individualAnteInvested,
          user_id: `seat${seat}`,
          username: `Seat ${seat}`,
          cards: seat === fixture.heroSeat ? fixture.heroCards : [],
          is_folded: !!(flags & 1),
          is_all_in: !!(flags & 2),
          is_sitting_out: !!(flags & 4),
          is_horse: true,
        })
      ) as SeatPlayer[];
      const hero = players.find((p) => p.seat === fixture.heroSeat)!;
      const board = cards((n.boards[0].match(/../g) ?? []).join(' '));
      const gs = {
        players,
        communityCards: board,
        pot: n.pot,
        currentBet: n.currentBet,
        minRaise: n.bigBlind,
        lastRaise: n.bigBlind,
        minRaiseTo: n.minRaiseTo,
        maxRaiseTo: n.maxRaiseTo,
        stage: n.street,
        gameVariant: n.variant,
        bigBlind: n.bigBlind,
        smallBlind: n.smallBlind,
        dealerSeat: n.dealerSeat,
        gameMode: n.mode,
        format: 'cash',
        bettingStructure: n.structure,
        chipUnit: n.chipUnit,
        legalActions: n.legalActions,
        toCall: n.toCall,
        heroSeat: fixture.heroSeat,
        currentPlayerSeat: fixture.heroSeat,
        rakeConfig: {
          ...n.deductions.rake,
          playerCountCaps: n.deductions.rake.playerCountCaps.map(([players, cap]) => ({
            players,
            cap,
          })),
        },
        actionHistory: fixture.history as ActionRecord[],
      } as HorseGameStateV2;
      for (let seed = 1; seed <= 40; seed++) {
        HorseMind.reset();
        seedFastRandom(seed * 977);
        expect(
          HorseLogic.decide(
            hero,
            gs,
            'balanced',
            {},
            { mind: true, telemetry: false, v56OmahaPressureRange: true }
          ).action
        ).toBe('fold');
        HorseMind.reset();
        seedFastRandom(seed * 977);
        expect(
          HorseLogic.decide(hero, gs, 'balanced', {}, { mind: true, telemetry: false }).action
        ).toBe('fold');
      }
      HorseMind.reset();
      seedFastRandom(977);
      expect(
        HorseLogic.decide(
          hero,
          gs,
          'balanced',
          {},
          { mind: true, telemetry: false, v56OmahaPressureRange: false }
        ).action
      ).not.toBe('fold');
    }
  );
});
