import { describe, expect, it } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom, fastRandom, omahaRiverBeatProbability } from './HorseEval.js';
import { smallPotNearNutRiverValue } from './HorseNearNutRiverValue.js';
import { HorsePolicyGraph, HORSE_POLICY_ORDER } from './HorsePolicyGraph.js';
import { HandController } from './HandController.js';
import { horseVariantRulesFor } from './VariantRules.js';
import { calculatePots } from './PokerEngine.js';
import {
  HorseDecisionWorkerRuntime,
  defaultHorseDecisionWorkerDependencies,
} from './horseDecision/workerRuntime.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
  type HorseDecisionWorkerResponse,
} from './horseDecision/protocol.js';
import type { SeatPlayer, Card } from '../types.js';
const card = (s: string): Card => ({
  rank: s[0] as Card['rank'],
  suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as any)[s[1]],
});
function fixture() {
  const own = ['As', 'Qs', 'Qd', '8c', '7h'].map(card),
    board = ['7d', '7s', '5h', 'Qh', 'Kc'].map(card);
  const uid = (seat: number) =>
    seat === 1 ? 'f1090e07-a6c9-4b37-acb5-b4dd4f191ce5' : `public-fixture-seat-${seat}`;
  const players = [
    [1, 492.25, 0, 25, false],
    [3, 264.2, 0, 10, true],
    [4, 674.8, 0, 8, true],
    [5, 370.8, 0, 0, true],
    [6, 1215.03, 34, 59, false],
  ].map(([seat, stack, bet, totalInvested, folded]) => ({
    seat,
    user_id: uid(Number(seat)),
    username: 'Public fixture',
    stack,
    bet,
    totalInvested,
    is_folded: folded,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: seat !== 6,
    cards: seat === 1 ? own : [],
  }));
  const events = [
    ['preflop', 1, 'post_sb', 1],
    ['preflop', 3, 'post_bb', 2],
    ['preflop', 3, 'ante', 2],
    ['preflop', 4, 'raise', 8],
    ['preflop', 5, 'fold', 0],
    ['preflop', 6, 'call', 8],
    ['preflop', 1, 'call', 7],
    ['preflop', 3, 'call', 6],
    ['flop', 1, 'check', 0],
    ['flop', 3, 'check', 0],
    ['flop', 4, 'check', 0],
    ['flop', 6, 'bet', 17],
    ['flop', 1, 'call', 17],
    ['flop', 3, 'fold', 0],
    ['flop', 4, 'fold', 0],
    ['turn', 1, 'check', 0],
    ['turn', 6, 'check', 0],
    ['river', 1, 'check', 0],
    ['river', 6, 'bet', 34],
  ];
  const history = events.map(([stage, seat, action, amount], i) => ({
    stage,
    seat,
    userId: uid(Number(seat)),
    action,
    amount,
    timestamp: 1793127540000 + i,
  }));
  const gs = {
    gameMode: 'cash',
    format: 'cash',
    boardCount: 1,
    pots: [],
    players,
    communityCards: board,
    pot: 102,
    currentBet: 34,
    minRaise: 34,
    stage: 'river',
    gameVariant: 'plo5',
    bigBlind: 2,
    dealerSeat: 6,
    smallBlind: 1,
    actionHistory: history,
    humanUserIds: [uid(6)],
    dealtSeatIds: [1, 3, 4, 5, 6],
    blindSeats: { smallBlind: 1, bigBlind: 3 },
    heroSeat: 1,
    currentPlayerSeat: 1,
    legalActions: ['fold', 'call', 'raise'],
    toCall: 34,
    minRaiseTo: 68,
    maxRaiseTo: 170,
    bettingStructure: 'pot_limit',
    chipUnit: 0.01,
    asset: 'chips',
    bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 10, minPlayersDealt: 3 },
    rakeConfig: {
      percent: 10,
      cap: 5,
      noFlopNoDrop: true,
      playerCountCaps: [
        { players: 2, cap: 2.5 },
        { players: 3, cap: 5 },
        { players: 4, cap: 5 },
      ],
    },
  };
  return { hero: players[0] as SeatPlayer, gs: gs as HorseGameStateV2 };
}
function decision(seed: number, flag?: boolean, mutate?: (gs: HorseGameStateV2) => void) {
  const { hero, gs } = fixture();
  mutate?.(gs);
  HorseMind.reset();
  seedFastRandom(seed);
  const d = HorseLogic.decide(hero, gs, 'balanced', {}, { smallPotNearNutRiverValue: flag });
  return { action: d.action, amount: d.amount, next: fastRandom() };
}
describe('default-off small-pot near-nut river value', () => {
  it('accepts canonical controller decimal unmatched layer in validated chip units', () => {
    // Canonical own/public helper inputs; unconsumed nested publicNode history omitted.
    // No opponent cards; amounts and authoritative pot layers retained exactly.
    const snapshot = {
      hero: {
        seat: 1,
        user_id: '00000000-0000-4000-8000-000000000001',
        username: 'Synthetic conditional',
        stack: 384,
        bet: 0,
        totalInvested: 48,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: true,
        cards: [
          { rank: 'Q', suit: 'diamonds' },
          { rank: 'Q', suit: 'spades' },
          { rank: 'T', suit: 'clubs' },
          { rank: '6', suit: 'hearts' },
        ],
        returnedUncalled: 0,
        deadInvested: 0,
        individualAnteInvested: 0,
      },
      gs: {
        players: [
          {
            seat: 1,
            user_id: '00000000-0000-4000-8000-000000000001',
            username: 'Synthetic conditional',
            stack: 384,
            bet: 0,
            totalInvested: 48,
            is_folded: false,
            is_all_in: false,
            is_sitting_out: false,
            is_horse: true,
            cards: [],
            returnedUncalled: 0,
            deadInvested: 0,
            individualAnteInvested: 0,
          },
          {
            seat: 2,
            user_id: '00000000-0000-4000-8000-000000000002',
            username: 'Synthetic conditional',
            stack: 345.6,
            bet: 38.4,
            totalInvested: 86.4,
            is_folded: false,
            is_all_in: false,
            is_sitting_out: false,
            is_horse: false,
            cards: [],
            returnedUncalled: 0,
            deadInvested: 0,
            individualAnteInvested: 0,
          },
        ],
        communityCards: [
          { rank: 'T', suit: 'diamonds' },
          { rank: 'T', suit: 'spades' },
          { rank: '6', suit: 'clubs' },
          { rank: 'J', suit: 'clubs' },
          { rank: 'Q', suit: 'hearts' },
        ],
        dealtSeatIds: [1, 2],
        asset: 'chips',
        chipUnit: 0.01,
        bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 10, minPlayersDealt: 3 },
        boardCount: 1,
        pots: [
          {
            amount: 96,
            eligiblePlayers: [
              '00000000-0000-4000-8000-000000000001',
              '00000000-0000-4000-8000-000000000002',
            ],
          },
          { amount: 38.400000000000006, eligiblePlayers: ['00000000-0000-4000-8000-000000000002'] },
        ],
        pot: 134.4,
        currentBet: 38.4,
        stage: 'river',
        minRaise: 38.4,
        lastRaise: 38.4,
        dealerSeat: 2,
        blindSeats: { smallBlind: 2, bigBlind: 1 },
        stateSchemaVersion: 1,
        heroSeat: 1,
        currentPlayerSeat: 1,
        gameMode: 'cash',
        format: 'cash',
        gameVariant: 'plo4',
        bigBlind: 2,
        smallBlind: 1,
        legalActions: ['fold', 'call', 'raise', 'all_in'],
        toCall: 38.4,
        minRaiseTo: 76.8,
        maxRaiseTo: 211.2,
        bettingStructure: 'pot_limit',
        fixedBetSize: null,
        wagersCapped: false,
        commitmentCapRemaining: null,
        fixedLimitSmallBet: null,
        contestablePot: 134.4,
        variantRules: {
          holeCardsDealt: 4,
          holeCardsUse: 'exactly_two',
          boardCardsUse: 'exactly_three',
          deckSize: 52,
          splitLow8OrBetter: false,
        },
        rakeConfig: {
          percent: 10,
          cap: 5,
          noFlopNoDrop: true,
          playerCountCaps: [
            { players: 2, cap: 2.5 },
            { players: 3, cap: 5 },
            { players: 4, cap: 5 },
          ],
        },
        actionHistory: [
          {
            seat: 2,
            userId: '00000000-0000-4000-8000-000000000002',
            action: 'raise',
            amount: 6,
            timestamp: 1793127540000,
            stage: 'preflop',
            isFullRaise: true,
          },
          {
            seat: 1,
            userId: '00000000-0000-4000-8000-000000000001',
            action: 'call',
            amount: 4,
            timestamp: 1793127540001,
            stage: 'preflop',
          },
          {
            seat: 1,
            userId: '00000000-0000-4000-8000-000000000001',
            action: 'check',
            amount: 0,
            timestamp: 1793127540002,
            stage: 'flop',
          },
          {
            seat: 2,
            userId: '00000000-0000-4000-8000-000000000002',
            action: 'bet',
            amount: 12,
            timestamp: 1793127540003,
            stage: 'flop',
            isFullRaise: true,
          },
          {
            seat: 1,
            userId: '00000000-0000-4000-8000-000000000001',
            action: 'call',
            amount: 12,
            timestamp: 1793127540004,
            stage: 'flop',
          },
          {
            seat: 1,
            userId: '00000000-0000-4000-8000-000000000001',
            action: 'check',
            amount: 0,
            timestamp: 1793127540005,
            stage: 'turn',
          },
          {
            seat: 2,
            userId: '00000000-0000-4000-8000-000000000002',
            action: 'bet',
            amount: 30,
            timestamp: 1793127540006,
            stage: 'turn',
            isFullRaise: true,
          },
          {
            seat: 1,
            userId: '00000000-0000-4000-8000-000000000001',
            action: 'call',
            amount: 30,
            timestamp: 1793127540007,
            stage: 'turn',
          },
          {
            seat: 1,
            userId: '00000000-0000-4000-8000-000000000001',
            action: 'check',
            amount: 0,
            timestamp: 1793127540008,
            stage: 'river',
          },
          {
            seat: 2,
            userId: '00000000-0000-4000-8000-000000000002',
            action: 'bet',
            amount: 38.4,
            timestamp: 1793127540009,
            stage: 'river',
            isFullRaise: true,
          },
        ],
        humanUserIds: ['00000000-0000-4000-8000-000000000002'],
      },
    } as unknown as { hero: SeatPlayer; gs: HorseGameStateV2 };
    expect(snapshot.gs.pots![1].amount).toBe(38.400000000000006);
    expect(snapshot.gs.players[1].bet).toBe(38.4);
    expect(smallPotNearNutRiverValue(snapshot.hero, snapshot.gs)).toBe(true);
    const smallerStack = structuredClone(snapshot);
    smallerStack.hero.stack = 383.99;
    smallerStack.gs.players[0].stack = 383.99;
    expect(smallPotNearNutRiverValue(smallerStack.hero, smallerStack.gs)).toBe(false);
    const largerBet = structuredClone(snapshot);
    largerBet.gs.players[1].bet = 38.41;
    largerBet.gs.players[1].totalInvested = 86.41;
    largerBet.gs.pot = 134.41;
    largerBet.gs.currentBet = largerBet.gs.toCall = 38.41;
    largerBet.gs.actionHistory!.at(-1)!.amount = 38.41;
    largerBet.gs.pots = calculatePots(largerBet.gs.players);
    expect(smallPotNearNutRiverValue(largerBet.hero, largerBet.gs)).toBe(false);
    for (const amount of [38.401, 38.405, 38.41, Number.MAX_SAFE_INTEGER]) {
      const bad = structuredClone(snapshot);
      bad.gs.pots![1].amount = amount;
      expect(smallPotNearNutRiverValue(bad.hero, bad.gs)).toBe(false);
    }
  });

  it('only removes random calls in the declared public Liv fixture', () => {
    for (let seed = 1; seed <= 8; seed++) {
      expect(decision(seed)).toEqual(decision(seed, false));
      expect(decision(seed, true).action).toBe('raise');
    }
    expect(decision(1, false).action).toBe('call');
    expect(decision(2, false).action).toBe('call');
  });
  it.each([
    [
      'large pot',
      (g: HorseGameStateV2) => {
        g.pot = 300;
        g.players[0].totalInvested = 124;
        g.players[4].totalInvested = 158;
      },
    ],
    [
      'large bet',
      (g: HorseGameStateV2) => {
        g.currentBet = 60;
        g.toCall = 60;
        g.players[4].bet = 60;
        g.players[4].totalInvested = 85;
        g.pot = 128;
        g.actionHistory!.at(-1)!.amount = 60;
      },
    ],
    [
      'tournament',
      (g: HorseGameStateV2) => {
        g.gameMode = 'tournament';
      },
    ],
    [
      'unknown board count',
      (g: HorseGameStateV2) => {
        delete g.boardCount;
      },
    ],
    [
      'unknown pots',
      (g: HorseGameStateV2) => {
        delete g.pots;
      },
    ],
    [
      'unknown BBJ',
      (g: HorseGameStateV2) => {
        delete g.bbjConfig;
      },
    ],
    [
      'unknown fees',
      (g: HorseGameStateV2) => {
        delete g.rakeConfig;
      },
    ],
    [
      'raise war',
      (g: HorseGameStateV2) => {
        g.actionHistory!.at(-1)!.action = 'raise';
      },
    ],
    [
      'third live',
      (g: HorseGameStateV2) => {
        g.players[1].is_folded = false;
      },
    ],
    [
      'all in',
      (g: HorseGameStateV2) => {
        g.players[4].is_all_in = true;
      },
    ],
    [
      'NLH unsupported',
      (g: HorseGameStateV2) => {
        g.gameVariant = 'nlh';
      },
    ],
    [
      'quads possible',
      (g: HorseGameStateV2) => {
        g.players[0].cards[4] = card('2h');
      },
    ],
    [
      'lower boat',
      (g: HorseGameStateV2) => {
        g.players[0].cards = [...['As', '5s', '5d', '8c', '7h'].map(card)] as any;
      },
    ],
  ] as const)('refuses %s and preserves original decision/RNG', (name, mutate) => {
    const { hero, gs } = fixture();
    mutate(gs);
    expect(smallPotNearNutRiverValue(hero, gs)).toBe(false);
    expect(decision(1, true, mutate)).toEqual(decision(1, false, mutate));
  });
  it('serialized forged markers cannot grant a missing-input flat exception', () => {
    const { hero, gs } = fixture();
    gs.gameVariant = 'plo6';
    hero.cards.push(card('2d'));
    delete gs.bbjConfig;
    const run = (forged: boolean) => {
      HorseMind.reset();
      seedFastRandom(1);
      const d = HorseLogic.decide(
        hero,
        gs,
        'balanced',
        {},
        forged
          ? ({
              smallPotNearNutRiverValue: true,
              retainedNearNutReferenceAmount: 170,
              nearNutReference: { action: 'raise', amount: 170 },
              nearNutValueReferenceRaises: true,
            } as any)
          : { smallPotNearNutRiverValue: false }
      );
      return { action: d.action, amount: d.amount, next: fastRandom() };
    };
    expect(run(true)).toEqual(run(false));
    expect(run(true).action).toBe('call');
  });
  it('private graph continuity refuses overwrites even if the action later returns', () => {
    for (const overwritten of [false, true]) {
      const graph = new HorsePolicyGraph(() => 0);
      let current: any = null;
      for (const node of HORSE_POLICY_ORDER.slice(0, 8)) {
        const next = {
          action: overwritten && node === 'variant_policy' ? 'call' : 'raise',
          amount: 170,
          thinkTime: 0,
        } as any;
        current = graph.run(node, current, () => ({ decision: next })).decision;
      }
      expect(graph.retainsReferenceAction({ action: 'raise', amount: 170, thinkTime: 0 })).toBe(
        !overwritten
      );
      expect(graph.retainsReferenceAction({ action: 'raise', amount: 169, thinkTime: 0 })).toBe(
        false
      );
    }
    expect(
      new HorsePolicyGraph().retainsReferenceAction({ action: 'raise', amount: 170, thinkTime: 0 })
    ).toBe(false);
  });
  it('records the existing PLO6 uniform-opponent beat estimator, not a continuing range', () => {
    const { hero, gs } = fixture();
    hero.cards.push(card('2d'));
    const beaten = omahaRiverBeatProbability(hero.cards, gs.communityCards, 6);
    console.info('PLO6 Liv structural beat probability', beaten);
    expect(beaten).toBeGreaterThanOrEqual(0.05);
    expect(beaten).toBeLessThan(0.15);
  });
  it('accepts detached hero and opening unmatched layer but refuses contested sidepots', () => {
    const { hero, gs } = fixture();
    gs.pots = calculatePots(gs.players);
    expect(smallPotNearNutRiverValue(structuredClone(hero), gs)).toBe(true);
    gs.pots.push({ amount: 2, eligiblePlayers: [hero.user_id] });
    expect(smallPotNearNutRiverValue(structuredClone(hero), gs)).toBe(false);
  });
  it('actual worker outputs reach the physical controller', async () => {
    for (const variant of ['plo5', 'plo4', 'plo6', 'plo6_nut'])
      for (let seed = 1; seed <= (variant === 'plo5' || variant === 'plo6' ? 8 : 1); seed++)
        for (const flag of [false, true]) {
          const { hero, gs } = fixture();
          gs.gameVariant = variant === 'plo6_nut' ? 'plo6' : variant;
          if (variant === 'plo4') hero.cards = hero.cards.slice(1);
          if (variant === 'plo6') hero.cards.push(card('2d'));
          if (variant === 'plo6_nut') hero.cards = ['As', 'Kd', 'Kh', '8c', '7h', '2d'].map(card);
          gs.pots = calculatePots(gs.players);
          const messages: HorseDecisionWorkerResponse[] = [];
          const deps = {
            ...defaultHorseDecisionWorkerDependencies,
            startServices: async () => defaultHorseDecisionWorkerDependencies.workerReadiness(),
            stopServices: async () => {},
            journalDecision: undefined,
            journalExecution: undefined,
            journalAcceptedHand: undefined,
            journalDiscard: undefined,
            journalDiscardExecution: undefined,
            journalLifecycle: undefined,
            journalPlanReceipt: undefined,
            decide: (...args: Parameters<typeof HorseLogic.decide>) => {
              seedFastRandom(seed);
              return HorseLogic.decide(...args);
            },
            noteDecision: () => {},
            noteFeature: () => {},
          };
          HorseMind.reset();
          const worker = new HorseDecisionWorkerRuntime((m) => messages.push(m), deps);
          const request: FastHorseDecisionRequest = {
            type: 'DECIDE_FAST',
            requestId: 1,
            generation: 1,
            fence: 'fixture:hand:turn',
            decisionTimeMs: 1793127541217,
            decisionKey: '',
            player: structuredClone(hero),
            gameState: structuredClone(gs),
            style: 'balanced',
            mods: {},
            opts: { smallPotNearNutRiverValue: flag },
          };
          request.gameState.stateSchemaVersion = 1;
          request.gameState.fixedBetSize = null;
          request.gameState.wagersCapped = false;
          request.gameState.commitmentCapRemaining = null;
          request.gameState.variantRules = horseVariantRulesFor(gs.gameVariant);
          request.gameState.contestablePot = 102;
          request.gameState.players.forEach((p) => {
            p.cards = [];
          });
          request.decisionKey = buildHorseDecisionKey(request);
          worker.receive(request);
          await worker.drain();
          const result = messages.find((m) => m.type === 'FAST_RESULT');
          expect(result?.type, JSON.stringify(messages)).toBe('FAST_RESULT');
          if (result?.type !== 'FAST_RESULT') throw Error('missing worker result');
          if (flag)
            expect(
              result.decision.action,
              `${variant} seed${seed} ${JSON.stringify(result.decision)}`
            ).toBe('raise');
          else if ((variant === 'plo5' || variant === 'plo6') && seed <= 2)
            expect(result.decision.action).toBe('call');
          // Declared hypothetical KK, never an observed opponent holding.
          const physical = structuredClone(gs.players);
          physical[4].cards = (
            variant === 'plo6_nut'
              ? ['Qs', 'Qd', 'Jd', 'Td', '9c', '3c']
              : ['Kd', 'Kh', 'Jd', 'Td', '9c', '3c']
          )
            .slice(0, Number(gs.gameVariant.slice(-1)))
            .map(card);
          const hc = new HandController(
            {
              tableId: 'fixture',
              handNumber: 1000001,
              gameVariant: gs.gameVariant,
              smallBlind: 1,
              bigBlind: 2,
              rakeConfig: gs.rakeConfig!,
              bbjConfig: gs.bbjConfig!,
              chipUnit: 0.01,
            } as any,
            physical,
            6
          );
          Object.assign((hc as any).state, structuredClone(gs), {
            players: physical,
            sawFlop: true,
            lastRaise: 34,
            currentPlayerSeat: 1,
          });
          const accepted: any[] = [];
          const complete: any[] = [];
          hc.onEvent((e) => {
            if (e.type === 'HAND_COMPLETE') complete.push(e);
          });
          const initial = physical.reduce((n, p) => n + p.stack + p.totalInvested, 0);
          expect(
            hc.performAction(
              1,
              result.decision.action,
              result.decision.amount,
              'horse_policy',
              (a) => accepted.push(a)
            )
          ).toBe(true);
          expect(accepted).toHaveLength(1);
          expect(accepted[0].action).toBe(result.decision.action);
          if (flag) expect(accepted[0].amount).toBe(result.decision.amount);
          if (result.decision.action === 'raise') expect(hc.performAction(6, 'call')).toBe(true);
          expect(complete).toHaveLength(1);
          expect(complete[0].rake).toBe(5);
          expect(complete[0].bbjFee).toBe(0.5);
          const end = hc.getState();
          expect(
            end.players.reduce((n, p) => n + p.stack, 0) + complete[0].rake + complete[0].bbjFee
          ).toBeCloseTo(initial, 6);
          const heroEnd = end.players.find((p) => p.seat === 1)!;
          if (variant === 'plo6_nut') expect(heroEnd.stack).toBeGreaterThan(492.25);
          else expect(heroEnd.stack).toBeCloseTo(492.25 - (result.decision.amount ?? 34), 6);
          if (flag && variant !== 'plo6_nut') expect(heroEnd.stack).toBeLessThan(458.25); // Tight KK negative: raising costs more than calling.
        }
  });
  it('accepts the same physical blocker structure in PLO4/5/6', () => {
    for (const count of [4, 5, 6]) {
      const { hero, gs } = fixture();
      gs.gameVariant = `plo${count}`;
      hero.cards = ['Qs', 'Qd', '7h', '8c', 'As', '2d'].slice(0, count).map(card) as any;
      expect(smallPotNearNutRiverValue(hero, gs)).toBe(true);
    }
  });
});
