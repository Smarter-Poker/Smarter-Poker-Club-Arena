/**
 * THE BUBBLE HAND (Dan 2026-10-25, binding).
 *
 * "a short stack calling a pre flop raise with 92o out of position!! ON THE
 * FUCKING MONEY BUBBLE THEN CALLIN OFF WITH 4 DIAMONDS ON THE RIVER WHEN HIS
 * OPPONENT PUTS HIM ALL IN ... THIS CAN NEVER FUCKING HAPPEN AGAIN!! ... JUST
 * CHECKS TOP PAIR TWICE".
 *
 * Hand 48403158: 13 players left, 12 paid, hand-for-hand. lilqueen (a horse)
 * in the small blind with 9c2d and 7.2 big blinds; bbNit min-raised to 21,876.
 * Three decisions, three defects:
 *
 *  1. Preflop it flat-called. The opener read as a wide raiser, and both
 *     maniac recoveries (the V38 all-in price and the reference call-down)
 *     priced a FLAT with a push/fold stack. A stack this short jams or folds.
 *  2. Flop 9-8-6 (top pair, 61%) and turn 3d (top pair and a flush draw,
 *     69%) with 50,036 behind into 63,752 it checked both: the donk-lead gate
 *     waited for an initiative a caller never has. At most one pot behind
 *     with that equity, the chips go in.
 *  3. River 7d put four diamonds on the board; its deuce made the lowest
 *     possible flush, and it called off the stack against the bet. Every
 *     diamond above the deuce beats it.
 *
 * This file replays that spot with the full tournament context the engine
 * sends (payout ladder, every stack, the Phase 7 utility live).
 *
 * 2026-10-26: the jam the brain chose must be the jam the engine plays. The
 * same stack in the BIG blind, heads-up against the opener, jammed through
 * the V38 variant price, and the policy receipt check refused that jam as
 * reference_shape - so the engine's liveness fallback folded A-T, pocket
 * eights and K-9 there instead. Every such receipt now matches its snapshot.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { remainingVariantSpot } from '../benchmark/RemainingVariantPolicyEvidence.js';
import { calculatePots, calculateContestablePot } from './PokerEngine.js';
import { horseVariantRulesFor } from './VariantRules.js';
import { horsePhase6AttributionMismatch, referenceReturnShape } from './HorsePhase6Attribution.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const T0 = 1_792_988_134_595;
const seat = (
  n: number,
  id: string,
  stack: number,
  bet: number,
  invested: number,
  folded: boolean
): SeatPlayer => ({
  seat: n,
  user_id: id,
  username: id,
  stack,
  bet,
  totalInvested: invested,
  cards: [],
  is_folded: folded,
  is_sitting_out: false,
  is_all_in: false,
});
const PREFLOP = [
  { stage: 'preflop', seat: 7, userId: 'hero', action: 'sb', amount: 5000, timestamp: T0 },
  { stage: 'preflop', seat: 8, userId: 'bb', action: 'bb', amount: 10000, timestamp: T0 },
  { stage: 'preflop', seat: 1, userId: 'p1', action: 'fold', amount: 0, timestamp: T0 + 1 },
  { stage: 'preflop', seat: 3, userId: 'p3', action: 'fold', amount: 0, timestamp: T0 + 2 },
  {
    stage: 'preflop',
    seat: 4,
    userId: 'opener',
    action: 'raise',
    amount: 21876,
    timestamp: T0 + 3,
    isFullRaise: true,
  },
  { stage: 'preflop', seat: 5, userId: 'p5', action: 'fold', amount: 0, timestamp: T0 + 4 },
  { stage: 'preflop', seat: 6, userId: 'p6', action: 'fold', amount: 0, timestamp: T0 + 5 },
];
const CALLED = [
  ...PREFLOP,
  { stage: 'preflop', seat: 7, userId: 'hero', action: 'call', amount: 16876, timestamp: T0 + 6 },
  { stage: 'preflop', seat: 8, userId: 'bb', action: 'fold', amount: 0, timestamp: T0 + 7 },
];
const OTHER_TABLE = [166936, 225546, 361230, 779742, 199474, 263380];

interface Spot {
  stage: 'preflop' | 'flop' | 'turn' | 'river';
  board: string;
  history: unknown[];
  pot: number;
  currentBet: number;
  hero: { stack: number; bet: number; invested: number };
  opener: { stack: number; bet: number; invested: number };
  bbFolded: boolean;
  legal: string[];
  mode?: 'tournament' | 'cash';
}

function state(spot: Spot, hole: string) {
  const players = [
    seat(1, 'p1', 98037, 0, 0, true),
    seat(3, 'p3', 120976, 0, 0, true),
    seat(4, 'opener', spot.opener.stack, spot.opener.bet, spot.opener.invested, false),
    seat(5, 'p5', 123608, 0, 0, true),
    seat(6, 'p6', 256327, 0, 0, true),
    seat(7, 'hero', spot.hero.stack, spot.hero.bet, spot.hero.invested, false),
    seat(8, 'bb', 206014, spot.bbFolded ? 0 : 10000, 20000, spot.bbFolded),
  ];
  const hero = { ...players[5], cards: cards(hole) };
  const mode = spot.mode ?? 'tournament';
  const toCall = Math.max(0, spot.currentBet - spot.hero.bet);
  const byUser = Object.fromEntries(players.map((p) => [p.user_id, p.stack + p.totalInvested]));
  const stacks = [...Object.values(byUser), ...OTHER_TABLE];
  const facing = toCall > 0;
  const gs: Record<string, unknown> = {
    stateSchemaVersion: 1,
    heroSeat: 7,
    currentPlayerSeat: 7,
    players,
    dealtSeatIds: players.map((p) => p.seat),
    chipUnit: 1,
    asset: 'chips',
    gameVariant: 'nlh',
    stage: spot.stage,
    communityCards: cards(spot.board),
    pot: spot.pot,
    currentBet: spot.currentBet,
    minRaise: 10000,
    lastRaise: 11876,
    bigBlind: 10000,
    smallBlind: 5000,
    ante: 10000,
    gameMode: mode,
    format: mode === 'cash' ? 'cash' : 'mtt',
    dealerSeat: 6,
    blindSeats: { smallBlind: 7, bigBlind: 8 },
    toCall,
    legalActions: spot.legal,
    minRaiseTo:
      spot.legal.includes('raise') || spot.legal.includes('bet') ? (facing ? 33752 : 10000) : null,
    maxRaiseTo:
      spot.legal.includes('raise') || spot.legal.includes('bet')
        ? spot.hero.stack + spot.hero.bet
        : null,
    bettingStructure: 'no_limit',
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    bbjConfig: null,
    variantRules: horseVariantRulesFor('nlh'),
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    actionHistory: spot.history,
    pots: calculatePots(players),
    contestablePot: calculateContestablePot(players, 'hero', Math.min(toCall, spot.hero.stack)),
  };
  if (mode === 'tournament') {
    gs.tournament = {
      ...remainingVariantSpot('flh', spot.stage, 4, 'tournament').state.tournament,
      gameVariant: 'nlh',
      entrants: 92,
      nearBubble: true,
      inMoney: false,
      playersLeft: 13,
      spotsPaid: 12,
      handForHand: true,
      currentLevel: 21,
      currentSmallBlind: 5000,
      currentBigBlind: 10000,
      currentAnte: 10000,
      anteType: 'big_blind',
      nextSmallBlind: 6000,
      nextBigBlind: 12000,
      nextAnte: 12000,
      payoutPct: [25.98, 14.92, 10.79, 8.57, 7.17, 6.2, 5.48, 4.92, 4.48, 4.12, 3.81, 3.56],
      stacks,
      stackByUser: byUser,
      seatsPerTable: 9,
      playersAtTable: 7,
      avgStackChips: stacks.reduce((a, b) => a + b, 0) / 13,
    };
  }
  return { hero, gs };
}

/** The opener reads as a wide raiser: 40% of first-in hands, credibly. */
function wideOpenerRead() {
  const stat = (mean: number, engaged: 'high' | null) => ({
    mean,
    n: 60,
    engaged,
    excess: engaged ? 0.1 : 0,
  });
  const read = {
    version: 1,
    envelope: 'test',
    scope: {},
    stats: {
      vpip: stat(0.45, 'high'),
      pfr: stat(0.4, 'high'),
      rfi: stat(0.4, 'high'),
      threeBet: stat(0.1, null),
      foldTo3Bet: stat(0.5, null),
      betCheckedTo: stat(0.5, null),
      foldToBet: stat(0.5, null),
      riverCall: stat(0.3, null),
    },
  };
  vi.spyOn(HorseMind, 'opponentRead').mockImplementation(((id: string) =>
    id === 'opener' ? read : null) as never);
}

