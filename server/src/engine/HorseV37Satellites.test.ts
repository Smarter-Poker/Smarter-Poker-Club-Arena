/**
 * V37 — satellites are survival, MTTs are ladders (2026-09-02, phase 4).
 *
 * Dan: "A FULL UNDERSTANDING OF ICM AND CHIP EV VALUE, AS WELL AS THE PLAY
 * DIFFERENCE BETWEEN A SATELLITE WHERE ALL WINNERS GET THE SAME PRIZE AND A
 * MTT WITH PRIZES PROGRESSIVELY PAYING MORE."
 *
 * Before this: a satellite's stored payout_structure is the MTT curve
 * (40/25/18/10/7) that settlement ignores, so the brain read every satellite
 * as a top-heavy ladder; and IcmModel's depth-4 truncation spread the rest
 * of a flat curve chip-proportionally, which says a locked stack's extra
 * chips are worth something. They are worth nothing.
 */
import { describe, it, expect } from 'vitest';
import { icmEquity, bubbleFactor, isFlatPayoutCurve, flatPayoutSurvival } from './IcmModel.js';
import { deriveContext } from '../services/TournamentBrainContext.js';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import { HorseLogic, satelliteRead } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

describe('V37 flat payout curves are priced as survival', () => {
  it('recognises a flat curve, with or without a cash remainder', () => {
    expect(isFlatPayoutCurve([25, 25, 25, 25])).toBe(true);
    expect(isFlatPayoutCurve([24, 24, 24, 24, 4])).toBe(true);
    expect(isFlatPayoutCurve([40, 25, 18, 10, 7])).toBe(false);
    expect(isFlatPayoutCurve([100])).toBe(false);
  });

  it('a covering stack near the bubble survives almost surely; a short one does not', () => {
    const stacks = [50000, 30000, 20000, 15000, 4000];
    expect(flatPayoutSurvival(stacks, 4, 0)).toBeGreaterThan(0.9);
    expect(flatPayoutSurvival(stacks, 4, 4)).toBeLessThan(0.5);
    expect(flatPayoutSurvival([100, 100, 100], 3, 0)).toBe(1);
  });

  it('flat equity is survival times one seat, not a chip-proportional ladder', () => {
    const stacks = [50000, 30000, 20000, 15000, 4000];
    const flat = [25, 25, 25, 25];
    const big = icmEquity(stacks, flat, 0);
    const mid = icmEquity(stacks, flat, 2);
    // the chip leader is worth at most one seat, not 2.5 seats' worth of chips
    expect(big).toBeLessThanOrEqual(25.01);
    expect(big).toBeGreaterThan(22);
    expect(mid).toBeGreaterThan(15);
  });

  it('the chip leader bubble factor saturates under flat prizes and not under a ladder', () => {
    const stacks = [50000, 30000, 20000, 15000, 4000];
    const flat = [25, 25, 25, 25];
    const ladder = [50, 30, 20];
    const risk = 15000;
    expect(bubbleFactor(stacks, flat, 0, risk)).toBeGreaterThan(
      bubbleFactor(stacks, ladder, 0, risk)
    );
    expect(bubbleFactor(stacks, flat, 0, risk)).toBeGreaterThanOrEqual(1.5);
  });
});

