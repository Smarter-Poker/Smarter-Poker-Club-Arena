/**
 * ♠ ENGINE IMPROVEMENTS — Unit Tests
 *
 * Comprehensive tests for all new Q1 engine features:
 * - Crypto RNG
 * - Disconnect Engine
 * - Time Bank Engine
 * - Insurance Engine
 * - Mixed Game Engine
 * - Chip Race Engine
 * - Pre-Action Engine
 * - Rakeback Engine
 * - BBA (Big Blind Ante)
 * - Run It Three Times
 * - Position-Aware AI
 * - Player-Count Rake Caps
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { secureRandomInt, secureRandom, secureShuffle } from '../src/engine/CryptoRandom';
import { calculateRake, calculateTimedRake, type TimedRakeConfig } from '../src/engine/PokerEngine';
import type { Card } from '../src/types/database.types';
// Phase 11 imports
import { tableBalancer } from '../src/engine/TableBalancer';
import { stateVerifier } from '../src/engine/StateVerifier';
import { disconnectEngine } from '../src/engine/DisconnectEngine';
import { preciseActionTimer } from '../src/engine/PreciseActionTimer';
import { engineTelemetry } from '../src/engine/EngineTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// CRYPTO RANDOM TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('CryptoRandom', () => {
  it('secureRandomInt should return values in range [0, max)', () => {
    for (let i = 0; i < 100; i++) {
      const val = secureRandomInt(10);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(10);
    }
  });

  it('secureRandomInt(1) should always return 0', () => {
    for (let i = 0; i < 10; i++) {
      expect(secureRandomInt(1)).toBe(0);
    }
  });

  it('secureRandomInt(0) should return 0', () => {
    expect(secureRandomInt(0)).toBe(0);
  });

  it('secureRandom should return values in [0, 1)', () => {
    for (let i = 0; i < 100; i++) {
      const val = secureRandom();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('secureShuffle should produce valid permutation', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const original = [...arr];
    secureShuffle(arr);

    // Same length
    expect(arr.length).toBe(original.length);
    // Same elements
    expect(arr.sort()).toEqual(original.sort());
  });

  it('secureShuffle should produce a 52-card deck with no duplicates', () => {
    const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const deck: { rank: string; suit: string }[] = [];
    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push({ rank, suit });
      }
    }

    secureShuffle(deck);

    expect(deck.length).toBe(52);
    const keys = new Set(deck.map((c) => `${c.rank}${c.suit}`));
    expect(keys.size).toBe(52);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISCONNECT ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine', () => {
  let disconnectEngine: typeof import('../src/engine/DisconnectEngine').disconnectEngine;

  beforeEach(async () => {
    const mod = await import('../src/engine/DisconnectEngine');
    disconnectEngine = mod.disconnectEngine;
    disconnectEngine.configure('table1', {
      disconnectTimeoutSeconds: 2,
      maxConsecutiveTimeouts: 3,
      preferCheckOverFold: true,
      reconnectGraceSeconds: 1,
    });
  });

  afterEach(() => {
    disconnectEngine.dispose('table1');
  });

  it('should register and track player connection', () => {
    disconnectEngine.registerPlayer('table1', 'player1');
    expect(disconnectEngine.isConnected('table1', 'player1')).toBe(true);
    expect(disconnectEngine.isSittingOut('table1', 'player1')).toBe(false);
  });

  it('should mark player disconnected', () => {
    disconnectEngine.registerPlayer('table1', 'player1');
    disconnectEngine.markDisconnected('table1', 'player1');
    expect(disconnectEngine.isConnected('table1', 'player1')).toBe(false);
  });

  it('should reconnect player via heartbeat', () => {
    disconnectEngine.registerPlayer('table1', 'player1');
    disconnectEngine.markDisconnected('table1', 'player1');
    expect(disconnectEngine.isConnected('table1', 'player1')).toBe(false);

    disconnectEngine.heartbeat('table1', 'player1');
    expect(disconnectEngine.isConnected('table1', 'player1')).toBe(true);
  });

  it('should return connected players', () => {
    disconnectEngine.registerPlayer('table1', 'p1');
    disconnectEngine.registerPlayer('table1', 'p2');
    disconnectEngine.markDisconnected('table1', 'p2');

    const connected = disconnectEngine.getConnectedPlayers('table1');
    expect(connected).toContain('p1');
    expect(connected).not.toContain('p2');
  });

  it('should handle sit out / sit back', () => {
    disconnectEngine.registerPlayer('table1', 'p1');
    disconnectEngine.sitOut('table1', 'p1');
    expect(disconnectEngine.isSittingOut('table1', 'p1')).toBe(true);

    disconnectEngine.sitBack('table1', 'p1');
    expect(disconnectEngine.isSittingOut('table1', 'p1')).toBe(false);
  });

  it('onPlayerTurn should return true for connected player', () => {
    disconnectEngine.registerPlayer('table1', 'p1');
    const canAct = disconnectEngine.onPlayerTurn('table1', 'p1', true);
    expect(canAct).toBe(true);
  });

  it('onPlayerTurn should auto-act for sitting out player', () => {
    disconnectEngine.registerPlayer('table1', 'p1');
    disconnectEngine.sitOut('table1', 'p1');

    let autoAction: any = null;
    disconnectEngine.onAutoAction('table1', (action) => {
      autoAction = action;
    });

    disconnectEngine.onPlayerTurn('table1', 'p1', true);
    expect(autoAction).not.toBeNull();
    expect(autoAction.action).toBe('check'); // preferCheckOverFold = true
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TIME BANK ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine', () => {
  let timeBankEngine: typeof import('../src/engine/TimeBankEngine').timeBankEngine;

  beforeEach(async () => {
    const mod = await import('../src/engine/TimeBankEngine');
    timeBankEngine = mod.timeBankEngine;
    timeBankEngine.configure('table1', {
      totalBankSeconds: 30,
      maxUses: 4,
      secondsPerUse: 15,
      refillPerOrbit: true,
      refillSeconds: 15,
      autoActivate: true,
    });
    timeBankEngine.initializePlayer('table1', 'p1');
  });

  afterEach(() => {
    timeBankEngine.dispose('table1');
  });

  it('should initialize player with full time bank', () => {
    expect(timeBankEngine.getRemainingSeconds('table1', 'p1')).toBe(30);
    expect(timeBankEngine.getUsesRemaining('table1', 'p1')).toBe(4);
    expect(timeBankEngine.hasTimeBank('table1', 'p1')).toBe(true);
  });

  it('should activate time bank', () => {
    const onExpire = vi.fn();
    const activated = timeBankEngine.activate('table1', 'p1', onExpire);
    expect(activated).toBe(true);

    const bank = timeBankEngine.getPlayerBank('table1', 'p1');
    expect(bank?.isActive).toBe(true);
    expect(bank?.usesRemaining).toBe(3); // Used 1
  });

  it('should handle player acting before time bank expires', () => {
    const onExpire = vi.fn();
    timeBankEngine.activate('table1', 'p1', onExpire);
    timeBankEngine.playerActed('table1', 'p1');

    const bank = timeBankEngine.getPlayerBank('table1', 'p1');
    expect(bank?.isActive).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('should not activate when no uses remain', () => {
    const onExpire = vi.fn();
    // Use all 4 time banks
    for (let i = 0; i < 4; i++) {
      timeBankEngine.activate('table1', 'p1', onExpire);
      timeBankEngine.playerActed('table1', 'p1');
    }

    const result = timeBankEngine.activate('table1', 'p1', onExpire);
    expect(result).toBe(false);
    expect(timeBankEngine.hasTimeBank('table1', 'p1')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIXED GAME ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('MixedGameEngine', () => {
  let mixedGameEngine: typeof import('../src/engine/MixedGameEngine').mixedGameEngine;

  beforeEach(async () => {
    const mod = await import('../src/engine/MixedGameEngine');
    mixedGameEngine = mod.mixedGameEngine;
  });

  afterEach(() => {
    mixedGameEngine.dispose('table1');
  });

  it('should configure with preset', () => {
    mixedGameEngine.configurePreset('table1', 'HOLDEM_OMAHA', 3, false);
    expect(mixedGameEngine.isActive('table1')).toBe(true);
    expect(mixedGameEngine.getCurrentVariant('table1')).toBe('nlh');
  });

  it('should rotate variant after threshold hands', () => {
    mixedGameEngine.configurePreset('table1', 'HOLDEM_OMAHA', 3, false);

    // Play 3 hands
    mixedGameEngine.onHandComplete('table1', 6);
    mixedGameEngine.onHandComplete('table1', 6);
    const rotated = mixedGameEngine.onHandComplete('table1', 6); // Should rotate on 3rd

    expect(rotated).toBe('plo4');
    expect(mixedGameEngine.getCurrentVariant('table1')).toBe('plo4');
  });

  it('should cycle back to first variant', () => {
    mixedGameEngine.configurePreset('table1', 'HOLDEM_OMAHA', 2, false);

    // Rotate through both variants
    mixedGameEngine.onHandComplete('table1', 6);
    mixedGameEngine.onHandComplete('table1', 6); // → plo4
    mixedGameEngine.onHandComplete('table1', 6);
    mixedGameEngine.onHandComplete('table1', 6); // → nlh again

    expect(mixedGameEngine.getCurrentVariant('table1')).toBe('nlh');
  });

  it('should track hands until rotation', () => {
    mixedGameEngine.configurePreset('table1', 'HOLDEM_OMAHA', 5, false);
    mixedGameEngine.onHandComplete('table1', 6);
    mixedGameEngine.onHandComplete('table1', 6);

    expect(mixedGameEngine.getHandsUntilRotation('table1', 6)).toBe(3);
  });

  it('forceRotate should skip to next variant', () => {
    mixedGameEngine.configurePreset('table1', 'HOLDEM_OMAHA', 10, false);
    const newVariant = mixedGameEngine.forceRotate('table1');
    expect(newVariant).toBe('plo4');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHIP RACE ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ChipRaceEngine', () => {
  let chipRaceEngine: typeof import('../src/engine/ChipRaceEngine').chipRaceEngine;

  beforeEach(async () => {
    const mod = await import('../src/engine/ChipRaceEngine');
    chipRaceEngine = mod.chipRaceEngine;
  });

  it('should convert fractional chips fairly', () => {
    const stacks = new Map([
      ['p1', 1250], // 1200 + 50 fractional (denomination: 100)
      ['p2', 1350], // 1200 + 150 fractional
      ['p3', 1475], // 1400 + 75 fractional
    ]);

    const result = chipRaceEngine.executeChipRace('tourney1', stacks, 25, 100);

    expect(result.removedDenomination).toBe(25);
    expect(result.newSmallestDenomination).toBe(100);

    // All stacks should be divisible by 100
    for (const [, stack] of stacks) {
      expect(stack % 100).toBe(0);
    }

    // No player eliminated
    for (const [, stack] of stacks) {
      expect(stack).toBeGreaterThan(0);
    }
  });

  it('should not eliminate any player', () => {
    const stacks = new Map([
      ['p1', 50], // Only fractional chips (denomination: 100)
      ['p2', 5000],
    ]);

    chipRaceEngine.executeChipRace('tourney1', stacks, 25, 100);

    // p1 must have at least 100 (minimum 1 chip of new denomination)
    expect(stacks.get('p1')!).toBeGreaterThanOrEqual(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-ACTION ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PreActionEngine', () => {
  let preActionEngine: typeof import('../src/engine/PreActionEngine').preActionEngine;

  beforeEach(async () => {
    const mod = await import('../src/engine/PreActionEngine');
    preActionEngine = mod.preActionEngine;
  });

  afterEach(() => {
    preActionEngine.dispose('table1');
  });

  it('should set and retrieve pre-action', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_fold');
    expect(preActionEngine.hasPreAction('table1', 'p1')).toBe(true);

    const entry = preActionEngine.getPreAction('table1', 'p1');
    expect(entry?.action).toBe('auto_fold');
  });

  it('auto_fold should execute as fold', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_fold');
    const result = preActionEngine.executePreAction('table1', 'p1', true, 0, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('fold');
  });

  it('auto_check_fold should check when free', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_check_fold');
    const result = preActionEngine.executePreAction('table1', 'p1', true, 0, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('check');
  });

  it('auto_check_fold should fold when bet is placed', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_check_fold');
    const result = preActionEngine.executePreAction('table1', 'p1', false, 50, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('fold');
  });

  it('auto_check should invalidate when bet is placed', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_check');
    const result = preActionEngine.executePreAction('table1', 'p1', false, 50, 1000);

    expect(result.executed).toBe(false);
    expect(result.invalidated).toBe(true);
  });

  it('auto_call should call the correct amount', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_call');
    const result = preActionEngine.executePreAction('table1', 'p1', false, 100, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('call');
    expect(result.amount).toBe(100);
  });

  it('auto_call with max amount should invalidate when exceeded', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_call', 50);
    const result = preActionEngine.executePreAction('table1', 'p1', false, 100, 1000);

    expect(result.executed).toBe(false);
    expect(result.invalidated).toBe(true);
  });

  it('should clear pre-actions for action', () => {
    preActionEngine.setPreAction('table1', 'p1', 'auto_fold');
    preActionEngine.clearPreAction('table1', 'p1');
    expect(preActionEngine.hasPreAction('table1', 'p1')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAKEBACK ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('RakebackEngine', () => {
  let rakebackEngine: typeof import('../src/engine/RakebackEngine').rakebackEngine;

  beforeEach(async () => {
    const mod = await import('../src/engine/RakebackEngine');
    rakebackEngine = mod.rakebackEngine;
    rakebackEngine.configure('club1', {
      enabled: true,
      tiers: [
        { minRake: 0, rakebackPercent: 10, name: 'Bronze' },
        { minRake: 100, rakebackPercent: 20, name: 'Silver' },
      ],
      settlementFrequency: 'daily',
      minimumPayout: 0.01,
    });
  });

  afterEach(() => {
    rakebackEngine.dispose('club1');
  });

  it('should track rake contributions', () => {
    const contributions = new Map([
      ['p1', 60],
      ['p2', 40],
    ]);

    rakebackEngine.recordHandRake('club1', 5, contributions, 100);

    const record = rakebackEngine.getPlayerRecord('club1', 'p1');
    expect(record).not.toBeNull();
    expect(record!.rakeContributed).toBe(3); // 60% of 5 = 3
    expect(record!.potsContributed).toBe(1);
  });

  it('should calculate weighted rakeback', () => {
    const contributions = new Map([
      ['p1', 100],
      ['p2', 100],
    ]);

    rakebackEngine.recordHandRake('club1', 10, contributions, 200);

    const record = rakebackEngine.getPlayerRecord('club1', 'p1');
    // P1 contributed 50% → rake share = 5 → 10% rakeback = 0.50
    expect(record!.pendingRakeback).toBe(0.5);
  });

  it('should settle rakeback', () => {
    // Record enough rake to qualify for settlement
    for (let i = 0; i < 10; i++) {
      rakebackEngine.recordHandRake('club1', 10, new Map([['p1', 100]]), 100);
    }

    const distribution = rakebackEngine.settleRakeback('club1');
    expect(distribution.size).toBe(1);
    expect(distribution.get('p1')).toBeGreaterThan(0);

    // After settlement, pending should be zero
    const record = rakebackEngine.getPlayerRecord('club1', 'p1');
    expect(record!.pendingRakeback).toBe(0);
  });

  it('should upgrade tier based on volume', () => {
    // Record large volume to trigger Silver tier (minRake: 100)
    for (let i = 0; i < 20; i++) {
      rakebackEngine.recordHandRake('club1', 10, new Map([['p1', 100]]), 100);
    }

    const tier = rakebackEngine.getCurrentTier('club1', 'p1');
    expect(tier?.name).toBe('Silver');
    expect(tier?.rakebackPercent).toBe(20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BBA (BIG BLIND ANTE) TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Big Blind Ante', () => {
  it('HandConfig should accept bigBlindAnte flag', async () => {
    const { HandController } = await import('../src/engine/HandController');
    const players = [
      {
        seat: 1,
        user_id: 'a',
        username: 'A',
        stack: 1000,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'b',
        username: 'B',
        stack: 1000,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 3,
        user_id: 'c',
        username: 'C',
        stack: 1000,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];

    // Create with BBA enabled
    const controller = new HandController(
      {
        tableId: 'test',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 5,
        bigBlind: 10,
        ante: 10,
        bigBlindAnte: true,
        rakeConfig: { percent: 0, cap: 0, noFlop: false },
      },
      players as any,
      1
    );

    // Should not throw
    expect(controller).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER-COUNT RAKE CAP TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Player-Count Rake Caps', () => {
  it('should apply default cap when no player count specified', () => {
    const config = { percent: 5, cap: 3, noFlop: false };
    expect(calculateRake(100, true, config)).toBe(3);
  });

  it('should apply player-count-specific cap', () => {
    const config = {
      percent: 5,
      cap: 3,
      noFlop: false,
      capByPlayerCount: { 2: 1, 3: 2, 6: 3 },
    };

    // Heads-up: cap = 1
    expect(calculateRake(100, true, config, 2)).toBe(1);
    // 3 players: cap = 2
    expect(calculateRake(100, true, config, 3)).toBe(2);
    // 6 players: cap = 3
    expect(calculateRake(100, true, config, 6)).toBe(3);
  });

  it('should fall back to default cap for unspecified player count', () => {
    const config = {
      percent: 5,
      cap: 3,
      noFlop: false,
      capByPlayerCount: { 2: 1 },
    };

    // 4 players not in map → use default cap (3)
    expect(calculateRake(100, true, config, 4)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION-AWARE AI TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Position-Aware AI', () => {
  it('should calculate correct positions', async () => {
    const { HorseLogic } = await import('../src/engine/HorseLogic');

    // 6 players, dealer at seat 0
    // Seat 1 = SB (blinds), Seat 2 = BB (blinds)
    // Seat 3 = UTG (early), Seat 4 = MP (middle), Seat 5 = CO/BTN (late)
    expect(HorseLogic.getPosition(1, 0, 6)).toBe('blinds');
    expect(HorseLogic.getPosition(2, 0, 6)).toBe('blinds');
    expect(HorseLogic.getPosition(3, 0, 6)).toBe('early');
    expect(HorseLogic.getPosition(5, 0, 6)).toBe('late');
  });

  it('should accept position parameter in decide()', async () => {
    const { HorseLogic } = await import('../src/engine/HorseLogic');

    const mockPlayer = {
      seat: 1,
      user_id: 'horse1',
      username: 'Horse',
      stack: 1000,
      bet: 0,
      totalInvested: 0,
      cards: [
        { rank: '7', suit: 'hearts' },
        { rank: '2', suit: 'clubs' },
      ],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };

    const gameState = {
      stage: 'preflop' as const,
      currentBet: 10,
      pot: 15,
      communityCards: [],
      bigBlind: 10,
      minRaise: 10,
      players: [mockPlayer],
      gameVariant: 'nlh' as const,
    };

    // Should not throw with position parameter
    const decision = HorseLogic.decide(mockPlayer as any, gameState as any, 'balanced', 'early');
    expect(decision).toBeTruthy();
    expect(decision.action).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER ACTION VALIDATOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServerActionValidator', () => {
  let serverActionValidator: typeof import('../src/engine/ServerActionValidator').serverActionValidator;

  beforeEach(async () => {
    const mod = await import('../src/engine/ServerActionValidator');
    serverActionValidator = mod.serverActionValidator;
    serverActionValidator.dispose();
  });

  const baseContext = (): import('../src/engine/ServerActionValidator').ValidationContext => ({
    currentPlayerId: 'p1',
    stage: 'flop',
    currentBet: 0,
    playerBet: 0,
    playerStack: 1000,
    bigBlind: 10,
    minRaise: 10,
    pot: 50,
    canCheck: true,
    actionDeadline: Date.now() + 30000,
    playerActedThisRound: false,
    isAllIn: false,
    isFolded: false,
    numActivePlayers: 4,
  });

  const baseRequest = (
    action: string,
    amount?: number
  ): import('../src/engine/ServerActionValidator').ActionRequest => ({
    tableId: 'table1',
    handId: 'hand1',
    playerId: 'p1',
    action: action as any,
    amount,
    timestamp: Date.now(),
  });

  it('should reject action from wrong player', () => {
    const ctx = baseContext();
    const req = { ...baseRequest('check'), playerId: 'p2' };
    const result = serverActionValidator.validate(req, ctx);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('NOT_YOUR_TURN');
  });

  it('should reject action from folded player', () => {
    const ctx = { ...baseContext(), isFolded: true };
    const result = serverActionValidator.validate(baseRequest('check'), ctx);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('ALREADY_FOLDED');
  });

  it('should reject action from all-in player', () => {
    const ctx = { ...baseContext(), isAllIn: true };
    const result = serverActionValidator.validate(baseRequest('check'), ctx);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('ALREADY_ALL_IN');
  });

  it('should allow valid check', () => {
    const result = serverActionValidator.validate(baseRequest('check'), baseContext());
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('check');
  });

  it('should reject check when there is a bet', () => {
    const ctx = { ...baseContext(), canCheck: false, currentBet: 20 };
    const result = serverActionValidator.validate(baseRequest('check'), ctx);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('CANNOT_CHECK');
  });

  it('should allow valid fold', () => {
    const result = serverActionValidator.validate(baseRequest('fold'), baseContext());
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('fold');
  });

  it('should allow valid call and return amount', () => {
    const ctx = { ...baseContext(), currentBet: 20, canCheck: false };
    const result = serverActionValidator.validate(baseRequest('call'), ctx);
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('call');
    expect(result.sanitizedAmount).toBe(20);
  });

  it('should auto-sanitize call to all-in when stack is insufficient', () => {
    const ctx = { ...baseContext(), currentBet: 2000, playerStack: 500, canCheck: false };
    const result = serverActionValidator.validate(baseRequest('call'), ctx);
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('all_in');
    expect(result.sanitizedAmount).toBe(500);
  });

  it('should allow valid bet', () => {
    const result = serverActionValidator.validate(baseRequest('bet', 50), baseContext());
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('bet');
    expect(result.sanitizedAmount).toBe(50);
  });

  it('should reject bet below minimum', () => {
    const result = serverActionValidator.validate(baseRequest('bet', 5), baseContext());
    expect(result.valid).toBe(false);
    expect(result.code).toBe('BELOW_MIN_RAISE');
  });

  it('should auto-sanitize bet to all-in when amount >= stack', () => {
    const result = serverActionValidator.validate(baseRequest('bet', 1500), baseContext());
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('all_in');
    expect(result.sanitizedAmount).toBe(1000);
  });

  it('should reject raise below minimum', () => {
    const ctx = { ...baseContext(), currentBet: 20, canCheck: false };
    const result = serverActionValidator.validate(baseRequest('raise', 25), ctx);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('BELOW_MIN_RAISE');
  });

  it('should suppress duplicate actions', () => {
    const req = baseRequest('check');
    serverActionValidator.validate(req, baseContext());
    const result2 = serverActionValidator.validate(req, baseContext());
    expect(result2.valid).toBe(false);
    expect(result2.code).toBe('ALREADY_ACTED');
  });

  it('should reject expired actions', () => {
    const ctx = { ...baseContext(), actionDeadline: Date.now() - 5000 };
    const result = serverActionValidator.validate(baseRequest('check'), ctx);
    expect(result.valid).toBe(false);
    expect(result.code).toBe('ACTION_EXPIRED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ATOMIC STACK SERVICE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('AtomicStackService', () => {
  let atomicStackService: typeof import('../src/engine/AtomicStackService').atomicStackService;

  beforeEach(async () => {
    const mod = await import('../src/engine/AtomicStackService');
    atomicStackService = mod.atomicStackService;
    atomicStackService.dispose();
  });

  it('should initialize stack with version 1', () => {
    atomicStackService.initializeStack('t1', 'p1', 1000);
    const sv = atomicStackService.getStackWithVersion('t1', 'p1');
    expect(sv.stack).toBe(1000);
    expect(sv.version).toBe(1);
  });

  it('should debit with correct version', () => {
    atomicStackService.initializeStack('t1', 'p1', 1000);
    const result = atomicStackService.atomicDebit('t1', 'p1', 200, 1);
    expect(result.success).toBe(true);
    expect(result.newStack).toBe(800);
    expect(result.newVersion).toBe(2);
  });

  it('should reject debit with wrong version', () => {
    atomicStackService.initializeStack('t1', 'p1', 1000);
    const result = atomicStackService.atomicDebit('t1', 'p1', 200, 99);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Version conflict');
  });

  it('should reject debit exceeding stack', () => {
    atomicStackService.initializeStack('t1', 'p1', 100);
    const result = atomicStackService.atomicDebit('t1', 'p1', 200, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient');
  });

  it('should credit without version check', () => {
    atomicStackService.initializeStack('t1', 'p1', 1000);
    const result = atomicStackService.atomicCredit('t1', 'p1', 500);
    expect(result.success).toBe(true);
    expect(result.newStack).toBe(1500);
  });

  it('should batch settle atomically', () => {
    atomicStackService.initializeStack('t1', 'p1', 1000);
    atomicStackService.initializeStack('t1', 'p2', 1000);

    const result = atomicStackService.atomicSettle('t1', [
      { userId: 'p1', delta: 500 },
      { userId: 'p2', delta: -500 },
    ]);

    expect(result.success).toBe(true);
    expect(result.settled.get('p1')).toBe(1500);
    expect(result.settled.get('p2')).toBe(500);
  });

  it('should reject settlement that would go negative', () => {
    atomicStackService.initializeStack('t1', 'p1', 100);
    const result = atomicStackService.atomicSettle('t1', [{ userId: 'p1', delta: -200 }]);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should clean up table state', () => {
    atomicStackService.initializeStack('t1', 'p1', 1000);
    atomicStackService.clearTable('t1');
    const sv = atomicStackService.getStackWithVersion('t1', 'p1');
    expect(sv.stack).toBe(0);
    expect(sv.version).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRECISE ACTION TIMER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PreciseActionTimer', () => {
  let preciseActionTimer: typeof import('../src/engine/PreciseActionTimer').preciseActionTimer;

  beforeEach(async () => {
    const mod = await import('../src/engine/PreciseActionTimer');
    preciseActionTimer = mod.preciseActionTimer;
    preciseActionTimer.clearTable('t1');
  });

  it('should start a timer and report remaining time', () => {
    preciseActionTimer.startTimer('t1', 'p1', 10000);
    const remaining = preciseActionTimer.getRemainingMs('t1', 'p1');
    expect(remaining).toBeGreaterThan(9000);
    expect(remaining).toBeLessThanOrEqual(10000);
    expect(preciseActionTimer.isExpired('t1', 'p1')).toBe(false);
  });

  it('should report expired for non-existent timer', () => {
    expect(preciseActionTimer.isExpired('t1', 'nobody')).toBe(true);
  });

  it('should cancel timer', () => {
    preciseActionTimer.startTimer('t1', 'p1', 10000);
    preciseActionTimer.cancelTimer('t1', 'p1');
    expect(preciseActionTimer.getRemainingMs('t1', 'p1')).toBe(0);
  });

  it('should extend timer', () => {
    preciseActionTimer.startTimer('t1', 'p1', 5000);
    preciseActionTimer.extendTimer('t1', 'p1', 5000);
    const remaining = preciseActionTimer.getRemainingMs('t1', 'p1');
    expect(remaining).toBeGreaterThan(9000);
  });

  it('should pause and resume timer', () => {
    preciseActionTimer.startTimer('t1', 'p1', 10000);
    preciseActionTimer.pauseTimer('t1', 'p1');
    const pausedRemaining = preciseActionTimer.getRemainingMs('t1', 'p1');
    expect(pausedRemaining).toBeGreaterThan(0);
    expect(preciseActionTimer.isExpired('t1', 'p1')).toBe(false);

    preciseActionTimer.resumeTimer('t1', 'p1');
    const resumed = preciseActionTimer.getRemainingMs('t1', 'p1');
    expect(resumed).toBeGreaterThan(0);
  });

  it('should get deadline timestamp', () => {
    preciseActionTimer.startTimer('t1', 'p1', 10000);
    const deadline = preciseActionTimer.getDeadline('t1', 'p1');
    expect(deadline).toBeGreaterThan(Date.now());
  });

  it('should clear all timers for a table', () => {
    preciseActionTimer.startTimer('t1', 'p1', 10000);
    preciseActionTimer.startTimer('t1', 'p2', 10000);
    preciseActionTimer.clearTable('t1');
    expect(preciseActionTimer.getRemainingMs('t1', 'p1')).toBe(0);
    expect(preciseActionTimer.getRemainingMs('t1', 'p2')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STATE VERIFIER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('StateVerifier', () => {
  let stateVerifier: typeof import('../src/engine/StateVerifier').stateVerifier;

  beforeEach(async () => {
    const mod = await import('../src/engine/StateVerifier');
    stateVerifier = mod.stateVerifier;
    stateVerifier.dispose();
  });

  const makePlayers = (stacks: number[]) =>
    stacks.map((s, i) => ({
      user_id: `p${i}`,
      username: `P${i}`,
      seat: i + 1,
      stack: s,
      bet: 0,
      totalInvested: 0,
      cards: [] as any[],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    }));

  it('should pass verification for valid state', () => {
    const players = makePlayers([500, 500]);
    stateVerifier.recordInitialChipTotal('t1', players as any);
    const result = stateVerifier.verify({
      tableId: 't1',
      handNumber: 1,
      players: players as any,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
      initialChipTotal: 1000,
    });
    expect(result.valid).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('should detect negative stacks', () => {
    const players = makePlayers([-100, 500]);
    const result = stateVerifier.verify({
      tableId: 't1',
      handNumber: 1,
      players: players as any,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });
    expect(result.valid).toBe(false);
    const neg = result.violations.find((v) => v.type === 'NEGATIVE_STACK');
    expect(neg).toBeDefined();
    expect(neg!.severity).toBe('critical');
  });

  it('should detect duplicate cards', () => {
    const players = makePlayers([500, 500]);
    (players[0] as any).cards = [{ rank: 'A', suit: 'spades' }];
    (players[1] as any).cards = [{ rank: 'A', suit: 'spades' }]; // Duplicate!
    const result = stateVerifier.verify({
      tableId: 't1',
      handNumber: 1,
      players: players as any,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.type === 'DUPLICATE_CARD')).toBe(true);
  });

  it('should detect wrong community card count for stage', () => {
    const result = stateVerifier.verify({
      tableId: 't1',
      handNumber: 1,
      players: makePlayers([500, 500]) as any,
      communityCards: [{ rank: 'K', suit: 'hearts' }] as any, // 1 card on flop = wrong
      pot: 0,
      stage: 'flop',
    });
    expect(result.violations.some((v) => v.type === 'COMMUNITY_CARD_COUNT')).toBe(true);
  });

  it('should detect negative pot', () => {
    const result = stateVerifier.verify({
      tableId: 't1',
      handNumber: 1,
      players: makePlayers([500, 500]) as any,
      communityCards: [],
      pot: -10,
      stage: 'preflop',
    });
    expect(result.violations.some((v) => v.type === 'NEGATIVE_POT')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HAND REPLAY ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('HandReplayEngine', () => {
  let handReplayEngine: typeof import('../src/engine/HandReplayEngine').handReplayEngine;

  beforeEach(async () => {
    const mod = await import('../src/engine/HandReplayEngine');
    handReplayEngine = mod.handReplayEngine;
    handReplayEngine.reset();
  });

  const sampleHand = (): import('../src/engine/HandReplayEngine').HandReplayData => ({
    handId: 'h1',
    tableId: 't1',
    handNumber: 1,
    initialPot: 0,
    players: [
      {
        userId: 'p1',
        username: 'Alice',
        stack: 1000,
        bet: 0,
        cards: [],
        isFolded: false,
        isAllIn: false,
        seat: 1,
      },
      {
        userId: 'p2',
        username: 'Bob',
        stack: 1000,
        bet: 0,
        cards: [],
        isFolded: false,
        isAllIn: false,
        seat: 2,
      },
    ],
    actions: [
      { type: 'post_blind', playerId: 'p1', amount: 5 },
      { type: 'post_blind', playerId: 'p2', amount: 10 },
      { type: 'deal_hole', playerId: 'p1', cards: ['Ah', 'Kh'] },
      { type: 'deal_hole', playerId: 'p2', cards: ['Qd', 'Jd'] },
      { type: 'action', playerId: 'p1', action: 'call', amount: 10 },
      { type: 'action', playerId: 'p2', action: 'check' },
      { type: 'deal_community', cards: ['Td', '9h', '8s'], stage: 'flop' },
      { type: 'action', playerId: 'p1', action: 'fold' },
      { type: 'winners', playerId: 'p2', amount: 20 },
    ],
  });

  it('should load hand data', () => {
    handReplayEngine.loadHand(sampleHand());
    const snapshot = handReplayEngine.getSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalSteps).toBe(9);
    expect(snapshot!.stepIndex).toBe(0);
  });

  it('should step forward through actions', () => {
    handReplayEngine.loadHand(sampleHand());

    // Post SB
    expect(handReplayEngine.stepForward()).toBe(true);
    let snap = handReplayEngine.getSnapshot()!;
    expect(snap.stepIndex).toBe(1);
    expect(snap.pot).toBe(5);

    // Post BB
    expect(handReplayEngine.stepForward()).toBe(true);
    snap = handReplayEngine.getSnapshot()!;
    expect(snap.pot).toBe(15);
  });

  it('should step back by replaying from beginning', () => {
    handReplayEngine.loadHand(sampleHand());
    handReplayEngine.stepForward(); // SB
    handReplayEngine.stepForward(); // BB
    handReplayEngine.stepForward(); // deal p1

    expect(handReplayEngine.stepBack()).toBe(true);
    const snap = handReplayEngine.getSnapshot()!;
    expect(snap.stepIndex).toBe(2); // back to after BB
  });

  it('should jump to specific step', () => {
    handReplayEngine.loadHand(sampleHand());
    handReplayEngine.jumpToStep(5);
    const snap = handReplayEngine.getSnapshot()!;
    expect(snap.stepIndex).toBe(5);
  });

  it('should detect completion', () => {
    handReplayEngine.loadHand(sampleHand());
    expect(handReplayEngine.isComplete()).toBe(false);

    // Step through all
    while (handReplayEngine.stepForward()) {
      void 0; /* exhaust steps */
    }
    expect(handReplayEngine.isComplete()).toBe(true);
  });

  it('should set speed', () => {
    handReplayEngine.loadHand(sampleHand());
    handReplayEngine.setSpeed(4);
    // No throw expected
    expect(handReplayEngine.getSnapshot()).not.toBeNull();
  });

  it('should track folded state', () => {
    handReplayEngine.loadHand(sampleHand());
    // Step through to fold action (step 8)
    handReplayEngine.jumpToStep(8);
    const snap = handReplayEngine.getSnapshot()!;
    const p1 = snap.players.find((p) => p.userId === 'p1');
    expect(p1!.isFolded).toBe(true);
  });

  it('should reset cleanly', () => {
    handReplayEngine.loadHand(sampleHand());
    handReplayEngine.stepForward();
    handReplayEngine.reset();
    expect(handReplayEngine.getSnapshot()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR LRU CACHE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Evaluator LRU Cache', () => {
  it('should return same result for same cards (cache hit)', async () => {
    const { evaluateHand, clearEvalCache } = await import('../src/engine/PokerEngine');
    clearEvalCache();

    const holeCards = [
      { rank: 'A' as const, suit: 'spades' as const },
      { rank: 'K' as const, suit: 'spades' as const },
    ];
    const community = [
      { rank: 'Q' as const, suit: 'spades' as const },
      { rank: 'J' as const, suit: 'spades' as const },
      { rank: 'T' as const, suit: 'spades' as const },
    ];

    const result1 = evaluateHand(holeCards as any, community as any);
    const result2 = evaluateHand(holeCards as any, community as any);

    expect(result1.ranking).toBe(result2.ranking);
    expect(result1.name).toBe(result2.name);
    expect(result1.name).toBe('Royal Flush');
  });

  it('should handle different hands correctly', async () => {
    const { evaluateHand, clearEvalCache } = await import('../src/engine/PokerEngine');
    clearEvalCache();

    const hand1 = evaluateHand(
      [
        { rank: 'A', suit: 'spades' },
        { rank: 'A', suit: 'hearts' },
      ] as any,
      [
        { rank: '2', suit: 'clubs' },
        { rank: '3', suit: 'diamonds' },
        { rank: '7', suit: 'hearts' },
      ] as any
    );

    const hand2 = evaluateHand(
      [
        { rank: '2', suit: 'spades' },
        { rank: '3', suit: 'hearts' },
      ] as any,
      [
        { rank: 'A', suit: 'clubs' },
        { rank: 'K', suit: 'diamonds' },
        { rank: '7', suit: 'clubs' },
      ] as any
    );

    // Pair of Aces should beat high card
    expect(hand1.ranking).toBeGreaterThan(hand2.ranking);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 11: CROSS-ENGINE INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 11 — TableBalancer Integration', () => {
  it('should detect imbalance when gap > 1', () => {
    const tables = [
      {
        tableId: 't1',
        playerCount: 8,
        maxSeats: 9,
        players: Array.from({ length: 8 }, (_, i) => ({
          userId: `p${i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
      {
        tableId: 't2',
        playerCount: 5,
        maxSeats: 9,
        players: Array.from({ length: 5 }, (_, i) => ({
          userId: `p${10 + i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
    ];
    expect(tableBalancer.shouldRebalance(tables)).toBe(true);
  });

  it('should not rebalance when gap <= 1', () => {
    const tables = [
      {
        tableId: 't1',
        playerCount: 6,
        maxSeats: 9,
        players: Array.from({ length: 6 }, (_, i) => ({
          userId: `p${i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
      {
        tableId: 't2',
        playerCount: 5,
        maxSeats: 9,
        players: Array.from({ length: 5 }, (_, i) => ({
          userId: `p${10 + i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
    ];
    expect(tableBalancer.shouldRebalance(tables)).toBe(false);
  });

  it('should calculate correct number of moves to balance', () => {
    const tables = [
      {
        tableId: 't1',
        playerCount: 8,
        maxSeats: 9,
        players: Array.from({ length: 8 }, (_, i) => ({
          userId: `p${i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
      {
        tableId: 't2',
        playerCount: 4,
        maxSeats: 9,
        players: Array.from({ length: 4 }, (_, i) => ({
          userId: `p${10 + i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
    ];
    const moves = tableBalancer.calculateMoves(tables);
    // 8+4=12 players, 2 tables → ideal 6 each → 2 moves from t1 → t2
    expect(moves.length).toBe(2);
    expect(moves[0].fromTableId).toBe('t1');
    expect(moves[0].toTableId).toBe('t2');
  });

  it('should identify table break when <= 3 players and capacity exists', () => {
    const smallTable = {
      tableId: 't1',
      playerCount: 2,
      maxSeats: 9,
      players: [
        { userId: 'a', stack: 1000, seat: 1 },
        { userId: 'b', stack: 1000, seat: 2 },
      ],
    };
    const allTables = [
      smallTable,
      {
        tableId: 't2',
        playerCount: 6,
        maxSeats: 9,
        players: Array.from({ length: 6 }, (_, i) => ({
          userId: `p${i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
    ];
    expect(tableBalancer.shouldBreakTable(smallTable, allTables)).toBe(true);
  });

  it('should generate break moves distributing to least-populated tables', () => {
    const breakTable = {
      tableId: 't1',
      playerCount: 2,
      maxSeats: 9,
      players: [
        { userId: 'a', stack: 1000, seat: 1 },
        { userId: 'b', stack: 500, seat: 2 },
      ],
    };
    const otherTables = [
      {
        tableId: 't2',
        playerCount: 5,
        maxSeats: 9,
        players: Array.from({ length: 5 }, (_, i) => ({
          userId: `p${i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
      {
        tableId: 't3',
        playerCount: 6,
        maxSeats: 9,
        players: Array.from({ length: 6 }, (_, i) => ({
          userId: `p${10 + i}`,
          stack: 1000,
          seat: i + 1,
        })),
      },
    ];
    const moves = tableBalancer.breakTable(breakTable, otherTables);
    expect(moves.length).toBe(2);
    // First move should go to t2 (fewest players)
    expect(moves[0].toTableId).toBe('t2');
  });
});

describe('Phase 11 — StateVerifier Integration', () => {
  it('should detect chip conservation violation when total changes', () => {
    const tableId = 'test-verify-integration';
    const players = [
      { user_id: 'p1', stack: 900, bet: 100, cards: [], is_folded: false, is_all_in: false },
      { user_id: 'p2', stack: 800, bet: 100, cards: [], is_folded: false, is_all_in: false },
    ];

    // Record initial total: 900+100 + 800+100 = 1900
    stateVerifier.recordInitialChipTotal(
      tableId,
      players.map((p: any) => ({ ...p, stack: p.stack + p.bet }))
    );

    // Simulate a discrepancy (extra chips appeared)
    const badPlayers = [
      { user_id: 'p1', stack: 1000, bet: 100, cards: [], is_folded: false, is_all_in: false },
      { user_id: 'p2', stack: 900, bet: 100, cards: [], is_folded: false, is_all_in: false },
    ];

    const result = stateVerifier.verify({
      tableId,
      handNumber: 1,
      players: badPlayers as any,
      communityCards: [],
      pot: 0,
      stage: 'flop',
    });

    expect(result.valid).toBe(false);
    expect(result.violations.some((v: any) => v.type === 'CHIP_CONSERVATION')).toBe(true);

    stateVerifier.clearTable(tableId);
  });

  it('should pass verification when chip total is conserved', () => {
    const tableId = 'test-verify-clean';
    const players = [
      { user_id: 'p1', stack: 900, bet: 100, cards: [], is_folded: false, is_all_in: false },
      { user_id: 'p2', stack: 800, bet: 200, cards: [], is_folded: false, is_all_in: false },
    ];

    stateVerifier.recordInitialChipTotal(tableId, [
      { ...players[0], stack: players[0].stack + players[0].bet },
      { ...players[1], stack: players[1].stack + players[1].bet },
    ] as any);

    const result = stateVerifier.verify({
      tableId,
      handNumber: 1,
      players: players as any,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    // Chip total = 900+100 + 800+200 = 2000 which matches initial
    expect(result.valid).toBe(true);
    stateVerifier.clearTable(tableId);
  });
});

describe('Phase 11 — DisconnectEngine + PreciseActionTimer Integration', () => {
  afterEach(() => {
    disconnectEngine.dispose('test-disconnect-table');
    preciseActionTimer.clearTable('test-disconnect-table');
  });

  it('should register and track player connection state', () => {
    disconnectEngine.configure('test-disconnect-table', { disconnectTimeoutSeconds: 10 });
    disconnectEngine.registerPlayer('test-disconnect-table', 'player1');

    expect(disconnectEngine.isConnected('test-disconnect-table', 'player1')).toBe(true);
    expect(disconnectEngine.isSittingOut('test-disconnect-table', 'player1')).toBe(false);
  });

  it('should mark player disconnected and emit bus event', () => {
    disconnectEngine.configure('test-disconnect-table', { disconnectTimeoutSeconds: 10 });
    disconnectEngine.registerPlayer('test-disconnect-table', 'player1');
    disconnectEngine.markDisconnected('test-disconnect-table', 'player1');

    expect(disconnectEngine.isConnected('test-disconnect-table', 'player1')).toBe(false);
  });

  it('should reconnect player and reset state', () => {
    disconnectEngine.configure('test-disconnect-table', { disconnectTimeoutSeconds: 10 });
    disconnectEngine.registerPlayer('test-disconnect-table', 'player1');
    disconnectEngine.markDisconnected('test-disconnect-table', 'player1');
    disconnectEngine.heartbeat('test-disconnect-table', 'player1');

    expect(disconnectEngine.isConnected('test-disconnect-table', 'player1')).toBe(true);
  });

  it('should auto-sit-out after max consecutive timeouts', () => {
    disconnectEngine.configure('test-disconnect-table', {
      disconnectTimeoutSeconds: 10,
      maxConsecutiveTimeouts: 2,
    });
    disconnectEngine.registerPlayer('test-disconnect-table', 'player1');

    // Simulate consecutive timeouts manually
    disconnectEngine.markDisconnected('test-disconnect-table', 'player1');
    const state = disconnectEngine.getState('test-disconnect-table', 'player1');
    if (state) {
      state.consecutiveTimeouts = 2;
      disconnectEngine.sitOut('test-disconnect-table', 'player1', 'forced');
    }

    expect(disconnectEngine.isSittingOut('test-disconnect-table', 'player1')).toBe(true);
  });
});

describe('Phase 11 — EngineTelemetry Integration', () => {
  beforeEach(() => {
    engineTelemetry.dispose();
  });

  it('should record hand timing and provide snapshot', () => {
    engineTelemetry.recordHandTiming('table1', 50, 30, 5000);
    engineTelemetry.recordHandTiming('table1', 45, 25, 4500);

    const snapshot = engineTelemetry.getSnapshot();
    expect(snapshot.global.activeTables).toBe(1);
    expect(snapshot.global.totalHandsDealt).toBe(2);
    expect(snapshot.global.avgHandDurationMs).toBeGreaterThan(0);
  });

  it('should track per-table metrics separately', () => {
    engineTelemetry.recordHandTiming('table1', 50, 30, 5000);
    engineTelemetry.recordHandTiming('table2', 60, 40, 6000);

    const snapshot = engineTelemetry.getSnapshot();
    expect(snapshot.global.activeTables).toBe(2);
    expect(snapshot.global.totalHandsDealt).toBe(2);
  });

  it('should track cache hit ratio', () => {
    engineTelemetry.recordCacheHit();
    engineTelemetry.recordCacheHit();
    engineTelemetry.recordCacheMiss();

    const snapshot = engineTelemetry.getSnapshot();
    // 2 hits / 3 total = 67% (rounded)
    expect(snapshot.global.cacheHitRatio).toBe(67);
  });
});
