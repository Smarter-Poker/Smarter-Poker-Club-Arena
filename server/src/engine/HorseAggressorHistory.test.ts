import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep equity fixed so these cases measure public-line attribution rather
// than Monte Carlo sampling or an opponent-memory update.
vi.mock('./HorseEval.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./HorseEval.js')>()),
  simulateEquity: () => 0.7,
}));

import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { HandController } from './HandController.js';
import type { ActionRecord, Card, HandConfig, SeatPlayer } from '../types.js';

const card = (spec: string): Card => ({
  rank: spec[0] as Card['rank'],
  suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[
    spec[1] as 's' | 'h' | 'd' | 'c'
  ],
});
const player = (seat: number, extra: Partial<SeatPlayer> = {}): SeatPlayer => ({
  seat,
  user_id: `p${seat}`,
  username: `Player${seat}`,
  stack: 500,
  bet: 0,
  totalInvested: 0,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  is_horse: true,
  ...extra,
});
const action = (
  seat: number,
  kind: ActionRecord['action'],
  amount: number,
  stage: ActionRecord['stage'],
  extra: Partial<ActionRecord> = {}
): ActionRecord => ({
  seat,
  userId: `p${seat}`,
  action: kind,
  amount,
  stage,
  timestamp: 0,
  ...extra,
});

const variants = [
  ['plo4', ['As', 'Ad', '7h', '2c']],
  ['plo5', ['As', 'Ad', '7h', '2c', 'Qh']],
  ['plo6', ['As', 'Ad', '7h', '2c', 'Qh', 'Tc']],
  // Four-card Hi-Lo8, deliberately without two qualifying low cards. This
  // verifies the same public-line fact without assuming a high-only pot.
  ['plo8', ['As', 'Ad', 'Kh', 'Qc']],
] as const;

function decideAfterLastAction(
  variant: readonly [string, readonly string[]],
  kind: 'call' | 'all_in' | 'raise',
  amount: number,
  isFullRaise?: boolean,
  context: {
    mind?: boolean;
    bet?: number;
    pot?: number;
    heroBet?: number;
    heroStack?: number;
    history?: ActionRecord[];
  } = {}
) {
  const bet = context.bet ?? 50;
  const hero = player(1, {
    cards: variant[1].map(card),
    totalInvested: 30,
    bet: context.heroBet ?? 0,
    stack: context.heroStack ?? 500,
  });
  const raises = kind === 'raise' || (kind === 'all_in' && isFullRaise !== undefined);
  const gs = {
    players: [
      hero,
      player(2, { bet }),
      player(3, { stack: kind === 'raise' ? 300 : 0, bet: amount, is_all_in: kind !== 'raise' }),
    ],
    communityCards: ['4s', '5c', '7d', '5d', 'Jc'].map(card),
    pot: context.pot ?? (raises ? amount * 4 : 200),
    currentBet: raises ? amount : bet,
    minRaise: bet,
    bigBlind: 2,
    gameVariant: variant[0],
    gameMode: 'cash',
    format: 'cash',
    stage: 'river',
    dealerSeat: 3,
    actionHistory: context.history ?? [
      action(2, 'bet', 10, 'flop', { isFullRaise: true }),
      action(1, 'call', 10, 'flop'),
      action(3, 'call', 10, 'flop'),
      action(2, 'bet', 20, 'turn', { isFullRaise: true }),
      action(1, 'call', 20, 'turn'),
      action(3, 'call', 20, 'turn'),
      action(2, 'bet', bet, 'river', { isFullRaise: true }),
      action(3, kind, amount, 'river', { isFullRaise }),
    ],
  } as HorseGameStateV2;
  return HorseLogic.decide(
    hero,
    gs,
    'balanced',
    {},
    {
      mind: context.mind ?? false,
      observeMind: false,
      // The separate one-street pressure model must not mask whether V40
      // retained the correct actor's earlier streets in these comparisons.
      v20Multiway: false,
      ploPairedBoardFold: false,
      v58Plo6RiverNuts: false,
      v38Ev: false,
    }
  );
}

function decideTempoLine(wagerTimestamp: number | undefined, precedingTimestamp = 1060) {
  return decideAfterLastAction(['nlh', ['As', 'Ad']], 'call', 1000, undefined, {
    mind: true,
    bet: 1000,
    pot: 2030,
    heroBet: 30,
    heroStack: 10000,
    history: [
      action(1, 'check', 0, 'river', { timestamp: 900 }),
      action(2, 'bet', 10, 'river', { timestamp: 1000, isFullRaise: true }),
      action(3, 'raise', 30, 'river', { timestamp: 1050, isFullRaise: true }),
      action(1, 'call', 30, 'river', { timestamp: precedingTimestamp }),
      action(2, 'raise', 1000, 'river', {
        timestamp: wagerTimestamp as number,
        isFullRaise: true,
      }),
      action(3, 'call', 970, 'river', { timestamp: 10020 }),
    ],
  });
}

beforeEach(() => {
  HorseMind.reset();
  seedFastRandom(41);
});

afterEach(() => vi.restoreAllMocks());