describe('V37 the brain context builds the real satellite curve', () => {
  const row = (o: Record<string, unknown> = {}) => ({
    format_contract: 'mtt-v1',
    effective_max_players: 200,
    tournament_type: 'MTT',
    variant: 'nlh',
    max_players: 100,
    table_size: 9,
    payout_structure: [
      { place: 1, percentage: 40 },
      { place: 2, percentage: 25 },
      { place: 3, percentage: 18 },
      { place: 4, percentage: 10 },
      { place: 5, percentage: 7 },
    ],
    prize_pool: 300,
    bounty_pool: 0,
    is_pko: false,
    is_bounty: false,
    satellite_seats: 3,
    satellite_target_id: 'target',
    ...o,
  });

  const entitlementFidelity = (pool: number, ticketCost: number) => {
    const seats = Math.floor(pool / ticketCost);
    const remainder = pool - seats * ticketCost;
    return {
      mysteryInventory: 'known' as const,
      satelliteEntitlements: 'known' as const,
      entitlementRows: [
        ...Array.from({ length: seats }, (_, index) => ({
          position: index + 1,
          award_kind: 'seat_or_cash',
          ticket_value: ticketCost,
          remainder_value: 0,
        })),
        ...(remainder > 0
          ? [
              {
                position: seats + 1,
                award_kind: 'cash',
                ticket_value: 0,
                remainder_value: remainder,
              },
            ]
          : []),
      ],
    };
  };

  const satelliteContext = (pool: number) =>
    deriveContext(
      row({ prize_pool: pool, prize_pool_finalized: true }) as never,
      10,
      30,
      30000,
      [],
      [],
      [],
      0,
      {},
      Date.now(),
      entitlementFidelity(pool, 100)
    );

  it('three seats at 100 from a 300 pool: three equal places, no remainder', () => {
    const ctx = satelliteContext(300);
    expect(ctx.satellite).toBe(true);
    expect(ctx.satelliteSeats).toBe(3);
    expect(ctx.spotsPaid).toBe(3);
    expect(ctx.payoutPct.length).toBe(3);
    for (const p of ctx.payoutPct) expect(p).toBeCloseTo(100 / 3, 6);
  });

  it('a 350 pool: the 50 remainder is a fourth, small place', () => {
    const ctx = satelliteContext(350);
    expect(ctx.satelliteSeats).toBe(3);
    expect(ctx.payoutPct.length).toBe(4);
    expect(ctx.payoutPct[3]).toBeCloseTo((100 * 50) / 350, 6);
    expect(ctx.payoutPct[0]).toBeCloseTo((100 * 100) / 350, 6);
  });

  it('the pool can fund more seats than guaranteed', () => {
    const ctx = satelliteContext(500);
    expect(ctx.satelliteSeats).toBe(5);
  });

  it('a plain MTT keeps its ladder', () => {
    const ctx = deriveContext(
      row({ satellite_seats: 0, satellite_target_id: null }) as never,
      10,
      30,
      30000
    );
    expect(ctx.satellite).toBe(false);
    expect(ctx.payoutPct[0]).toBe(40);
  });
});

function gsFor(stacks: number[], heroChips: number, playersLeft: number, seats: number) {
  const players: SeatPlayer[] = [
    {
      seat: 1,
      user_id: 'hero',
      username: 'h',
      stack: heroChips,
      bet: 0,
      totalInvested: 0,
      cards: cards('AhAd'),
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 2,
      user_id: 'v1',
      username: 'v1',
      stack: 8000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 3,
      user_id: 'v2',
      username: 'v2',
      stack: 6000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
  ];
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: [] as Card[],
      pot: 300,
      currentBet: 200,
      minRaise: 200,
      stage: 'preflop' as const,
      gameVariant: 'nlh',
      gameMode: 'tournament' as const,
      format: 'mtt' as const,
      bigBlind: 200,
      ante: 25,
      dealerSeat: 3,
      actionHistory: [],
      tournament: {
        playersLeft,
        spotsPaid: seats,
        satellite: true,
        satelliteSeats: seats,
        stacks,
        payoutPct: Array.from({ length: seats }, () => 100 / seats),
        avgStackChips: stacks.reduce((a, b) => a + b, 0) / stacks.length,
      },
    },
  };
}

