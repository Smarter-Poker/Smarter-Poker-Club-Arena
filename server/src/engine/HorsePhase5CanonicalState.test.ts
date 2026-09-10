import { describe, expect, it, vi } from 'vitest';

import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import {
  applyAllInOrFoldActionState,
  applyTableCommitmentCap,
  ServerTableEngineTurns,
} from './ServerTableEngineTurns.js';
import { calculateContestablePot } from './PokerEngine.js';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import type { HorseDecision, RakeConfig, SeatPlayer } from '../types.js';

const hero: SeatPlayer = {
  seat: 1,
  user_id: 'horse-phase5',
  username: 'Horse Phase Five',
  stack: 94,
  bet: 6,
  totalInvested: 6,
  cards: [],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
};

function state(overrides: Partial<HorseGameStateV2> = {}): HorseGameStateV2 {
  return {
    stateSchemaVersion: 1,
    heroSeat: 1,
    currentPlayerSeat: 1,
    legalActions: ['fold', 'call'],
    toCall: 4,
    minRaiseTo: null,
    maxRaiseTo: null,
    bettingStructure: 'no_limit',
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    players: [{ ...hero, cards: [] }],
    communityCards: [],
    communityCards2: [],
    communityCards3: [],
    pot: 30,
    contestablePot: 30,
    currentBet: 10,
    minRaise: 4,
    stage: 'turn',
    gameVariant: 'nlh',
    bigBlind: 2,
    actionHistory: [],
    pots: [{ amount: 30, eligiblePlayers: ['horse-phase5'] }],
    rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
    variantRules: {
      holeCardsDealt: 2,
      holeCardsUse: 'any',
      boardCardsUse: 'any',
      deckSize: 52,
      splitLow8OrBetter: false,
    },
    ...overrides,
  };
}

const enforce = (
  decision: HorseDecision,
  gameState: HorseGameStateV2,
  player: SeatPlayer = hero
): HorseDecision =>
  (HorseLogic as any).__testables.enforceAuthoritativeDecision(decision, player, gameState);

