import { describe, it, expect } from 'vitest';
import {
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  compareHands,
  determineWinners,
  calculatePots,
} from '../engine/PokerEngine.js';
import { HandController } from '../engine/HandController.js';
import { potLimitRaiseTo } from '../engine/BettingStructure.js';
import type { Card, SeatPlayer } from '../types.js';
import {
  OMAHA_RULES,
  referenceOmaha,
  referenceDeck,
  referencePotLimitRaiseTo,
  settleOmahaReference,
  contributionLayers,
  physicalBoardCards,
  omahaHandComponents,
  type OmahaVariant,
} from './OmahaReference.js';

const parse = (text: string): Card[] =>
  text.split(' ').map((s) => ({
    rank: s[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[
      s[1] as 'c' | 'd' | 'h' | 's'
    ],
  }));
let seed = 901123;
function deal(n: number): Card[] {
  const deck = referenceDeck();
  return Array.from({ length: n }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return deck.splice((seed >>> 0) % deck.length, 1)[0];
  });
}

describe('Phase 9 reusable independent Omaha reference', () => {
  it('uses exactly two hole cards, including on a board-made royal flush', () => {
    const result = referenceOmaha(parse('2c 3d 4h 5s'), parse('As Ks Qs Js Ts'));
    expect(result.category).not.toBe(10);
    expect(result.highHoleIndices).toHaveLength(2);
    expect(result.highBoardIndices).toHaveLength(3);
    expect(referenceOmaha(parse('As Ks 2d 3d'), parse('Qs Js Ts 7c 8h')).category).toBe(10);
  });
  it('qualifies only five distinct eight-or-better ranks and permits different high/low cards', () => {
    const hand = referenceOmaha(parse('As 2s Kh Kd'), parse('3c 4d 8h Kc Qh'));
    expect(hand.lowRanks).toEqual([8, 4, 3, 2, 1]);
    expect(hand.lowHoleIndices).toEqual([0, 1]);
    expect(hand.highHoleIndices).toEqual([2, 3]);
    expect(referenceOmaha(parse('As 2s Kh Kd'), parse('3c 4d 9h Kc Qh')).low).toBeNull();
  });
  it.each(Object.keys(OMAHA_RULES) as OmahaVariant[])(
    '%s winner ordering, exact cards and low agree on 128 independent deals',
    (variant) => {
      for (let trial = 0; trial < 128; trial++) {
        const count = OMAHA_RULES[variant].holes,
          cards = deal(count * 2 + 5),
          a = cards.slice(0, count),
          b = cards.slice(count, count * 2),
          board = cards.slice(count * 2);
        const ra = referenceOmaha(a, board),
          rb = referenceOmaha(b, board),
          pa = evaluateOmahaHand(a, board),
          pb = evaluateOmahaHand(b, board);
        expect(Math.sign(ra.high - rb.high)).toBe(Math.sign(compareHands(pa, pb)));
        expect(ra.category).toBe(pa.ranking);
        expect(ra.lowRanks).toEqual(evaluateOmahaLowHand(a, board)?.kickers ?? null);
        expect(ra.highHoleIndices).toHaveLength(2);
        expect(ra.highBoardIndices).toHaveLength(3);
      }
    }
  );
  it.each(Object.keys(OMAHA_RULES) as OmahaVariant[])(
    '%s conserves side pots and agrees with production payouts',
    (variant) => {
      for (let trial = 0; trial < 64; trial++) {
        const count = OMAHA_RULES[variant].holes,
          cards = deal(count * 3 + 5),
          board = cards.slice(count * 3);
        const players = [31, 72, 104].map((contributed, i) => ({
          id: 'p' + i,
          seat: i + 1,
          contributed: contributed + trial,
          cards: cards.slice(i * count, (i + 1) * count),
          folded: trial % 3 === 0 && i === 0,
        }));
        const ref = settleOmahaReference({
          variant,
          players,
          boards: [board],
          chipUnit: 1,
          dealerSeat: (trial % 3) + 1,
        });
        const seats = players.map((p) => ({
          user_id: p.id,
          username: p.id,
          seat: p.seat,
          cards: p.cards,
          is_folded: p.folded,
          stack: 0,
          bet: p.contributed,
          totalInvested: p.contributed,
          is_all_in: true,
          is_sitting_out: false,
        }));
        // Exercise production refund and production pot construction independently.
        // This is an isolated settled-snapshot fixture, not a live chip operation.
        const controller = new HandController(
          {
            tableId: 'phase9-reference',
            handNumber: 1,
            gameVariant: variant,
            smallBlind: 1,
            bigBlind: 2,
            isTournament: true,
            rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
          },
          seats,
          (trial % 3) + 1
        );
        const internal = controller as unknown as {
          state: { players: SeatPlayer[]; pot: number };
          returnUncalledBet(): number;
        };
        internal.state.players = seats;
        internal.state.pot = players.reduce((sum, p) => sum + p.contributed, 0);
        internal.returnUncalledBet();
        const refunds = Object.fromEntries(
          seats.filter((p) => p.stack > 0).map((p) => [p.user_id, p.stack])
        );
        expect(refunds).toEqual(ref.refunds);
        const productionPots = calculatePots(seats);
        expect(
          productionPots.map((p) => ({ amount: p.amount, eligible: [...p.eligiblePlayers].sort() }))
        ).toEqual(ref.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible].sort() })));
        const production = determineWinners(
          seats,
          board,
          productionPots,
          variant,
          (trial % 3) + 1,
          undefined,
          undefined,
          1
        );
        const actual = Object.fromEntries(players.map((p) => [p.id, 0]));
        production.forEach((p) => {
          actual[p.userId] += p.amount;
        });
        expect(actual).toEqual(ref.totals);
        expect(ref.distributed).toBe(ref.contributed);
        expect(ref.refunds.p2).toBe(32);
      }
    }
  );
  it('allocates a tied low quarter without crediting an ineligible side pot', () => {
    const players = [
      { id: 'hero', seat: 1, contributed: 100, cards: parse('As 2s Jh Td') },
      { id: 'high', seat: 2, contributed: 200, cards: parse('Kh Kd Qc Qd') },
      { id: 'low', seat: 3, contributed: 200, cards: parse('Ah 2h 9s 9d') },
    ];
    const settled = settleOmahaReference({
      variant: 'plo8',
      players,
      boards: [parse('3c 4d 8h Kc Qh')],
      chipUnit: 1,
      dealerSeat: 3,
    });
    expect(settled.totals).toEqual({ hero: 75, high: 250, low: 175 });
    expect(settled.awards.filter((a) => a.playerId === 'hero').every((a) => a.potIndex === 0)).toBe(
      true
    );
  });
  it('rejects bad physical cards, malformed contexts and impossible eligibility', () => {
    expect(() => referenceOmaha(parse('As As Kh Kd'), parse('3c 4d 8h Kc Qh'))).toThrow(
      'Duplicate'
    );
    expect(() => physicalBoardCards([parse('As Ks Qs'), parse('As 2c 3c')])).toThrow('Duplicate');
    expect(() => physicalBoardCards([parse('As Ks Qs 2c'), parse('As Ks Qs 3d')], 3)).not.toThrow();
    expect(() =>
      contributionLayers(
        [
          { id: 'a', seat: 1, cards: [], contributed: 1, folded: true },
          { id: 'b', seat: 2, cards: [], contributed: 1, folded: true },
        ],
        1
      )
    ).toThrow('eligible');
    expect(() =>
      contributionLayers(
        [
          { id: 'a', seat: 1, cards: [], contributed: 0.5 },
          { id: 'b', seat: 2, cards: [], contributed: 1 },
        ],
        1
      )
    ).toThrow('geometry');
  });
  it('independently checks pot-limit total ceilings including existing bets and stack caps', () => {
    for (const pot of [0, 3, 100, 200])
      for (const current of [0, 2, 25])
        for (const own of [0, current])
          for (const stack of [1, 1000]) {
            expect(referencePotLimitRaiseTo(pot, current, own, stack)).toBe(
              Math.min(own + stack, potLimitRaiseTo(pot, current, current - own))
            );
          }
    expect(referencePotLimitRaiseTo(200, 100, 0, 1000)).toBe(400);
    expect(() => referencePotLimitRaiseTo(-1, 0, 0, 100)).toThrow();
  });
  it('exposes factual suit, pair, low backup and board-pairing components', () => {
    const profile = omahaHandComponents(parse('As 2s 3h 3d'), parse('3c 4d 8h Kc Qh'));
    expect(profile.nutSuitedAces).toEqual(['spades']);
    expect(profile.pairedRanks).toEqual(['3']);
    expect(profile.hasBackupLowCards).toBe(true);
    expect(profile.lowHoleRanksRepeatedOnBoard).toEqual([3]);
    expect(profile.calibratedDominationProbability).toBeNull();
  });
});