describe('V37 satelliteRead: locked, urgent, or in the field', () => {
  it.each([false, true])(
    'prices the dealt ante population even when a player sits out (%s)',
    (dealt) => {
      const { gs, hero } = gsFor([200, 170, 100], 170, 3, 2);
      gs.bigBlind = 10;
      gs.ante = 10;
      gs.players[2].is_sitting_out = true;
      gs.players[2].is_folded = true;
      const read = satelliteRead(
        { ...gs, dealtSeatIds: dealt ? [1, 2, 3] : [1, 2] } as never,
        hero,
        17
      );
      expect(read.rank).toBe(2);
      // Four orbits require 18BB at the dealt three-seat table, 14BB at two.
      expect(read.locked).toBe(!dealt);
    }
  );
  it('a covering chip leader on the bubble is LOCKED and covers the table', () => {
    const { gs, hero } = gsFor([40000, 8000, 6000, 3000, 2500], 40000, 5, 4);
    const r = satelliteRead(gs as never, hero, 200);
    expect(r.active).toBe(true);
    expect(r.locked).toBe(true);
    expect(r.coversAll).toBe(true);
    expect(r.rank).toBe(1);
  });
  it('the shortest stack on the bubble is URGENT', () => {
    const { gs, hero } = gsFor([40000, 8000, 6000, 3000, 2500], 2500, 5, 4);
    const r = satelliteRead(gs as never, hero, 12.5);
    expect(r.locked).toBe(false);
    expect(r.urgent).toBe(true);
  });
  it('uses the worst tied rank so equal boundary stacks cannot all be locked', () => {
    const { gs, hero } = gsFor([8000, 8000, 8000, 8000], 8000, 4, 3);
    const r = satelliteRead(gs as never, hero, 40);
    expect(r.active).toBe(true);
    expect(r.rank).toBe(4);
    expect(r.locked).toBe(false);
    expect(r.urgent).toBe(true);
  });
  it('far from the bubble nobody is locked', () => {
    const { gs, hero } = gsFor([40000, 8000, 6000, 3000, 2500], 40000, 40, 4);
    expect(satelliteRead(gs as never, hero, 200).locked).toBe(false);
  });
  it('an MTT is never a satellite read', () => {
    const { gs, hero } = gsFor([40000, 8000, 6000, 3000, 2500], 40000, 5, 4);
    (gs.tournament as { satellite: boolean }).satellite = false;
    expect(satelliteRead(gs as never, hero, 200).active).toBe(false);
  });
});

function ctx(o: Partial<PreflopCtx>): PreflopCtx {
  return {
    strength: 0.5,
    position: 'late',
    raiserPosition: null,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 4,
    toCall: 2,
    currentBet: 2,
    pot: 4,
    bigBlind: 2,
    stack: 400,
    stackBB: 200,
    tightness: 1,
    bluffFreq: 0.17,
    aggression: 1,
    slowplayFreq: 0,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0.1,
    mode: 'tournament',
    anteInPlay: true,
    anteOrbitBB: 1,
    tableSize: 6,
    rand: () => 0.99,
    ...o,
  };
}

describe('V37 a locked seat folds aces to a covering all-in and jams a table it covers', () => {
  it('aces fold to an all-in worth a meaningful share of the stack', () => {
    const d = decidePreflopV7(
      ctx({
        strength: 1,
        raises: 1,
        raiserPosition: 'early',
        toCall: 120,
        currentBet: 122,
        pot: 126,
        satellite: { locked: true, urgent: false, coversAll: false },
      })
    );
    expect(d.a).toBe('fold');
  });
  it('a locked captain open-jams a middling hand into stacks that cannot call', () => {
    const d = decidePreflopV7(
      ctx({ strength: 0.5, satellite: { locked: true, urgent: false, coversAll: true } })
    );
    expect(d.a).toBe('jam');
  });
  it('a locked stack that does not cover the table just folds', () => {
    const d = decidePreflopV7(
      ctx({ strength: 0.9, satellite: { locked: true, urgent: false, coversAll: false } })
    );
    expect(d.a).toBe('fold');
  });
  it('below the seat line, the jam range widens', () => {
    const base = ctx({
      strength: 0.47,
      position: 'early',
      stack: 20,
      stackBB: 10,
      riskAdd: 0,
      anteInPlay: false,
      anteOrbitBB: 0,
    });
    expect(decidePreflopV7(base).a).toBe('fold');
    expect(
      decidePreflopV7({ ...base, satellite: { locked: false, urgent: true, coversAll: false } }).a
    ).toBe('jam');
  });
});

