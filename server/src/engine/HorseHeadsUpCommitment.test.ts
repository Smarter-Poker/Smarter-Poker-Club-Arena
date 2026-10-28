import { afterEach, describe, expect, it } from 'vitest';
import type { Card, SeatPlayer } from '../types.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { headsUpCashCommitment } from './HorseHeadsUpCommitment.js';
import { HandController } from './HandController.js';
import { horsePlanHandKey } from './HorseDecisionEffects.js';

const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[c[1] as 'c'],
  }));
function spot(stack: number) {
  const hero: SeatPlayer = {
    seat: 1,
    user_id: 'hero',
    username: 'Hero',
    stack,
    bet: 0,
    totalInvested: 10,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    cards: cards('Ac Qd'),
  };
  const villain: SeatPlayer = {
    ...hero,
    seat: 2,
    user_id: 'villain',
    stack: 15,
    bet: 20,
    totalInvested: 30,
    cards: [],
  };
  const gs: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    players: [{ ...hero, cards: [] }, villain],
    communityCards: cards('Qs 8h 3d'),
    dealtSeatIds: [1, 2],
    dealerSeat: 2,
    pot: 40,
    contestablePot: 40,
    currentBet: 20,
    minRaise: 20,
    lastRaise: 20,
    stage: 'flop',
    gameVariant: 'nlh',
    gameMode: 'cash',
    smallBlind: 1,
    bigBlind: 2,
    toCall: 20,
    legalActions: stack < 40 ? ['fold', 'call', 'all_in'] : ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: stack < 40 ? null : 40,
    maxRaiseTo: stack < 40 ? null : stack,
    bettingStructure: 'no_limit',
    actionHistory: [
      { stage: 'flop', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 1 },
      { stage: 'flop', seat: 2, userId: 'villain', action: 'bet', amount: 20, timestamp: 2 },
    ],
  };
  return { hero, gs };
}
afterEach(() => HorseMind.reset());
describe('cash heads-up matched commitment', () => {
  it('does not turn the existing low-SPR wager into a call because hero covers surplus chips', () => {
    const choices = [35, 1000].map((stack) => {
      HorseMind.reset();
      seedFastRandom(1);
      const s = spot(stack);
      return HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false });
    });
    expect(choices[0].action).toBe('all_in');
    expect(choices[1]).toMatchObject({ action: 'raise', amount: 40 });
  });

  it.each(['flop', 'turn', 'river'] as const)(
    'preserves callOnce on %s when facing a raise',
    (street) => {
      for (const stack of [35, 1000]) {
        HorseMind.reset();
        seedFastRandom(1);
        const s = spot(stack);
        s.gs.stage = street;
        s.gs.communityCards = cards(
          street === 'flop' ? 'Qs 8h 3d' : street === 'turn' ? 'Qs 8h 3d 2s' : 'Qs 8h 3d 2s 6h'
        );
        s.hero.bet = 5;
        s.hero.totalInvested = 15;
        s.gs.players[0] = { ...s.hero, cards: [] };
        s.gs.toCall = 15;
        s.gs.pot = 45;
        s.gs.contestablePot = 45;
        s.gs.actionHistory = [
          { stage: street, seat: 1, userId: 'hero', action: 'bet', amount: 5, timestamp: 1 },
          { stage: street, seat: 2, userId: 'villain', action: 'raise', amount: 20, timestamp: 2 },
        ];
        HorseMind.noteRaisePlan(horsePlanHandKey(s.gs.actionHistory), 'hero', street, 'callOnce');
        expect(
          HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false }).action
        ).toBe('call');
      }
    }
  );

  it('never creates raise rights when the canonical menu offers only a call', () => {
    const s = spot(1000);
    s.gs.legalActions = ['fold', 'call'];
    s.gs.minRaiseTo = null;
    s.gs.maxRaiseTo = null;
    expect(headsUpCashCommitment(s.hero, s.gs)).toMatchObject({
      exposure: 35,
      wager: { action: 'call', amount: 20 },
    });
    seedFastRandom(1);
    expect(HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false }).action).toBe(
      'call'
    );
  });

  it('respects a canonical commitment cap instead of promoting it to all in', () => {
    const s = spot(1000);
    s.gs.commitmentCapRemaining = 30;
    s.gs.legalActions = ['fold', 'call'];
    s.gs.minRaiseTo = null;
    s.gs.maxRaiseTo = null;
    expect(headsUpCashCommitment(s.hero, s.gs)).toMatchObject({
      exposure: 30,
      wager: { action: 'call' },
    });
  });

  it('ignores folded covering chips but excludes every additional showdown contender', () => {
    const s = spot(1000);
    s.gs.players.push({
      ...s.gs.players[1],
      seat: 3,
      user_id: 'third',
      stack: 9999,
      is_folded: true,
    });
    expect(headsUpCashCommitment(s.hero, s.gs)?.exposure).toBe(35);
    s.gs.players[2].is_folded = false;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
    s.gs.players[2].stack = 0;
    s.gs.players[2].is_all_in = true;
    s.gs.players[2].is_sitting_out = true;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });

  it.each(['plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo8', 'short_deck', 'pineapple'])(
    'retains the existing %s policy',
    (variant) => {
      const s = spot(1000);
      s.gs.gameVariant = variant;
      expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
    }
  );
  it.each([
    { gameMode: 'tournament' as const },
    { stateSchemaVersion: undefined },
    { bettingStructure: 'pot_limit' as const },
    { bombPot: true },
    { boardCount: 2 as const },
    { communityCards2: cards('Ac Kd 7h') },
    { legalActions: undefined },
  ])('leaves unqualified domains unchanged: %j', (change) => {
    const s = spot(1000);
    Object.assign(s.gs, change);
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it('retains the all-in-only opponent policy', () => {
    const s = spot(1000);
    s.gs.players[1].is_all_in = true;
    s.gs.players[1].stack = 0;
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it.each([0, NaN, -1, 0.1])('refuses invalid chip unit %s', (unit) => {
    const s = spot(1000);
    Object.assign(s.gs, { chipUnit: unit });
    expect(headsUpCashCommitment(s.hero, s.gs)).toBeNull();
  });
  it('rounds up to a legal chip unit without rounding below the minimum', () => {
    const s = spot(1000);
    s.gs.minRaiseTo = 40.005;
    expect(headsUpCashCommitment(s.hero, s.gs)?.wager.amount).toBe(40.01);
    s.gs.maxRaiseTo = 40;
    expect(headsUpCashCommitment(s.hero, s.gs)?.wager.action).toBe('call');
    s.gs.chipUnit = 1;
    s.gs.minRaiseTo = 40.1;
    s.gs.maxRaiseTo = 40.6;
    expect(headsUpCashCommitment(s.hero, s.gs)?.wager.action).toBe('call');
  });

  it('prices a retained foldToRaise plan against the same matched exposure', () => {
    const choices = [35, 1000].map((stack) => {
      HorseMind.reset();
      seedFastRandom(1);
      const s = spot(stack);
      s.hero.bet = 5;
      s.hero.totalInvested = 20;
      s.gs.players[0] = { ...s.hero, cards: [] };
      s.gs.players[1].stack = 20;
      s.gs.players[1].totalInvested = 35;
      s.gs.pot = 55;
      s.gs.contestablePot = 55;
      s.gs.toCall = 15;
      s.gs.minRaise = 15;
      s.gs.lastRaise = 15;
      s.gs.minRaiseTo = 35;
      s.gs.maxRaiseTo = stack + 5;
      s.gs.legalActions = ['fold', 'call', 'raise', 'all_in'];
      s.gs.actionHistory = [
        { stage: 'flop', seat: 1, userId: 'hero', action: 'bet', amount: 5, timestamp: 1 },
        { stage: 'flop', seat: 2, userId: 'villain', action: 'raise', amount: 20, timestamp: 2 },
      ];
      HorseMind.noteRaisePlan(horsePlanHandKey(s.gs.actionHistory), 'hero', 'flop', 'foldToRaise');
      return HorseLogic.decide(s.hero, s.gs, 'balanced', {}, { v7AdaptiveMC: false });
    });
    expect(choices.map((d) => d.action)).toEqual(['call', 'call']);
  });

  it('uses actual controller menus and matches the same 35 units after acceptance and refund', () => {
    const results = [45, 1010].map((initial) => {
      const s = spot(initial);
      const controller = new HandController(
        {
          tableId: 'isolated-effective-risk',
          handNumber: 1,
          gameVariant: 'nlh',
          smallBlind: 1,
          bigBlind: 2,
          rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
        },
        [
          { ...s.hero, stack: initial },
          { ...s.gs.players[1], stack: 45 },
        ],
        2
      );
      controller.start();
      for (const [seat, action, amount] of [
        [2, 'raise', 10],
        [1, 'call', 8],
        [1, 'check', undefined],
        [2, 'bet', 20],
      ] as const)
        expect(controller.performAction(seat, action, amount, 'player')).toBe(true);
      const state = controller.getState();
      const hero = state.players.find((p) => p.seat === 1)!;
      const auth = controller.getAuthoritativeActionState('hero')!;
      const gs = {
        ...s.gs,
        ...auth,
        players: state.players,
        contestablePot: controller.getContestablePotForCall('hero')!,
        commitmentCapRemaining: null,
      };
      const decision = headsUpCashCommitment(hero, gs)!.wager;
      expect(controller.performAction(1, decision.action, decision.amount, 'horse_policy')).toBe(
        true
      );
      expect(
        controller.performAction(
          2,
          'call',
          controller.getAuthoritativeActionState('villain')!.toCall,
          'player'
        )
      ).toBe(true);
      const end = controller.getState();
      expect(end.pot).toBe(90);
      expect(end.players.map((p) => p.totalInvested)).toEqual([45, 45]);
      return { decision, returned: end.players[0].returnedUncalled };
    });
    expect(results).toEqual([
      { decision: { action: 'all_in', thinkTime: 0 }, returned: 0 },
      { decision: { action: 'raise', amount: 40, thinkTime: 0 }, returned: 5 },
    ]);
  });
});