describe('Phase 5 canonical legality boundary', () => {
  it('removes a cap-breaking call when unequal forced contributions change whole-hand totals', () => {
    const bounded = applyTableCommitmentCap(
      {
        schemaVersion: 1,
        heroSeat: 1,
        currentPlayerSeat: 1,
        canAct: true,
        legalActions: ['fold', 'call', 'raise', 'all_in'],
        toCall: 10,
        minRaiseTo: 30,
        maxRaiseTo: 110,
        structure: 'no_limit',
        fixedBetSize: null,
        wagersCapped: false,
      },
      { stack: 100, bet: 10, totalInvested: 95 },
      true,
      50,
      2
    );

    expect(bounded.commitmentCapRemaining).toBe(5);
    expect(bounded.legalActions).toEqual(['fold']);
    expect(bounded.minRaiseTo).toBeNull();
    expect(bounded.maxRaiseTo).toBeNull();
  });

  it('gives Phase 7 only fold and jam on an all-in-or-fold preflop decision', () => {
    const bounded = applyTableCommitmentCap(
      {
        schemaVersion: 1,
        heroSeat: 1,
        currentPlayerSeat: 1,
        canAct: true,
        legalActions: ['fold', 'call', 'raise', 'all_in'],
        toCall: 10,
        minRaiseTo: 30,
        maxRaiseTo: 100,
        structure: 'no_limit',
        fixedBetSize: null,
        wagersCapped: false,
      },
      { stack: 100, bet: 10, totalInvested: 10 },
      false,
      0,
      2
    );

    expect(applyAllInOrFoldActionState(bounded, true, 'preflop')).toMatchObject({
      legalActions: ['fold', 'all_in'],
      minRaiseTo: null,
      maxRaiseTo: null,
    });
  });

  it('never resurrects a cap-forbidden jam on an all-in-or-fold table', () => {
    const capped = applyTableCommitmentCap(
      {
        schemaVersion: 1,
        heroSeat: 1,
        currentPlayerSeat: 1,
        canAct: true,
        legalActions: ['fold', 'call', 'raise', 'all_in'],
        toCall: 10,
        minRaiseTo: 30,
        maxRaiseTo: 100,
        structure: 'no_limit',
        fixedBetSize: null,
        wagersCapped: false,
      },
      { stack: 100, bet: 10, totalInvested: 95 },
      true,
      50,
      2
    );

    expect(applyAllInOrFoldActionState(capped, true, 'preflop').legalActions).toEqual(['fold']);
  });

  it('preserves a free check alongside jam in all-in-or-fold preflop state', () => {
    const source = applyTableCommitmentCap(
      {
        schemaVersion: 1,
        heroSeat: 1,
        currentPlayerSeat: 1,
        canAct: true,
        legalActions: ['fold', 'check', 'bet', 'all_in'],
        toCall: 0,
        minRaiseTo: 2,
        maxRaiseTo: 100,
        structure: 'no_limit',
        fixedBetSize: null,
        wagersCapped: false,
      },
      { stack: 100, bet: 0, totalInvested: 0 },
      false,
      0,
      2
    );
    expect(applyAllInOrFoldActionState(source, true, 'preflop').legalActions).toEqual([
      'check',
      'all_in',
    ]);
  });

  it.each(['call', 'all_in'])('rejects a cap-breaking %s before chips move', (action) => {
    const performAction = vi.fn();
    const engine = Object.create(ServerTableEngineTurns.prototype) as any;
    engine.handController = {
      getState: () => ({
        currentPlayerSeat: 1,
        currentBet: 20,
        minRaise: 10,
        actionHistory: [],
        stage: 'turn',
        pot: 200,
        players: [{ ...hero, stack: 100, bet: 10, totalInvested: 95 }],
      }),
      performAction,
    };
    engine.disconnectEngine = { recordPlayerActed: vi.fn() };
    engine.activeHandVariant = () => 'nlh';
    engine.tableInfo = { cap_enabled: true, cap_bb: 50, big_blind: 2 };

    expect(engine._handlePlayerActionInner(hero.user_id, action)).toEqual({
      success: false,
      error: "Calling would exceed this table's per-hand commitment cap",
    });
    expect(performAction).not.toHaveBeenCalled();
  });

  it('cannot raise or shove when a short all-in did not reopen action', () => {
    expect(enforce({ action: 'raise', amount: 40, thinkTime: 0 }, state())).toEqual({
      action: 'call',
      amount: 4,
      thinkTime: 0,
    });
    expect(enforce({ action: 'all_in', thinkTime: 0 }, state())).toEqual({
      action: 'call',
      amount: 4,
      thinkTime: 0,
    });
  });

  it('snaps a fixed-limit wager to the controller exact bound', () => {
    const gs = state({
      currentBet: 0,
      toCall: 0,
      legalActions: ['fold', 'check', 'bet'],
      minRaiseTo: 20,
      maxRaiseTo: 20,
      bettingStructure: 'fixed_limit',
      fixedBetSize: 20,
    });
    expect(enforce({ action: 'bet', amount: 37, thinkTime: 0 }, gs)).toEqual({
      action: 'bet',
      amount: 20,
      thinkTime: 0,
    });
  });

  it('turns a false all-in into the largest legal cap-bounded raise', () => {
    const gs = state({
      legalActions: ['fold', 'call', 'raise'],
      minRaiseTo: 14,
      maxRaiseTo: 30,
      commitmentCapRemaining: 24,
    });
    expect(enforce({ action: 'all_in', thinkTime: 0 }, gs)).toEqual({
      action: 'raise',
      amount: 30,
      thinkTime: 0,
    });
  });

  it('degrades an unavailable wager to check without committing chips', () => {
    const gs = state({
      currentBet: 0,
      toCall: 0,
      legalActions: ['fold', 'check'],
    });
    expect(enforce({ action: 'bet', amount: 50, thinkTime: 0 }, gs)).toEqual({
      action: 'check',
      thinkTime: 0,
    });
  });
});

