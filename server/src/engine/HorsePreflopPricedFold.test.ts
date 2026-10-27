import { afterEach, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import * as Eval from './HorseEval.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import type { OpponentExploitRead } from './HorseOpponentExploit.js';
import type { SeatPlayer } from '../types.js';

afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
  drainFires();
});
it.each([false, true])('retains a priced Omaha refusal with pending responder=%s', (pending) => {
  const seat = (n: number, values: Partial<SeatPlayer>): SeatPlayer => ({
    seat: n,
    user_id: `public-${n}`,
    username: `public-${n}`,
    stack: 400,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...values,
  });
  const hero = seat(1, {
    stack: 396.2,
    bet: 11,
    totalInvested: 11,
    cards: [
      { rank: 'A', suit: 'hearts' },
      { rank: '8', suit: 'clubs' },
      { rank: '8', suit: 'hearts' },
      { rank: '6', suit: 'clubs' },
      { rank: '2', suit: 'spades' },
    ],
  });
  const base = { engaged: null, mean: 0.2, excess: 0, lower: 0, upper: 1 };
  const stats = Object.fromEntries(
    ['vpip', 'pfr', 'rfi', 'threeBet', 'foldTo3Bet', 'betCheckedTo', 'foldToBet', 'riverCall'].map(
      (k) => [k, { ...base, ...(k === 'pfr' ? { engaged: 'high', mean: 1 } : {}) }]
    )
  );
  vi.spyOn(HorseMind, 'opponentRead').mockReturnValue({ stats } as unknown as OpponentExploitRead);
  vi.spyOn(HorseMind, 'bandFor').mockReturnValue([0, 1]);
  vi.spyOn(HorseMind, 'bandsForOpponents').mockReturnValue([[0, 1]]);
  const sampled = vi.spyOn(Eval, 'simulateEquity').mockReturnValue(0.44);
  vi.spyOn(Eval, 'equitySampleSizeOfLastCall').mockReturnValue(360);
  const gs = {
    stateSchemaVersion: 1,
    asset: 'chips',
    chipUnit: 0.01,
    players: [
      { ...hero, cards: [] },
      seat(2, { bet: 167, totalInvested: 167 }),
      seat(3, { bet: 50, totalInvested: 50, is_folded: !pending }),
    ],
    dealtSeatIds: [1, 2, 3],
    communityCards: [],
    stage: 'preflop',
    gameVariant: 'plo5',
    gameMode: 'cash',
    pot: 234,
    contestablePot: 234,
    currentBet: 167,
    bigBlind: 2,
    smallBlind: 1,
    dealerSeat: 1,
    minRaise: 117,
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: 284,
    maxRaiseTo: 396.2,
    actionHistory: [
      { seat: 2, userId: 'public-2', stage: 'preflop', action: 'raise', amount: 11, timestamp: 1 },
      { seat: 1, userId: 'public-1', stage: 'preflop', action: 'call', amount: 11, timestamp: 2 },
      { seat: 3, userId: 'public-3', stage: 'preflop', action: 'raise', amount: 50, timestamp: 3 },
      { seat: 2, userId: 'public-2', stage: 'preflop', action: 'raise', amount: 167, timestamp: 4 },
    ],
  } as HorseGameStateV2;
  Eval.seedFastRandom(20261027);
  enableBrainTelemetry();
  drainFires();
  const decision = HorseLogic.decide(
    hero,
    gs,
    'balanced',
    {},
    {
      telemetry: true,
      mind: true,
      v10Rake: false,
      phase13Joint: 'off',
    }
  );
  const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
  expect(fires.v38_preflop_allin_price).toBe(1);
  expect(decision.action).toBe('fold');
  expect(sampled).toHaveBeenCalledTimes(1);
});