function decide(spot: Spot, hole: string, n = 120) {
  const { hero, gs } = state(spot, hole);
  enableBrainTelemetry();
  drainFires();
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const d = HorseLogic.decide(hero as never, gs as never, 'balanced', {}, {
      telemetry: true,
      decisionTimeMs: T0 + 100 + i * 7919,
    } as never);
    counts[d.action] = (counts[d.action] ?? 0) + 1;
  }
  const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
  return { counts, fires };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const SB_FACING_OPEN: Spot = {
  stage: 'preflop',
  board: '',
  history: PREFLOP,
  pot: 46876,
  currentBet: 21876,
  hero: { stack: 66912, bet: 5000, invested: 5000 },
  opener: { stack: 204942, bet: 21876, invested: 21876 },
  bbFolded: false,
  legal: ['fold', 'call', 'raise', 'all_in'],
};

describe('a push/fold tournament stack facing a raise jams or folds, it never flats', () => {
  it('9-2 offsuit in the small blind on the bubble folds, against a wide opener too', () => {
    wideOpenerRead();
    for (const hole of ['9c2d', '7c3h', '8c3d', '6h2c']) {
      const { counts } = decide(SB_FACING_OPEN, hole, 60);
      expect(counts, hole).toEqual({ fold: 60 });
    }
  });

  it('a hand worth the whole stack jams instead of calling', () => {
    wideOpenerRead();
    for (const hole of ['AcTh', '8s8h']) {
      const { counts } = decide(SB_FACING_OPEN, hole, 60);
      expect(counts, hole).toEqual({ all_in: 60 });
    }
  });

  it('no hand in the deck flat-calls from that seat', () => {
    wideOpenerRead();
    for (const hole of ['Ac5d', 'Kc4h', 'Qs9s', 'Td9d', '6s6c', 'KhJc', '5c4c']) {
      const { counts } = decide(SB_FACING_OPEN, hole, 30);
      expect(counts.call ?? 0, hole).toBe(0);
    }
  });
});