describe('V37 a locked seat does not play big pots postflop', () => {
  it('folds a top-pair hand to a pot-sized bet, calls a cheap one', () => {
    seedFastRandom(0x5eed37);
    const build = (bet: number) => {
      const stacks = [40000, 8000, 6000, 3000, 2500];
      const players: SeatPlayer[] = [
        {
          seat: 1,
          user_id: 'hero',
          username: 'h',
          stack: 40000,
          bet: 0,
          totalInvested: 200,
          cards: cards('KhQd'),
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        },
        {
          seat: 2,
          user_id: 'v1',
          username: 'v1',
          stack: 8000 - bet,
          bet,
          totalInvested: 200 + bet,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        },
      ];
      return {
        hero: players[0],
        gs: {
          players,
          communityCards: cards('Kc7d2s'),
          pot: 500 + bet,
          currentBet: bet,
          minRaise: Math.max(200, bet),
          stage: 'flop',
          gameVariant: 'nlh',
          gameMode: 'tournament',
          format: 'mtt',
          bigBlind: 200,
          ante: 25,
          dealerSeat: 2,
          actionHistory: [
            { stage: 'preflop', seat: 2, userId: 'v1', action: 'raise', amount: 450, timestamp: 1 },
            {
              stage: 'preflop',
              seat: 1,
              userId: 'hero',
              action: 'call',
              amount: 250,
              timestamp: 2,
            },
            { stage: 'flop', seat: 2, userId: 'v1', action: 'bet', amount: bet, timestamp: 3 },
          ],
          tournament: {
            playersLeft: 5,
            spotsPaid: 4,
            satellite: true,
            satelliteSeats: 4,
            stacks,
            payoutPct: [25, 25, 25, 25],
            avgStackChips: 11900,
          },
        },
      };
    };
    // a 7,800 jam is a fifth of the locked stack: fold, whatever the pair
    const big = build(7800);
    const dBig = HorseLogic.decide(big.hero, big.gs as never, 'balanced', {}, { mind: false });
    expect(dBig.action).toBe('fold');
    const small = build(60);
    const dSmall = HorseLogic.decide(
      small.hero,
      small.gs as never,
      'balanced',
      {},
      { mind: false }
    );
    expect(dSmall.action).toBe('call');
  });
});

import { headBountyScale, prizeLandscapeScale, bubblePressure } from './HorseLogic.js';

