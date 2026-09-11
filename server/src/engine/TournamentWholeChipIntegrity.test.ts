import { describe, expect, it, vi } from 'vitest';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';
import { HandController } from './HandController.js';
import { ServerActionValidator, type ValidationContext } from './ServerActionValidator.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HorseLogic } from './HorseLogic.js';
import { escalatedBlindLevel } from '../tournament/blindEscalation.js';

const tableId = 'f1000000-0000-4000-8000-000000000001';

function player(seat: number, stack = 100): SeatPlayer {
  return {
    seat,
    user_id: `player-${seat}`,
    username: `Player ${seat}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
}

function config(overrides: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId,
    handNumber: 1,
    isTournament: true,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...overrides,
  };
}

function validationContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    isTournament: true,
    currentPlayerId: 'player-0',
    stage: 'preflop',
    currentBet: 2,
    playerBet: 1,
    playerStack: 99,
    bigBlind: 2,
    minRaise: 2,
    pot: 3,
    canCheck: false,
    actionDeadline: 0,
    playerActedThisRound: false,
    isAllIn: false,
    isFolded: false,
    numActivePlayers: 2,
    ...overrides,
  };
}

function request(amount: number) {
  return {
    tableId,
    handId: 'hand-1',
    playerId: 'player-0',
    action: 'raise' as const,
    amount,
    timestamp: 1,
  };
}

function expectWholeChipEvent(event: HandEvent): void {
  const e = event as unknown as Record<string, any> & { type: string };
  const whole = (value: unknown): void => expect(Number.isSafeInteger(value)).toBe(true);
  const postings = (values: unknown): void => {
    if (Array.isArray(values)) values.forEach((value) => whole(value.amount));
  };
  const players = (values: unknown): void => {
    if (!Array.isArray(values)) return;
    values.forEach((value) => {
      whole(value.stack);
      whole(value.bet);
      whole(value.totalInvested);
      if (value.deadInvested !== undefined) whole(value.deadInvested);
      if (value.returnedUncalled !== undefined) whole(value.returnedUncalled);
    });
  };

  switch (e.type) {
    case 'HAND_START':
      players(e.players);
      break;
    case 'PLAYER_ACTION':
    case 'UNCALLED_BET_RETURNED':
    case 'STRADDLE_POSTED':
      whole(e.amount);
      break;
    case 'POT_UPDATE':
      whole(e.pot);
      postings(e.pots);
      break;
    case 'ALL_IN_RUNOUT':
      whole(e.pot);
      players(e.players);
      break;
    case 'WINNERS':
      postings(e.winners);
      postings(e.winnersByBoard);
      postings(e.perPotAwards);
      break;
    case 'BLINDS_POSTED':
    case 'FORCED_BETS_POSTED':
      postings(e.postings);
      break;
    case 'BOMB_POT_TRIGGERED':
      whole(e.anteAmount);
      postings(e.postings);
      break;
    case 'HAND_COMPLETE':
      whole(e.rake);
      whole(e.bbjFee);
      break;
  }
}

describe('tournament chips are indivisible at the authoritative hand boundary', () => {
  it('refuses the reported 4.5-chip raise before any state or event changes', () => {
    const hc = new HandController(config(), [player(0), player(1)], 0);
    const events: HandEvent[] = [];
    hc.onEvent((event) => events.push(event));
    hc.start();

    const before = hc.getState();
    const eventCount = events.length;
    expect(hc.performAction(before.currentPlayerSeat, 'raise', 4.5)).toBe(false);
    expect(hc.getState()).toEqual(before);
    expect(events).toHaveLength(eventCount);
  });

  it('preserves a 4.50 wager on a cash table', () => {
    const hc = new HandController(
      config({ isTournament: false, smallBlind: 1, bigBlind: 2 }),
      [player(0), player(1)],
      0
    );
    hc.start();
    const seat = hc.getState().currentPlayerSeat;
    expect(hc.performAction(seat, 'raise', 4.5)).toBe(true);
    expect(hc.getState().actionHistory.at(-1)).toMatchObject({ action: 'raise', amount: 4.5 });
  });

  it.each([
    ['small blind', config({ smallBlind: 0.5 })],
    ['big blind', config({ bigBlind: 2.5 })],
    ['ante', config({ ante: 0.5 })],
    ['straddle', config({ straddles: [{ seat: 0, amount: 4.5 }] })],
    ['fixed bomb ante', config({ bombPot: { anteMultiplier: 2, anteFixed: 3.5 } })],
    [
      'resolved bomb ante',
      config({ smallBlind: 1, bigBlind: 1, bombPot: { anteMultiplier: 1.5 } }),
    ],
  ])('refuses a fractional tournament %s before the hand exists', (_name, badConfig) => {
    expect(() => new HandController(badConfig, [player(0), player(1)], 0)).toThrow(
      /Tournament chip amounts must be whole chips/
    );
  });

  it('refuses a fractional starting stack and never rounds it', () => {
    expect(() => new HandController(config(), [player(0, 100.5), player(1)], 0)).toThrow(
      /players\[0\]\.stack=100\.5/
    );
  });

  it('validates an entire runout delta batch before mutating any stack', () => {
    const hc = new HandController(config(), [player(0), player(1)], 0);
    const before = hc.getState().players.map((p) => p.stack);
    expect(() =>
      hc.applyStackDeltas(
        new Map([
          ['player-0', 5],
          ['player-1', -2.5],
        ])
      )
    ).toThrow(/stackDelta\[player-1\]=-2\.5/);
    expect(hc.getState().players.map((p) => p.stack)).toEqual(before);
  });

  it('fails closed when a fractional state is injected instead of rounding it', () => {
    const hc = new HandController(config(), [player(0), player(1)], 0) as any;
    hc.state.players[0].stack = 99.5;
    expect(() => hc.start()).toThrow(/players\[0\]\.stack=99\.5/);
    expect(hc.state.players[0].stack).toBe(99.5);
  });

  it('makes copied cash rake and BBJ configuration inert at tournament pricing', () => {
    const hc = new HandController(
      config({
        rakeConfig: { percent: 10, cap: 2.25, noFlopNoDrop: false },
        bbjConfig: {
          enabled: true,
          feeBB: 0.25,
          minPotBB: 0,
          minPlayersDealt: 2,
        },
      }),
      [player(0), player(1)],
      0
    );
    expect(hc.priceDeductions(true, 7, { forecast: true })).toEqual({ rake: 0, bbjFee: 0 });
  });

  it('accepts every synthesized overflow level without a fractional table refresh', () => {
    for (const ratio of [1.15, 1.4, 1.6]) {
      const level = escalatedBlindLevel(
        { smallBlind: 375, bigBlind: 750, ante: 75 },
        17,
        10,
        10,
        ratio
      );
      expect(
        () =>
          new HandController(
            config({
              smallBlind: level.smallBlind,
              bigBlind: level.bigBlind,
              ante: level.ante,
            }),
            [player(0, 100_000), player(1, 100_000)],
            0
          )
      ).not.toThrow();
    }
  });
});

describe('tournament whole-chip requests are refused on both server action gates', () => {
  it('ServerActionValidator rejects a fractional request and fractional context', () => {
    const validator = new ServerActionValidator();
    expect(validator.validate(request(4.5), validationContext())).toMatchObject({
      valid: false,
      code: 'INVALID_AMOUNT',
      reason: expect.stringContaining('requestedWager=4.5'),
    });
    expect(validator.validate(request(5), validationContext({ pot: 3.5 }))).toMatchObject({
      valid: false,
      code: 'INVALID_AMOUNT',
      reason: expect.stringContaining('context.pot=3.5'),
    });
  });

  it('horse legalization never emits a fractional tournament amount from integral state', () => {
    const hero = {
      ...player(0, 97),
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
    } satisfies SeatPlayer;
    const villain = {
      ...player(1, 113),
      cards: [
        { rank: 'Q', suit: 'hearts' },
        { rank: 'J', suit: 'hearts' },
      ],
    } satisfies SeatPlayer;

    for (let trial = 0; trial < 120; trial++) {
      const currentBet = trial % 4 === 0 ? 0 : 2 + (trial % 13);
      const heroBet = currentBet === 0 ? 0 : trial % 2 === 0 ? currentBet : 0;
      hero.bet = heroBet;
      villain.bet = currentBet;
      const decision = HorseLogic.decide(
        hero,
        {
          players: [hero, villain],
          communityCards: [
            { rank: 'A', suit: 'diamonds' },
            { rank: '7', suit: 'clubs' },
            { rank: '2', suit: 'hearts' },
          ],
          pot: 9 + (trial % 37),
          currentBet,
          minRaise: 2,
          lastRaise: 2,
          stage: 'flop',
          gameVariant: 'nlh',
          bigBlind: 2,
          dealerSeat: 1,
          gameMode: 'tournament',
          format: 'mtt',
        },
        'balanced'
      );
      if (decision.amount !== undefined) {
        expect(Number.isSafeInteger(decision.amount), JSON.stringify(decision)).toBe(true);
      }
    }
  });

  it('ServerActionValidator still accepts a cash 4.50 raise', () => {
    const validator = new ServerActionValidator();
    expect(
      validator.validate(request(4.5), validationContext({ isTournament: false }))
    ).toMatchObject({ valid: true, sanitizedAction: 'raise', sanitizedAmount: 4.5 });
  });

  it('the real human turn path rejects the original fraction before any clamp or timer mutation', () => {
    const engine = new ServerTableEngine(tableId) as any;
    const recordPlayerActed = vi.fn();
    engine.running = true;
    engine.lifecycleCanMutate = () => true;
    engine.tableInfo = { tournament_id: 'tournament-1', game_type: 'tournament', big_blind: 2 };
    engine.disconnectEngine = { recordPlayerActed };
    engine.handController = {
      getState: () => ({
        currentPlayerSeat: 0,
        currentBet: 2,
        minRaise: 2,
        pot: 3,
        stage: 'preflop',
        players: [
          {
            ...player(0, 99),
            bet: 1,
          },
        ],
      }),
    };

    expect(engine.handlePlayerAction('player-0', 'raise', 4.5)).toMatchObject({
      success: false,
      code: 'INVALID_AMOUNT',
      error: expect.stringContaining('requestedWager=4.5'),
    });
    expect(recordPlayerActed).not.toHaveBeenCalled();
  });

  it('ignores a copied fractional cash cap on a tournament instead of clamping a valid wager', () => {
    const engine = new ServerTableEngine(tableId) as any;
    const performAction = vi.fn(() => true);
    engine.running = true;
    engine.lifecycleCanMutate = () => true;
    engine.tableInfo = {
      tournament_id: 'tournament-1',
      game_type: 'tournament',
      game_variant: 'nlh',
      big_blind: 2,
      cap_enabled: true,
      cap_bb: 2.25,
    };
    engine.disconnectEngine = { recordPlayerActed: vi.fn() };
    engine.handController = {
      getState: () => ({
        currentPlayerSeat: 0,
        currentBet: 0,
        minRaise: 2,
        pot: 3,
        stage: 'preflop',
        players: [{ ...player(0, 100), bet: 0, totalInvested: 0 }],
      }),
      performAction,
    };
    engine.actionValidator = {
      validate: vi.fn((actionRequest: any) => ({
        valid: true,
        sanitizedAction: actionRequest.action,
        sanitizedAmount: actionRequest.amount,
      })),
    };
    engine.preciseTimer = { getDeadline: vi.fn(() => 0), cancelTimer: vi.fn() };
    engine.timeBankEngine = { isArmed: vi.fn(() => false), playerActed: vi.fn() };
    engine.turnFSM = { transition: vi.fn() };
    engine.engineTelemetry = { recordTimerActed: vi.fn() };
    engine.clearTurnTimer = vi.fn();
    engine.requestSnapshot = vi.fn();
    engine.humansSeated = () => 1;
    engine.tableFormat = () => 'mtt';

    expect(engine.handlePlayerAction('player-0', 'bet', 5)).toEqual({ success: true });
    expect(performAction).toHaveBeenCalledWith(0, 'bet', 5);
  });

  it('the real pre-action route refuses a fractional tournament call cap before arming', () => {
    const engine = new ServerTableEngine(tableId) as any;
    const setPreAction = vi.fn();
    engine.tableInfo = { tournament_id: 'tournament-1', game_type: 'tournament' };
    engine.handController = {
      getState: () => ({
        currentPlayerSeat: 1,
        currentBet: 5,
        players: [{ ...player(0), bet: 2 }],
      }),
    };
    engine.preActionEngine = { setPreAction };

    expect(engine.setPreAction('player-0', 'auto_call', 3.5)).toMatchObject({
      success: false,
      error: expect.stringContaining('maxCallAmount=3.5'),
    });
    expect(setPreAction).not.toHaveBeenCalled();
  });
});

describe('whole-chip tournament hands conserve their denomination', () => {
  it('keeps every state, action, pot and event integral across varied stacks and forced bets', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const count = 2 + (seed % 5);
      const bigBlind = 2 + (seed % 4);
      const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
      const stacks = Array.from(
        { length: count },
        (_, seat) => 8 + ((seed * 17 + seat * 31) % 193)
      );
      const players = stacks.map((stack, seat) => player(seat, stack));
      const handConfig = config({
        handNumber: seed,
        smallBlind,
        bigBlind,
        ante: seed % 3 === 0 ? 1 : undefined,
        bigBlindAnte: seed % 6 === 0,
        bombPot:
          seed % 10 === 0
            ? { anteMultiplier: bigBlind % 2 === 0 ? 1.5 : 2, boardCount: seed % 20 === 0 ? 2 : 1 }
            : undefined,
      });
      const hc = new HandController(handConfig, players, seed % count);
      let complete = false;
      hc.onEvent((event) => {
        expectWholeChipEvent(event);
        if (event.type === 'HAND_COMPLETE') complete = true;
      });
      hc.start();

      for (let actionNo = 0; !complete && actionNo < 80; actionNo++) {
        const state = hc.getState();
        state.players.forEach((p) => {
          expect(Number.isSafeInteger(p.stack)).toBe(true);
          expect(Number.isSafeInteger(p.bet)).toBe(true);
          expect(Number.isSafeInteger(p.totalInvested)).toBe(true);
        });
        expect(Number.isSafeInteger(state.pot)).toBe(true);
        expect(Number.isSafeInteger(state.currentBet)).toBe(true);
        expect(Number.isSafeInteger(state.minRaise)).toBe(true);
        expect(Number.isSafeInteger(state.lastRaise)).toBe(true);
        state.pots.forEach((pot) => expect(Number.isSafeInteger(pot.amount)).toBe(true));
        state.actionHistory.forEach((action) =>
          expect(Number.isSafeInteger(action.amount)).toBe(true)
        );

        if (state.currentPlayerSeat < 0) {
          // HandController deliberately parks all-in runouts for the server's
          // insurance/RIT decision. This harness chooses the ordinary single
          // run and resumes the same authoritative path.
          hc.continueRunout();
          continue;
        }
        const acting = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
        const toCall = state.currentBet - acting.bet;
        // Exercise whole-stack ingress as well as ordinary call/check paths.
        // With integral state an all-in is integral by construction; side-pot
        // and runout settlement must preserve that denomination too.
        const action =
          actionNo % 7 === 0 && acting.stack > 0 ? 'all_in' : toCall > 0 ? 'call' : 'check';
        expect(hc.performAction(acting.seat, action)).toBe(true);
      }

      expect(complete, `seed ${seed} completed`).toBe(true);
      expect(hc.getState().players.reduce((sum, p) => sum + p.stack, 0)).toBe(
        stacks.reduce((sum, stack) => sum + stack, 0)
      );
    }
  });
});