describe('with at most one pot behind, a strong hand puts the chips in', () => {
  const flop: Spot = {
    stage: 'flop',
    board: '9h8d6d',
    history: CALLED,
    pot: 63752,
    currentBet: 0,
    hero: { stack: 50036, bet: 0, invested: 21876 },
    opener: { stack: 204942, bet: 0, invested: 21876 },
    bbFolded: true,
    legal: ['fold', 'check', 'bet', 'all_in'],
  };
  it('top pair on the flop does not check', () => {
    const { counts, fires } = decide(flop, '9c2d');
    expect(counts).toEqual({ all_in: 120 });
    expect(fires.v58_low_spr_stack_off).toBe(120);
  });

  it('top pair and a flush draw on the turn does not check', () => {
    const turn: Spot = {
      ...flop,
      stage: 'turn',
      board: '9h8d6d3d',
      history: [
        ...CALLED,
        { stage: 'flop', seat: 7, userId: 'hero', action: 'check', amount: 0, timestamp: T0 + 8 },
        { stage: 'flop', seat: 4, userId: 'opener', action: 'check', amount: 0, timestamp: T0 + 9 },
      ],
    };
    expect(decide(turn, '9c2d').counts).toEqual({ all_in: 120 });
  });

  it('air still checks', () => {
    const { counts } = decide(flop, '4c2s');
    expect(counts.all_in ?? 0).toBe(0);
  });
});

describe('a one-card low flush on a four-flush board does not call off a tournament', () => {
  const river = (mode: 'tournament' | 'cash' = 'tournament'): Spot => ({
    stage: 'river',
    board: '9h8d6d3d7d',
    history: [
      ...CALLED,
      { stage: 'flop', seat: 7, userId: 'hero', action: 'check', amount: 0, timestamp: T0 + 8 },
      { stage: 'flop', seat: 4, userId: 'opener', action: 'check', amount: 0, timestamp: T0 + 9 },
      { stage: 'turn', seat: 7, userId: 'hero', action: 'check', amount: 0, timestamp: T0 + 10 },
      { stage: 'turn', seat: 4, userId: 'opener', action: 'check', amount: 0, timestamp: T0 + 11 },
      { stage: 'river', seat: 7, userId: 'hero', action: 'check', amount: 0, timestamp: T0 + 12 },
      {
        stage: 'river',
        seat: 4,
        userId: 'opener',
        action: 'bet',
        amount: 51192,
        timestamp: T0 + 13,
        isFullRaise: true,
      },
    ],
    pot: 114944,
    currentBet: 51192,
    hero: { stack: 50036, bet: 0, invested: 21876 },
    opener: { stack: 153750, bet: 51192, invested: 73068 },
    bbFolded: true,
    legal: ['fold', 'call', 'all_in'],
    mode,
  });

  it('the deuce-high flush folds to the bet that puts it all in', () => {
    const { counts, fires } = decide(river(), '9c2d');
    expect(counts).toEqual({ fold: 120 });
    expect(fires.v58_one_card_low_flush_fold).toBe(120);
  });

  it('a queen-high flush (only the ace and king above it) is not this rule', () => {
    const { fires } = decide(river(), 'Qd9c');
    expect(fires.v58_one_card_low_flush_fold ?? 0).toBe(0);
  });

  it('a cash game keeps its own pricing', () => {
    const { fires } = decide(river('cash'), '9c2d');
    expect(fires.v58_one_card_low_flush_fold ?? 0).toBe(0);
  });
});