describe('Phase 5 contestable side-pot pricing', () => {
  it('excludes a side pot a short hero can never win', () => {
    const seats: SeatPlayer[] = [
      { ...hero, stack: 100, bet: 0, totalInvested: 0 },
      {
        ...hero,
        seat: 2,
        user_id: 'short-all-in',
        stack: 0,
        bet: 100,
        totalInvested: 100,
        is_all_in: true,
      },
      {
        ...hero,
        seat: 3,
        user_id: 'deep-all-in',
        stack: 0,
        bet: 1_000,
        totalInvested: 1_000,
        is_all_in: true,
      },
    ];

    // After hero calls 100, the 300-chip main pot is contestable and hero's
    // own 100 is removed. The deep player's 900-chip side pot is not priced.
    expect(calculateContestablePot(seats, hero.user_id, 1_000)).toBe(200);
  });

  it('keeps folded contributions and a shared dead blind in the winnable main pot', () => {
    const seats: SeatPlayer[] = [
      { ...hero, stack: 100, bet: 0, totalInvested: 0 },
      {
        ...hero,
        seat: 2,
        user_id: 'live-bettor',
        stack: 80,
        bet: 20,
        totalInvested: 30,
        deadInvested: 10,
      },
      {
        ...hero,
        seat: 3,
        user_id: 'folded-dead-money',
        stack: 50,
        bet: 0,
        totalInvested: 50,
        is_folded: true,
      },
    ];

    // Hero's 20-chip call can win every chip currently in the middle: the
    // live bettor's 20, its shared 10-chip dead blind and the folded 50.
    expect(calculateContestablePot(seats, hero.user_id, 20)).toBe(80);
  });

  it('changes a false full-pot price-in call into the correct fold', () => {
    const base: PreflopCtx = {
      strength: 0,
      position: 'early',
      raiserPosition: 'early',
      raises: 2,
      limpers: 0,
      callers: 1,
      oppsLeft: 2,
      toCall: 100,
      currentBet: 100,
      pot: 1_100,
      bigBlind: 2,
      stack: 100,
      stackBB: 50,
      tightness: 1,
      bluffFreq: 0,
      aggression: 1,
      slowplayFreq: 0,
      sizingMultiplier: 1,
      isOmaha: false,
      isPotLimit: false,
      riskAdd: 0,
      mode: 'cash',
      tableSize: 3,
      rand: () => 0.5,
    };

    expect(decidePreflopV7(base).a).toBe('call');
    expect(decidePreflopV7({ ...base, contestablePot: 200 }).a).toBe('fold');
  });
});

describe('Phase 5 exact rake context', () => {
  const rakeDrag = (HorseLogic as any).__testables.rakeDrag as (
    pot: number,
    bigBlind: number,
    config?: RakeConfig,
    playerCount?: number
  ) => number;

  it('uses the active percent, heads-up ceiling and player-count cap', () => {
    const config: RakeConfig = {
      percent: 10,
      cap: 8,
      noFlopNoDrop: true,
      playerCountCaps: [
        { players: 2, cap: 2.5 },
        { players: 6, cap: 8 },
      ],
    };
    expect(rakeDrag(20, 2, config, 6)).toBe(0.1);
    expect(rakeDrag(20, 2, config, 2)).toBe(0.05);
    expect(rakeDrag(60, 2, config, 2)).toBe(0);
    expect(rakeDrag(20, 2, { ...config, percent: 0 }, 6)).toBe(0);
    expect(rakeDrag(20, 2, { ...config, timedRake: { amountPerMinute: 1 } }, 6)).toBe(0);
  });
});
