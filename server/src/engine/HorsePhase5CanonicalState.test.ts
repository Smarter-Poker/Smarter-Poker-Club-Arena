import { describe, expect, it } from 'vitest';

import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
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