/** The same table one orbit on: the stack is in the big blind, the small
 * blind has folded, and the opener's min-raise is heads-up against it. */
function bigBlindHeadsUp(hole: string, heroStack: number) {
  const players = [
    seat(1, 'p1', 98037, 0, 0, true),
    seat(3, 'p3', 120976, 0, 0, true),
    seat(4, 'opener', 204942, 21876, 21876, false),
    seat(5, 'p5', 123608, 0, 0, true),
    seat(6, 'p6', 256327, 0, 0, true),
    seat(7, 'sb', 150000, 5000, 5000, true),
    seat(8, 'hero', heroStack, 10000, 10000, false),
  ];
  const history = [
    { stage: 'preflop', seat: 7, userId: 'sb', action: 'sb', amount: 5000, timestamp: T0 },
    { stage: 'preflop', seat: 8, userId: 'hero', action: 'bb', amount: 10000, timestamp: T0 },
    ...PREFLOP.slice(2),
    { stage: 'preflop', seat: 7, userId: 'sb', action: 'fold', amount: 0, timestamp: T0 + 6 },
  ];
  const { gs } = state({ ...SB_FACING_OPEN, history }, hole);
  const toCall = 21876 - 10000;
  const byUser = Object.fromEntries(players.map((p) => [p.user_id, p.stack + p.totalInvested]));
  const stacks = [...Object.values(byUser), ...OTHER_TABLE];
  Object.assign(gs, {
    heroSeat: 8,
    currentPlayerSeat: 8,
    players,
    toCall,
    maxRaiseTo: heroStack + 10000,
    pots: calculatePots(players),
    contestablePot: calculateContestablePot(players, 'hero', Math.min(toCall, heroStack)),
  });
  Object.assign(gs.tournament as object, {
    stacks,
    stackByUser: byUser,
    avgStackChips: stacks.reduce((a, b) => a + b, 0) / 13,
  });
  return { hero: { ...players[6], cards: cards(hole) }, gs };
}

describe('the jam the brain chooses is the jam the engine plays', () => {
  it('a short big blind heads-up against the opener jams, and its receipt is accepted', () => {
    wideOpenerRead();
    for (const hole of ['AcTh', '8s8h', 'Kc9d'])
      for (const stack of [30000, 15000]) {
        const { hero, gs } = bigBlindHeadsUp(hole, stack);
        for (let i = 0; i < 12; i++) {
          const d = HorseLogic.decide(hero as never, gs as never, 'balanced', {}, {
            decisionTimeMs: T0 + 100 + i * 7919,
          } as never);
          expect(d.action, `${hole} ${stack}`).toBe('all_in');
          expect(d.tournamentPreflopAttribution?.route).toBe('variant_price');
          expect(
            horsePhase6AttributionMismatch(d, {
              gameState: gs as never,
              player: hero as never,
              opts: {},
            }),
            `${hole} ${stack}`
          ).toBeNull();
        }
      }
  });

  it('the admitted jam is only the short-stack shape, not any all-in', () => {
    wideOpenerRead();
    const { hero, gs } = bigBlindHeadsUp('AcTh', 30000);
    const d = HorseLogic.decide(hero as never, gs as never, 'balanced', {}, {
      decisionTimeMs: T0 + 100,
    } as never);
    const receipt = d.tournamentPreflopAttribution!;
    const snapshot = (player: object, game: object = gs) => ({
      gameState: game as never,
      player: player as never,
      opts: {},
    });
    expect(referenceReturnShape(receipt, snapshot(hero))).toBe(true);
    // A deep stack (30 big blinds) heads-up is not this shape.
    expect(referenceReturnShape(receipt, snapshot({ ...hero, stack: 290000 }))).toBe(false);
    // Nor is a cash game, or a pot-limit Omaha table, at the same depth.
    expect(referenceReturnShape(receipt, snapshot(hero, { ...gs, gameMode: 'cash' }))).toBe(false);
    expect(
      referenceReturnShape(
        receipt,
        snapshot(hero, {
          ...gs,
          gameVariant: 'plo4',
          variantRules: horseVariantRulesFor('plo4'),
          bettingStructure: 'pot_limit',
        })
      )
    ).toBe(false);
  });
});