describe('current-bettor reads use the wager being faced', () => {
  it.each([['nlh', ['As', 'Ad']] as const, ...variants])(
    '%s consults the bettor rather than a later all-in caller',
    (variant, cards) => {
      const targeting = vi.spyOn(HorseMind, 'targetingOf').mockReturnValue(0);
      const bigBet = vi.spyOn(HorseMind, 'bigBetValueTendency').mockReturnValue(null);
      const snap = vi.spyOn(HorseMind, 'snapBetValueTendency').mockReturnValue(null);
      vi.spyOn(HorseMind, 'opponentRead').mockReturnValue(null);
      decideAfterLastAction([variant, cards], 'all_in', 5, undefined, {
        mind: true,
        bet: 100,
        pot: 200,
      });
      expect(targeting).toHaveBeenCalledWith('p1', 'p2');
      expect(targeting).not.toHaveBeenCalledWith('p1', 'p3');
      expect(bigBet).toHaveBeenCalledWith('p2');
      expect(bigBet).not.toHaveBeenCalledWith('p3');
      expect(snap).toHaveBeenCalledWith('p2');
      expect(snap).not.toHaveBeenCalledWith('p3');
    }
  );

  it('uses the latest increasing wager and its preceding action for the tempo read', () => {
    vi.spyOn(HorseMind, 'targetingOf').mockReturnValue(0);
    vi.spyOn(HorseMind, 'opponentRead').mockReturnValue(null);
    vi.spyOn(HorseMind, 'bigBetValueTendency').mockReturnValue(null);
    const snap = vi.spyOn(HorseMind, 'snapBetValueTendency').mockReturnValue(null);
    const tank = vi.spyOn(HorseMind, 'tankBetValueTendency').mockReturnValue(null);
    decideTempoLine(10000);
    expect(tank).toHaveBeenCalledWith('p2');
    expect(snap).not.toHaveBeenCalled();
  });

  it.each([
    [55, false],
    [100, true],
  ] as const)('reads the new all-in raiser to %s (full raise: %s)', (amount, full) => {
    const targeting = vi.spyOn(HorseMind, 'targetingOf').mockReturnValue(0);
    vi.spyOn(HorseMind, 'opponentRead').mockReturnValue(null);
    decideAfterLastAction(variants[0], 'all_in', amount, full, { mind: true });
    expect(targeting).toHaveBeenCalledWith('p1', 'p3');
    expect(targeting).not.toHaveBeenCalledWith('p1', 'p2');
  });

  it.each([
    ['missing current timestamp', undefined, 1060],
    ['invalid current timestamp', NaN, 1060],
    ['clock moved backwards', 1000, 1060],
  ] as const)(
    'does not invent a tempo read when %s',
    (_reason, wagerTimestamp, previousTimestamp) => {
      vi.spyOn(HorseMind, 'targetingOf').mockReturnValue(0);
      vi.spyOn(HorseMind, 'opponentRead').mockReturnValue(null);
      vi.spyOn(HorseMind, 'bigBetValueTendency').mockReturnValue(null);
      const snap = vi.spyOn(HorseMind, 'snapBetValueTendency').mockReturnValue(null);
      const tank = vi.spyOn(HorseMind, 'tankBetValueTendency').mockReturnValue(null);
      decideTempoLine(wagerTimestamp, previousTimestamp);
      expect(snap).not.toHaveBeenCalled();
      expect(tank).not.toHaveBeenCalled();
    }
  );
});

describe('the current bettor owns its earlier barrels', () => {
  it.each(variants)(
    '%s does not replace a triple-barrel bettor with a short all-in caller',
    (gameVariant, cards) => {
      const variant = [gameVariant, cards] as (typeof variants)[number];
      const call = decideAfterLastAction(variant, 'call', 5);
      HorseMind.reset();
      seedFastRandom(41);
      const allInCall = decideAfterLastAction(variant, 'all_in', 5);
      expect(call.policyFallback).toBeUndefined();
      expect(allInCall.policyFallback).toBeUndefined();
      expect(allInCall.action).toBe(call.action);
      expect(allInCall.amount ?? null).toBe(call.amount ?? null);
    }
  );

  it('a large all-in call also leaves the triple-barrel bettor in place', () => {
    const call = decideAfterLastAction(variants[0], 'call', 50);
    HorseMind.reset();
    seedFastRandom(41);
    const allInCall = decideAfterLastAction(variants[0], 'all_in', 50);
    expect(allInCall.action).toBe(call.action);
    expect(allInCall.amount ?? null).toBe(call.amount ?? null);
  });

  it.each([
    [55, false],
    [100, true],
  ] as const)(
    'keeps a genuine all-in raise to %s as the new bettor (full raise: %s)',
    (amount, full) => {
      const raise = decideAfterLastAction(variants[0], 'raise', amount, full);
      HorseMind.reset();
      seedFastRandom(41);
      const allInRaise = decideAfterLastAction(variants[0], 'all_in', amount, full);
      expect(raise.action).toBe('call');
      expect(allInRaise.action).toBe(raise.action);
      expect(allInRaise.amount ?? null).toBe(raise.amount ?? null);
    }
  );
});

describe('the authoritative controller distinguishes all-in calls and raises', () => {
  it.each([
    [5, undefined],
    [50, undefined],
    [55, false],
    [100, true],
  ] as const)('records a %s-chip all-in with the correct raise flag', (stack, full) => {
    const controller = new HandController(
      {
        tableId: 'horse-aggressor-history',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      } as HandConfig,
      [player(1), player(2, { stack }), player(3)],
      1
    );
    controller.start();
    expect(controller.performAction(1, 'raise', 50)).toBe(true);
    expect(controller.performAction(2, 'all_in')).toBe(true);
    const record = controller
      .getState()
      .actionHistory.find((a) => a.userId === 'p2' && a.action === 'all_in');
    expect(record?.amount).toBe(stack);
    expect(record?.isFullRaise).toBe(full);
  });
});