describe('V37 bounties: the head, not the mean; the inventory, not the badge', () => {
  const gsB = (o: Record<string, unknown> = {}) =>
    ({
      players: [],
      communityCards: [],
      pot: 0,
      currentBet: 0,
      minRaise: 0,
      stage: 'preflop',
      gameVariant: 'nlh',
      bigBlind: 100,
      gameMode: 'tournament',
      tournament: {
        playersLeft: 30,
        spotsPaid: 5,
        bountyFactor: 0.5,
        meanBountyCents: 1000,
        bountyByUser: { whale: 4000, minnow: 200, avg: 1000 },
        ...o,
      },
    }) as never;

  it('a head worth four means pulls three times (clamped), a small one barely', () => {
    expect(headBountyScale(gsB(), 'whale')).toBe(3);
    expect(headBountyScale(gsB(), 'minnow')).toBeCloseTo(0.4, 6);
    expect(headBountyScale(gsB(), 'avg')).toBe(1);
    expect(headBountyScale(gsB(), 'unknown')).toBe(1);
    expect(headBountyScale(gsB({ bountyByUser: undefined }), 'whale')).toBe(1);
  });

  it('the top chest still in the box is a lottery; an empty box is a freezeout', () => {
    expect(
      prizeLandscapeScale(
        gsB({ mysteryMeanCents: 1000, mysteryTopLive: true, mysteryChestsLeft: 20 })
      )
    ).toBeGreaterThan(1.3);
    expect(
      prizeLandscapeScale(
        gsB({ mysteryMeanCents: 0, mysteryChestsLeft: 0, mysteryTopCents: 50000 })
      )
    ).toBe(0.35);
    expect(prizeLandscapeScale(gsB({ mysteryMeanCents: 1000, mysteryChestsLeft: 2 }))).toBeLessThan(
      1
    );
    expect(prizeLandscapeScale(gsB(), false)).toBe(1);
  });

  it('the captain near an MTT bubble reads pressure; nobody does in a satellite or in the money', () => {
    const mk = (heroStack: number, others: number[], t: Record<string, unknown> = {}) =>
      ({
        players: [
          {
            seat: 1,
            user_id: 'hero',
            stack: heroStack,
            bet: 0,
            is_folded: false,
            is_sitting_out: false,
          },
          ...others.map((st, i) => ({
            seat: i + 2,
            user_id: 'v' + i,
            stack: st,
            bet: 0,
            is_folded: false,
            is_sitting_out: false,
          })),
        ],
        communityCards: [],
        pot: 0,
        currentBet: 0,
        minRaise: 0,
        stage: 'preflop',
        gameVariant: 'nlh',
        bigBlind: 100,
        gameMode: 'tournament',
        format: 'mtt',
        tournament: { playersLeft: 12, spotsPaid: 9, inMoney: false, ...t },
      }) as never;
    const hero = { seat: 1, user_id: 'hero', stack: 50000, bet: 0 } as never;
    expect(bubblePressure(mk(50000, [10000, 8000, 5000]), hero, 2)).toBe(1);
    expect(bubblePressure(mk(50000, [45000, 8000, 5000]), hero, 3)).toBeCloseTo(0.6, 6);
    expect(bubblePressure(mk(50000, [45000, 8000, 5000]), hero, 2)).toBe(0);
    expect(bubblePressure(mk(50000, [10000, 8000, 5000], { satellite: true }), hero, 2)).toBe(0);
    expect(
      bubblePressure(mk(50000, [10000, 8000, 5000], { playersLeft: 8, inMoney: true }), hero, 2)
    ).toBe(0);
    expect(bubblePressure(mk(50000, [10000, 8000, 5000], { playersLeft: 40 }), hero, 2)).toBe(0);
  });

  it('the captain opens wider and 3-bet-bluffs more against covered raisers', () => {
    // button bar 0.27 - ante widen 0.05 = 0.22: a 0.18 folds until the field is covered
    const open = ctx({ strength: 0.18, isButton: true, riskAdd: 0 });
    expect(decidePreflopV7(open).a).toBe('fold');
    expect(decidePreflopV7({ ...open, bubblePressure: 1 }).a).toBe('raiseTo');
  });

  it('a big bounty on hero own head trims the bluff budget', () => {
    let bluffs = 0;
    let bluffsHeavy = 0;
    for (let i = 0; i < 200; i++) {
      const r = i / 200;
      const base = ctx({
        strength: 0.6,
        raises: 1,
        raiserPosition: 'late',
        oppsLeft: 1,
        toCall: 5,
        currentBet: 5,
        pot: 8,
        riskAdd: 0,
        anteInPlay: false,
        bluffFreq: 0.3,
        rand: () => r,
      });
      if (decidePreflopV7(base).a === 'raiseTo') bluffs++;
      if (decidePreflopV7({ ...base, ownHeadBounty: 3 }).a === 'raiseTo') bluffsHeavy++;
    }
    expect(bluffs).toBeGreaterThan(0);
    expect(bluffsHeavy).toBeLessThan(bluffs);
  });
});

describe('V37 preflop blockers: the ace is the bluff', () => {
  it('an ace-blocker hand 3-bet-bluffs more often than the same strength without one', () => {
    const count = (holdsAce: boolean) => {
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const r = i / 400;
        const d = decidePreflopV7(
          ctx({
            strength: 0.6,
            raises: 1,
            raiserPosition: 'late',
            oppsLeft: 1,
            toCall: 5,
            currentBet: 5,
            pot: 8,
            riskAdd: 0,
            anteInPlay: false,
            bluffFreq: 0.3,
            holdsAce,
            rand: () => r,
          })
        );
        if (d.a === 'raiseTo') n++;
      }
      return n;
    };
    expect(count(true)).toBeGreaterThan(count(false));
  });
});
